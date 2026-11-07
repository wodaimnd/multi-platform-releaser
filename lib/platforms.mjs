// dsh-multi-publisher — platform registry & per-platform config.
//
// A platform is one publish destination. Each entry declares what its config
// page needs (fields), how to normalise a stored config, and which pipeline the
// publish job appends. GitHub and npm ship built in; a third one is a matter of
// adding a module here plus its step group in lib/publisher.mjs.
//
// Node builtins only. No network here: verification lives in the adapters.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** Steps every job runs before the per-platform groups. */
export const SHARED_STEP_IDS = Object.freeze(['inspect', 'prepare'])

/** Steps every job runs after all platform groups. */
export const FINAL_STEP_IDS = Object.freeze(['finish'])

/** GitHub group step ids, in pipeline order. */
export const GITHUB_STEP_IDS = Object.freeze(['auth', 'repo', 'topics', 'commit', 'push', 'release'])

/** npm group step ids, in pipeline order. */
export const NPM_STEP_IDS = Object.freeze(['npm-auth', 'npm-guard', 'npm-publish', 'npm-verify'])

/** Step ids in the historic (GitHub-only) order, kept for existing consumers. */
export const STEP_IDS = Object.freeze(['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])

const ACCESS_IDS = Object.freeze(['public', 'restricted'])
const SCHEME_TEST = /^https?:\/\//i
const HOST_WITH_PORT_TEST = /^(\[[0-9a-f:]+\]|[a-z0-9._-]+)(:\d+)?(\/.*)?$/i

/**
 * Strict IPv4 parser. `isPrivateHostname` must not accept "127.0.0.1.evil.com"
 * just because it starts with "127." — the host has to *be* an address.
 */
function isIpv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** RFC 1918 + loopback + link-local, i.e. "an address on a private network". */
function isPrivateIpv4(host) {
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  const second = Number(host.split('.')[1])
  return /^172\./.test(host) && second >= 16 && second <= 31
}

/**
 * Is this hostname only reachable inside a private network?
 *
 * Private registries are routinely served over plain http: Verdaccio on
 * 192.168.x.x, a Nexus at 10.x, an intranet name like `registry.internal`.
 * Refusing those made the field unusable for exactly the people who need it.
 * What must still be refused is http to a *public* host, because that ships the
 * npm token in cleartext across the internet.
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false
  // IPv4: only the private ranges count, and the host must be a real address.
  if (isIpv4(host)) return isPrivateIpv4(host)
  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  // Reserved private / intranet TLDs.
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  // A single-label name ("myserver", "registry") never resolves on the public
  // internet — it is a hosts-file / intranet name.
  if (!host.includes('.')) return true
  return false
}

/**
 * Split user input into `{ scheme, host, rest }` so the same parse feeds both
 * validation and normalisation. A value with no scheme is accepted as input
 * (people paste `registry.npmjs.org:4873`), the scheme is inferred later.
 */
function splitBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return null
  if (SCHEME_TEST.test(text)) {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(text)
    if (!match) return null
    return { scheme: match[1].toLowerCase(), authority: match[2], rest: match[3] }
  }
  // No scheme: only accept something that actually looks like host[:port][/path].
  if (!HOST_WITH_PORT_TEST.test(text)) return null
  const match = /^([^/?#]*)(.*)$/.exec(text)
  if (!match) return null
  return { scheme: null, authority: match[1], rest: match[2] }
}

/** `host` part of an authority (`host:port` → `host`), brackets stripped. */
function hostOfAuthority(authority) {
  const value = String(authority || '')
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    return close === -1 ? value : value.slice(1, close)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/**
 * Would this URL be acceptable as a registry / API base?
 *
 * Accepts: any `https://`, and `http://` *only* when the host is private
 * (loopback, RFC 1918, link-local, `.local` / `.internal` / single-label).
 * A scheme-less value is judged by the scheme it would be given: http for a
 * private host, https otherwise — so `127.0.0.1:4873` is fine while
 * `evil.example.com` still needs an explicit `https://`.
 */
export function isAcceptableBaseUrl(value) {
  const parts = splitBaseUrl(value)
  if (parts === null) return false
  const host = hostOfAuthority(parts.authority)
  if (host === '') return false
  if (parts.scheme === 'https') return true
  if (parts.scheme === 'http') return isPrivateHostname(host)
  // Scheme omitted: infer. Private host → http is fine; public host → we would
  // have to assume https, which is also fine (nothing is downgraded).
  return true
}

/** The reason a value was rejected, in words the user can act on. */
export function describeBaseUrlProblem(value, key = 'url') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return `${key} 不能为空`
  const parts = splitBaseUrl(text)
  if (parts === null) return `${key} 不是合法地址：${text}（应形如 https://registry.npmjs.org 或 http://127.0.0.1:4873）`
  const host = hostOfAuthority(parts.authority)
  if (host === '') return `${key} 缺少主机名：${text}`
  if (parts.scheme === 'http' && !isPrivateHostname(host)) {
    return `${key} 用 http:// 指向公网主机 ${host}：令牌会明文上网。请改用 https://${parts.authority}${parts.rest}，`
      + '或确认这是内网地址（私网 IP / .local / .internal / 单段主机名）'
  }
  return `${key} 不是合法地址：${text}`
}

export function normalizeBaseUrl(value, key = 'url') {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new PlatformConfigError(`${key} 不能为空`)
  if (!isAcceptableBaseUrl(raw)) {
    throw new PlatformConfigError(describeBaseUrlProblem(raw, key))
  }
  // Scheme-less input gets the scheme the host implies: http for a private host
  // (that is how Verdaccio/Nexus are served), https everywhere else.
  const parts = splitBaseUrl(raw)
  const text = parts.scheme === null
    ? `${isPrivateHostname(hostOfAuthority(parts.authority)) ? 'http' : 'https'}://${parts.authority}${parts.rest}`
    : raw
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new PlatformConfigError(`${key} 不是合法 URL：${text}`)
  }
  // Belt and braces for anything that slipped past the string checks.
  const hostname = parsed.hostname
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateHostname(hostname))) {
    throw new PlatformConfigError(describeBaseUrlProblem(text, key))
  }
  return parsed.toString().replace(/\/+$/, '')
}

export class PlatformConfigError extends Error {
  constructor(message, { code = 'bad-request', status = 400 } = {}) {
    super(message)
    this.name = 'PlatformConfigError'
    this.code = code
    this.status = status
  }
}

/* ── built-in platform descriptors ──────────────────────────────────────── */

/**
 * @typedef {Object} PlatformField
 * @property {string} key
 * @property {'token'|'text'|'url'|'select'|'bool'} type
 * @property {string} label
 * @property {string} [hint]
 * @property {boolean} [secret]
 * @property {boolean} [optional]
 * @property {string[]} [options]
 * @property {string} [placeholder]
 */

export const PLATFORMS = Object.freeze([
  {
    id: 'github',
    label: 'GitHub',
    short: 'GitHub',
    kind: 'release',
    order: 10,
    description: '仓库 + topics + git 提交 + tag + Release（原 GitHub 发布台的全部能力）',
    fields: [
      { key: 'apiBase', type: 'url', label: 'API 地址', hint: '公共 GitHub 默认 https://api.github.com；Enterprise 填 https://ghe.example.com/api/v3' },
      { key: 'gitBase', type: 'url', label: '网页地址', hint: '公共 GitHub 默认 https://github.com；Enterprise 填 https://ghe.example.com' },
    ],
  },
  {
    id: 'npm',
    label: 'npm registry',
    short: 'npm',
    kind: 'release',
    order: 20,
    description: 'npm publish 到 registry（含 scoped 包、dist-tag 与 2FA OTP）',
    fields: [
      { key: 'registry', type: 'url', label: 'Registry', hint: '默认 https://registry.npmjs.org；私有源填自建地址', placeholder: 'https://registry.npmjs.org' },
      { key: 'token', type: 'token', label: 'Access Token', secret: true, hint: 'classic 或 granular token，需要 publish 权限；只保存在本机 0600 配置里' },
      {
        key: 'publishName',
        type: 'text',
        label: '发布用包名',
        optional: true,
        placeholder: '@<你的 scope>/<包名>',
        hint: '留空则用 package.json 里的 name。填写时只在发布时改写临时副本的 name，源码 package.json 不动。',
      },
      { key: 'access', type: 'select', label: '访问级别', options: ['public', 'restricted'], hint: 'scoped 包可选 restricted；非 scoped 包只能 public' },
      { key: 'distTag', type: 'text', label: 'dist-tag', placeholder: 'latest', hint: '例如 latest / next / beta' },
      { key: 'otp', type: 'text', label: '2FA OTP', optional: true, hint: '开启 2FA 时每次发布填一次，不落盘' },
      { key: 'provenance', type: 'bool', label: 'provenance', hint: '需要 CI/OIDC 环境，本机发布通常关闭' },
    ],
  },
  {
    id: 'gitee',
    label: 'Gitee',
    short: 'Gitee',
    kind: 'release',
    order: 30,
    description: '码云仓库 + git 提交 + tag + Release（Gitee 没有 topics，该步骤自动跳过）',
    fields: [
      { key: 'apiBase', type: 'url', label: 'API 地址', hint: '公共 Gitee 默认 https://gitee.com/api/v5' },
      { key: 'gitBase', type: 'url', label: '网页地址', hint: '默认 https://gitee.com' },
      {
        key: 'token',
        type: 'token',
        label: '私人令牌',
        secret: true,
        hint: '在 Gitee「设置 → 私人令牌」生成，需要 projects 权限。Gitee 用 access_token 传参，不认 Authorization 头（插件已按官方 spec 处理）',
      },
    ],
    topicsSupported: false,
  },
  {
    id: 'codeberg',
    label: 'Codeberg',
    short: 'Codeberg',
    kind: 'release',
    order: 40,
    description: 'Codeberg（Forgejo）仓库 + topics + git 提交 + tag + Release；自建 Forgejo/Gitea 改 API 地址即可',
    fields: [
      { key: 'apiBase', type: 'url', label: 'API 地址', hint: '公共 Codeberg 默认 https://codeberg.org/api/v1；自建 Forgejo 填 https://<host>/api/v1' },
      { key: 'gitBase', type: 'url', label: '网页地址', hint: '默认 https://codeberg.org' },
      {
        key: 'token',
        type: 'token',
        label: 'Access Token',
        secret: true,
        hint: '在 Codeberg「Settings → Applications」生成，需要 write:repository 权限。鉴权用 Authorization: token <值>',
      },
    ],
    topicsSupported: true,
  },
])

export function platformMeta(id) {
  return PLATFORMS.find((platform) => platform.id === id) || null
}

/** Every platform id the UI may offer, in display order. */
export function platformIds() {
  return PLATFORMS.map((platform) => platform.id)
}

/* ── config normalisation ───────────────────────────────────────────────── */

/** npm config as it is stored on disk (never contains a token hint). */
export const DEFAULT_NPM_CONFIG = Object.freeze({
  registry: 'https://registry.npmjs.org',
  access: 'public',
  distTag: 'latest',
  provenance: false,
  publishName: '',
})

/** The complete `platforms` section of config.json. */
export const DEFAULT_PLATFORM_CONFIG = Object.freeze({
  enabled: ['github'],
  github: Object.freeze({ enabled: true }),
  npm: Object.freeze({ enabled: false, ...DEFAULT_NPM_CONFIG }),
})

function asBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce the stored platforms section. Unknown ids are dropped, the token is
 * kept only when it is a non-empty string, and `enabled` is derived from each
 * platform's own flag so the two can never disagree.
 */
export function normalizePlatforms(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const npm = source.npm && typeof source.npm === 'object' ? source.npm : {}
  const github = source.github && typeof source.github === 'object' ? source.github : {}

  const npmConfig = {
    enabled: asBool(npm.enabled, false),
    registry: asText(npm.registry) || DEFAULT_NPM_CONFIG.registry,
    token: asText(npm.token) || null,
    access: ACCESS_IDS.includes(asText(npm.access)) ? asText(npm.access) : 'public',
    distTag: asText(npm.distTag) || 'latest',
    provenance: asBool(npm.provenance, false),
    publishName: asText(npm.publishName),
  }
  if (npmConfig.token === null) delete npmConfig.token

  const githubConfig = {
    enabled: asBool(github.enabled, true),
    apiBase: asText(github.apiBase) || null,
    gitBase: asText(github.gitBase) || null,
  }
  if (githubConfig.apiBase === null) delete githubConfig.apiBase
  if (githubConfig.gitBase === null) delete githubConfig.gitBase

  /**
   * Repository hostings beyond GitHub.
   *
   * Same shape as GitHub's config (apiBase / gitBase are optional overrides, plus
   * a token for the ones that need one), so `publicPlatformConfig` and the
   * platform field descriptors drive the rest without special cases. Built from
   * the registry so adding a fourth hosting stays a data change.
   */
  const hostingConfig = (id) => {
    const raw = source[id] && typeof source[id] === 'object' ? source[id] : {}
    const config = {
      enabled: asBool(raw.enabled, false),
      apiBase: asText(raw.apiBase) || null,
      gitBase: asText(raw.gitBase) || null,
      token: asText(raw.token) || null,
    }
    if (config.apiBase === null) delete config.apiBase
    if (config.gitBase === null) delete config.gitBase
    if (config.token === null) delete config.token
    return config
  }

  const platforms = { github: githubConfig, npm: npmConfig }
  for (const meta of PLATFORMS) {
    if (meta.id === 'github' || meta.id === 'npm') continue
    if (meta.kind !== 'release') continue
    platforms[meta.id] = hostingConfig(meta.id)
  }
  const enabled = platformIds().filter((id) => platforms[id] && platforms[id].enabled === true)
  return { enabled: enabled.length > 0 ? enabled : ['github'], ...platforms }
}

/** Public (token-free) view of one platform config for the UI / API. */
export function publicPlatformConfig(id, platforms) {
  const meta = platformMeta(id)
  const config = platforms && platforms[id] ? platforms[id] : null
  if (!meta || !config) return null
  const view = { id: id, ...config, enabled: config.enabled === true }
  if (meta.fields.some((field) => field.secret)) {
    view.tokenConfigured = typeof config.token === 'string' && config.token !== ''
    view.tokenHint = view.tokenConfigured ? hintOf(config.token) : null
    delete view.token
  }
  return view
}

/** `abcd…wxyz` — never the whole secret. */
export function hintOf(secret) {
  const text = typeof secret === 'string' ? secret : ''
  if (text === '' || text.length < 9) return text === '' ? null : '***'
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

/* ── publish name (the npm name actually sent to the registry) ──────────── */

const NPM_NAME_TEST = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const NPM_SCOPED_TEST = /^@[a-z0-9][a-z0-9._-]*\//

/** npm's own limits: 214 chars total, lowercase, no spaces. */
export function isValidNpmName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > 214) return false
  if (text !== text.toLowerCase()) return false
  return NPM_NAME_TEST.test(text)
}

export function isScopedNpmName(value) {
  return NPM_SCOPED_TEST.test(typeof value === 'string' ? value.trim() : '')
}

/**
 * The name this plugin publishes under.
 *
 * `publishName` is an explicit override stored in the npm platform config: it
 * lets a plugin whose `package.json` says `@local/x` publish as
 * `@jntm114514/x` without editing the source manifest. It is applied only to
 * a throwaway copy at publish time (see `stageForNpmPublish`), so the
 * repository and the working tree keep their original name.
 */
/**
 * Resolve the npm package name to publish under.
 *
 * Priority: the per-plugin override (from that plugin's draft) → the manifest
 * name. A global `publishName` is deliberately *not* consulted: one plugin's
 * publish name must never decide another plugin's package, which used to make
 * unrelated plugins report bogus "version already exists" failures.
 */
export function npmPublishNameOf(pluginName, pluginConfig) {
  const override = pluginConfig && typeof pluginConfig.publishName === 'string' ? pluginConfig.publishName.trim() : ''
  if (override !== '') return override
  return typeof pluginName === 'string' ? pluginName.trim() : ''
}

/**
 * Rewrite `@old/**` or a bare `old` into the new scope/name.
 *
 * `@local/market-lens` + `@jntm114514` → `@jntm114514/market-lens`
 * `market-lens`       + `@jntm114514` → `@jntm114514/market-lens`
 * A full name is returned unchanged when it already has a scope.
 */
export function scopePublishName(name, scope) {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanScope = typeof scope === 'string' ? scope.trim().replace(/^@?/, '@').replace(/\/+$/, '') : ''
  if (cleanName === '' || cleanScope === '' || cleanScope === '@') return cleanName
  const bare = cleanName.includes('/') ? cleanName.slice(cleanName.indexOf('/') + 1) : cleanName
  if (bare === '') return cleanName
  return `${cleanScope}/${bare}`
}

/** The scope of a name (`@scope/name` → `@scope`), or '' when unscoped. */
export function scopeOfName(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text.startsWith('@')) return ''
  const slash = text.indexOf('/')
  return slash === -1 ? text : text.slice(0, slash)
}

/* ── step-id planning ───────────────────────────────────────────────────── */

/**
 * Build the ordered step ids a job will run for the selected platforms.
 * Shared steps first, then one group per platform in registry order, then the
 * final steps. A platform that is not selected contributes no steps at all.
 */
/** Repository hostings that publish through the git pipeline (any of them). */
const HOSTING_IDS = Object.freeze(['github', 'gitee', 'codeberg']);

/**
 * Which repository hostings a selection targets, in registry order.
 *
 * The plugin is a multi-platform publisher: one commit is pushed to every
 * selected hosting, each with its own repository, topics and release. A job that
 * could only reach one remote would defeat the point of the product.
 *
 * Returns `[]` for an npm-only selection — that is a real answer ("no hosting").
 */
export function hostingsOf(selected) {
  const ids = normalizeSelection(selected)
  return HOSTING_IDS.filter((id) => ids.includes(id))
}

/**
 * The primary hosting for a selection, or `''` when it publishes to none.
 *
 * Used where a single value is genuinely needed (the label on a preflight
 * summary), never to decide how many remotes receive the commit.
 */
export function hostingOf(selected) {
  return hostingsOf(selected)[0] || ''
}

/** Whether a selection publishes to any repository hosting at all. */
export function hasHosting(selected) {
  const ids = normalizeSelection(selected)
  return HOSTING_IDS.some((id) => ids.includes(id))
}

export function buildStepIds(selected) {
  const ids = normalizeSelection(selected)
  const steps = []
  // Any repository hosting runs the same pipeline: authenticate, create/reuse the
  // repo, commit, push, then release. The step *ids* stay GitHub's names because
  // they are the pipeline's vocabulary (and locked by tests), but a Gitee or
  // Codeberg publish takes them too — earlier this was keyed on `github` alone,
  // which made a Gitee-only publish "succeed" after three steps having silently
  // created no repository at all.
  const publishesToHosting = HOSTING_IDS.some((id) => ids.includes(id))
  if (publishesToHosting) steps.push(GITHUB_STEP_IDS[0])
  steps.push(...SHARED_STEP_IDS)
  if (publishesToHosting) steps.push(...GITHUB_STEP_IDS.slice(1))
  if (ids.includes('npm')) steps.push(...NPM_STEP_IDS)
  steps.push(...FINAL_STEP_IDS)
  return steps
}

/** Which platform a step id belongs to ('shared' / 'github' / 'npm' / 'final'). */
export function stepPlatformOf(stepId) {
  const id = typeof stepId === 'string' ? stepId : ''
  if (SHARED_STEP_IDS.includes(id)) return 'shared'
  if (FINAL_STEP_IDS.includes(id)) return 'final'
  if (GITHUB_STEP_IDS.includes(id)) return 'github'
  if (NPM_STEP_IDS.includes(id)) return 'npm'
  return 'shared'
}

/** Resolve, validate and de-duplicate the requested platform ids. */
export function normalizeSelection(raw, fallback = ['github']) {
  const list = Array.isArray(raw) ? raw : []
  const known = list.filter((id) => typeof id === 'string' && platformMeta(id) !== null)
  const unique = [...new Set(known)]
  if (unique.length === 0) return [...fallback]
  return platformIds().filter((id) => unique.includes(id))
}

/** Human-readable "GitHub + npm" label used by the publish button. */
export function describeSelection(selected) {
  const list = normalizeSelection(selected)
  return list.map((id) => (platformMeta(id) || { label: id }).label).join(' + ')
}

/* ── data directory note ────────────────────────────────────────────────── */

/** Directory name inside $DSH_HOME, exported so tests can assert on it. */
export const DATA_DIR_NAME = 'multi-publisher'

/** Resolve the plugin data directory (kept next to the old publisher dir). */
export function resolveDataDirFor(env, home) {
  return path.join(home, DATA_DIR_NAME)
}

/* ── shared npm runner (used by the npm adapter steps) ──────────────────── */

/**
 * Candidate npm-cli.js paths, most specific first.
 *
 * The Host runs inside Electron, where `process.execPath` is the app EXE
 * (DeepSeek Harness.exe), not node — so the npm that ships with the user's Node
 * install is never adjacent to execPath. Resolution therefore also walks:
 *   · a `node` found on PATH (whose sibling node_modules/npm is the real npm),
 *   · `npm`/`npm.cmd` on PATH (resolving its npx-style shim directory back),
 *   · npm_config_prefix / %APPDATA%\npm,
 *   · the npm CLI exposed through the runtime that launched this process.
 */
function executableNames(base) {
  if (process.platform !== 'win32') return [base]
  return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base]
}

function walkPathFor(command) {
  const raw = typeof process.env.PATH === 'string' ? process.env.PATH : ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const entries = raw.split(separator).map((entry) => entry.trim()).filter(Boolean)
  const found = []
  for (const entry of entries) {
    for (const name of executableNames(command)) {
      const candidate = path.join(entry, name)
      try {
        if (fs.existsSync(candidate)) found.push(candidate)
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return found
}

/** npm-cli.js candidates derived from one node / npm binary path. */
function npmCandidatesFrom(binary) {
  const dir = path.dirname(binary)
  const stem = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '')
  const out = []
  if (stem === 'node') out.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  // %APPDATA%\npm holds the global npm shim; its node_modules is one level up.
  out.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  return out
}

export function npmCliCandidates(execPath = process.execPath, env = process.env) {
  const candidates = []
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }

  // 1. Next to the running executable (works when DSH runs on plain node).
  for (const candidate of npmCandidatesFrom(execPath)) push(candidate)
  push(path.join(execPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'))

  // 2. A `node` on PATH — its sibling npm is the one the user actually uses.
  for (const nodeBinary of walkPathFor('node')) {
    for (const candidate of npmCandidatesFrom(nodeBinary)) push(candidate)
  }

  // 3. npm / npm.cmd on PATH (their dir is usually <node>/ for the shim itself).
  for (const npmBinary of walkPathFor('npm')) {
    for (const candidate of npmCandidatesFrom(npmBinary)) push(candidate)
  }

  // 4. Explicit prefix overrides.
  const prefix = typeof env.npm_config_prefix === 'string' ? env.npm_config_prefix.trim() : ''
  if (prefix !== '') push(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  if (typeof env.APPDATA === 'string' && env.APPDATA !== '') {
    push(path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  if (typeof env.NODE_PATH === 'string' && env.NODE_PATH !== '') {
    for (const entry of env.NODE_PATH.split(process.platform === 'win32' ? ';' : ':')) {
      if (entry.trim() !== '') push(path.join(entry.trim(), 'npm', 'bin', 'npm-cli.js'))
    }
  }
  return candidates
}

/** Location of the npm CLI as a JS entry point (`node npm-cli.js …`), or null. */
export function npmCliPath(execPath = process.execPath, env = process.env) {
  for (const candidate of npmCliCandidates(execPath, env)) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* next candidate */
    }
  }
  return null
}

/**
 * The node binary to run npm with: the npm CLI is a JS file, so it needs a node.
 * Prefer a `node` on PATH (the same one npm belongs to), then execPath itself
 * when it really is node, then the node bundled with DSH.
 */
export function nodeBinaryFor(execPath = process.execPath, env = process.env) {
  const onPath = walkPathFor('node')
  // On Windows the first PATH hit may be node.exe; keep it as-is.
  if (onPath.length > 0) return onPath[0]
  const stem = path.basename(execPath).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (stem === 'node') return execPath
  if (typeof env.DSH_NODE_BIN === 'string' && env.DSH_NODE_BIN.trim() !== '' && fs.existsSync(env.DSH_NODE_BIN.trim())) {
    return env.DSH_NODE_BIN.trim()
  }
  return 'node'
}

/**
 * Run the npm CLI without a shell: `node npm-cli.js …`. The token travels only
 * through the child environment (`npm_config_<registry>:_authToken`), never in
 * argv, never written to .npmrc, and any long alphanumeric in the output is
 * scrubbed before it reaches a log or an error message.
 */
export function runNpm(argv, { cwd, registry, token, signal, timeoutMs = 180_000, log = null } = {}) {
  const cli = npmCliPath()
  if (cli === null) {
    const error = new PlatformConfigError('找不到 npm CLI：需要 Node 自带的 npm（node_modules/npm/bin/npm-cli.js）。可以在 PATH 里放一个 node，或设置 DSH_NODE_BIN。')
    error.code = 'npm-missing'
    return Promise.reject(error)
  }
  // Credential delivery.
  //
  // `npm_config_<host>:_authToken` looks tempting, but on Windows the key
  // contains a colon and the host may contain a port — a var name that npm
  // (and cmd.exe) do not reliably see, which surfaced as ENEEDAHEAD/ENEEDAUTH
  // during a real publish. A throwaway .npmrc is the portable way: npm reads
  // `//host/:_authToken=…` there exactly as it does from the user's own file.
  const registryOrigin = (() => {
    try {
      const parsed = new URL(registry || 'https://registry.npmjs.org')
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return 'https://registry.npmjs.org'
    }
  })()
  let npmrcFile = null
  let npmrcDir = null
  if (token) {
    npmrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npmrc-'))
    npmrcFile = path.join(npmrcDir, '.npmrc')
    fs.writeFileSync(npmrcFile, `//${registryOrigin.replace(/^https?:\/\//, '')}/:_authToken=${token}\n`, { mode: 0o600 })
  }
  const env = {
    ...process.env,
    npm_config_loglevel: 'error',
    npm_config_always_auth: 'true',
    ...(npmrcFile ? { npm_config_userconfig: npmrcFile } : {}),
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      // npm-cli.js is JavaScript: it must be launched with a real node, which
      // is not necessarily process.execPath (the Host runs inside Electron).
      child = spawn(nodeBinaryFor(), [cli, ...argv], {
        cwd,
        env,
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(new PlatformConfigError(`无法启动 npm CLI：${error.message}`))
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new PlatformConfigError(`npm 启动失败：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (npmrcDir) {
        try { fs.rmSync(npmrcDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      const combined = `${err}\n${out}`
      const scrubbed = combined.replace(/\b[A-Za-z0-9_\-]{24,}\b/g, (match) => (match.includes('@') ? match : '***'))
      if (log && typeof log === 'function') log(scrubbed.slice(-1200))
      if (code === 0) {
        resolve(out)
        return
      }
      const message = scrubbed.trim().split('\n').filter(Boolean).slice(-6).join('\n') || `npm exit ${code}`
      const error = new PlatformConfigError(message)
      error.code = 'npm-failed'
      error.status = 400
      reject(error)
    })
  })
}

/** Fetch one JSON document with a bearer token; 404 means "not published". */
/** Host (host[:port]) of a URL, for readable transport errors. */
function hostOfUrl(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(String(url || '').trim())
  return match ? match[1].toLowerCase() : String(url || '')
}

/**
 * Fetch a registry endpoint.
 *
 * A bare `fetch failed` tells the user nothing — the preflight used to surface
 * exactly that when the configured registry simply was not running. Every
 * transport failure is therefore translated into a `registry-unreachable`
 * error that names the endpoint and the underlying cause (`ECONNREFUSED`,
 * `ENOTFOUND`, DNS, timeout…), so the panel can say *which* registry is down.
 */
export async function registryFetch(url, { token = null, timeoutMs = 20_000, accept = 'application/json' } = {}) {
  const headers = { 'user-agent': 'dsh-multi-publisher', accept }
  if (token) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const cause = error && error.cause ? error.cause : null
    const reason = (cause && (cause.code || cause.syscall)) || (error && (error.code || error.name)) || 'network'
    const host = hostOfUrl(url)
    // Order matters: a DNS failure often surfaces *inside* the socket error,
    // so the resolver code has to win over the generic socket/type failure.
    const isDns = reason === 'ENOTFOUND' || reason === 'EAI_AGAIN' || reason === 'UND_ERR_SOCKET'
    const isConnRefused = !isDns && (reason === 'ECONNREFUSED' || reason === 'ECONNRESET' || (error && error.name === 'TypeError'))
    const isTimeout = reason === 'TimeoutError' || reason === 'UND_ERR_CONNECT_TIMEOUT'
    const detail =
      isDns
        ? `${host} 无法解析（DNS 查不到该主机）`
        : isTimeout
          ? `${host} 连接超时（${timeoutMs}ms）`
          : isConnRefused
            ? `${host} 上没有 registry 在监听（连接被拒绝）`
            : `${host} 连接失败（${reason}）`
    const wrapped = new PlatformConfigError(`${detail} —— registry 未运行或地址填错：${url}`)
    wrapped.code = 'registry-unreachable'
    wrapped.detail = detail
    throw wrapped
  }
  if (response.status === 404) return null
  if (!response.ok) {
    const error = new PlatformConfigError(`registry HTTP ${response.status}`)
    error.code = 'registry-http'
    throw error
  }
  return response.json()
}

/* ── npm adapter ────────────────────────────────────────────────────────── */

/** Percent-encode a package name the way the registry expects (`@scope/name`). */
export function npmPackagePath(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value === '') throw new PlatformConfigError('缺少包名')
  return value.startsWith('@') ? `@${value.slice(1).replace('/', '%2f')}` : value
}

/** `GET {registry}/-/whoami` → the token's npm username. */
export async function npmVerify(config) {
  const registry = normalizeBaseUrl(config && config.registry ? config.registry : DEFAULT_NPM_CONFIG.registry, 'registry')
  const token = typeof config?.token === 'string' ? config.token.trim() : ''
  if (token === '') throw new PlatformConfigError('npm token 不能为空', { code: 'npm-no-token' })
  const doc = await registryFetch(`${registry}/-/whoami`, { token })
  const username = doc && typeof doc.username === 'string' ? doc.username : ''
  if (username === '') throw new PlatformConfigError('registry 没有返回用户名，token 可能无效')
  return { ok: true, account: { login: username, source: 'config' }, hint: hintOf(token), warnings: [] }
}

/**
 * Copy a plugin into a throwaway directory whose `package.json` carries the
 * publish name.
 *
 * This is how an npm publish renames a package without touching the source:
 * the repository keeps `@local/x`, and only the tarball that reaches the
 * registry is `@jntm114514/x`. Everything else (files, `files[]` filters,
 * README, LICENSE) is copied verbatim so `npm publish` sees the same tree.
 *
 * Returns `{ dir, name, renamed }`; the caller must call `cleanup()`.
 */
export async function stageForNpmPublish(pluginDir, publishName) {
  const source = path.resolve(pluginDir)
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-npm-stage-'))
  const cleanup = () => fsp.rm(target, { recursive: true, force: true }).catch(() => {})
  try {
    await fsp.cp(source, target, {
      recursive: true,
      // node_modules is rebuilt by npm and would make the copy enormous.
      filter: (entry) => {
        const name = path.basename(entry)
        return name !== '.git' && name !== 'node_modules'
      },
    })
    const manifestPath = path.join(target, 'package.json')
    const raw = await fsp.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)
    const previous = typeof manifest.name === 'string' ? manifest.name : ''
    const needsRename = previous !== publishName
    // A registry refuses `private: true` with EPRIVATE. The staged copy exists
    // precisely to be published, so the flag is dropped here — never in the
    // source manifest, which keeps guarding the local plugin.
    const droppedPrivate = manifest.private === true
    if (!needsRename && !droppedPrivate) {
      return { dir: target, name: publishName, renamed: false, previous, droppedPrivate: false, cleanup }
    }
    manifest.name = publishName
    if (droppedPrivate) delete manifest.private
    const indent = /^\{\s*\n(\s+)/.exec(raw)
    const spacing = indent ? indent[1] : '  '
    const rebuilt = JSON.stringify(manifest, null, spacing)
    await fsp.writeFile(manifestPath, `${rebuilt}\n`, 'utf8')
    return { dir: target, name: publishName, renamed: needsRename, previous, droppedPrivate, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Human-facing package page for a registry (npmjs gets the real site). */
function registryPageUrl(base, name) {
  return /(^|\.)registry\.npmjs\.(org|com)/.test(base.replace(/^https?:\/\//, '').split('/')[0])
    ? `https://www.npmjs.com/package/${name}`
    : `${base}/-/web/detail/${npmPackagePath(name)}`
}

/**
 * What a registry already holds for a package name.
 *
 * npm's only hard prohibition is a **duplicate version**. A registry happily
 * accepts `1.0.0` for a package whose latest is `2.0.0` (verified against
 * Verdaccio 7: `latest` then moves *back* to `1.0.0`). Asking only for
 * `/<name>/latest` collapsed "this exact version is taken" and "your version is
 * below the remote latest" into a single answer, so a legal publish of a lower
 * version was blocked with the misleading message "版本 X 已存在于 npm".
 *
 * The abbreviated packument carries every published version plus `dist-tags`,
 * so callers can ask the precise question with `has(version)`.
 */
export async function npmRemoteState({ name, registry = DEFAULT_NPM_CONFIG.registry, token = null } = {}) {
  const base = normalizeBaseUrl(registry, 'registry')
  const doc = await registryFetch(`${base}/${npmPackagePath(name)}`, {
    token,
    accept: 'application/vnd.npm.install-v1+json, application/json',
  })
  const url = registryPageUrl(base, name)
  if (!doc) {
    return { exists: false, version: null, latest: null, versions: [], url, publishedAt: null, has: () => false }
  }
  const versions = Object.keys(doc.versions && typeof doc.versions === 'object' ? doc.versions : {}).sort((a, b) =>
    compareVersions(b, a),
  )
  const tag = doc['dist-tags'] && typeof doc['dist-tags'].latest === 'string' ? doc['dist-tags'].latest : null
  const latest = tag || versions[0] || null
  const times = doc.time && typeof doc.time === 'object' ? doc.time : null
  const has = (value) => {
    const wanted = String(value === undefined || value === null ? '' : value).trim().replace(/^v/, '')
    if (wanted === '') return false
    if (versions.includes(wanted)) return true
    // Registries normalise some spellings; fall back to a semantic compare so
    // `1.0.0+build.1` and `1.0.0` are not treated as different versions.
    return versions.some((entry) => compareVersions(entry, wanted) === 0)
  }
  return {
    exists: true,
    version: latest,
    latest,
    versions,
    url,
    publishedAt: times && latest ? times[latest] || null : null,
    has,
  }
}

/**
 * The next version that is safely above both the local and the remote one.
 *
 * A plain patch bump of the local version is NOT a fix when the local version
 * trails the remote: `0.3.4` → `0.3.5` stays below a remote `1.0.1`, so the same
 * collision returns on every preflight and the one-click button can never
 * escape. Leaping to just past the remote does terminate.
 */
export function nextVersionAbove(local, remote) {
  const strip = (value) =>
    String(value === undefined || value === null ? '0.0.0' : value)
      .trim()
      .replace(/^v/, '')
      .replace(/[-+].*$/, '')
  const localBase = strip(local) || '0.0.0'
  const remoteBase = strip(remote) || '0.0.0'
  const floor = compareVersions(remoteBase, localBase) > 0 ? remoteBase : localBase
  // A local copy of the patch bump on purpose: `bumpVersionString` lives in
  // publisher.mjs, which imports *this* module, so reaching back would be a
  // cycle. The shape is trivial and covered by its own tests.
  const parts = floor.split('.')
  const major = Number(parts[0]) || 0
  const minor = Number(parts[1]) || 0
  const patch = Number(parts[2]) || 0
  return `${major}.${minor}.${patch + 1}`
}

/** Compare dotted/numeric versions without pulling in semver. */
export function compareVersions(left, right) {
  const a = String(left || '').split(/[.\-+]/)
  const b = String(right || '').split(/[.\-+]/)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] === undefined ? '' : a[index]
    const y = b[index] === undefined ? '' : b[index]
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/* ── read npm credentials the user already has ──────────────────────────── */

/**
 * Candidate `.npmrc` files, most specific first.
 *
 * A local registry is usually authenticated once by `npm login`, which writes
 * `//host/:_authToken=…` into an `.npmrc`. Asking the user to copy that value
 * back into the panel is error-prone (the key prefix gets pasted instead of the
 * value), so the Host reads it directly.
 */
export function npmrcCandidates(env = process.env) {
  const home = os.homedir()
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(path.join(home, '.npmrc'))
  push(path.join(home, '.npmrc-verdaccio'))
  if (typeof env.NPM_CONFIG_USERCONFIG === 'string' && env.NPM_CONFIG_USERCONFIG.trim() !== '') {
    push(env.NPM_CONFIG_USERCONFIG.trim())
  }
  if (typeof env.DSH_NPMRC === 'string' && env.DSH_NPMRC.trim() !== '') push(env.DSH_NPMRC.trim())
  return out
}

/**
 * Parse `//host[:port]/:_authToken=…` lines out of an .npmrc body.
 *
 * Returns `{ '<host>': '<token>' }`. The key may carry a path prefix
 * (`//host/path/:_authToken`), which is why the host is matched separately.
 */
export function parseNpmrcTokens(text) {
  const map = {}
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    const m = /^\s*(\/\/[^=\s]+?)\/?:?_authToken\s*=\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    // Key like "//127.0.0.1:4873" or "//registry.npmjs.org/:_authToken".
    const key = m[1].replace(/^\/\//, '').replace(/\/+$/, '')
    const token = m[2].trim()
    if (token !== '' && key !== '') map[key.toLowerCase()] = token
  }
  return map
}

/** Is this string obviously the .npmrc *key* rather than a token? */
export function looksLikeNpmrcKey(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return false
  if (text.startsWith('//')) return true
  if (text.includes('_authToken')) return true
  return false
}

/**
 * Find a token for `registry` in the user's .npmrc files.
 *
 * Matching is host-first (`host:port` → `host`), so both
 * `//127.0.0.1:4873/:_authToken=…` and `//registry.npmjs.org/:_authToken=…`
 * resolve correctly. Returns `{ token, source, host }` or null.
 */
export async function readNpmrcToken(registry, env = process.env) {
  const parts = splitBaseUrl(registry)
  if (parts === null) return null
  const host = hostOfAuthority(parts.authority).toLowerCase()
  const authority = parts.authority.toLowerCase().replace(/\/+$/, '')
  if (host === '') return null
  for (const file of npmrcCandidates(env)) {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    const map = parseNpmrcTokens(text)
    const exact = map[authority]
    const byHost = map[host]
    const token = exact || byHost
    if (typeof token === 'string' && token !== '') return { token, source: file, host }
  }
  return null
}

/** Files Verdaccio writes next to its config; used to recognise a local registry. */
const VERDACCIO_CONFIG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'verdaccio')
const VERDACCIO_START_SCRIPT = 'G:\\AI PGRM\\plugn\\start-verdaccio.ps1'
const VERDACCIO_TASK_NAME = 'VerdaccioLocalRegistry'
const REGISTRY_PROBE_TIMEOUT_MS = 4_000
const REGISTRY_START_TIMEOUT_MS = 25_000

/**
 * Is this registry address something we may try to start ourselves?
 *
 * Only a *local* registry qualifies: loopback or this machine's own private
 * address. Starting a remote service is not ours to do, and a public host is
 * never the user's own Verdaccio.
 */
export function isLocallyManagedRegistry(registry) {
  const parts = splitBaseUrl(registry)
  if (parts === null) return false
  const host = hostOfAuthority(parts.authority)
  if (!isPrivateHostname(host)) return false
  if (host === 'localhost' || host.indexOf('.localhost') >= 0) return true
  if (isIpv4(host)) return isPrivateIpv4(host)
  // An IPv6 literal / single-label intranet name is fine to probe; we only ever
  // *start* the known Verdaccio install, never an arbitrary service.
  return true
}

/** Is Verdaccio actually installed on this machine? */
export function verdaccioBinaryPath(env = process.env) {
  const candidates = [
    path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'verdaccio.cmd'),
    path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'verdaccio'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable candidate */
    }
  }
  return null
}

/** Does a TCP port answer on loopback? Used to tell "not started" from "wrong URL". */
function probePort(port, timeoutMs = REGISTRY_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * Health of the configured registry, without throwing.
 *
 * Returns `{ reachable, host, port, local, verdaccio, running, detail }` so the
 * panel can offer the right action: start the local registry, fix the address,
 * or nothing at all.
 */
export async function registryStatus(registry, env = process.env) {
  const parts = splitBaseUrl(registry)
  const host = parts ? hostOfAuthority(parts.authority) : ''
  const authority = parts ? parts.authority : ''
  const portMatch = /:(\d+)$/.exec(authority.replace(/^\[[^\]]*\]/, (m) => m))
  const port = portMatch ? Number(portMatch[1]) : 443
  const local = isLocallyManagedRegistry(registry)
  const binary = verdaccioBinaryPath(env)
  let reachable = false
  try {
    const response = await fetch(`${normalizeBaseUrl(registry)}/-/ping`, {
      signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
    })
    reachable = response.ok
  } catch {
    reachable = false
  }
  const listening = local ? await probePort(port) : false
  return {
    registry: typeof registry === 'string' ? registry.trim() : '',
    host,
    port,
    local,
    verdaccio: binary !== null,
    listening,
    reachable,
    // "Not running but the port is closed" is exactly the startable state.
    startable: local && binary !== null && !reachable && !listening,
    detail: reachable
      ? 'registry 在线，可以发布'
      : listening
        ? '端口有响应但 /-/ping 失败，registry 可能仍在启动或不是 npm registry'
        : local
          ? '本地 registry 没有在监听：可以点「启动 registry」'
          : '远端 registry 连不上：检查地址或网络（本插件只能启动本机 registry）',
  }
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, output: String(error && error.message ? error.message : error) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: String(error && error.message ? error.message : error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: `${out}${err}`.trim() })
    })
  })
}

/**
 * Start the local Verdaccio and wait until it answers.
 *
 * Prefers the Windows scheduled task (it detaches from this session, so the
 * registry survives a DSH restart), then the start script, then a bare
 * `verdaccio -c <config>` process. Returns the post-start status either way —
 * never throws, so a failed start still updates the UI.
 */
export async function startLocalRegistry(registry, env = process.env) {
  const before = await registryStatus(registry, env)
  if (!before.local) {
    return { ...before, started: false, error: '只能启动本机 registry：当前地址指向外部主机' }
  }
  if (before.reachable) {
    return { ...before, started: false, alreadyRunning: true, detail: 'registry 已在运行' }
  }
  const binary = verdaccioBinaryPath(env)
  if (binary === null) {
    return { ...before, started: false, error: '没有安装 Verdaccio：先执行 npm i -g verdaccio' }
  }

  const configPath = path.join(VERDACCIO_CONFIG_DIR, 'config.yaml')
  const attempts = []
  // Each strategy runs only while the port is still closed, so a successful
  // scheduled-task start does not also spawn the script (which would flash a
  // second PowerShell window for nothing).
  const portOpen = async () => probePort(before.port)
  if (process.platform === 'win32' && !(await portOpen())) {
    // 1. Scheduled task: survives session end / re-login.
    const task = await runPowerShell(
      `$t = Get-ScheduledTask -TaskName '${VERDACCIO_TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { Start-ScheduledTask -TaskName '${VERDACCIO_TASK_NAME}'; 'ok' } else { 'no-task' }`,
      15_000,
    )
    attempts.push({ strategy: 'scheduled-task', ok: task.ok && task.output.includes('ok'), output: task.output })
    // The task is asynchronous: give it a moment before deciding it failed.
    if (task.ok && task.output.includes('ok')) {
      for (let i = 0; i < 10 && !(await portOpen()); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
  if (process.platform === 'win32' && !(await portOpen())) {
    // 2. Project start script: starts a detached process when the task is gone.
    try {
      if (fs.existsSync(VERDACCIO_START_SCRIPT)) {
        const script = await runPowerShell(`& '${VERDACCIO_START_SCRIPT}'`, 30_000)
        attempts.push({ strategy: 'start-script', ok: script.ok, output: script.output })
      }
    } catch {
      /* script unreadable */
    }
  }
  // 3. Last resort: detached verdaccio process of our own.
  if (!(await portOpen())) {
    try {
      const child = spawn(process.platform === 'win32' ? 'cmd.exe' : binary, process.platform === 'win32'
        ? ['/c', `"${binary}" -c "${configPath}"`]
        : ['-c', configPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      attempts.push({ strategy: 'detached-process', ok: true, output: `pid=${child.pid || '?'}` })
    } catch (error) {
      attempts.push({ strategy: 'detached-process', ok: false, output: String(error && error.message ? error.message : error) })
    }
  }

  // Wait for the port to answer (Verdaccio needs a moment to boot).
  const deadline = Date.now() + REGISTRY_START_TIMEOUT_MS
  let status = await registryStatus(registry, env)
  while (!status.reachable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    status = await registryStatus(registry, env)
  }
  return {
    ...status,
    started: status.reachable,
    attempts,
    error: status.reachable ? null : '启动后仍连不上，请检查 Verdaccio 日志',
  }
}
