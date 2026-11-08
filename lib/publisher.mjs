/**
 * dsh-multi-publisher — publish pipeline.
 *
 * One Preflight (read-only checks + file plan + README preview) and one Job
 * shared by the Web UI (HTTP API in index.js) and the `multi_platform_releaser` agent
 * tool. A job runs a GitHub group (auth → repo → topics → commit → push →
 * release) and/or an npm group (npm-auth → npm-guard → npm-publish →
 * npm-verify) around the shared inspect/prepare/finish steps, depending on
 * which platforms the form selected. Every user-visible action of the plugin
 * goes through this class, so the two callers can never drift apart.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { GitHubClient, GitHubError } from './github.mjs'
import * as git from './git.mjs'
import {
  buildStepIds,
  compareVersions,
  DEFAULT_NPM_CONFIG,
  isValidNpmName,
  NPM_STEP_IDS,
  nodeBinaryFor,
  npmCliPath,
  npmPublishNameOf,
  npmRemoteState,
  npmVerify,
  nextVersionAbove,
  normalizeBaseUrl as normalizeBaseUrlFor,
  normalizeSelection,
  platformMeta,
  PLATFORMS,
  publicPlatformConfig,
  npmrcCandidates,
  readNpmrcToken,
  looksLikeNpmrcKey,
  hintOf,
  runNpm,
  scopeOfName,
  stageForNpmPublish,
  stepPlatformOf,
  hostingOf,
  hostingsOf,
  hasHosting,
} from './platforms.mjs'
import { providerOf, supportsTopics as providerSupportsTopics, repoWebUrlFor, repoCloneUrlFor, pushUsernameFor } from './providers.mjs'
import { applyPreparation, buildReleaseNotesEntry, planPreparation, readManifestText } from './prepare.mjs'
import { inspectPlugin, sanitizeRepoName } from './scanner.mjs'
import { inspectVersionDrift, syncVersionDeclarations } from './version-sync.mjs'
import {
  DRAFTS_MAX,
  fingerprintOf,
  HISTORY_MAX,
  LICENSE_IDS,
  tokenHint,
  VISIBILITY_IDS,
} from './store.mjs'

/** Repository hostings that run the git pipeline (shared with platforms.mjs). */
const HOSTING_PLATFORM_IDS = ['github', 'gitee', 'codeberg']

export const VERSION = '0.4.2'

/**
 * Git HTTPS transport used for push / tag push.
 *
 * Some networks (notably a local proxy / VPN in front of GitHub) break
 * libcurl's HTTP/2 framing: `fatal: unable to access ...: Error in the HTTP2
 * framing layer`, or a 75s connect timeout. GitHub serves git over HTTP/1.1
 * fine and it is dramatically more reliable on those networks, so publish uses
 * HTTP/1.1 by default; `DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION=auto` restores the
 * old HTTP/2-first behaviour for users behind a healthy proxy.
 */
const GIT_HTTP_VERSION = (() => {
  const value = String(process.env.DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION || '').trim()
  if (value === 'auto' || value === 'HTTP/2' || value === 'HTTP/1.1') return value === 'auto' ? null : value
  return 'HTTP/1.1'
})()

/** True when pushes should force the given HTTP version. */
function pushHttpVersion(attempt) {
  if (GIT_HTTP_VERSION) return GIT_HTTP_VERSION
  return attempt >= 3 ? 'HTTP/1.1' : null
}

/** Default step ids for a GitHub-only job (kept for compatibility). */
export const STEP_IDS = Object.freeze(['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])

const JOB_LOG_MAX = 400
const JOB_MAX_LOGS_CHARS = 2000
const JOB_RETENTION = 5
const MAX_JOBS = 8

/** The npm CLI ships with Node; the step group is only runnable when it exists. */
const NPM_CLI_PATH = npmCliPath()
const NPM_CLI_AVAILABLE = NPM_CLI_PATH !== null
const BRANCH_TEST = /^[A-Za-z0-9._/-]{1,200}$/
const REPO_NAME_TEST = /^[A-Za-z0-9._-]{1,100}$/
const EMAIL_TEST = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
const DEFAULT_TIMEOUT_MS = 30_000

/** Errors that carry an HTTP status + stable code for the API layer. */
/**
 * A manifest that still says private:true cannot be published — npm answers
 * EPRIVATE. The flag protects the local install, so it is never edited in the
 * source: publishing goes through a staged copy that drops it.
 */
async function isPrivatePackage(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    return manifest.private === true
  } catch {
    return false
  }
}

export class PublisherError extends Error {
  constructor(code, message, { status = 400, details = null } = {}) {
    super(message)
    this.name = 'PublisherError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Small promise timeout that clears its own timer. */
function withTimeout(promise, ms, message) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PublisherError('timeout', message || `操作超过 ${ms}ms 未完成`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function abortError(message = '已取消') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}

function isAbort(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'ABORT_ERR')
}

/**
 * Transport-level git failures worth retrying: on flaky networks / VPNs libcurl
 * reports errors like "Error in the HTTP2 framing layer" or "RPC failed" before
 * any ref negotiation happens. Retrying (the last attempt forced over HTTP/1.1)
 * is the standard workaround; auth/ref errors are NOT retried.
 */
const TRANSIENT_GIT_TRANSPORT = /HTTP2 framing layer|HTTP\/2|RPC failed|Connection reset|early EOF|unexpected EOF|Empty reply from server|Could not resolve host|Failed to connect|Connection timed out|Operation timed out|TLS handshake|SSL_|gnutls|Recv failure|Send failure|transfer closed|Connection closed|remote end hung up/i

/** True when a git error is a transient network transport problem. */
export function isTransientGitTransportError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase()
  return TRANSIENT_GIT_TRANSPORT.test(text)
}

/** Abortable sleep used between transport retries. */
function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
}

/** Run a command without a shell and return trimmed output; never throws. */
function runCollect(argv, { env = null, timeoutMs = 5000, stdin = null } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          timeout: timeoutMs,
          env: { ...process.env, ...(env || {}) },
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          })
        },
      )
      if (stdin !== null && child.stdin) {
        child.stdin.end(stdin)
      }
    } catch {
      resolve({ ok: false, stdout: '', stderr: 'spawn failed', code: 1 })
    }
  })
}

/** Auto-detect a GitHub token from the user's environment, in priority order. */
async function detectTokenCandidates(env) {
  const candidates = []
  const push = (source, token) => {
    if (typeof token !== 'string') return
    const value = token.trim()
    if (value === '') return
    if (!candidates.some((candidate) => candidate.token === value)) candidates.push({ source, token: value })
  }
  push('env', env.GITHUB_TOKEN)
  push('env', env.GH_TOKEN)
  const gh = await runCollect(['gh', 'auth', 'token'], { timeoutMs: 4000 })
  if (gh.ok) push('gh-cli', firstLine(gh.stdout))
  const credential = await runCollect(
    ['git', 'credential', 'fill'],
    { timeoutMs: 5000, env: { GIT_TERMINAL_PROMPT: '0' }, stdin: 'protocol=https\nhost=github.com\n\n' },
  )
  if (credential.ok) {
    const password = credential.stdout.split('\n').find((line) => line.startsWith('password='))
    if (password) push('git-credential', password.slice('password='.length))
  }
  return candidates
}

/** Merge defaults ← draft ← request ← suggested into a complete PublishForm. */
export function mergeForm({ defaults = {}, draft = {}, request = {}, plugin, account = null }) {
  const suggested = plugin?.suggested || {}
  const form = {}
  const pick = (key, fallback) => {
    if (request[key] !== undefined && request[key] !== null) return request[key]
    if (draft[key] !== undefined && draft[key] !== null) return draft[key]
    if (defaults[key] !== undefined && defaults[key] !== null) return defaults[key]
    if (suggested[key] !== undefined && suggested[key] !== null) return suggested[key]
    return fallback
  }
  const asString = (value) => (typeof value === 'string' ? value.trim() : '')
  const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const asTopics = (value) => {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
    return [...new Set(
      list
        .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
        .filter((topic) => topic !== '' && topic.length <= 50),
    )].slice(0, 20)
  }

  const login = account && account.login ? account.login : ''
  /**
   * Owner precedence: what the operator typed, then what they saved, then the
   * global default, then — **only when GitHub is the sole repository hosting** —
   * GitHub's own login.
   *
   * The last step used to be unconditional. With any other hosting it is wrong:
   * `wodaimnd` on GitHub is not a valid namespace on Gitee or Codeberg, and the
   * publish fails with `POST /orgs/wodaimnd/repos → 404`. A blank owner is a
   * meaningful value here ("use each hosting's own account"), so the fallback
   * must be keyed on *which* hosting, not merely on how many.
   */
  const requestedHosts = normalizeSelection(
    (request && request.platforms) || (draft && draft.platforms) || (defaults && defaults.platforms) || ['github'],
  )
  const soleHosting = hostingsOf(requestedHosts)
  const ownerFromAccount = soleHosting.length === 1 && soleHosting[0] === 'github' ? login : ''
  /*
   * Owner precedence, with "explicitly blank" treated as a real answer.
   *
   * A blank owner means "publish under each hosting's own account" — the only
   * workable choice when GitHub/Gitee/Codeberg log in as different users. The old
   * chain used `||`, so an empty request.owner fell through to the saved draft and
   * resurrected a stale login that then went to the wrong forges as an org name.
   *
   * Only a MISSING key may fall back; a present-but-empty one is honoured.
   */
  const explicit = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'string'
  const ownerFromRequest = explicit(request, 'owner') ? asString(request.owner) : null
  const ownerFromDraft = explicit(draft, 'owner') ? asString(draft.owner) : null
  const blankOrInherited = ownerFromRequest !== null
    ? ownerFromRequest
    : ownerFromDraft !== null
      ? ownerFromDraft
      : asString(defaults.owner)
  /*
   * A blank result still lets GitHub fill itself in — but only when GitHub is the
   * sole hosting (ownerFromAccount is `''` otherwise), so a multi-forge publish
   * keeps each forge on its own login.
   */
  form.owner = blankOrInherited || ownerFromAccount || asString(suggested.owner)
  /*
   * The resolved selection must live on the form: preflight and the publish pipeline
   * both read `form.platforms`, and it was previously left undefined here, so every
   * job quietly fell back to GitHub-only no matter what the caller asked for.
   */
  form.platforms = normalizeSelection(requestedHosts)
  form.host = hostingsOf(form.platforms)[0] || ''
  form.name = sanitizeRepoName(pick('name', plugin?.name || 'dsh-plugin'))
  form.description = asString(pick('description', '')) || asString(suggested.description)
  form.descriptionZh = asString(pick('descriptionZh', '')) || asString(suggested.descriptionZh)
  form.homepage = asString(pick('homepage', ''))
  form.topics = asTopics(request.topics !== undefined ? request.topics : draft.topics !== undefined ? draft.topics : defaults.topicPreset !== undefined ? defaults.topicPreset : suggested.topics)
  form.visibility = VISIBILITY_IDS.includes(pick('visibility', 'public')) ? pick('visibility', 'public') : 'public'
  const license = asString(pick('license', 'MIT')).toUpperCase() === 'APACHE-2.0' ? 'Apache-2.0' : asString(pick('license', 'MIT'))
  form.license = LICENSE_IDS.includes(license) ? license : 'MIT'
  form.branch = BRANCH_TEST.test(asString(pick('branch', 'main'))) ? asString(pick('branch', 'main')) : 'main'
  form.tagPrefix = asString(pick('tagPrefix', 'v'))
  form.commitMessage = asString(pick('commitMessage', 'chore: publish {name} v{version}')) || 'chore: publish {name} v{version}'
  const authorName = asString(pick('authorName', '')) || (account && (account.name || account.login)) || ''
  let authorEmail = asString(pick('authorEmail', '')) || (login ? `${login}@users.noreply.github.com` : '')
  if (authorEmail !== '' && !EMAIL_TEST.test(authorEmail)) authorEmail = ''
  form.authorName = authorName
  form.authorEmail = authorEmail
  // An explicit acknowledgement, never a gate: forked plugins legitimately keep
  // the original author in the manifest, so the operator may state "this is
  // mine to publish" and the check stops nagging.
  //
  // It is remembered per plugin (it lives in the draft, keyed by plugin path), and
  // it carries the author it was given for. Editing the author afterwards
  // invalidates it, because a confirmation for one person must never vouch for
  // another.
  form.confirmForeignAuthor = asBool(pick('confirmForeignAuthor', false), false)
  // `null` means "no fingerprint recorded" and is treated as a legacy tick, while
  // an explicit empty string means "withdrawn". They are different states, so the
  // absent case must not collapse into `''`.
  const rememberedFor = request.confirmForeignAuthorFor !== undefined
    ? request.confirmForeignAuthorFor
    : draft.confirmForeignAuthorFor !== undefined ? draft.confirmForeignAuthorFor : undefined
  form.confirmForeignAuthorFor = rememberedFor === undefined || rememberedFor === null ? null : asString(rememberedFor)
  form.repoExistsStrategy = pick('repoExistsStrategy', 'reuse') === 'error' ? 'error' : 'reuse'
  form.addReadme = asBool(request.addReadme, asBool(draft.addReadme, asBool(defaults.addReadme, true))) && form.addReadme !== false
  form.readmeMode = (request.readmeMode || draft.readmeMode || 'auto') === 'regenerate' ? 'regenerate' : 'auto'
  form.addLicense = asBool(request.addLicense, asBool(draft.addLicense, asBool(defaults.addLicense, true)))
  form.addGitignore = asBool(request.addGitignore, asBool(draft.addGitignore, asBool(defaults.addGitignore, true)))
  form.updatePackageJson = asBool(request.updatePackageJson, asBool(draft.updatePackageJson, asBool(defaults.updatePackageJson, true)))
  form.createRelease = asBool(request.createRelease, asBool(draft.createRelease, asBool(defaults.createRelease, true))) && form.createRelease !== false
  form.releaseNotes = asString(pick('releaseNotes', ''))
  form.dryRun = asBool(request.dryRun, asBool(draft.dryRun, false))
  form.forceWithLease = asBool(request.forceWithLease, asBool(draft.forceWithLease, false))

  // ── platform selection + npm overrides (the "publish to all ticked
  // platforms" switch: one form, one button) ───────────────────────────────
  const selected = pick('platforms', defaults.platforms || ['github'])
  form.platforms = normalizeSelection(selected, ['github'])
  // Which repository hosting this publish targets. One hosting per job: a single
  // commit is pushed to a single remote, and mixing two hostings into one job
  // would make a partial failure ambiguous. npm rides along as a second
  // destination and is not part of this choice.
  form.host = hostingOf(form.platforms)
  form.npmAccess = asString(pick('npmAccess', defaults.npmAccess || 'public')) === 'restricted' ? 'restricted' : 'public'
  form.npmDistTag = asString(pick('npmDistTag', defaults.npmDistTag || 'latest')) || 'latest'
  form.npmOtp = asString(pick('npmOtp', ''))
  // This field belongs to the plugin being published, never to the workstation:
  // an empty value means "use package.json's name". It is deliberately NOT read
  // from the global platform config, so one plugin's override cannot rename
  // another plugin's package.
  form.publishName = asString(pick('publishName', ''))
  return form
}

/** Render the `{name}` / `{version}` / `{owner}` placeholders in a commit message. */
export function renderCommitMessage(template, { name, version, owner }) {
  return String(template || '')
    .replace(/\{name\}/g, name || '')
    .replace(/\{version\}/g, version || '')
    .replace(/\{owner\}/g, owner || '')
}

/**
 * The plugin's application service: state, settings, token management,
 * preflight and jobs. Constructed once from index.js apply().
 */
export class Publisher {
  #store
  #env
  #jobs = new Map()
  #activeJobId = null
  #sessionToken = null
  #sessionTokenSource = null
  #sessionNpmToken = null
  #gitVersionCache = null
  #ghVersionCache = null
  // `node --version` cannot change during the life of the process, so probing it
  // on every state build was pure waste.
  #nodeVersionCache = null

  /** Verified hosting identities, keyed by hosting|base|token. Never persisted. */
  #identityCache = new Map()
  static #IDENTITY_TTL_MS = 180_000

  #scanCache = null
  // A scan already running is returned to every caller instead of starting a
  // second walk: the panel polls, and two overlapping walks would double the
  // process churn for identical output.
  #scanInFlight = null
  #detectCache = null
  #getWorkspacePaths

  constructor({ store, env = process.env, getWorkspacePaths = null }) {
    this.#store = store
    this.#env = { ...process.env, ...env }
    this.#getWorkspacePaths = getWorkspacePaths
  }

  get store() {
    return this.#store
  }

  /* ── platform configuration ───────────────────────────────────────────── */

  /** Token-free platform config for the UI, plus the registry metadata. */
  async platformState() {
    const config = await this.#store.loadConfig()
    const platforms = config.platforms
    const npmTokenAvailable = Boolean(this.#npmToken(platforms))
    const views = PLATFORMS.map((meta) => {
      const view = publicPlatformConfig(meta.id, platforms) || { id: meta.id, enabled: false }
      if (meta.id === 'npm') {
        view.tokenAvailable =
          (typeof platforms.npm.token === 'string' && platforms.npm.token !== '') || npmTokenAvailable
        // A token picked up from the environment is never persisted; say so.
        view.tokenSource =
          typeof platforms.npm.token === 'string' && platforms.npm.token !== ''
            ? 'config'
            : npmTokenAvailable
              ? this.#npmTokenSource()
              : null
      }
      return {
        id: meta.id,
        label: meta.label,
        short: meta.short,
        kind: meta.kind,
        order: meta.order,
        description: meta.description,
        // Whether this hosting has a topics feature at all. The panel shows the
        // topics step as "unsupported" rather than letting the publish fail.
        topicsSupported: meta.topicsSupported !== false,
        fields: meta.fields,
        config: view,
      }
    })
    return { platforms: views, enabled: platforms.enabled }
  }

  /**
   * Patch one platform's config (or several at once). The shared token rules:
   * a plain string sets it, `null` clears it, and an absent key leaves it alone.
   */
  async updatePlatforms(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    // Validate every URL-ish field BEFORE touching the store: a rejected
    // registry/apiBase must not leave a half-written config behind.
    const validated = {}
    for (const meta of PLATFORMS) {
      const incoming = source[meta.id]
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue
      const copy = { ...incoming }
      for (const field of meta.fields) {
        if (field.type !== 'url') continue
        if (!Object.prototype.hasOwnProperty.call(copy, field.key)) continue
        const value = copy[field.key]
        if (value === null || value === '') continue
        if (typeof value !== 'string') {
          throw new PublisherError('bad-request', `${field.key} 必须是字符串`)
        }
        try {
          copy[field.key] = normalizeBaseUrlFor(value, field.key)
        } catch (error) {
          throw new PublisherError('bad-request', error.message)
        }
      }
      validated[meta.id] = copy
    }
    let saved = null
    await this.#store.updateConfig((current) => {
      const next = { ...current, platforms: { ...current.platforms } }
      for (const meta of PLATFORMS) {
        const incoming = validated[meta.id]
        if (!incoming) continue
        const existing = { ...(current.platforms[meta.id] || {}) }
        for (const field of meta.fields) {
          const key = field.key
          if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue
          const value = incoming[key]
          if (field.type === 'bool') existing[key] = value === true
          else if (value === null) delete existing[key]
          else if (typeof value === 'string') {
            const text = value.trim()
            if (text === '') delete existing[key]
            else existing[key] = text
          }
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'enabled')) {
          existing.enabled = incoming.enabled === true
        } else if (existing.enabled === undefined) {
          existing.enabled = current.platforms[meta.id] ? current.platforms[meta.id].enabled === true : false
        }
        next.platforms[meta.id] = existing
      }
      saved = next
      return next
    })
    if (saved && typeof source.enabled !== 'undefined') {
      const selection = normalizeSelection(source.enabled, saved.platforms.enabled)
      await this.#store.updateConfig((current) => ({
        ...current,
        platforms: { ...current.platforms, enabled: selection },
      }))
    }
    return this.platformState()
  }

  /** Save and verify one platform's token, then cache the identity. */
  async verifyPlatform(platformId) {
    const id = typeof platformId === 'string' ? platformId.trim() : ''
    if (id === 'npm') {
      const config = await this.#store.loadConfig()
      const npmConfig = { ...config.platforms.npm, token: this.#npmToken(config.platforms) }
      const result = await npmVerify(npmConfig)
      await this.#store.updateConfig((current) => ({
        ...current,
        platforms: {
          ...current.platforms,
          npm: { ...current.platforms.npm, account: result.account, validatedAt: Date.now() },
        },
      }))
      return { platform: id, ...result }
    }
    if (id === 'github') {
      const account = await this.resolveAccount({ validate: true, detect: true })
      return { platform: id, ok: account.connected === true, account, hint: account.tokenHint, warnings: [] }
    }
    throw new PublisherError('bad-request', `未知平台：${id}`, { details: { platforms: PLATFORMS.map((meta) => meta.id) } })
  }

  /* ── npm credentials ─────────────────────────────────────────────────── */

  /** Short-lived npm identity cache: { key, at, value }. Keyed by registry+token. */
  #npmVerifyCache = null
  static #NPM_VERIFY_TTL_MS = 60_000

  /** Verify an npm token, reusing a recent answer for the same registry+token. */
  async #npmVerifyCached(config) {
    const key = String(config.registry || DEFAULT_NPM_CONFIG.registry) + '|' + String(config.token || '')
    const hit = this.#npmVerifyCache
    if (hit && hit.key === key && Date.now() - hit.at < Publisher.#NPM_VERIFY_TTL_MS) return hit.value
    const value = await npmVerify(config)
    this.#npmVerifyCache = { key, at: Date.now(), value }
    return value
  }

  /** Drop the npm cache after a credential change, so the next check is real. */
  #invalidateNpmVerify() {
    this.#npmVerifyCache = null
  }

  #npmTokenSource() {
    if (this.#sessionNpmToken) return 'memory'
    if (typeof this.#env.NPM_TOKEN === 'string' && this.#env.NPM_TOKEN.trim() !== '') return 'env'
    return null
  }

  #npmToken(platforms) {
    if (this.#sessionNpmToken) return this.#sessionNpmToken
    const saved = platforms && platforms.npm && typeof platforms.npm.token === 'string' ? platforms.npm.token.trim() : ''
    if (saved !== '') return saved
    const envToken = typeof this.#env.NPM_TOKEN === 'string' ? this.#env.NPM_TOKEN.trim() : ''
    return envToken !== '' ? envToken : ''
  }

  async saveNpmToken(token) {
    // A fresh credential must not be judged by the previous one's cached answer.
    this.#invalidateNpmVerify()
    const value = typeof token === 'string' ? token.trim() : ''
    if (value === '') throw new PublisherError('bad-request', 'npm token 不能为空')
    // The panel's "copy the .npmrc key" affordance used to paste the *key*
    // (`//host/:_authToken=`) instead of the value. Catch that before it
    // reaches the registry and say what to do instead.
    if (looksLikeNpmrcKey(value)) {
      throw new PublisherError(
        'npm-token-is-key',
        '这看起来是 .npmrc 的键名（//host/:_authToken=），不是 token 本身。点「从 .npmrc 自动读取」让插件自己取那个值',
        { status: 400 },
      )
    }
    const config = await this.#store.loadConfig()
    const probe = await npmVerify({ ...config.platforms.npm, token: value })
    await this.#store.updateConfig((current) => ({
      ...current,
      platforms: { ...current.platforms, npm: { ...current.platforms.npm, token: value } },
    }))
    this.#sessionNpmToken = value
    return probe
  }

  /**
   * Find the npm token the user already has on disk for the configured registry.
   *
   * `npm login` writes `//host/:_authToken=…` into an `.npmrc`; asking a human
   * to copy that across is how the key prefix ends up pasted as the token.
   * This reads it directly. Read-only: nothing is saved until `saveNpmToken`.
   */
  async detectNpmrcToken() {
    const config = await this.#store.loadConfig()
    const registry = config.platforms?.npm?.registry || DEFAULT_NPM_CONFIG.registry
    const found = await readNpmrcToken(registry, this.#env)
    if (found === null) {
      return {
        ok: false,
        registry,
        found: false,
        searched: npmrcCandidates(this.#env),
        error: `没有在 .npmrc 里找到 ${registry} 的 token：先执行 npm login --registry=${registry}`,
      }
    }
    // Verify before claiming success, so a stale entry is reported as stale.
    let account = null
    let warnings = []
    try {
      account = (await npmVerify({ ...config.platforms.npm, registry, token: found.token })).account
    } catch (error) {
      warnings.push(`读到了 token（${hintOf(found.token)}），但验证失败：${error.message}`)
    }
    return {
      ok: true,
      registry,
      found: true,
      token: found.token,
      hint: hintOf(found.token),
      source: found.source,
      account,
      warnings,
    }
  }

  /** Read a token from .npmrc, verify it, then persist it. */
  async adoptNpmrcToken() {
    const detected = await this.detectNpmrcToken()
    if (detected.found !== true) {
      throw new PublisherError('npm-no-npmrc', detected.error || '没有在 .npmrc 里找到 token', { status: 400 })
    }
    const probe = await this.saveNpmToken(detected.token)
    return { ...detected, account: probe.account, saved: true }
  }

  async clearNpmToken() {
    this.#sessionNpmToken = null
    await this.#store.updateConfig((current) => {
      const npm = { ...current.platforms.npm }
      delete npm.token
      delete npm.account
      return { ...current, platforms: { ...current.platforms, npm } }
    })
    return { ok: true, account: null, hint: null, warnings: [] }
  }

  /* ── tokens & account ─────────────────────────────────────────────────── */

  /** Resolve the token in priority order: session → saved → env. */
  async resolveToken({ detect = true } = {}) {
    if (this.#sessionToken) {
      return { token: this.#sessionToken, source: this.#sessionTokenSource || 'memory', persisted: this.#sessionTokenSource === 'config' }
    }
    const config = await this.#store.loadConfig()
    if (config.token) return { token: config.token, source: 'config', persisted: true }
    const envToken = this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN
    if (typeof envToken === 'string' && envToken.trim() !== '') return { token: envToken.trim(), source: 'env', persisted: false }
    if (!detect) return null
    if (this.#detectCache && Date.now() - this.#detectCache.at < 30_000) {
      if (!this.#detectCache.value) return null
      this.#sessionToken = this.#detectCache.value.token
      this.#sessionTokenSource = this.#detectCache.value.source
      return this.#detectCache.value
    }
    const candidates = await detectTokenCandidates(this.#env)
    if (candidates.length === 0) {
      this.#detectCache = { at: Date.now(), value: null }
      return null
    }
    const [first] = candidates
    const value = { token: first.token, source: first.source, persisted: false }
    this.#detectCache = { at: Date.now(), value }
    this.#sessionToken = first.token
    this.#sessionTokenSource = first.source
    return value
  }

  /**
   * The credential for one hosting.
   *
   * GitHub keeps its original resolution chain (config → env → detected helper),
   * because that is how it always worked and existing installs depend on it.
   * Gitee and Codeberg only have an explicitly configured token — there is no
   * `gh auth token` equivalent, and guessing would be worse than saying so.
   */
  async #resolveHostingToken(hostId, config) {
    if (hostId === 'github') {
      const tokenInfo = await this.resolveToken({ detect: config.autoDetectToken !== false })
      return tokenInfo ? { token: tokenInfo.token, source: tokenInfo.source } : null
    }
    const cfg = config.platforms && config.platforms[hostId] ? config.platforms[hostId] : {}
    if (typeof cfg.token === 'string' && cfg.token.trim() !== '') return { token: cfg.token.trim(), source: 'config' }
    return null
  }

  /** Who this token belongs to, asked of the hosting itself. */
  async validateHostingIdentity(hostId, tokenInfo, apiBase) {
    if (hostId === 'github') return this.validateToken(tokenInfo, { apiBase })
    const client = this.#client(tokenInfo.token, apiBase, hostId)
    const user = await client.getAuthenticatedUser()
    return {
      connected: true,
      validated: true,
      login: user.login || '',
      name: user.name || '',
      avatarUrl: user.avatarUrl || '',
      htmlUrl: user.htmlUrl || '',
      scopes: [],
      isFineGrained: false,
      tokenSource: tokenInfo.source,
      persisted: tokenInfo.source === 'config',
      provider: hostId,
    }
  }

  /**
   * Build a client for one hosting. `provider` defaults to GitHub so every
   * existing call site keeps its behaviour; the multi-host publish path passes
   * the id it is currently working on.
   */
  #client(token, apiBase, provider = 'github') {
    const descriptor = providerOf(provider);
    return new GitHubClient({
      // A custom base (Enterprise, self-hosted Forgejo) wins; otherwise the
      // provider's own default is used rather than GitHub's.
      apiBase: apiBase || (descriptor ? descriptor.apiBase : 'https://api.github.com'),
      token,
      provider,
      userAgent: `dsh-github-publisher/${VERSION}`,
    })
  }

  /**
   * Create a repository on one hosting, or reuse the existing one.
   *
   * Extracted from the pipeline so the multi-host loop can call it per remote
   * without duplicating the org precheck, the update-on-reuse path, and the
   * provider-specific URL handling. Throws on failure; the caller decides
   * whether that fails the step (it does not when another hosting succeeded).
   *
   * @returns {Promise<{repoUrl: string, created: boolean, detail: string}>}
   */
  async #ensureRepo({ job, hostId, ctx, form, plugin, log }) {
    const meta = providerOf(hostId) || providerOf('github')
    const client = this.#client(ctx.token, ctx.apiBase, hostId)
    const repoUrlFor = (owner, repo) => repoWebUrlFor(hostId, owner, repo, ctx.webBase)
    /**
     * Which namespace owns the repository on *this* hosting.
     *
     * The three hostings have different accounts (`wodaimnd` on GitHub,
     * `ward-day` on Gitee, `InfiniteOFone` on Codeberg), so a single form `owner`
     * cannot serve all of them. An explicit owner is honoured verbatim (that is
     * how an organisation is targeted); when it is blank, each hosting publishes
     * under the account its own token belongs to.
     */
    const owner = String(form.owner || '').trim() || ctx.login || ''
    if (owner === '') {
      throw new PublisherError('owner-missing', `${meta.label} 需要一个 owner：请填写账号/组织名，或先配置该平台的令牌`)
    }

    const existing = await client.getRepo(owner, form.name)
    if (existing) {
      if (form.repoExistsStrategy === 'error') {
        throw new PublisherError('repo-exists', `仓库 ${owner}/${form.name} 在 ${meta.label} 上已存在`)
      }
      const patch = {}
      if (form.description && existing.description !== form.description) patch.description = form.description
      if (form.homepage && existing.homepage !== form.homepage) patch.homepage = form.homepage
      if (Object.keys(patch).length > 0) {
        await client.updateRepo(owner, form.name, patch)
        log('info', `${meta.label} 已更新仓库信息：${Object.keys(patch).join('、')}`)
      }
      const url = existing.htmlUrl || repoUrlFor(owner, form.name)
      log('info', `${meta.label} 复用已有仓库 ${url}`)
      return { repoUrl: url, created: false, detail: `复用 ${url}`, owner }
    }

    // A wrong owner (a display name instead of the login) otherwise surfaces as an
    // opaque 404 from the create call. GitHub answers /orgs for real orgs;
    // Gitee and Forgejo may not implement it for a personal namespace, so a miss
    // there is a warning rather than a hard failure.
    const isSelf = Boolean(ctx.login && owner.toLowerCase() === ctx.login.toLowerCase())
    if (!isSelf) {
      if (hostId === 'gitee' || hostId === 'codeberg') {
        try {
          await client.getOrg(owner)
        } catch (error) {
          if ((error.code || '') !== 'not-found') log('warn', `${meta.label} 无法预检组织 ${owner}：${error.message}`)
          else log('info', `${meta.label} 未提供组织信息，交由建仓调用判定`)
        }
      } else {
        let org = null
        try {
          org = await client.getOrg(owner)
        } catch (error) {
          throw new PublisherError(error.code || 'github-network', error.message, { details: error.details || null })
        }
        if (!org) {
          throw new PublisherError(
            'owner-not-found',
            `${meta.label} 上找不到名为 “${owner}” 的账号或组织。当前登录的是 @${ctx.login || '未知'}；发布到个人账号请把 Owner 改成 ${ctx.login || '你的登录名'}，发布到组织请填组织登录名。`,
            { details: { owner, login: ctx.login || null } },
          )
        }
      }
    }

    const created = await client.createRepo({
      owner: isSelf ? null : owner,
      name: form.name,
      description: form.description,
      homepage: form.homepage,
      private: form.visibility === 'private',
      branch: form.branch,
    })
    const url = created.htmlUrl || repoUrlFor(owner, form.name)
    log('success', `${meta.label} 已创建仓库 ${url}`)
    return { repoUrl: url, created: true, detail: `新建 ${url}`, owner }
  }


  /**
   * Cached identity probe for a hosting.
   *
   * Preflight runs this per selected platform on every form edit; without a cache
   * that is three network round trips per keystroke batch (measured ~1s for
   * GitHub+Gitee+Codeberg). Keyed by hosting + token + base so a changed token or a
   * switched endpoint never reads a stale answer.
   */
  async #identityCached(hostId, token, apiBase) {
    const key = hostId + '|' + apiBase + '|' + token
    const now = Date.now()
    const hit = this.#identityCache.get(key)
    if (hit && now - hit.at < Publisher.#IDENTITY_TTL_MS) return hit.value
    const value = await this.validateHostingIdentity(hostId, { token, source: 'config' }, apiBase)
    // Bounded: only the handful of configured hostings are ever probed.
    if (this.#identityCache.size > 8) this.#identityCache.clear()
    this.#identityCache.set(key, { at: now, value })
    return value
  }

  /** Validate one token and cache the identity (never the token) in config. */
  async validateToken(tokenInfo, { apiBase = null } = {}) {
    const config = await this.#store.loadConfig()
    const base = apiBase || config.defaults.apiBase || 'https://api.github.com'
    const client = this.#client(tokenInfo.token, base)
    let user
    try {
      user = await client.getAuthenticatedUser()
    } catch (error) {
      if (error instanceof GitHubError) throw new PublisherError(error.code, error.message, { status: error.status === 401 ? 401 : 400, details: error.details })
      throw error
    }
    const fingerprint = fingerprintOf(tokenInfo.token)
    const cached = {
      login: user.login,
      id: user.id ?? null,
      name: user.name || '',
      avatarUrl: user.avatarUrl || '',
      htmlUrl: user.htmlUrl || '',
      scopes: user.scopes || [],
      isFineGrained: user.isFineGrained === true,
      fingerprint,
      apiBase: base,
      validatedAt: Date.now(),
    }
    await this.#store.updateConfig(() => ({ account: cached }))
    return this.#accountOf(tokenInfo, cached)
  }

  #accountOf(tokenInfo, cached) {
    const persisted = tokenInfo.persisted === true
    return {
      connected: true,
      validated: Boolean(cached && cached.validatedAt),
      login: cached?.login || '',
      name: cached?.name || '',
      avatarUrl: cached?.avatarUrl || '',
      htmlUrl: cached?.htmlUrl || '',
      tokenSource: tokenInfo.source || 'memory',
      persisted,
      tokenHint: tokenHint(tokenInfo.token),
      scopes: cached?.scopes || [],
      isFineGrained: cached?.isFineGrained === true,
      validatedAt: cached?.validatedAt || 0,
      apiBase: cached?.apiBase || null,
    }
  }

  /** Cached-or-validated account view. Never throws for a missing token. */
  async resolveAccount({ validate = false, detect = false } = {}) {
    const config = await this.#store.loadConfig()
    let tokenInfo = null
    try {
      tokenInfo = await this.resolveToken({ detect: detect && config.autoDetectToken !== false })
    } catch {
      tokenInfo = null
    }
    if (!tokenInfo) return this.#emptyAccount()
    const fingerprint = fingerprintOf(tokenInfo.token)
    const cached = config.account && config.account.fingerprint === fingerprint
      && (!config.account.apiBase || config.account.apiBase === (config.defaults.apiBase || 'https://api.github.com'))
      ? config.account
      : null
    if (!validate) {
      if (cached) return this.#accountOf(tokenInfo, cached)
      return { ...this.#accountOf(tokenInfo, null), validated: false }
    }
    try {
      return await this.validateToken(tokenInfo)
    } catch (error) {
      if (error instanceof PublisherError && error.status === 401) {
        return { ...this.#emptyAccount(), connected: false, tokenSource: tokenInfo.source, tokenHint: tokenHint(tokenInfo.token), error: { code: error.code, message: error.message } }
      }
      // Network failure: we still know a token exists, we just cannot verify it now.
      return { ...this.#accountOf(tokenInfo, cached), validated: false, error: { code: error.code || 'github-network', message: error.message } }
    }
  }

  #emptyAccount() {
    return {
      connected: false,
      validated: false,
      login: '',
      name: '',
      avatarUrl: '',
      htmlUrl: '',
      tokenSource: null,
      persisted: false,
      tokenHint: null,
      scopes: [],
      isFineGrained: false,
      validatedAt: 0,
      apiBase: null,
    }
  }

  /** Save a user-pasted PAT after validating it. */
  async saveToken(token) {
    const value = typeof token === 'string' ? token.trim() : ''
    if (value === '') throw new PublisherError('bad-request', 'token 不能为空')
    const tokenInfo = { token: value, source: 'config', persisted: true }
    const account = await this.validateToken(tokenInfo)
    await this.#store.updateConfig(() => ({ token: value }))
    this.#sessionToken = value
    this.#sessionTokenSource = 'config'
    return account
  }

  /** Clear the saved token (file + memory). */
  async clearToken() {
    this.#sessionToken = null
    this.#sessionTokenSource = null
    await this.#store.updateConfig(() => ({ token: null, account: null }))
    return this.#emptyAccount()
  }

  /** Explicit auto-detection (env → gh CLI → git credential helper). */
  async detectToken({ persist = false } = {}) {
    const candidates = await detectTokenCandidates(this.#env)
    if (candidates.length === 0) {
      throw new PublisherError('not-found', '没有在环境变量、gh CLI 或 git 凭证中找到 GitHub token')
    }
    let lastError = null
    for (const candidate of candidates) {
      try {
        const account = await this.validateToken(candidate)
        this.#sessionToken = candidate.token
        this.#sessionTokenSource = candidate.source
        if (persist) await this.#store.updateConfig(() => ({ token: candidate.token }))
        return account
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new PublisherError('invalid-token', '自动检测到的 token 无效')
  }

  /* ── settings / state ─────────────────────────────────────────────────── */

  async updateSettings(patch = {}) {
    const config = await this.#store.loadConfig()
    const next = {}
    if (patch.defaults && typeof patch.defaults === 'object') {
      const defaults = { ...config.defaults }
      for (const [key, value] of Object.entries(patch.defaults)) {
        if (!(key in config.defaults)) continue
        if (key === 'apiBase' || key === 'gitBase') {
          defaults[key] = normalizeBaseUrl(value, key)
        } else if (key === 'topicPreset') {
          defaults.topicPreset = (Array.isArray(value) ? value : [])
            .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
            .filter(Boolean)
            .slice(0, 10)
        } else if (typeof config.defaults[key] === 'boolean') {
          defaults[key] = value === true
        } else if (typeof config.defaults[key] === 'string') {
          defaults[key] = String(value)
        }
      }
      next.defaults = defaults
    }
    if (Array.isArray(patch.scanRoots)) {
      const roots = []
      for (const entry of patch.scanRoots) {
        if (typeof entry !== 'string' || entry.trim() === '') continue
        const resolved = path.resolve(entry.trim())
        const stat = await fsp.stat(resolved).catch(() => null)
        if (!stat || !stat.isDirectory()) throw new PublisherError('bad-request', `扫描目录不存在：${resolved}`)
        if (!roots.includes(resolved)) roots.push(resolved)
      }
      next.scanRoots = roots.slice(0, 30)
    }
    if (typeof patch.autoDetectToken === 'boolean') next.autoDetectToken = patch.autoDetectToken
    if (Array.isArray(patch.platforms)) next.defaults = { ...(next.defaults || config.defaults), platforms: normalizeSelection(patch.platforms) }
    const saved = await this.#store.saveConfig(next)
    return saved
  }

  /** Filled, masked account + platforms + capabilities + plugins + history. */
  async buildState({ scan = true } = {}) {
    const config = await this.#store.loadConfig()
    const account = await this.resolveAccount({ validate: false, detect: false })
    if (this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN) {
      if (!account.connected) {
        const envToken = (this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN).trim()
        account.connected = true
        account.tokenSource = 'env'
        account.persisted = false
        account.tokenHint = tokenHint(envToken)
      }
    }
    const capabilities = await this.#capabilities()
    const history = await this.#store.loadHistory()
    const drafts = await this.#store.loadDrafts()
    let scanned = { plugins: [], roots: [], warnings: [], scannedAt: 0 }
    if (scan) {
      try {
        // Serve the previous result first so the panel paints immediately, then
        // refresh in the background. The first ever load has no cache and pays
        // the walk once; every load after a restart is instant.
        scanned = await this.scan({ allowCache: true })
        if (scanned.cached === true) {
          scanned.stale = true
          void this.scan({ force: true }).catch(() => {})
        }
      } catch (error) {
        scanned.warnings = [`扫描失败：${error.message}`]
      }
    }
    const plugins = applyPublished(scanned.plugins, history)
    const platformState = await this.platformState()
    return {
      version: VERSION,
      platform: process.platform,
      dataDir: this.#store.dataDir,
      settings: { defaults: config.defaults, scanRoots: config.scanRoots, autoDetectToken: config.autoDetectToken },
      account,
      platforms: platformState.platforms,
      platformSelection: platformState.enabled,
      plugins,
      drafts,
      history,
      job: this.getJob(this.#activeJobId) || this.getJob(),
      capabilities,
      scanInfo: { roots: scanned.roots, warnings: scanned.warnings, scannedAt: scanned.scannedAt },
      serverTime: Date.now(),
    }
  }

  async #capabilities() {
    // Three independent probes, run together instead of one after another. They
    // are subprocess spawns (~80 ms each on Windows), so overlapping turns 240 ms
    // of startup latency into one.
    //
    // `git` and `gh` are cached per instance; `node --version` was re-spawned on
    // every call even though the answer cannot change during a process's life,
    // so it is cached too.
    const gitProbe = this.#gitVersionCache !== null
      ? Promise.resolve(this.#gitVersionCache)
      : git.gitVersion()
    const ghProbe = this.#ghVersionCache !== null
      ? Promise.resolve(this.#ghVersionCache)
      : runCollect(['gh', '--version'], { timeoutMs: 2500 }).then((gh) => (gh.ok ? firstLine(gh.stdout) : false))
    const nodeProbe = this.#nodeVersionCache !== null
      ? Promise.resolve(this.#nodeVersionCache)
      : runCollect(['node', '--version'], { timeoutMs: 2500 }).then((result) => (result.ok ? firstLine(result.stdout) : false))

    const [gitVersion, ghVersion, nodeVersion] = await Promise.all([gitProbe, ghProbe, nodeProbe])
    this.#gitVersionCache = gitVersion
    this.#ghVersionCache = ghVersion
    this.#nodeVersionCache = nodeVersion
    return {
      git: this.#gitVersionCache !== null,
      gitVersion: this.#gitVersionCache,
      ghCli: this.#ghVersionCache !== false,
      ghVersion: this.#ghVersionCache === false ? null : this.#ghVersionCache,
      envToken: Boolean(this.#env.GITHUB_TOKEN || this.#env.GH_TOKEN),
      envNpmToken: Boolean(this.#env.NPM_TOKEN),
      npmCli: NPM_CLI_AVAILABLE,
      node: this.#nodeVersionCache === false ? null : this.#nodeVersionCache,
      // HTTPS pushes go through a throwaway GIT_ASKPASS helper on every
      // platform; lib/git.mjs emits a `.cmd` shim on Windows so the same
      // credential hand-off works there too.
      askpassSupported: true,
      platform: process.platform,
    }
  }

  /** Scan every known root; cached for a short interval to keep state cheap. */
  /**
   * Last scan result, persisted so a page load after a restart is instant.
   *
   * The in-memory cache below lives three seconds; a DSH restart or a reload
   * after a coffee break used to pay the full walk again.
   *
   * Kept per root-list fingerprint rather than as a single slot: the same machine
   * legitimately scans different root sets (a different profile, a different
   * working directory), and letting one evict the other would mean both keep
   * paying the cold price. Entries are capped so the file cannot grow forever.
   */
  static #SCAN_CACHE_MAX_ENTRIES = 4

  async #readScanCache() {
    try {
      const raw = await fsp.readFile(path.join(this.#store.dataDir, 'scan-cache.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      // Shape v2: `entries` keyed by root fingerprint. v1 was a single slot and
      // is simply ignored (it will be rewritten on the next scan).
      return parsed.version === 2 && parsed.entries && typeof parsed.entries === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  #scanCacheKey(rootPaths) {
    // Short, stable, collision-unlikely: the root list itself is stored alongside
    // the entry, so the key only has to be unique enough to bucket on.
    const text = rootPaths.join('\n')
    let hash = 0
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % 0xffffffff
    }
    return `${rootPaths.length}-${hash.toString(36)}`
  }

  async #writeScanCache(value, rootPaths) {
    try {
      const key = this.#scanCacheKey(rootPaths)
      const before = await this.#readScanCache()
      const entries = Object.assign({}, before ? before.entries : {})
      entries[key] = {
        scannedAt: value.scannedAt || Date.now(),
        rootPaths,
        plugins: value.plugins,
        roots: value.roots,
        warnings: value.warnings,
      }
      // Newest keeps its slot; older ones are evicted rather than accumulated.
      const keys = Object.keys(entries)
      if (keys.length > Publisher.#SCAN_CACHE_MAX_ENTRIES) {
        keys
          .sort((a, b) => (entries[b].scannedAt || 0) - (entries[a].scannedAt || 0))
          .slice(Publisher.#SCAN_CACHE_MAX_ENTRIES)
          .forEach((stale) => { delete entries[stale] })
      }
      await fsp.mkdir(this.#store.dataDir, { recursive: true })
      await fsp.writeFile(
        path.join(this.#store.dataDir, 'scan-cache.json'),
        JSON.stringify({ version: 2, entries }),
        'utf8',
      )
    } catch {
      /* a cache that cannot be written simply is not used */
    }
  }

  /** Cache hit only if the root list is unchanged, so plugin adds/removals still rescan. */
  #scanCacheMatches(cached, rootPaths) {
    if (!cached || !Array.isArray(cached.rootPaths)) return false
    return cached.rootPaths.join('\n') === rootPaths.join('\n')
  }

  async scan({ roots = null, maxAgeMs = 3000, allowCache = false, force = false } = {}) {
    if (!force && !roots && this.#scanCache && Date.now() - this.#scanCache.at < maxAgeMs) return this.#scanCache.value
    if (!force && !roots && this.#scanInFlight) return this.#scanInFlight
    const run = this.#performScan({ roots, allowCache: allowCache && !force })
    if (!roots && !force) {
      this.#scanInFlight = run.finally(() => { this.#scanInFlight = null })
      return this.#scanInFlight
    }
    return run
  }

  /** The actual walk; `scan` adds the cache and de-duplication around it. */
  async #performScan({ roots = null, allowCache = false } = {}) {
    const config = await this.#store.loadConfig()
    const workspacePaths = typeof this.#getWorkspacePaths === 'function' ? this.#getWorkspacePaths() : []
    const discovered = await discoverRootsFor({ settings: config, env: this.#env, workspacePaths, roots })
    const rootPaths = discovered.map((root) => root.path)

    if (!roots && allowCache) {
      const cacheFile = await this.#readScanCache()
      const entry = cacheFile ? cacheFile.entries[this.#scanCacheKey(rootPaths)] : null
      if (entry && this.#scanCacheMatches(entry, rootPaths)) {
        const value = {
          plugins: Array.isArray(entry.plugins) ? entry.plugins : [],
          roots: Array.isArray(entry.roots) ? entry.roots : [],
          warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
          scannedAt: entry.scannedAt || 0,
          cached: true,
        }
        this.#scanCache = { at: Date.now(), value }
        return value
      }
    }

    const result = await scanWithRoots(discovered)
    const value = {
      plugins: result.plugins,
      roots: result.roots,
      warnings: result.warnings,
      scannedAt: result.scannedAt,
    }
    if (!roots) {
      this.#scanCache = { at: Date.now(), value }
      await this.#writeScanCache(value, rootPaths)
    }
    return value
  }

  /** Scan + history merge (+ optional remote repo status) for the scan API. */
  async scanResponse({ roots = null, checkRemote = false } = {}) {
    const result = await this.scan({ roots, maxAgeMs: 0 })
    const history = await this.#store.loadHistory()
    let plugins = applyPublished(result.plugins, history)
    const warnings = [...result.warnings]
    if (checkRemote) {
      const remote = await this.#checkRemoteStatuses(plugins)
      plugins = remote.plugins
      warnings.push(...remote.warnings)
    }
    return { plugins, roots: result.roots, warnings, scannedAt: result.scannedAt }
  }

  async #checkRemoteStatuses(plugins) {
    const config = await this.#store.loadConfig()
    const tokenInfo = await this.resolveToken({ detect: false })
    if (!tokenInfo) return { plugins, warnings: ['未连接 GitHub 账号，跳过远端仓库检查'] }
    const client = this.#client(tokenInfo.token, trimBase(config.defaults.apiBase))
    const targets = plugins.filter((plugin) => plugin.remote && plugin.remote.isGitHub)
    const warnings = []
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor]
        cursor += 1
        try {
          const repo = await client.getRepo(target.remote.owner, target.remote.repo)
          target.remoteStatus = repo
            ? { exists: true, htmlUrl: repo.htmlUrl, stars: repo.stars, latestVersion: repo.version || null, private: repo.private === true }
            : { exists: false }
        } catch (error) {
          target.remoteStatus = { exists: null, error: error.message }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
    return { plugins, warnings }
  }

  /* ── preflight ────────────────────────────────────────────────────────── */

  async preflight({ path: pluginPath, form: requestForm = {} } = {}) {
    const config = await this.#store.loadConfig()
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') {
      throw new PublisherError('bad-request', '缺少插件目录 path')
    }
    const resolved = path.resolve(pluginPath.trim())
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new PublisherError('not-found', `插件目录不存在：${resolved}`, { status: 404 })
    const plugin = await inspectPlugin(resolved)
    if (!plugin.isPlugin) {
      throw new PublisherError('not-a-plugin', `不是 DSH 插件目录（package.json 缺少 dsh.bundle / dsh.client）：${resolved}`, { details: { errors: plugin.errors } })
    }
    plugin.manifestText = await readManifestText(resolved)

    const tokenInfo = await this.resolveToken({ detect: config.autoDetectToken !== false })

    /*
     * Kick off every network probe that does not depend on another probe's result.
     * They run concurrently; each site below awaits its own promise. A rejected
     * probe is still caught at its original try/catch — nothing here swallows it.
     */
    const npmConfigEarly = config.platforms?.npm || {}
    const npmTokenEarly = this.#npmToken(config.platforms)
    const npmVerifyPromise = npmTokenEarly
      ? this.#npmVerifyCached({ ...npmConfigEarly, token: npmTokenEarly }).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        )
      : null
    const gitProbePromise = this.#gitVersionCache === null
      ? git.gitVersion().then((v) => v, () => null)
      : Promise.resolve(this.#gitVersionCache)

    let account = null
    let authError = null
    /** Started as soon as the login is known; awaited where its checks are emitted. */
    let repoProbePromise = null
    if (tokenInfo) {
      try {
        account = await this.validateToken(tokenInfo)
      } catch (error) {
        authError = error
        account = {
          ...this.#emptyAccount(),
          connected: true,
          tokenSource: tokenInfo.source,
          tokenHint: tokenHint(tokenInfo.token),
          // A network hiccup must not erase who is connected. The cached identity
          // was validated against the same token fingerprint, and losing it here
          // would make every plugin look like somebody else's.
          ...(config.account && config.account.login
            ? {
                login: config.account.login,
                name: config.account.name || '',
                avatarUrl: config.account.avatarUrl || '',
                htmlUrl: config.account.htmlUrl || '',
                validated: true,
                cachedIdentity: true,
              }
            : {}),
        }
      }
    }
    const drafts = await this.#store.loadDrafts()
    const form = mergeForm({
      defaults: config.defaults,
      draft: drafts[resolved] || {},
      request: requestForm && typeof requestForm === 'object' ? requestForm : {},
      plugin,
      account,
    })
    /**
     * Fill the owner box from GitHub's account **only when GitHub is the sole
     * hosting**.
     *
     * An explicit owner is honoured everywhere (that is how an organisation is
     * targeted). A blank owner means "use each hosting's own account": GitHub has
     * a resolver that can fill this in, Gitee and Codeberg do not, so filling the
     * box with GitHub's login would point their pushes at a user that does not
     * exist there — verified: `POST /orgs/ward-day/repos` → 404 on Codeberg.
     */
    const selectedHosts = hostingsOf(form.platforms)
    if (!form.owner && account?.login && selectedHosts.length === 1 && selectedHosts[0] === 'github') {
      form.owner = account.login
    }
    const checks = []
    const warnings = []
    /**
     * Kick the repo probe off now that `account.login` is known, instead of after
     * the npm checks have finished awaiting the registry. The section that emits
     * its result awaits `repoProbePromise` and otherwise behaves exactly as before.
     */
    if (account && account.login && tokenInfo && !authError) {
      const parkedChecks = []
      const parkedWarnings = []
      repoProbePromise = this.#checkRepo({
        account,
        form: { ...form },
        tokenInfo,
        checks: parkedChecks,
        warnings: parkedWarnings,
        apiBase: trimBase(form.apiBase || config.defaults.apiBase),
      }).then(
        (value) => ({ ok: true, value, parkedChecks, parkedWarnings }),
        (error) => ({ ok: false, error, parkedChecks, parkedWarnings }),
      )
    }

    const selected = form.platforms
    // Any repository hosting runs the git pipeline; Gitee and Codeberg were
    // invisible to preflight while this was keyed on `github` alone.
    const hostId = hostingOf(selected)
    const wantHosting = hasHosting(selected)
    const wantGithub = hostId === 'github'
    const wantNpm = selected.includes('npm')
    const hostMeta = providerOf(hostId)
    // A dry run needs no account: fall back to a clearly local label so the
    // "owner" field is never a hard blocker for a rehearsal.
    if (form.dryRun && !form.owner) {
      form.owner = 'local-preview'
      warnings.push(`演练模式：未连接 ${hostMeta ? hostMeta.label : '仓库'} 账号，目标仓库将显示为 local-preview（不会创建远端仓库）`)
    }

    checks.push({ id: 'manifest', status: 'pass', title: '插件清单可用', detail: `${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}` })

    // A plugin repeats its version in several declarations. Publishing while
    // they disagree ships a self-contradicting package, so this is surfaced
    // before the button becomes available — a warning, not a blocker, because
    // `POST /api/version/bump` fixes all of them in one step.
    try {
      const drift = await inspectVersionDrift(plugin.path, plugin.version)
      if (drift.drifted.length > 0) {
        const where = drift.drifted.map((entry) => `${entry.rel}（${entry.version}）`).join('、')
        checks.push({
          id: 'version-drift',
          status: 'warn',
          title: '版本声明不一致',
          detail: `package.json 是 ${drift.version}，但这些地方还是旧版本：${where}。点「提升版本」会一次同步全部`,
          fix: 'sync',
        })
        warnings.push(`版本声明不一致：${where}（package.json 为 ${drift.version}）`)
      } else {
        checks.push({
          id: 'version-drift',
          status: 'pass',
          title: '版本声明一致',
          detail: drift.declarations.length > 0
            ? `package.json 与 ${drift.declarations.length} 处声明都是 ${drift.version}`
            : '没有额外版本声明',
        })
      }
    } catch (error) {
      checks.push({ id: 'version-drift', status: 'warn', title: '版本声明检查失败', detail: error.message })
    }
    checks.push({
      id: 'platforms',
      status: selected.length > 0 ? 'pass' : 'fail',
      title: selected.length > 0 ? `发布到 ${platformLabelList(selected)}` : '没有勾选任何平台',
      detail: selected.length > 0 ? '各平台按顺序执行；单个平台失败不会中断其他平台' : '至少勾选一个平台后才能发布',
      fix: selected.length > 0 ? undefined : 'form',
    })

    if (wantHosting) {
      // Reuse the cached probe: spawning `git --version` costs ~80ms and preflight
      // runs on every keystroke of the form. The cache is already invalidated by
      // #capabilities() and refreshed by the manual rescan.
      const gitVersion = await gitProbePromise
      if (gitVersion && this.#gitVersionCache === null) this.#gitVersionCache = gitVersion
      checks.push(gitVersion
        ? { id: 'git', status: 'pass', title: 'git 可用', detail: `git ${gitVersion}` }
        : { id: 'git', status: 'fail', title: '未找到 git', detail: '请先安装 git 并确保它在 PATH 中', fix: 'settings' })

      // The account/token checks below belong to GitHub only: it is the one
      // hosting whose credential comes from the account resolver. Gitee and
      // Codeberg get their own `host-auth` check further down, so running this
      // for them would report a GitHub problem on a Gitee publish.
      if (wantGithub) {
        if (!tokenInfo) {
          checks.push({ id: 'auth', status: 'warn', title: '尚未连接 GitHub 账号', detail: '在设置中填入 Personal Access Token 后即可发布', fix: 'settings' })
        } else if (authError) {
          const code = authError.code || 'invalid-token'
          checks.push({
            id: 'auth',
            status: code === 'github-network' || code === 'github-timeout' ? 'warn' : 'fail',
            title: code === 'github-network' ? 'GitHub 网络暂不可用' : 'GitHub token 无效',
            detail: authError.message,
            fix: 'settings',
          })
        } else {
          checks.push({
            id: 'auth',
            status: 'pass',
            title: `已连接 @${account.login}`,
            detail: `${tokenHint(tokenInfo.token)} · ${tokenInfo.source}${account.isFineGrained ? ' · fine-grained token' : account.scopes.length > 0 ? ` · scopes: ${account.scopes.join(',')}` : ''}`,
          })
        }
      }
    }

    // ── npm group checks (only when npm is selected) ──────────────────────
    let npmState = null
    if (wantNpm) {
      const npmConfig = config.platforms.npm || {}
      const npmToken = this.#npmToken(config.platforms)
      checks.push(NPM_CLI_AVAILABLE
        ? { id: 'npm-cli', status: 'pass', title: 'npm CLI 可用', detail: NPM_CLI_PATH }
        : { id: 'npm-cli', status: 'fail', title: '找不到 npm CLI', detail: '需要 Node 自带 npm（node_modules/npm/bin/npm-cli.js）', fix: 'settings' })
      if (!npmToken) {
        checks.push({ id: 'npm-auth', status: 'warn', title: '尚未配置 npm token', detail: '在「平台配置」里填入 npm Access Token 后即可发布', fix: 'platforms' })
      } else {
        try {
          const settled = await npmVerifyPromise
          if (!settled || !settled.ok) throw (settled && settled.error) || new PublisherError('npm-auth', 'npm token 未配置')
          const verified = settled.value
          checks.push({
            id: 'npm-auth',
            status: 'pass',
            title: `npm 身份 @${verified.account.login}`,
            detail: `${verified.hint} · ${npmConfig.registry || DEFAULT_NPM_CONFIG.registry}`,
          })
        } catch (error) {
          const unreachable = error && error.code === 'registry-unreachable'
          checks.push({
            id: 'npm-auth',
            status: 'warn',
            title: unreachable ? 'registry 连不上' : 'npm token 未能验证',
            detail: unreachable
              ? `${error.detail || error.message}。请启动该 registry，或在「平台配置 → npm」里改成 https://registry.npmjs.org`
              : `${error.message}（发布时仍会尝试，若失败请看 npm-publish 步骤）`,
            fix: 'platforms',
          })
        }
      }
      const manifestName = npmPackageNameOf(plugin)
      const npmName = npmPublishNameOf(manifestName, { publishName: form.publishName })
      const renamed = npmName !== manifestName
      if (npmName && !isValidNpmName(npmName)) {
        checks.push({
          id: 'npm-name',
          status: 'fail',
          title: '发布用包名不合法',
          detail: `${npmName} 不是合法的 npm 包名（小写、无空格、可带 @scope）。请改「平台配置 → npm → 发布用包名」`,
          fix: 'platforms',
        })
      } else {
        checks.push(npmName
          ? {
              id: 'npm-name',
              status: 'pass',
              title: renamed ? '发布用包名（仅发布时生效）' : 'npm 包名',
              detail: renamed ? `${npmName}（源码 package.json 仍是 ${manifestName}）` : npmName,
            }
          : { id: 'npm-name', status: 'fail', title: 'package.json 缺少 name', detail: 'npm 发布必须有包名', fix: 'form' })
      }
      if (npmName && isValidNpmName(npmName)) {
        try {
          npmState = await npmRemoteState({ name: npmName, registry: npmConfig.registry, token: npmToken || null })
          const localVersion = plugin.version || ''
          const verdict = versionGuardVerdict({ local: localVersion, remote: npmState })
          if (verdict.reason === 'first-publish') {
            checks.push({ id: 'npm-version', status: 'pass', title: '首次发布该包名', detail: `${npmName} 在 registry 上可用` })
          } else if (verdict.reason === 'duplicate') {
            checks.push({
              id: 'npm-version',
              status: 'fail',
              title: `版本 ${localVersion} 已存在于 npm`,
              detail: `${npmName}@${localVersion} 已发布过（远端最新 ${npmState.version}）。npm 不允许重发同一个版本号，先提升到 ${verdict.next} 再发布。`,
              // `bump` is an actionable fix the UI can run in one click; a plain
              // `form` fix only scrolled to a section where no version field
              // lives, which read to the user as "there is nowhere to click".
              fix: 'bump',
              suggestion: verdict.next,
            })
          } else if (verdict.reason === 'below-latest') {
            checks.push({
              id: 'npm-version',
              status: 'warn',
              title: `本地 ${localVersion} 低于远端最新 ${npmState.version}`,
              detail: `${npmName}@${localVersion} 尚未发布过，npm 会接受本次发布；但 latest 标签会从 ${npmState.version} 退回 ${localVersion}。想让最新版本继续前进，先提升到 ${verdict.next}；或者把 npm dist-tag 改成 next 之类的非 latest 标签。`,
              fix: 'bump',
              suggestion: verdict.next,
            })
          } else if (verdict.reason === 'ahead') {
            checks.push({
              id: 'npm-version',
              status: 'pass',
              title: `远端 ${npmState.version} → 本次 ${localVersion}`,
              detail: 'npm 不接受重复版本，本地版本已更高',
            })
          }
        } catch (error) {
          const unreachable = error && error.code === 'registry-unreachable'
          checks.push({
            id: 'npm-version',
            status: 'warn',
            title: unreachable ? 'registry 连不上，版本未校验' : 'npm 版本未校验',
            detail: unreachable
              ? `${error.detail || error.message}。registry 恢复后重新预检即可`
              : error.message,
          })
        }
      }
      if (npmConfig.access === 'restricted' && npmName && !npmName.startsWith('@')) {
        checks.push({ id: 'npm-access', status: 'warn', title: 'restricted 只对 scoped 包生效', detail: `${npmName} 没有 scope，npm 会强制 public`, fix: 'platforms' })
      }
      if (npmName && isValidNpmName(npmName) && scopeOfName(npmName) !== '' && npmConfig.publishName === '') {
        warnings.push(`源码包名 ${npmName} 的 scope 可能不属于你的 npm 账号：若 publish 被 403 拒绝，在「平台配置 → npm → 发布用包名」里填你自己的 scope（只影响发布，不改源码）。`)
      }
      if (!plugin.version) {
        checks.push({ id: 'npm-version-package', status: 'fail', title: 'package.json 没有 version', detail: 'npm 发布必须有版本号', fix: 'form' })
      }
      if (!plugin.hasReadme) {
        warnings.push('npm 页面会缺少 README：建议先勾选「生成 README」再发布')
      }
    }

    // ── shared metadata checks (any repository hosting) ──────
    if (wantHosting) {
      if (!REPO_NAME_TEST.test(form.name)) {
        checks.push({ id: 'name', status: 'fail', title: '仓库名无效', detail: '只能包含字母、数字、点、下划线和连字符（1–100 字符）', fix: 'form' })
      }
      if ((form.description || '').length > 350) {
        checks.push({ id: 'description', status: 'fail', title: '描述过长', detail: '仓库描述最多 350 字符', fix: 'form' })
      }
      if (!form.owner) {
        // A blank owner is a valid choice, not a mistake: it means "publish under
        // whatever account each hosting's own token belongs to", which is the only
        // sane default when GitHub/Gitee/Codeberg use different logins. Say so
        // instead of blocking.
        const known = selectedHosts.map((id) => {
          const meta = providerOf(id)
          const cfg = (config.platforms && config.platforms[id]) || {}
          const login = id === 'github'
            ? (account && account.login) || ''
            : (cfg.account && cfg.account.login) || ''
          return `${meta ? meta.label : id}${login ? ` @${login}` : ''}`
        })
        checks.push({
          id: 'owner',
          status: 'pass',
          title: '仓库归属：使用各平台自己的账号',
          detail: known.length > 0
            ? `未填写 owner，将分别发布到 ${known.join('、')}。要发到组织或另一个账号，在这栏填登录名。`
            : '未填写 owner，将使用各平台令牌对应的账号',
        })
      }

      /*
       * Every non-GitHub hosting gets its own credential check — not just the
       * first one. A multi-host publish validates three identities, and reporting
       * only the primary would have let an invalid Gitee token sit until it failed
       * mid-publish.
       *
       * Each check costs a round trip, so the verified identity is cached briefly:
       * preflight runs on every form edit and re-asking the same token is pure
       * latency. A dry run needs no live identity at all.
       */
      const hostingCandidates = selectedHosts.filter((id) => id !== 'github')
      for (const candidate of hostingCandidates) {
        const candidateMeta = providerOf(candidate)
        const label = candidateMeta ? candidateMeta.label : candidate
        const hostCfg = (config.platforms && config.platforms[candidate]) || {}
        const hasToken = typeof hostCfg.token === 'string' && hostCfg.token.trim() !== ''
        if (!hasToken) {
          checks.push({
            id: 'host-auth',
            status: form.dryRun ? 'warn' : 'fail',
            title: `尚未配置 ${label} 访问令牌`,
            detail: `在「平台配置 → ${label}」里填入令牌。${candidate === 'gitee' ? 'Gitee 需要用「私人令牌」（设置 → 私人令牌），仓库级令牌不能建仓' : '需要 write:repository 权限'}`,
            fix: 'platforms',
          })
          continue
        }
        if (form.dryRun) continue
        try {
          const base = trimBase(hostCfg.apiBase) || (candidateMeta ? candidateMeta.apiBase : '')
          const identity = await this.#identityCached(candidate, hostCfg.token.trim(), base)
          checks.push({
            id: 'host-auth',
            status: 'pass',
            title: `${label} 身份 @${identity.login}`,
            detail: hostCfg.apiBase || (candidateMeta ? candidateMeta.apiBase : ''),
          })
        } catch (error) {
          checks.push({
            id: 'host-auth',
            status: 'fail',
            title: `${label} 令牌无法验证`,
            detail: error.message,
            fix: 'platforms',
          })
        }
      }

      /*
       * Say up front which hostings will skip topics instead of letting the publish
       * report "skipped" later with no explanation. Gitee has no topics endpoint at
       * all; the others accept them.
       */
      if (form.topics && form.topics.length > 0) {
        for (const candidate of hostingCandidates) {
          if (providerSupportsTopics(candidate)) continue
          const candidateMeta = providerOf(candidate)
          warnings.push(`${candidateMeta ? candidateMeta.label : candidate} 不支持仓库 topics，发布会跳过该步骤（不影响发布）`)
        }
      }
    }

    const apiBase = trimBase(config.defaults.apiBase)
    const gitBase = trimBase(config.defaults.gitBase)
    if (!form.authorName && !form.authorEmail && wantHosting) {
      const identity = await readGitIdentity(plugin.path)
      if (identity.name) form.authorName = identity.name
      if (identity.email) form.authorEmail = identity.email
    }
    if (!form.authorName && !form.authorEmail && form.dryRun) {
      form.authorName = 'DSH Publisher'
      form.authorEmail = 'dry-run@localhost.invalid'
    }

    let repoCheck = null
    if (wantGithub) {
      if (account?.login && tokenInfo && !authError) {
        /*
         * The probe was already started (and has been running while the npm
         * checks awaited the registry). It collected its own check rows into a
         * private list so ordering stays exactly where this section emits them:
         * waiting on it here would otherwise let it write rows early.
         */
        const settled = await repoProbePromise
        if (settled) {
          // Rows are parked, not guessed: whatever #checkRepo recorded travels here
          // with the result so the order of checks in the panel is unchanged.
          for (const row of settled.parkedChecks || []) checks.push(row)
          for (const line of settled.parkedWarnings || []) warnings.push(line)
        }
        if (settled && settled.ok) {
          repoCheck = settled.value
        } else if (settled && settled.error) {
          checks.push({ id: 'repo', status: 'warn', title: '仓库状态待校验', detail: settled.error.message, fix: 'settings' })
        }
      } else if (!tokenInfo) {
        checks.push({ id: 'repo', status: 'warn', title: '仓库状态待校验', detail: '连接账号后会检查仓库是否已存在', fix: 'settings' })
      } else {
        checks.push({ id: 'repo', status: 'warn', title: '仓库状态待校验', detail: authError?.message || '账号不可用', fix: 'settings' })
      }

      // Guard against "selected plugin B but the form still carries plugin A's
      // repository name" — the classic way to publish the wrong project into an
      // existing repository (this is what produced the 2026-10-28 push rejection).
      const expectedRepoName = sanitizeRepoName(plugin.name)
      if (form.name !== expectedRepoName) {
        const repoExists = repoCheck?.exists === true
        const freshLocalRepo = !plugin.hasGit || !plugin.hasCommits
        checks.push({
          id: 'target',
          status: repoExists && freshLocalRepo ? 'fail' : 'warn',
          title: repoExists ? '目标仓库与当前插件不匹配' : '仓库名与插件名不一致',
          detail: `当前选中的插件是 ${plugin.name}，但目标仓库名是 ${form.name}。${
            repoExists
              ? '该仓库在 GitHub 上已存在，而本地插件还没有与它关联的 git 历史：直接发布会因 non-fast-forward 被拒绝，或把另一个项目推进已有仓库。'
              : '如果不是有意改名，请确认没有残留上一个插件的表单。'
          }`,
          fix: 'form',
        })
      }
      if (repoCheck?.exists === true && (!plugin.hasGit || !plugin.hasCommits)) {
        checks.push({
          id: 'repo-history',
          status: 'warn',
          title: '目标仓库已有历史，本地是全新仓库',
          detail: '推送可能被拒绝（non-fast-forward）。建议在 GitHub 上新建一个空仓库（不要勾选 README / .gitignore），或先在本地合并远端历史后再发布。',
        })
      }

      if (!form.authorName || !form.authorEmail) {
        checks.push({ id: 'identity', status: 'warn', title: '提交身份不完整', detail: '填写作者名与邮箱，或连接 GitHub 账号自动生成 noreply 地址', fix: 'form' })
      } else if (!EMAIL_TEST.test(form.authorEmail)) {
        checks.push({ id: 'identity', status: 'fail', title: '提交邮箱格式无效', detail: form.authorEmail, fix: 'form' })
      } else {
        checks.push({ id: 'identity', status: 'pass', title: '提交身份', detail: `${form.authorName} <${form.authorEmail}>` })
      }
    }

    // ── ownership: whose plugin is this? ───────────────────────────────────
    // Never a blocking check. Forks keep the original author on purpose, so the
    // only honest options are "say it matches", "say it differs and offer a
    // confirmation", or "no opinion because there is no author at all".
    const npmScopeValue = (() => {
      const npmName = (() => {
        try {
          return npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName })
        } catch {
          return ''
        }
      })()
      return scopeOfName(npmName) || ''
    })()
    const ownership = ownershipVerdict({
      author: { name: plugin.authorName || '', email: plugin.authorEmail || '' },
      accountLogin: account?.login || '',
      repositoryOwner: plugin.repositoryOwner || (form.owner || ''),
      npmScope: npmScopeValue,
    })
    // A remembered "yes, this is mine" must name *whose* plugin it was given for.
    // Confirming once and then editing the author to somebody else would otherwise
    // carry the old blessing over to a different person — exactly the mistake this
    // whole check exists to catch.
    ownership.fingerprint = ownershipFingerprint(ownership, form.owner || '')
    ownership.confirmed = form.confirmForeignAuthor === true &&
      ownershipRememberedFor(form.confirmForeignAuthorFor, ownership.fingerprint)
    ownership.rememberedFor = form.confirmForeignAuthorFor || ''
    ownership.declared = plugin.author || ''
    if (ownership.status === 'none') {
      checks.push({
        id: 'ownership',
        status: 'warn',
        title: '插件未声明作者',
        detail: 'package.json 里没有 author，发布后仓库与 npm 页面的作者会显示成账号所有人。不影响发布。',
        fix: 'form',
      })
    } else if (ownership.confirmed) {
      checks.push({
        id: 'ownership',
        status: 'pass',
        title: '插件归属已确认',
        detail: `作者 ${ownership.author} 与当前账号 ${ownership.login || '（未连接）'} 不同，你已确认这是自己的插件（例如 fork 后自行修改）。这条确认会写进发布记录。`,
      })
    } else if (ownership.status === 'own') {
      checks.push({
        id: 'ownership',
        status: 'pass',
        title: '插件归属一致',
        detail: ownership.scopeDrift
          ? `作者与账号一致（${ownership.login}）；注意 npm 作用域 @${ownership.scope} 与账号不同，npm 会把作者记成该作用域的所有者`
          : `作者与当前账号一致（${ownership.login}）`,
      })
    } else if (ownership.status === 'fork') {
      checks.push({
        id: 'ownership',
        status: 'warn',
        title: '作者与当前账号不同',
        detail: `作者声明是 ${ownership.author}，目标仓库属于 ${ownership.owner}（当前账号）。这是 fork 的常见情况；确认后勾选下面的复选框即可。`,
        fix: 'confirmAuthor',
      })
    } else {
      checks.push({
        id: 'ownership',
        status: 'warn',
        title: '插件归属与当前账号不一致',
        detail: `作者声明是 ${ownership.author}，账号是 ${ownership.login || '（未连接）'}，目标仓库 ${form.owner}/${form.name} 也不属于这个作者。确认这是你自己的插件后再勾选下面的复选框。`,
        fix: 'confirmAuthor',
      })
    }

    const plan = planPreparation({ plugin, form })
    for (const warning of plan.warnings) warnings.push(warning)
    const writes = plan.files.filter((entry) => entry.action === 'create' || entry.action === 'update')
    checks.push({
      id: 'files',
      status: plan.packageJson.error ? 'warn' : 'pass',
      title: writes.length > 0 ? `将写入 ${writes.length} 个文件` : '仓库文件已齐全',
      detail: writes.length > 0
        ? writes.map((entry) => `${entry.file}（${entry.action === 'create' ? '新建' : '更新'}${entry.bytes ? `，${formatBytes(entry.bytes)}` : ''}）`).join('、')
        : 'README / LICENSE / .gitignore / package.json 均无需改动',
    })

    if (wantHosting) {
      if (plugin.parentRepo) {
        checks.push({
          id: 'worktree',
          status: 'warn',
          title: '插件目录位于另一个 git 仓库内',
          detail: `将为此目录建立独立 git 仓库，不会提交到父仓库 ${plugin.parentRepo}；父仓库会看到这些文件改动，请自行决定是否提交/忽略`,
        })
      } else if (!plugin.hasGit) {
        checks.push({ id: 'worktree', status: 'warn', title: '将初始化 git 仓库', detail: `git init -b ${form.branch}，并创建首个提交` })
      } else if (plugin.gitStatus.dirty) {
        checks.push({
          id: 'worktree',
          status: 'warn',
          title: '工作区有未提交改动',
          detail: `${plugin.gitStatus.modified + plugin.gitStatus.staged} 个修改、${plugin.gitStatus.untracked} 个未跟踪文件将一并提交`,
        })
      } else {
        checks.push({ id: 'worktree', status: 'pass', title: 'git 工作区干净', detail: `当前分支 ${plugin.branch || form.branch}` })
      }

      if (plugin.remote && plugin.remote.isGitHub) {
        const current = `${plugin.remote.owner}/${plugin.remote.repo}`.toLowerCase()
        const target = `${form.owner}/${form.name}`.toLowerCase()
        if (current !== target) {
          checks.push({ id: 'remote', status: 'warn', title: '将改写 git remote origin', detail: `当前 ${plugin.remote.url} → 目标 ${form.owner}/${form.name}` })
        }
      }

      if (!plugin.version) {
        checks.push({ id: 'version', status: 'warn', title: 'package.json 没有 version', detail: '将跳过 tag 与 Release' })
      }

      if (form.createRelease && plugin.version) {
        const hostLabel = hostMeta ? hostMeta.label : '仓库'
        // Codeberg's release endpoint refuses new repositories outright (verified
        // live), so promising a Release there would be misleading. The publish
        // step degrades to a warning rather than failing, and this says so early.
        const detail = form.dryRun
          ? '演练模式：不会创建'
          : hostId === 'github'
            ? '推送 tag 后通过 GitHub API 创建'
            : `推送 tag 后通过 ${hostLabel} API 创建（若平台拒绝，会保留 tag 并提示手动补建）`
        checks.push({ id: 'release', status: 'pass', title: `将创建 Release ${releaseTag(form.tagPrefix, plugin.version)}`, detail })
      }
    }

    const blocking = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.id)
    const accountReady = Boolean(account?.connected && tokenInfo && !authError)
    const npmReady = wantNpm ? Boolean(this.#npmToken(config.platforms)) : true
    // A Gitee/Codeberg publish needs *its own* token, not GitHub's account. The
    // hosting credential was already checked above as `host-auth`, so readiness
    // here is just "that check did not fail".
    const hostAuthFailed = checks.some((entry) => entry.id === 'host-auth' && entry.status === 'fail')
    const hostReady = hostId === 'github' ? accountReady : !hostAuthFailed
    const needsAccount = wantHosting && !hostReady && hostId === 'github'
    const needsHostToken = hostId !== 'github' && wantHosting && !hostReady
    const needsNpmToken = wantNpm && !npmReady
    const canPublish = blocking.length === 0 && (form.dryRun === true || (hostReady && npmReady))
    const npmConfig = config.platforms.npm || {}
    const planSummary = {
      platforms: selected,
      platformsLabel: platformLabelList(selected),
      owner: form.owner,
      repo: form.name,
      branch: form.branch,
      repoExists: repoCheck?.exists === true,
      createRepo: repoCheck ? !repoCheck.exists : null,
      visibility: form.visibility,
      remoteUrl: form.owner ? `${gitBase}/${form.owner}/${form.name}.git` : '',
      commitMessage: renderCommitMessage(form.commitMessage, { name: form.name, version: plugin.version, owner: form.owner }),
      tag: plugin.version ? releaseTag(form.tagPrefix, plugin.version) : null,
      createRelease: Boolean(form.createRelease && plugin.version && !form.dryRun),
      dryRun: form.dryRun === true,
      apiBase,
      gitBase,
      version: plugin.version,
      license: form.license,
      topics: form.topics,
      npm: wantNpm
        ? {
            name: npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName }),
            manifestName: npmPackageNameOf(plugin),
            renamedForPublish: npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName }) !== npmPackageNameOf(plugin),
            registry: npmConfig.registry || DEFAULT_NPM_CONFIG.registry,
            access: form.npmAccess,
            distTag: form.npmDistTag,
            remoteVersion: npmState?.version || null,
            url: npmState?.url || null,
            versions: npmState?.versions || [],
            versionOccupied: Boolean(npmState && plugin.version && npmState.has(plugin.version)),
            belowLatest: Boolean(npmState && plugin.version && compareVersions(plugin.version, npmState.version) < 0),
            needsVersionBump: Boolean(
              npmState &&
                plugin.version &&
                (npmState.has(plugin.version) || compareVersions(plugin.version, npmState.version) < 0),
            ),
            bumpSuggestion: npmState && plugin.version ? nextVersionAbove(plugin.version, npmState.version) : null,
          }
        : null,
    }
    const actionText = form.dryRun
      ? '演练：只做本地准备与提交，不建仓、不推送、不创建 Release、不 publish npm'
      : describeAction(selected, repoCheck, form, npmState, plugin, npmConfig)

    return {
      plugin: publicPlugin(plugin),
      form,
      checks,
      blocking,
      canPublish,
      needsAccount,
      // Which hosting this preflight describes, and whether its own token is the
      // missing piece (as opposed to GitHub's account connection).
      host: hostId,
      needsHostToken,
      needsNpmToken,
      platforms: selected,
      ownership,
      plan: planSummary,
      actionText,
      preview: {
        files: plan.files,
        writes,
        packageJson: plan.packageJson,
        generatedReadme: plan.generatedReadme,
        readmeAction: plan.files.find((entry) => /^readme/i.test(entry.file))?.action || 'keep',
        license: plan.license,
        year: plan.year,
      },
      warnings,
    }
  }

  /** Repo existence / creation-permission check used by preflight. */
  async #checkRepo({ account, form, tokenInfo, checks, apiBase }) {
    const client = this.#client(tokenInfo.token, apiBase)
    // Same owner resolution as the publish path: an explicit owner wins, a blank
    // one means "this hosting's own account". Without this, a blank owner reached
    // the API as an empty namespace and reported `GitHub 上找不到 “”`.
    const owner = String(form.owner || '').trim() || (account && account.login) || ''
    const repoForm = { ...form, owner }
    let existing = null
    try {
      existing = await client.getRepo(owner, form.name)
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'github-rate-limit') {
        checks.push({ id: 'repo', status: 'warn', title: 'GitHub API 限额已用尽', detail: `${error.message}（可稍后重试）` })
        return null
      }
      checks.push({ id: 'repo', status: 'fail', title: '无法检查仓库', detail: error.message })
      return null
    }
    if (existing) {
      if (form.repoExistsStrategy === 'error') {
        checks.push({ id: 'repo', status: 'fail', title: '仓库已存在', detail: `${owner}/${form.name} 已存在；可在发布选项中选择「复用已有仓库」`, fix: 'form' })
      } else {
        const canPush = !existing.permissions || existing.permissions.push !== false
        checks.push({
          id: 'repo',
          status: canPush ? 'pass' : 'fail',
          title: '仓库已存在，将复用',
          detail: `${existing.htmlUrl || `${owner}/${form.name}`}${canPush ? '' : ' · 当前 token 没有推送权限'}`,
          fix: canPush ? undefined : 'settings',
        })
      }
      return { exists: true, repo: existing }
    }
    if (account.login && owner.toLowerCase() !== account.login.toLowerCase()) {
      // The owner is not the authenticated user: it must be an organisation the
      // token can see. Catch display-name/typo mistakes here instead of letting
      // POST /orgs/{owner}/repos fail with an opaque 404.
      let org = null
      try {
        org = await client.getOrg(owner)
      } catch (error) {
        checks.push({ id: 'repo', status: 'warn', title: '无法校验组织', detail: `${error.message}（发布前会再次校验）`, fix: 'settings' })
        return { exists: false, repo: null }
      }
      if (!org) {
        checks.push({
          id: 'repo',
          status: 'fail',
          title: `GitHub 上找不到 “${owner}”`,
          detail: `它既不是你的账号（你登录的是 @${account.login}），也不是你能访问的组织。发布到个人账号请把 Owner 改成 ${account.login}；要发布到组织请填组织登录名。`,
          fix: 'form',
        })
        return { exists: false, repo: null, ownerInvalid: true }
      }
      checks.push({
        id: 'repo',
        status: 'warn',
        title: `将尝试在组织 ${org.login} 下创建仓库`,
        detail: '需要该组织的建仓权限（token 需具备相应授权）',
      })
      return { exists: false, repo: null }
    }
    checks.push({ id: 'repo', status: 'pass', title: '仓库名可用', detail: `将新建 ${owner}/${form.name}（${form.visibility}）` })
    return { exists: false, repo: null }
  }

  /* ── jobs ─────────────────────────────────────────────────────────────── */

  /** Validate, plan and start an async publish job. */
  async publish({ path: pluginPath, form: requestForm = {} } = {}) {
    if (this.#activeJobId) {
      const active = this.#jobs.get(this.#activeJobId)
      if (active && (active.status === 'running' || active.status === 'queued')) {
        throw new PublisherError('job-running', '已有发布任务在执行，请先等待或取消', { status: 409, details: { jobId: active.jobId } })
      }
    }
    const preflight = await this.preflight({ path: pluginPath, form: requestForm })
    if (!preflight.canPublish) {
      throw new PublisherError('preflight-failed', '预检未通过，请先处理标记为失败的项目', {
        status: 400,
        details: { checks: preflight.checks, blocking: preflight.blocking },
      })
    }
    const job = this.#createJob({ preflight })
    this.#jobs.set(job.jobId, job)
    this.#activeJobId = job.jobId
    this.#pruneJobs()
    // Fire and forget: the HTTP layer returns the jobId immediately.
    void this.#runJob(job, preflight).catch(() => {})
    return { jobId: job.jobId }
  }

  /**
   * Run one network git command (push / pushTag) with bounded retries for
   * transient transport failures. Attempt 3 forces HTTP/1.1, which fixes the
   * common "Error in the HTTP2 framing layer" on proxied/unstable networks.
   */
  async #runGitTransport(job, stepId, { label, signal, attempts = 3, run }) {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (job.cancelled) throw abortError()
      if (signal.aborted) throw abortError()
      if (attempt > 1) this.#appendLog(job, 'warn', stepId, `${label}：第 ${attempt}/${attempts} 次尝试…`)
      try {
        return await run(attempt)
      } catch (error) {
        lastError = error
        if (isAbort(error)) throw error
        const transient = isTransientGitTransportError(error)
        if (!transient || attempt >= attempts) {
          if (transient) {
            this.#appendLog(job, 'error', stepId, `${label} 连续 ${attempt} 次因网络传输失败；如持续失败可在 DSH 插件设置里联系维护者，或手动执行 git -c http.version=HTTP/1.1 push`)
          }
          throw error
        }
        const waitMs = 800 * 2 ** (attempt - 1)
        this.#appendLog(job, 'warn', stepId, `${label} 遇到网络传输错误（${firstLine(error.message)}），${waitMs}ms 后重试；第 ${attempts} 次会尝试 HTTP/1.1`)
        await sleep(waitMs, signal)
      }
    }
    throw lastError || new Error('git transport retry exhausted')
  }

  #createJob({ preflight }) {
    const now = Date.now()
    const selected = normalizeSelection(preflight.platforms || preflight.form.platforms)
    const stepIds = buildStepIds(selected)
    const hosts = hostingsOf(selected)
    const job = {
      jobId: `job_${now}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'running',
      path: preflight.plugin.path,
      pluginName: preflight.plugin.name,
      platforms: selected,
      /**
       * The repository hostings this job pushes to. One commit goes to each of
       * them, with its own repo/topics/release — that is the product's premise.
       */
      hosts: hosts,
      /**
       * Per-hosting outcome, so a failure on one remote is attributable rather
       * than reported as "the publish failed". `stepHost` holds the live status
       * shown while running (`repo`/`push`/`release` → 'pending'|'running'|'done'|'failed'|'skipped').
       */
      hostResults: hosts.reduce((acc, id) => {
        acc[id] = {
          status: 'pending',
          repoUrl: null,
          releaseUrl: null,
          tag: null,
          createdRepo: false,
          pushed: false,
          error: null,
          code: null,
          steps: { repo: 'pending', push: 'pending', release: 'pending' },
        }
        return acc
      }, {}),
      step: stepIds[0],
      startedAt: now,
      endedAt: null,
      steps: stepIds.map((id, index) => ({
        id,
        platform: stepPlatformOf(id),
        status: index === 0 ? 'running' : 'pending',
        startedAt: index === 0 ? now : null,
        endedAt: null,
        detail: null,
        error: null,
      })),
      logs: [],
      result: null,
      platformResults: {},
      error: null,
      dryRun: preflight.form.dryRun === true,
      abort: new AbortController(),
      cancelled: false,
      token: null,
      npmToken: null,
    }
    this.#appendLog(job, 'info', 'job', `开始发布 ${preflight.plugin.name} → ${platformLabelList(selected)}${job.dryRun ? '（演练模式）' : ''}`)
    return job
  }

  /**
   * Record what happened to one hosting at one step.
   *
   * Kept separate from `#setStep` because the *step* has a single status per job
   * (`repo` ran), while each hosting has its own outcome (`repo` succeeded for
   * GitHub, failed for Gitee). Reporting only the step status would either hide a
   * partial failure or turn a good GitHub push into a failed job.
   */
  #setHostStep(job, hostId, stepId, status, { detail = null, error = null } = {}) {
    const entry = job.hostResults && job.hostResults[hostId]
    if (!entry) return
    if (entry.steps) entry.steps[stepId] = status
    const secrets = [job.token, this.#sessionToken, job.npmToken].filter(Boolean)
    if (status === 'failed') {
      entry.status = 'failed'
      entry.error = error === null ? null : redactSecrets(String(error), secrets)
      entry.code = entry.code || (error && error.code) || null
    } else if (status === 'done' && entry.status !== 'failed') {
      entry.status = 'partial'
    }
    this.#appendLog(job, status === 'failed' ? 'warn' : 'info', stepId, `[${hostId}] ${detail || status}`)
  }

  #appendLog(job, level, step, text) {
    const secrets = [job.token, this.#sessionToken, job.npmToken].filter(Boolean)
    const line = String(text === undefined || text === null ? '' : text).slice(0, JOB_MAX_LOGS_CHARS)
    job.logs.push({ at: Date.now(), level, step, platform: stepPlatformOf(step), text: redactSecrets(line, secrets) })
    if (job.logs.length > JOB_LOG_MAX) job.logs.splice(0, job.logs.length - JOB_LOG_MAX)
  }

  #setStep(job, id, status, { detail = undefined, error = undefined } = {}) {
    const step = job.steps.find((entry) => entry.id === id)
    if (!step) return
    const now = Date.now()
    step.status = status
    if (detail !== undefined) step.detail = redactSecrets(String(detail), [job.token, this.#sessionToken].filter(Boolean))
    if (error !== undefined) step.error = error === null ? null : redactSecrets(String(error), [job.token, this.#sessionToken].filter(Boolean))
    if (status === 'running') step.startedAt = step.startedAt || now
    if (status === 'done' || status === 'failed' || status === 'skipped') step.endedAt = now
    job.step = id
  }

  /** The pipeline. Errors mark the job failed; cancellation marks it cancelled. */
  async #runJob(job, preflight) {
    const { form, plugin } = preflight
    const config = await this.#store.loadConfig()
    const apiBase = trimBase(form.apiBase || config.defaults.apiBase)
    const gitBase = trimBase(form.gitBase || config.defaults.gitBase)
    const signal = job.abort.signal
    /**
     * The repository hostings this job pushes to.
     *
     * A job targets every hosting the operator ticked: one commit, several
     * repositories, each with its own topics and release. Earlier this was a
     * single `hostId`, which silently turned the multi-platform publisher into a
     * single-remote one.
     *
     * `hostId`/`host` keep pointing at the primary hosting for the few places that
     * genuinely need one value (legacy single-token fields, npm hand-off); the
     * push path iterates `hosts` instead.
     */
    const hosts = Array.isArray(job.hosts) && job.hosts.length > 0
      ? job.hosts
      : (providerOf(form.host) ? [form.host] : [])
    const hostId = providerOf(form.host) ? form.host : 'github'
    const host = providerOf(hostId)
    // Per-platform credentials and endpoints: a host's own config wins, then the
    // job's form, then the provider default.
    const hostConfig = config.platforms && config.platforms[hostId] ? config.platforms[hostId] : {}
    // Order matters: the host's own configured base wins, then an explicit
    // override on this job's form, then the provider default. `config.defaults`
    // holds GitHub's endpoint, so using it for a Gitee job would point the client
    // at api.github.com and answer 401 for a perfectly good Gitee token.
    const hostApiBase = trimBase(hostConfig.apiBase)
      || trimBase(form.host === 'github' ? form.apiBase : '')
      || trimBase(hostId === 'github' ? config.defaults.apiBase : '')
      || host.apiBase
    const hostWebBase = trimBase(hostConfig.gitBase)
      || trimBase(form.host === 'github' ? form.gitBase : '')
      || trimBase(hostId === 'github' ? config.defaults.gitBase : '')
      || host.webBase
    const hostRepoUrl = (owner, repo) => repoWebUrlFor(hostId, owner, repo, hostWebBase)
    const hostCloneUrl = (owner, repo) => repoCloneUrlFor(hostId, owner, repo, hostWebBase)
    const hostTopicsSupported = providerSupportsTopics(hostId)
    let written = []
    let commitSha = null
    let createdRepo = false
    let pushed = false
    let tag = null
    let releaseUrl = null
    let repoUrl = null
    let account = null
    let npmPublished = false
    let npmRemoteVersion = null
    let npmUrl = null

    const guard = () => {
      if (job.cancelled) throw abortError()
      if (signal.aborted) throw abortError()
    }
    const hasStep = (id) => job.steps.some((entry) => entry.id === id)
    const step = async (id, work) => {
      // A platform that is not selected contributes no step: its runner is a
      // no-op, so the shared pipeline can call every step unconditionally.
      if (!hasStep(id)) return undefined
      guard()
      this.#setStep(job, id, 'running')
      this.#appendLog(job, 'info', id, `开始：${STEP_TITLES[id] || id}`)
      try {
        const detail = await work()
        guard()
        const current = job.steps.find((entry) => entry.id === id)
        if (current && current.status === 'skipped') {
          this.#appendLog(job, 'info', id, current.detail || '已跳过')
          return detail
        }
        this.#setStep(job, id, 'done', { detail: typeof detail === 'string' ? detail : detail?.detail })
        if (typeof detail === 'string') this.#appendLog(job, 'success', id, detail)
        else if (detail?.log) this.#appendLog(job, 'success', id, detail.log)
        return detail
      } catch (error) {
        if (isAbort(error)) throw error
        this.#setStep(job, id, 'failed', { detail: null, error: error.message })
        this.#appendLog(job, 'error', id, error.message)
        throw error
      }
    }

    /**
     * Per-hosting credentials and identities, collected once at `auth`.
     *
     * Replaces the former single `job.token`/`account` pair: with several remotes
     * in one job, each hosting has its own token, its own login, and its own
     * endpoints. Everything downstream reads from this map instead of a shared
     * variable.
     */
    const hostContext = {}
    const hostTokenOf = (id) => (hostContext[id] ? hostContext[id].token : null)
    const hostLoginOf = (id) => (hostContext[id] ? hostContext[id].login : '')

    try {
      await step('auth', async () => {
        if (!hosts.length) {
          this.#setStep(job, 'auth', 'skipped', { detail: '没有勾选仓库平台' })
          return 'skipped'
        }
        const lines = []
        const failures = []
        for (const id of hosts) {
          const meta = providerOf(id) || providerOf('github')
          const cfg = (config.platforms && config.platforms[id]) || {}
          const token = await this.#resolveHostingToken(id, config)
          if (!token) {
            failures.push(`${meta.label} 未配置访问令牌（平台配置 → ${meta.label}）`)
            this.#setHostStep(job, id, 'repo', 'pending', { detail: '缺少令牌，未执行' })
            continue
          }
          const apiBase = trimBase(cfg.apiBase) || meta.apiBase
          try {
            const identity = await this.validateHostingIdentity(id, token, apiBase)
            hostContext[id] = {
              token: token.token,
              source: token.source,
              login: identity.login || '',
              apiBase,
              webBase: trimBase(cfg.gitBase) || meta.webBase,
              label: meta.label,
            }
            lines.push(`@${identity.login || '?'}（${meta.label}）`)
          } catch (error) {
            failures.push(`${meta.label} 令牌无法验证：${error.message}`)
            this.#setHostStep(job, id, 'repo', 'pending', { detail: '令牌无效，未执行' })
          }
        }
        // The first hosting keeps populating the legacy single-token fields so
        // older code paths and the npm group keep working.
        const primary = hosts.find((id) => hostContext[id])
        if (primary) {
          job.token = hostContext[primary].token
          account = { connected: true, login: hostContext[primary].login, provider: primary }
        }
        if (failures.length > 0 && !form.dryRun) {
          // Every hosting failed: there is nothing to push to.
          if (lines.length === 0) {
            throw new PublisherError('invalid-token', failures.join('；'))
          }
          // Some hostings are unusable but others are fine: publish to the good
          // ones and record the rest as failed rather than aborting everything.
          for (const line of failures) this.#appendLog(job, 'warn', 'auth', line)
        }
        this.#appendLog(job, 'info', 'auth', `将发布到：${lines.join('、')}`)
        return `${lines.join('、')}${failures.length > 0 ? `（${failures.length} 个平台未就绪）` : ''}`
      })

      await step('inspect', async () => {
        // Re-read the plugin right before mutating it: preflight may be minutes old.
        const fresh = await inspectPlugin(plugin.path)
        fresh.manifestText = await readManifestText(plugin.path)
        Object.assign(plugin, fresh)
        this.#appendLog(job, 'info', 'inspect', `版本 ${plugin.version || '未声明'}，分支 ${form.branch}`)
        return `${plugin.name} ${plugin.version || ''}`.trim()
      })

      await step('prepare', async () => {
        const plan = planPreparation({ plugin, form })
        // A changelog entry is appended to an existing README rather than
        // rewriting it, so re-publishing never destroys hand-written docs.
        const notesTag = plugin.version ? releaseTag(form.tagPrefix, plugin.version) : ''
        const notesEntry = buildReleaseNotesEntry({ plugin, form, tag: notesTag })
        const outcome = await applyPreparation(plan, { dryRun: false, notesEntry, tag: notesTag })
        written = outcome.written
        for (const entry of outcome.written) {
          if (entry.action === 'keep') {
            this.#appendLog(job, 'info', 'prepare', `保留 ${entry.file}：${entry.reason || '无变化'}`)
            continue
          }
          const verb = entry.action === 'create' ? '新建' : entry.action === 'append-notes' ? '追加更新日志到' : '更新'
          this.#appendLog(job, 'success', 'prepare', `${verb} ${entry.file}（${formatBytes(entry.bytes)}）`)
        }
        for (const entry of plan.files.filter((file) => file.action === 'keep')) this.#appendLog(job, 'info', 'prepare', `保留 ${entry.file}：${entry.reason}`)
        for (const warning of outcome.warnings) this.#appendLog(job, 'warn', 'prepare', warning)
        const changed = written.filter((entry) => entry.action !== 'keep')
        return {
          detail: changed.length > 0 ? `写入 ${changed.length} 个文件` : '无需写入文件',
          log: changed.length > 0 ? changed.map((entry) => entry.file).join('、') : '仓库文件已齐全',
        }
      })

      /**
       * Create or reuse one repository per hosting, then set its topics.
       *
       * A hosting that fails here is marked failed and skipped for the rest of
       * the pipeline; the others carry on. That is the whole point of a
       * multi-platform publisher: one remote being unavailable must not erase the
       * publish that succeeded somewhere else.
       */
      await step('repo', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'repo', 'skipped', { detail: '演练模式：跳过建仓' })
          this.#appendLog(job, 'info', 'repo', '演练模式：不创建/修改远端仓库')
          return 'skipped'
        }
        if (!hosts.length) {
          this.#setStep(job, 'repo', 'skipped', { detail: '没有勾选仓库平台' })
          return 'skipped'
        }
        const results = []
        for (const id of hosts) {
          const ctx = hostContext[id]
          if (!ctx) {
            this.#setHostStep(job, id, 'repo', 'skipped', { detail: '缺少令牌，未建仓' })
            results.push(`${id}: 跳过`);
            continue
          }
          const meta = providerOf(id)
          this.#setHostStep(job, id, 'repo', 'running', { detail: `在 ${meta.label} 建仓` })
          try {
            const entry = await this.#ensureRepo({
              job, hostId: id, ctx, form, plugin, log: (level, text) => this.#appendLog(job, level, 'repo', text),
            })
            const hr = job.hostResults[id]
            hr.repoUrl = entry.repoUrl
            hr.createdRepo = entry.created
            this.#setHostStep(job, id, 'repo', 'done', { detail: entry.detail })
            results.push(`${meta.label}: ${entry.detail}`)
            // Legacy single-host fields keep the first success.
            if (!repoUrl) { repoUrl = entry.repoUrl; createdRepo = entry.created }
          } catch (error) {
            if (isAbort(error)) throw error
            const hr = job.hostResults[id]
            hr.status = 'failed'; hr.error = error.message; hr.code = error.code || null
            this.#setHostStep(job, id, 'repo', 'failed', { detail: error.message, error })
            results.push(`${meta.label}: 失败（${error.message}）`)
          }
        }
        const ok = hosts.filter((id) => job.hostResults[id].steps.repo === 'done')
        if (ok.length === 0) {
          // Nothing was created anywhere: that is a real failure, not a partial.
          const detail = results.join('；')
          throw new PublisherError('repo-all-failed', detail || '所有仓库平台都建仓失败')
        }
        return {
          detail: `${ok.length}/${hosts.length} 个平台建仓成功`,
          log: results.join(' · '),
        }
      })

      await step('topics', async () => {
        if (form.dryRun || !form.topics || form.topics.length === 0) {
          this.#setStep(job, 'topics', 'skipped', { detail: form.dryRun ? '演练模式：跳过 topics' : '未设置 topics' })
          return 'skipped'
        }
        const done = []
        for (const id of hosts) {
          const hr = job.hostResults[id]
          if (!hr || hr.steps.repo !== 'done') continue
          const meta = providerOf(id)
          if (!providerSupportsTopics(id)) {
            this.#appendLog(job, 'info', 'topics', `${meta.label} 没有 topics 功能，已跳过（不是失败）`)
            continue
          }
          const ctx = hostContext[id]
          try {
            const client = this.#client(ctx.token, ctx.apiBase, id)
            const names = await client.setTopics(form.owner, form.name, form.topics)
            this.#appendLog(job, 'success', 'topics', `${meta.label} 已设置 topics：${names.join(', ')}`)
            done.push(meta.label)
          } catch (error) {
            // Topics are cosmetic: never fail a publish for them.
            this.#appendLog(job, 'warn', 'topics', `${meta.label} 设置 topics 失败（不影响发布）：${error.message}`)
          }
        }
        if (done.length === 0) {
          this.#setStep(job, 'topics', 'skipped', { detail: '没有平台支持或需要 topics' })
          return 'skipped'
        }
        return `${done.length} 个平台已设置 topics`
      })

      await step('commit', async () => {
        const dir = plugin.path
        // Only a plugin that is the TOP LEVEL of its own work tree reuses that
        // repository. A plugin nested in a parent repo gets a fresh nested repo,
        // so publishing never commits into (or pushes) the parent project.
        const insideRepo = await git.isGitRepo(dir)
        const topLevel = insideRepo ? await git.gitTopLevel(dir) : null
        let ownRepo = false
        if (insideRepo && topLevel) {
          try {
            ownRepo = (await fsp.realpath(topLevel)) === (await fsp.realpath(dir))
          } catch {
            ownRepo = path.resolve(topLevel) === path.resolve(dir)
          }
        }
        if (!ownRepo) {
          const init = await git.initRepo(dir, { branch: form.branch })
          this.#appendLog(job, 'info', 'commit', `已初始化 git 仓库（${init.branch}）${topLevel ? `；该目录位于父仓库 ${topLevel} 内，已为其建立独立仓库` : ''}`)
        }
        const branch = await git.currentBranch(dir)
        if (branch !== form.branch) {
          await git.checkoutOrCreateBranch(dir, form.branch, { signal })
          this.#appendLog(job, 'info', 'commit', `已切换到分支 ${form.branch}`)
        }
        if (form.authorName && form.authorEmail) {
          await git.configSetLocal(dir, 'user.name', form.authorName)
          await git.configSetLocal(dir, 'user.email', form.authorEmail)
        }
        await git.addAll(dir, { signal })
        const message = renderCommitMessage(form.commitMessage, { name: form.name, version: plugin.version, owner: form.owner })
        if (await git.hasStagedChanges(dir)) {
          const result = await git.commit(dir, message, { signal, author: form.authorName && form.authorEmail ? { name: form.authorName, email: form.authorEmail } : null })
          commitSha = result.sha
          this.#appendLog(job, 'success', 'commit', `提交 ${result.sha.slice(0, 7)}：${message}（${result.files} 个文件）`)
          return { detail: `提交 ${result.sha.slice(0, 7)}`, log: `${result.files} 个文件：${message}` }
        }
        if (!(await git.headCommit(dir))) {
          throw new PublisherError('git-failed', '没有可提交的内容：插件目录为空？')
        }
        commitSha = await git.headCommit(dir)
        this.#appendLog(job, 'warn', 'commit', `没有新的改动，复用最近提交 ${commitSha ? commitSha.slice(0, 7) : ''}`)
        return { detail: `复用提交 ${commitSha ? commitSha.slice(0, 7) : ''}` }
      })

      /**
       * Push the one commit to every ready hosting.
       *
       * The commit is made once; each remote gets the same sha. A remote that
       * rejects the push is recorded against that hosting and the loop continues,
       * so a Gitee outage cannot stop GitHub from receiving the code.
       */
      await step('push', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'push', 'skipped', { detail: '演练模式：跳过 push' })
          return 'skipped'
        }
        const ready = hosts.filter((id) => hostContext[id] && job.hostResults[id].steps.repo === 'done')
        if (ready.length === 0) {
          this.#setStep(job, 'push', 'skipped', { detail: '没有可用平台，跳过推送' })
          return 'skipped'
        }
        const results = []
        for (const id of ready) {
          const ctx = hostContext[id]
          const meta = providerOf(id)
          // The namespace belongs to this hosting, not to the form: the three
          // accounts differ, so a single form owner would send the push to the
          // wrong user. An explicit owner still wins (organisations).
          const owner = String(form.owner || '').trim() || ctx.login || ''
          const remoteUrl = repoCloneUrlFor(id, owner, form.name, ctx.webBase)
          this.#setHostStep(job, id, 'push', 'running', { detail: `推送 ${form.branch} → ${meta.label}` })
          try {
            // The remote name is per hosting so three remotes can coexist on one
            // work tree; `origin` stays as GitHub's for tooling that expects it.
            const remoteName = 'origin'
            await git.setRemote(plugin.path, remoteName, remoteUrl)
            await this.#runGitTransport(job, 'push', {
              label: `推送 ${form.branch} → ${meta.label}`,
              signal,
              run: (attempt) => git.push(plugin.path, {
                url: remoteUrl,
                refspec: `HEAD:refs/heads/${form.branch}`,
                token: ctx.token,
                username: pushUsernameFor(id, ctx.login || ''),
                signal,
                forceWithLease: form.forceWithLease === true,
                httpVersion: pushHttpVersion(attempt),
              }),
            })
            job.hostResults[id].pushed = true
            this.#setHostStep(job, id, 'push', 'done', { detail: `已推送 ${remoteUrl}` })
            results.push(`${meta.label}: 已推送`)
            pushed = true
          } catch (error) {
            if (isAbort(error)) throw error
            const message = String(error.message || '')
            let surfaced = error
            if (/rejected|non-fast-forward|fetch first/i.test(message)) {
              surfaced = new PublisherError('git-push-rejected', [
                `${meta.label} 推送被拒绝：远端已有与本地不同的提交历史。`,
                `目标仓库：${form.owner}/${form.name}`,
                '处理方式：换个仓库名重新发布；或勾选 force-with-lease 覆盖远端；或先 git pull --allow-unrelated-histories 合并后再发布。',
                '', message,
              ].join(String.fromCharCode(10)))
            } else if (/HTTP2 framing layer|Failed to connect|Couldn't connect|Connection timed out/i.test(message)) {
              surfaced = new PublisherError('git-network', `无法连接 ${meta.label} 的 git 服务：${firstLine(message) || '连接失败'}。已重试并用 HTTP/1.1 兜底；如仍失败请检查代理/VPN 或稍后重试。`)
            }
            const hr = job.hostResults[id]
            hr.status = 'failed'; hr.error = surfaced.message; hr.code = surfaced.code || null
            this.#setHostStep(job, id, 'push', 'failed', { detail: surfaced.message, error: surfaced })
            results.push(`${meta.label}: 失败（${surfaced.message.split(String.fromCharCode(10))[0]}）`)
          }
        }
        const ok = ready.filter((id) => job.hostResults[id].steps.push === 'done')
        if (ok.length === 0) throw new PublisherError('git-push-all-failed', results.join('；') || '所有平台推送失败')
        return { detail: `${ok.length}/${ready.length} 个平台已推送`, log: results.join(' · ') }
      })

      /**
       * Tag + release on every hosting that accepted the push.
       *
       * The tag is created once locally and pushed to each remote, so all of them
       * point at the same commit. A hosting whose release endpoint refuses (Codeberg
       * does this for new repositories) keeps its pushed tag and is reported as a
       * warning rather than failing the whole publish.
       */
      await step('release', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'release', 'skipped', { detail: '演练模式：跳过 tag / Release' })
          return 'skipped'
        }
        if (!form.createRelease) {
          this.#setStep(job, 'release', 'skipped', { detail: '未启用 Release' })
          return 'skipped'
        }
        if (!plugin.version) {
          this.#setStep(job, 'release', 'skipped', { detail: 'package.json 没有 version' })
          return 'skipped'
        }
        const ready = hosts.filter((id) => hostContext[id] && job.hostResults[id].steps.push === 'done')
        if (ready.length === 0) {
          this.#setStep(job, 'release', 'skipped', { detail: '没有平台接受推送，跳过 Release' })
          return 'skipped'
        }
        tag = releaseTag(form.tagPrefix, plugin.version)
        if (!(await git.tagExists(plugin.path, tag))) {
          await git.createTag(plugin.path, tag, { message: `Release ${tag}`, signal })
          this.#appendLog(job, 'info', 'release', `已创建 tag ${tag}`)
        }
        const results = []
        for (const id of ready) {
          const ctx = hostContext[id]
          const meta = providerOf(id)
          const owner = String(form.owner || '').trim() || ctx.login || ''
          const remoteUrl = repoCloneUrlFor(id, owner, form.name, ctx.webBase)
          this.#setHostStep(job, id, 'release', 'running', { detail: `推送 tag 到 ${meta.label}` })
          try {
            await this.#runGitTransport(job, 'release', {
              label: `推送 tag ${tag} → ${meta.label}`,
              signal,
              attempts: 2,
              run: (attempt) => git.pushTag(plugin.path, {
                url: remoteUrl,
                tag,
                token: ctx.token,
                username: pushUsernameFor(id, ctx.login || ''),
                signal,
                httpVersion: pushHttpVersion(attempt),
              }),
            })
            job.hostResults[id].tag = tag
            const client = this.#client(ctx.token, ctx.apiBase, id)
            const freshBody = form.releaseNotes || buildReleaseBody({ plugin, form, tag })
            let release = await client.getReleaseByTag(owner, form.name, tag)
            if (release) {
              const releaseId = Number(release.id)
              const previous = typeof release.body === 'string' ? release.body.trim() : ''
              if (previous === '') {
                release = await client.updateRelease(owner, form.name, releaseId, { body: freshBody }) || release
              } else if (!previous.includes(freshBody.trim()) && !previous.includes(tag)) {
                release = await client.updateRelease(owner, form.name, releaseId, { body: `${freshBody.trim()}${String.fromCharCode(10,10)}---${String.fromCharCode(10,10)}${previous}` }) || release
              }
            } else {
              try {
                release = await client.createRelease(owner, form.name, {
                  tagName: tag, name: tag, body: freshBody, targetCommitish: form.branch,
                })
              } catch (error) {
                const duplicate = error instanceof GitHubError
                  && (error.code === 'name-taken' || error.code === 'already-exists'
                    || /already[_ ]exists|already[ _]taken/i.test(`${error.message} ${JSON.stringify(error.details || {})}`))
                if (duplicate) {
                  release = await client.getReleaseByTag(owner, form.name, tag)
                } else {
                  // Tag is pushed; only the release page is missing. Report and move on.
                  this.#appendLog(job, 'warn', 'release', `${meta.label} Release 创建失败（tag 已推送）：${error.message}`)
                  this.#setHostStep(job, id, 'release', 'skipped', { detail: `tag ${tag} 已推送，Release 未创建` })
                  results.push(`${meta.label}: tag 已推送，Release 未创建`)
                  continue
                }
              }
            }
            const url = client.releaseUrl(owner, form.name, release, tag) || `${ctx.webBase}/${form.owner}/${form.name}/releases/tag/${tag}`
            job.hostResults[id].releaseUrl = url
            this.#setHostStep(job, id, 'release', 'done', { detail: url })
            results.push(`${meta.label}: ${url}`)
            if (!releaseUrl) releaseUrl = url
          } catch (error) {
            if (isAbort(error)) throw error
            const hr = job.hostResults[id]
            hr.status = 'failed'; hr.error = error.message; hr.code = error.code || null
            this.#setHostStep(job, id, 'release', 'failed', { detail: error.message, error })
            results.push(`${meta.label}: 失败（${error.message}）`)
          }
        }
        const ok = ready.filter((id) => ['done','skipped'].includes(job.hostResults[id].steps.release))
        if (ok.length === 0) throw new PublisherError('release-all-failed', results.join('；') || '所有平台 Release 失败')
        return { detail: `${ok.length}/${ready.length} 个平台完成`, log: results.join(' · ') }
      })

      if (hasStep('release')) {
        job.platformResults.github = {
          status: 'succeeded',
          owner: form.owner,
          repo: form.name,
          repoUrl: repoUrl || hostRepoUrl(form.owner, form.name),
          branch: form.branch,
          commitSha,
          tag,
          releaseUrl,
          createdRepo,
          pushed,
        }
      }

      // ── npm group ────────────────────────────────────────────────────────
      await step('npm-auth', async () => {
        const npmToken = this.#npmToken(config.platforms)
        if (!npmToken) {
          if (form.dryRun) {
            this.#setStep(job, 'npm-auth', 'skipped', { detail: '演练模式：跳过 npm 凭据校验' })
            return 'skipped'
          }
          throw new PublisherError('npm-no-token', '尚未配置 npm token：在「平台配置 → npm」里填入 Access Token')
        }
        job.npmToken = npmToken
        try {
          const verified = await npmVerify({ ...config.platforms.npm, token: npmToken })
          this.#appendLog(job, 'info', 'npm-auth', `npm 身份 @${verified.account.login}（${verified.hint}）`)
          return `@${verified.account.login}`
        } catch (error) {
          if (form.dryRun) {
            this.#setStep(job, 'npm-auth', 'skipped', { detail: `演练模式：npm 凭据未验证（${error.message}）` })
            return 'skipped'
          }
          throw error
        }
      })

      await step('npm-guard', async () => {
        const npmConfig = config.platforms.npm || {}
        const npmName = npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName })
        if (!npmName) throw new PublisherError('npm-name-missing', 'package.json 缺少 name，npm 无法发布')
        if (!isValidNpmName(npmName)) throw new PublisherError('npm-name-invalid', `发布用包名不合法：${npmName}（小写、无空格、可带 @scope）`)
        if (!plugin.version) throw new PublisherError('version-missing', 'package.json 缺少 version，npm 无法发布')
        try {
          const remote = await npmRemoteState({ name: npmName, registry: npmConfig.registry, token: job.npmToken })
          npmRemoteVersion = remote.exists ? remote.version : null
          npmUrl = remote.url
          // Only a duplicate version is illegal — and the same pure verdict the
          // preflight used decides it, so the panel can never advertise a publish
          // this guard then refuses. Publishing below the remote latest is legal
          // (verified against Verdaccio 7, which accepts it); the real hazard is
          // that the chosen dist-tag moves *backwards*, which is a warning.
          const verdict = versionGuardVerdict({ local: plugin.version, remote })
          if (!verdict.ok) {
            throw new PublisherError(
              'version-exists',
              `${npmName}@${plugin.version} 已发布过（远端最新 ${remote.version}）。npm 不允许重发同一个版本号：请把 package.json 的 version 提升到 ${verdict.next}（或更高）再发布。`,
              { status: 409 },
            )
          }
          if (verdict.reason === 'below-latest') {
            const tag = form.npmDistTag || 'latest'
            this.#appendLog(
              job,
              'warn',
              'npm-guard',
              `本次发布的 ${plugin.version} 低于远端最新 ${remote.version}：npm 会接受，但 ${tag} 标签会指向较低的 ${plugin.version}。想让 latest 前进请先提升到 ${verdict.next}。`,
            )
            return `远端最新 ${remote.version}，本次发布较低版本 ${plugin.version}`
          }
          if (verdict.reason === 'first-publish' || verdict.reason === 'no-local') return `首次发布 ${npmName}@${plugin.version}`
          return `远端 ${remote.version} → 本次 ${plugin.version}`
        } catch (error) {
          if (error && error.code === 'version-exists') throw error
          this.#appendLog(job, 'warn', 'npm-guard', `无法确认远端版本：${error.message}（继续发布，重复版本会由 registry 拒绝）`)
          return '版本未校验'
        }
      })

      await step('npm-publish', async () => {
        const npmConfig = config.platforms.npm || {}
        const npmName = npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName })
        const argv = ['publish', '--access', form.npmAccess || 'public', '--tag', form.npmDistTag || 'latest', '--registry', npmConfig.registry || DEFAULT_NPM_CONFIG.registry]
        if (form.npmOtp) argv.push('--otp', form.npmOtp)
        if (npmConfig.provenance) argv.push('--provenance')
        if (form.dryRun) argv.push('--dry-run')

        // A publish name that differs from the manifest is applied to a
        // throwaway copy: the repository keeps its own `package.json`, only the
        // tarball that reaches the registry carries the override.
        let stage = null
        try {
          // A registry refuses `private: true` with EPRIVATE, and a differing name
          // cannot be published from the source manifest either. Both cases go
          // through the throwaway copy; the source tree keeps its own guard flag.
          const sourcePrivate = await isPrivatePackage(plugin.path)
          if (npmName !== npmPackageNameOf(plugin) || sourcePrivate) {
            stage = await stageForNpmPublish(plugin.path, npmName)
            const what = stage.renamed
              ? `临时副本改名：${stage.previous} → ${npmName}`
              : '临时副本：去掉 private'
            this.#appendLog(job, 'info', 'npm-publish', `${what}（源码未改动）`)
          }
          const publishDir = stage ? stage.dir : plugin.path
          this.#appendLog(job, 'info', 'npm-publish', `npm ${argv.join(' ')}`) // OTP travels in argv, never persisted
          await runNpm(argv, {
            cwd: publishDir,
            registry: npmConfig.registry || DEFAULT_NPM_CONFIG.registry,
            token: job.npmToken,
            signal,
            log: (text) => {
              if (text.trim() !== '') this.#appendLog(job, 'info', 'npm-publish', text)
            },
          })
        } finally {
          if (stage) await stage.cleanup()
        }
        if (form.dryRun) {
          this.#setStep(job, 'npm-publish', 'skipped', { detail: '演练模式：npm publish --dry-run' })
          return '演练通过（未真正上传）'
        }
        npmPublished = true
        const url = `https://www.npmjs.com/package/${npmName}/v/${plugin.version}`
        this.#appendLog(job, 'success', 'npm-publish', `已发布 ${npmName}@${plugin.version}`)
        return { detail: `${npmName}@${plugin.version}`, log: url }
      })

      await step('npm-verify', async () => {
        if (form.dryRun) {
          this.#setStep(job, 'npm-verify', 'skipped', { detail: '演练模式：跳过回查' })
          return 'skipped'
        }
        const npmConfig = config.platforms.npm || {}
        const npmName = npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName })
        const registry = npmConfig.registry || DEFAULT_NPM_CONFIG.registry

        /*
         * npm indexes asynchronously: a 201 from `npm publish` means "accepted", not
         * "queryable". The old single-shot check therefore recorded successful
         * publishes as failures whenever the index had not caught up yet (observed
         * ~30s lag on this machine, six times in a row).
         *
         * Retry with backoff. The publish already succeeded, so waiting costs
         * nothing; reporting a failure that did not happen costs the user a
         * pointless re-run (and npm rejects republishing the same version).
         */
        const ATTEMPTS = 5
        const DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 25_000]
        let remote = null
        let lastError = null

        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
          if (attempt > 0) {
            const wait = DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)]
            this.#appendLog(job, 'info', 'npm-verify', `registry 尚未索引到 ${plugin.version}，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1}/${ATTEMPTS} 次）`)
            await new Promise((resolve) => { const t = setTimeout(resolve, wait); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true }) })
            guard()
          }
          try {
            remote = await npmRemoteState({ name: npmName, registry, token: job.npmToken })
          } catch (error) {
            // A network/registry hiccup is not a verdict on the publish.
            lastError = error
            continue
          }
          // `has`, not `version ===`: a lower version is a legal publish and it
          // does not become `dist-tags.latest` on every registry.
          if (remote.exists && remote.has(plugin.version)) {
            npmUrl = remote.url
            if (attempt > 0) this.#appendLog(job, 'success', 'npm-verify', `第 ${attempt + 1} 次回查命中，registry 已索引 ${plugin.version}`)
            return { detail: `registry 已收录 ${remote.version}`, log: npmUrl || '' }
          }
        }

        /*
         * Still absent after ~54s. Two different situations, and only one is the
         * user's problem:
         *   · the registry is reachable and the package/version genuinely is not
         *     there → the publish did not take, fail with the code;
         *   · the registry could not be read at all (every attempt errored) → say so
         *     instead of implying the publish failed.
         */
        if (lastError && (!remote || !remote.exists)) {
          throw new PublisherError(
            'npm-verify-unreachable',
            `发布已提交，但回查时 registry 无法访问（${lastError.message}）。${npmName}@${plugin.version} 通常仍在索引中，稍后可在 ${registry} 确认；发布本身没有被判失败`,
          )
        }
        throw new PublisherError(
          'npm-verify-failed',
          remote && remote.exists
            ? `回查 registry 得到版本 ${remote.version}，本次 ${plugin.version} 不在其中（已重试 ${ATTEMPTS} 次、约 54 秒）`
            : `回查 registry 仍找不到 ${npmName}（已重试 ${ATTEMPTS} 次、约 54 秒），本次 ${plugin.version} 未发布成功`,
        )
      })

      if (hasStep('npm-verify')) {
        job.platformResults.npm = {
          status: form.dryRun ? 'dry-run' : 'succeeded',
          name: npmPublishNameOf(npmPackageNameOf(plugin), { publishName: form.publishName }),
          manifestName: npmPackageNameOf(plugin),
          version: plugin.version,
          access: form.npmAccess,
          distTag: form.npmDistTag,
          registry: (config.platforms.npm || {}).registry || DEFAULT_NPM_CONFIG.registry,
          previousVersion: npmRemoteVersion,
          published: npmPublished,
          url: npmUrl,
        }
      }

      await step('finish', async () => {
        /**
         * Aggregate the per-hosting outcomes.
         *
         * `partial` is a first-class state, not a rounding of success: with several
         * remotes, "GitHub got the code but Gitee rejected the push" must not read
         * as either a clean success or a total failure. `hostSummary` carries the
         * per-platform detail so the UI can say which one broke and why.
         */
        const hostSummary = hosts.map((id) => {
          const hr = job.hostResults[id] || {}
          const meta = providerOf(id)
          const steps = hr.steps || {}
          /*
            * Release satisfaction is per-hosting, not per-plan.
            *
            * `release` always exists in the job plan, so asking "was the step
            * scheduled" is useless. When the operator turns Release off, the step
            * short-circuits to skipped before touching any hosting, leaving each
            * `steps.release` at its initial 'pending' — which the old code read as
            * unfinished work and reported every hosting as partial.
            *
            * Only an actual failure leaves a hosting short.
            */
          const releaseOk = steps.release === 'done'
            || steps.release === 'skipped'
            || steps.release === 'pending'
          const pushed = hr.pushed === true
          const repoOk = steps.repo === 'done'
          let status = 'failed'
          if (job.dryRun) {
            // A rehearsal never reaches the remote, so "nothing was pushed" is the
            // expected outcome, not a failure: the point of a dry run is that the
            // whole pipeline walks through without touching anything.
            status = 'skipped'
          } else if (repoOk && pushed && releaseOk) status = 'succeeded'
          else if (repoOk || pushed) status = 'partial'
          else if (steps.repo === 'skipped' && !hr.error) status = 'skipped'
          return {
            id,
            label: meta ? meta.label : id,
            status,
            repoUrl: hr.repoUrl || '',
            releaseUrl: hr.releaseUrl || '',
            tag: hr.tag || '',
            createdRepo: hr.createdRepo === true,
            pushed,
            steps: { ...steps },
            error: hr.error || null,
            code: hr.code || null,
          }
        })
        const succeededCount = hostSummary.filter((entry) => entry.status === 'succeeded').length
        const failedCount = hostSummary.filter((entry) => entry.status === 'failed').length

        const result = {
          platforms: job.platforms,
          platformsLabel: platformLabelList(job.platforms),
          owner: form.owner,
          repo: form.name,
          repoUrl: repoUrl || (job.platforms.some((id) => HOSTING_PLATFORM_IDS.includes(id)) ? hostRepoUrl(form.owner, form.name) : ''),
          branch: form.branch,
          commitSha,
          tag,
          releaseUrl,
          createdRepo,
          pushed,
          dryRun: form.dryRun === true,
          files: written.map((entry) => ({ file: entry.file, action: entry.action, bytes: entry.bytes })),
          version: plugin.version,
          license: form.license,
          topics: form.topics,
          npm: job.platformResults.npm || null,
          perPlatform: { ...job.platformResults },
          /** The per-hosting outcome table — what the result card renders. */
          hosts: hostSummary,
          hostedOk: succeededCount,
          hostedFailed: failedCount,
          finishedAt: Date.now(),
        }
        job.result = result
        await this.#store.appendHistory({
          id: `hist_${job.jobId}`,
          at: Date.now(),
          path: plugin.path,
          name: plugin.name,
          owner: form.owner,
          repo: form.name,
          repoUrl: result.repoUrl,
          releaseUrl,
          version: plugin.version,
          commitSha,
          tag,
          platforms: job.platforms,
          hosts: hostSummary,
          npmUrl: job.platformResults.npm ? job.platformResults.npm.url : null,
          npmVersion: job.platformResults.npm ? job.platformResults.npm.version : null,
          status: failedCount > 0 ? 'partial' : 'succeeded',
          dryRun: result.dryRun,
          files: written.map((entry) => entry.file),
          // Whose plugin this was, and whether the operator had to vouch for it.
          // Forked plugins legitimately carry another author, so the publish
          // itself must not be blocked — but the record has to show that
          // somebody confirmed it rather than that nobody noticed.
          ownership: ownershipStamp(preflight),
          error: null,
        })
        const summaryLine = hostSummary.length > 0
          ? hostSummary.map((entry) => `${entry.label}: ${entry.status}`).join(' · ')
          : ''
        this.#appendLog(job, failedCount > 0 ? 'warn' : 'success', 'finish', job.dryRun
          ? `演练完成：本地提交 ${commitSha ? commitSha.slice(0, 7) : '无'}，未创建远端仓库、未 publish npm`
          : `发布完成：${platformLabelList(job.platforms)}${summaryLine ? `（${summaryLine}）` : ''}`)
        return { detail: failedCount > 0 ? `${succeededCount}/${hostSummary.length} 个仓库平台成功` : '完成', log: summaryLine }
      })

      /**
       * Final job status. `partial` when at least one hosting got everything and
       * at least one did not: reporting `succeeded` would hide a real failure,
       * reporting `failed` would discard work that is actually live on a remote.
       */
      const hostStatuses = job.result && Array.isArray(job.result.hosts) ? job.result.hosts : []
      const anyOk = hostStatuses.some((entry) => entry.status === 'succeeded' || entry.status === 'partial')
      const anyBad = hostStatuses.some((entry) => entry.status === 'failed')
      job.status = anyOk && anyBad ? 'partial' : 'succeeded'
      job.endedAt = Date.now()
      const label = job.status === 'partial' ? '部分平台完成' : '发布成功'
      this.#appendLog(job, job.status === 'partial' ? 'warn' : 'success', 'job', `${label}，用时 ${formatDuration(job.endedAt - job.startedAt)}`)
    } catch (error) {
      const cancelled = isAbort(error) || job.cancelled
      job.status = cancelled ? 'cancelled' : 'failed'
      job.endedAt = Date.now()
      job.error = cancelled
        ? { code: 'cancelled', message: '发布已取消', step: job.step }
        : { code: error.code || 'internal', message: error.message, step: job.step, details: error.details || null }
      for (const stepEntry of job.steps) {
        if (stepEntry.status === 'running') stepEntry.status = cancelled ? 'skipped' : 'failed'
        if (stepEntry.status === 'pending') stepEntry.status = 'skipped'
      }
      this.#appendLog(job, cancelled ? 'warn' : 'error', job.step, cancelled ? '发布已取消（已写入的文件保留在本地，未回滚）' : error.message)
      try {
        await this.#store.appendHistory({
          id: `hist_${job.jobId}`,
          at: Date.now(),
          path: job.path,
          name: job.pluginName,
          owner: preflight.form.owner,
          repo: preflight.form.name,
          repoUrl: null,
          releaseUrl: null,
          version: preflight.plugin.version,
          commitSha: null,
          tag: null,
          platforms: job.platforms,
          npmUrl: null,
          npmVersion: null,
          status: job.status === 'cancelled' ? 'cancelled' : 'failed',
          dryRun: job.dryRun,
          files: [],
          error: job.error ? { code: job.error.code, message: job.error.message } : null,
        })
      } catch {
        /* history is best-effort */
      }
    } finally {
      job.token = null
      job.npmToken = null
      if (this.#activeJobId === job.jobId) this.#activeJobId = null
      this.#pruneJobs()
    }
  }

  #pruneJobs() {
    for (const [id, job] of this.#jobs) {
      if (id === this.#activeJobId) continue
      if (job.status === 'running' || job.status === 'queued') continue
      job.abort = null
    }
    const completed = [...this.#jobs.values()]
      .filter((job) => job.status !== 'running' && job.status !== 'queued' && job.jobId !== this.#activeJobId)
      .sort((left, right) => (right.endedAt || right.startedAt) - (left.endedAt || left.startedAt))
    for (const job of completed.slice(JOB_RETENTION)) this.#jobs.delete(job.jobId)
  }

  /** Snapshot of one job (or the most recent one) with the token field removed. */
  getJob(jobId = null) {
    const job = jobId ? this.#jobs.get(jobId) : [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
    return job ? snapshotJob(job) : null
  }

  listJobs() {
    return [...this.#jobs.values()].map(snapshotJob)
  }

  cancel(jobId = null) {
    const job = jobId ? this.#jobs.get(jobId) : [...this.#jobs.values()].find((entry) => entry.status === 'running')
    if (!job || job.status !== 'running') return false
    job.cancelled = true
    try {
      job.abort.abort()
    } catch {
      /* already aborted */
    }
    this.#appendLog(job, 'warn', job.step, '收到取消请求…')
    return true
  }

  /* ── history ──────────────────────────────────────────────────────────── */

  async clearHistory() {
    return this.#store.clearHistory()
  }

  async saveDraft(pluginPath, form) {
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') throw new PublisherError('bad-request', '缺少插件目录 path')
    const resolved = path.resolve(pluginPath.trim())
    const drafts = await this.#store.saveDraft(resolved, form === null ? null : form)
    if (Object.keys(drafts).length > DRAFTS_MAX) throw new PublisherError('bad-request', '草稿过多')
    return drafts
  }

  /* ── version bump ──────────────────────────────────────────────────────── */

  /**
   * Bump the version everywhere it is declared.
   *
   * `package.json` is the single source of truth; the client's `CLIENT_VERSION`,
   * the Host's `VERSION` and the GitHub User-Agent follow it. Bumping only the
   * manifest used to leave the tarball contradicting itself (manifest says 0.4.0,
   * `/api/health` says 0.3.x), so this rewrite is all-or-nothing: the manifest
   * is written last, after every follower already accepted the new value.
   */
  async bumpVersion({ path: pluginPath, mode = 'patch', version = null, sync = true } = {}) {
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') throw new PublisherError('bad-request', '缺少插件目录 path')
    const resolved = path.resolve(pluginPath.trim())
    const file = path.join(resolved, 'package.json')
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    if (text === null) throw new PublisherError('not-found', `找不到 package.json：${file}`, { status: 404 })
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch (error) {
      throw new PublisherError('bad-request', `package.json 无法解析：${error.message}`)
    }
    const current = typeof manifest.version === 'string' ? manifest.version.trim() : ''
    const next = version ? normalizeVersionInput(version) : bumpVersionString(current, mode)
    if (next === current) throw new PublisherError('bad-request', `版本没有变化（当前 ${current || '空'}）`)

    // Followers first: a follower write that fails must not leave the manifest
    // claiming a version nothing else agrees with.
    let followers = []
    if (sync) {
      const drift = await inspectVersionDrift(resolved, next)
      followers = drift.drifted.map((entry) => ({ rel: entry.rel, from: entry.version, to: next }))
      await syncVersionDeclarations(resolved, next)
    }

    manifest.version = next
    const indent = detectIndent(text)
    const updated = `${JSON.stringify(manifest, null, indent)}\n`
    await fsp.writeFile(file, updated, 'utf8')
    return {
      path: resolved,
      file,
      mode: version ? 'set' : mode,
      previous: current,
      version: next,
      changed: true,
      diff: { from: current, to: next },
      synced: followers,
    }
  }

  /* ── cross-platform sync matrix ────────────────────────────────────────── */

  /**
   * Compare the local version with every platform's remote state and return a
   * drift table: which platform is behind, which is in sync, which is unreachable.
   * Read-only — the actual re-publish is the normal publish path with only the
   * drifting platforms selected.
   */
  async syncPlan({ path: pluginPath } = {}) {
    if (typeof pluginPath !== 'string' || pluginPath.trim() === '') throw new PublisherError('bad-request', '缺少插件目录 path')
    const resolved = path.resolve(pluginPath.trim())
    const stat = await fsp.stat(resolved).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new PublisherError('not-found', `插件目录不存在：${resolved}`, { status: 404 })
    const plugin = await inspectPlugin(resolved)
    const config = await this.#store.loadConfig()
    const local = typeof plugin.version === 'string' ? plugin.version : ''
    const rows = []

    // GitHub: read the remote repository's most recent release/tag state.
    const tokenInfo = await this.resolveToken({ detect: config.autoDetectToken !== false })
    let account = null
    if (tokenInfo) {
      try {
        account = await this.validateToken(tokenInfo)
      } catch {
        account = null
      }
    }
    const owner = account && account.login ? account.login : ''
    const repoName = sanitizeRepoName(plugin.name)
    if (owner) {
      try {
        const client = this.#client(tokenInfo.token, trimBase(config.defaults.apiBase))
        const repo = await client.getRepo(owner, repoName)
        if (repo) {
          const release = await client.getLatestRelease(owner, repoName).catch(() => null)
          const rawTag = release && (release.tag_name || release.tagName)
          const remoteVersion = typeof rawTag === 'string' ? rawTag.replace(/^v/, '') : null
          rows.push({
            platform: 'github',
            label: 'GitHub',
            local,
            remote: remoteVersion,
            url: repo.htmlUrl || null,
            state: compareSyncState(local, remoteVersion),
            // The same tag already exists: GitHub reuses that Release instead of
            // creating a new one, so the same hazard as an npm duplicate.
            occupied: Boolean(local && remoteVersion && compareVersions(local, remoteVersion) === 0),
            detail: repo.htmlUrl || `${owner}/${repoName}`,
          })
        } else {
          rows.push({ platform: 'github', label: 'GitHub', local, remote: null, url: null, state: 'absent', detail: `仓库 ${owner}/${repoName} 尚未创建` })
        }
      } catch (error) {
        rows.push({ platform: 'github', label: 'GitHub', local, remote: null, url: null, state: 'unknown', detail: error.message })
      }
    } else {
      rows.push({ platform: 'github', label: 'GitHub', local, remote: null, url: null, state: 'unknown', detail: '未连接 GitHub 账号' })
    }

    // npm: read the registry's latest published version.
    const npmConfig = config.platforms.npm || {}
    const npmToken = this.#npmToken(config.platforms)
    // This plugin's own draft decides its npm name; the global platform config
    // deliberately does not (see npmPublishNameOf).
    const drafts = await this.#store.loadDrafts()
    const draft = drafts[resolved] || {}
    const npmName = npmPublishNameOf(npmPackageNameOf(plugin), { publishName: draft.publishName })
    if (npmName) {
      try {
        const remote = await npmRemoteState({ name: npmName, registry: npmConfig.registry, token: npmToken || null })
        const occupied = Boolean(remote.exists && remote.has(local))
        const belowLatest = Boolean(remote.exists && local && compareVersions(local, remote.version) < 0)
        rows.push({
          platform: 'npm',
          label: 'npm registry',
          local,
          remote: remote.exists ? remote.version : null,
          url: remote.url || null,
          state: remote.exists ? compareSyncState(local, remote.version) : 'absent',
          occupied,
          belowLatest,
          detail: remote.exists
            ? occupied
              ? `${npmName}@${local} 已发布过，需先 bump`
              : belowLatest
                ? `${npmName}@${remote.version} 更新；本次 ${local} 低于它`
                : `${npmName}@${remote.version}`
            : `${npmName} 尚未发布`,
        })
      } catch (error) {
        rows.push({ platform: 'npm', label: 'npm registry', local, remote: null, url: null, state: 'unknown', detail: error.message })
      }
    }

    const behind = rows.filter((row) => row.state === 'behind' || row.state === 'absent').map((row) => row.platform)
    const occupied = rows.filter((row) => row.occupied === true).map((row) => row.platform)
    const belowLatest = rows.filter((row) => row.belowLatest === true).map((row) => row.platform)
    // `behind` alone used to drive this, but a platform whose remote version is
    // *ahead* of the local one also blocks the version from moving forward, and a
    // version that is already taken blocks the publish outright. Neither showed
    // up in `behind`, so the panel said "nothing to do" while preflight failed.
    const highestRemote = rows.reduce(
      (max, row) => (row.remote && (!max || compareVersions(row.remote, max) > 0) ? row.remote : max),
      null,
    )
    const bumpNeeded = occupied.length > 0 || belowLatest.length > 0
    return {
      path: resolved,
      name: plugin.name,
      version: local,
      platforms: rows,
      behind,
      occupied,
      belowLatest,
      inSync: rows.filter((row) => row.state === 'in-sync').map((row) => row.platform),
      needsBump: bumpNeeded,
      bumpSuggestion: bumpNeeded ? nextVersionAbove(local, highestRemote) : null,
      checkedAt: Date.now(),
    }
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const STEP_TITLES = Object.freeze({
  auth: '校验 GitHub 账号',
  inspect: '读取插件信息',
  prepare: '完善仓库文件',
  repo: '创建 / 复用仓库',
  topics: '设置 topics',
  commit: '提交 git 版本',
  push: '推送到 GitHub',
  release: '创建 tag 与 Release',
  'npm-auth': '校验 npm 凭据',
  'npm-guard': '版本守卫（npm 不允许重发同名版本）',
  'npm-publish': 'npm publish',
  'npm-verify': '回查 npm registry',
  finish: '写入发布记录',
})

/** "GitHub + npm registry" — the label used by the publish button and logs. */
export function platformLabelList(selected) {
  const list = normalizeSelection(selected)
  return list.map((id) => {
    const meta = platformMeta(id)
    return meta ? meta.label : id
  }).join(' + ')
}

/** The npm package name a plugin publishes under. */
export function npmPackageNameOf(plugin) {
  const value = plugin && typeof plugin.name === 'string' ? plugin.name.trim() : ''
  return value === '' ? '' : value
}

/** One-line description of what the publish action will do. */
function describeAction(selected, repoCheck, form, npmState, plugin, npmConfig) {
  const parts = []
  if (selected.includes('github')) {
    parts.push(repoCheck?.exists ? `更新已有仓库 ${form.owner}/${form.name}` : `在 ${form.owner} 下创建仓库 ${form.name}`)
  }
  if (selected.includes('npm')) {
    const manifestName = npmPackageNameOf(plugin)
    const name = npmPublishNameOf(manifestName, { publishName: form.publishName })
    const renamed = name !== manifestName ? `（源码 ${manifestName}，发布时改名）` : ''
    const occupied = Boolean(npmState && plugin.version && npmState.has(plugin.version))
    const belowLatest = Boolean(npmState && plugin.version && compareVersions(plugin.version, npmState.version) < 0)
    const tail = belowLatest ? `（${plugin.version} 低于远端 latest ${npmState.version}，latest 会退回）` : ''
    parts.push(
      occupied
        ? `npm ${name}@${plugin.version} 需要先 bump 版本`
        : `npm publish ${name}@${plugin.version || '?'}（${form.npmAccess}）${renamed}${tail}`,
    )
  }
  return parts.length > 0 ? parts.join('；') : '未选择平台'
}

function releaseTag(prefix, version) {
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim() : 'v'
  const cleanVersion = String(version || '').trim()
  if (cleanPrefix === '') return cleanVersion
  return cleanVersion.startsWith(cleanPrefix) ? cleanVersion : `${cleanPrefix}${cleanVersion}`
}

function buildReleaseBody({ plugin, form, tag }) {
  const lines = []
  const zh = form.descriptionZh || plugin.descriptionZh
  if (zh) lines.push(zh, '')
  if (form.description) lines.push(form.description, '')
  lines.push(`- 版本：${plugin.version || 'unknown'}（${tag}）`)
  lines.push(`- 许可证：${form.license === 'none' ? '未声明' : form.license}`)
  if (Array.isArray(form.topics) && form.topics.length > 0) lines.push(`- 关键词：${form.topics.join(', ')}`)
  lines.push('')
  lines.push(`安装：\`plugin_manager action=install_bundle target=<解压目录>/${form.name}\``)
  return lines.join('\n')
}

function snapshotJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    path: job.path,
    pluginName: job.pluginName,
    platforms: job.platforms ? job.platforms.slice() : [],
    step: job.step,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    steps: job.steps.map((step) => ({ ...step })),
    logs: job.logs.slice(),
    result: job.result,
    platformResults: { ...(job.platformResults || {}) },
    error: job.error,
    dryRun: job.dryRun,
  }
}

function publicPlugin(plugin) {
  const copy = { ...plugin }
  delete copy.manifestText
  return copy
}

/**
 * The ownership fact frozen into a publish record.
 *
 * Kept small on purpose: history is a log, not a second copy of the manifest.
 * `confirmed` is the part that matters — it says a human looked at "author is
 * somebody else" and said yes.
 */
function ownershipStamp(preflight) {
  const ownership = preflight && preflight.ownership ? preflight.ownership : null
  if (!ownership) return null
  return {
    status: ownership.status || 'none',
    author: ownership.author || '',
    account: ownership.login || '',
    repositoryOwner: ownership.owner || '',
    npmScope: ownership.scope || '',
    scopeDrift: ownership.scopeDrift === true,
    confirmed: ownership.confirmed === true,
    confirmedAt: ownership.confirmed === true ? Date.now() : null,
  }
}

function applyPublished(plugins, history) {
  const lastByPath = new Map()
  const npmByPath = new Map()
  for (const entry of history) {
    if (!entry || entry.status !== 'succeeded' || !entry.path) continue
    if (!lastByPath.has(entry.path)) lastByPath.set(entry.path, entry)
    const platforms = Array.isArray(entry.platforms) ? entry.platforms : (entry.repoUrl ? ['github'] : [])
    if (platforms.includes('npm') && !npmByPath.has(entry.path)) npmByPath.set(entry.path, entry)
  }
  return plugins.map((plugin) => {
    const entry = lastByPath.get(plugin.path)
    const npmEntry = npmByPath.get(plugin.path) || null
    if (!entry && !npmEntry) return plugin
    const platforms = entry && Array.isArray(entry.platforms)
      ? entry.platforms.slice()
      : (entry && entry.repoUrl ? ['github'] : [])
    if (npmEntry && !platforms.includes('npm')) platforms.push('npm')
    return {
      ...plugin,
      publishedPlatforms: platforms,
      published: {
        platforms: platforms,
        repoUrl: entry ? entry.repoUrl : null,
        releaseUrl: entry ? (entry.releaseUrl || null) : null,
        npmUrl: npmEntry ? (npmEntry.npmUrl || null) : null,
        npmVersion: npmEntry ? (npmEntry.npmVersion || null) : null,
        lastPublishedAt: (entry || npmEntry).at,
        lastVersion: (entry || npmEntry).version || null,
        lastOwner: entry ? (entry.owner || null) : null,
        lastRepo: entry ? (entry.repo || null) : null,
      },
    }
  })
}

/** Same-origin-ish base URL validation used by settings and form planning. */
export function normalizeBaseUrl(value, key) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  if (text === '') return key === 'gitBase' ? 'https://github.com' : 'https://api.github.com'
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new PublisherError('bad-request', `${key} 不是合法 URL：${text}`)
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  // file:// is accepted for gitBase only: it lets users and tests push into a
  // local bare repository (dry-run-style rehearsal) without any network.
  if (key === 'gitBase' && parsed.protocol === 'file:') {
    return parsed.href.replace(/\/+$/, '')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new PublisherError('bad-request', `${key} 必须是 https:// 地址（本机测试可用 http://127.0.0.1，gitBase 可用 file://）`)
  }
  return parsed.toString().replace(/\/+$/, '')
}

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

/** Detect the indent width of an existing JSON document (2 is the default). */
function detectIndent(text) {
  const match = /^\{\s*\n([ \t]+)/.exec(String(text || ''))
  if (!match) return 2
  const unit = match[1]
  return unit.includes('\t') ? '\t' : Math.min(Math.max(unit.length, 1), 8)
}

/** Validate and normalise an explicit `set` version input. */
function normalizeVersionInput(value) {
  const text = String(value || '').trim().replace(/^v/, '')
  if (!/^[0-9]+(\.[0-9]+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(text)) {
    throw new PublisherError('bad-request', `版本号不合法：${value}（示例：1.2.3 / 1.2.3-beta.1）`)
  }
  return text
}

/**
 * The single verdict on whether a version may be published to npm.
 *
 * Preflight and the publish-time guard both consume this, so the panel can never
 * promise a publish the guard then refuses (or vice versa) — the divergence that
 * produced "版本 0.3.4 已存在于 npm" for a version that was never published.
 *
 * `remote` is an `npmRemoteState` result: `{ exists, version, versions, has }`.
 *
 *   no-local     — the manifest has no version; a separate check reports that.
 *   first-publish— the name is free.
 *   duplicate    — this exact version already exists: npm rejects it. Blocking.
 *   below-latest — free, but older than the remote latest. Legal to publish;
 *                  the chosen dist-tag then moves *backwards*. Warning only.
 *   ahead        — free and newer than the remote latest.
 */
/**
 * A stable identity for "whose plugin is this, as far as the confirmation cares".
 *
 * Deliberately excludes the account: signing in as somebody else should not
 * silently re-use a confirmation given under the previous identity. It includes
 * the declared author and the repo owner, because those are the two facts the
 * operator actually looked at when they ticked the box.
 */
export function ownershipFingerprint(ownership, repoOwner) {
  const verdict = ownership && typeof ownership === 'object' ? ownership : {}
  const author = String(verdict.author || '').trim().toLowerCase()
  const owner = String(repoOwner || verdict.owner || '').trim().toLowerCase()
  if (author === '' && owner === '') return ''
  return `${author}|${owner}`
}

/**
 * Whether a previously stored confirmation still applies.
 *
 * `rememberedFor` is the fingerprint captured when the box was ticked.
 *
 * Three shapes are possible, and they must not be conflated:
 *   · `true` / `undefined` — a draft written before fingerprints existed. It was
 *     still a deliberate act, so it is honoured rather than silently dropped.
 *   · a non-empty string — compare it against the current fingerprint.
 *   · the empty string — an explicit "forgotten"; it matches nothing.
 */
export function ownershipRememberedFor(rememberedFor, fingerprint) {
  if (typeof rememberedFor === 'string') {
    return rememberedFor !== '' && rememberedFor === (fingerprint || '')
  }
  return true
}

/**
 * Whose plugin is this before it goes out under the current account?
 *
 * The point is not to police forking — an author field that still names the
 * original project, or a repo that predates the fork, is completely normal.
 * The point is that the panel currently shows *no* author at all, so publishing
 * someone else's plugin under your own name is a one-click mistake that leaves
 * no trace. This returns a verdict the UI renders and the operator can override.
 *
 * Deliberately never `fail`: a mismatch must not block a legitimate publish,
 * because the common case for a mismatch is "I am the one who forked it".
 *
 *   none        — no author declared at all
 *   own         — author name/email matches the account (incl. GitHub noreply)
 *   fork        — author differs, but the account owns the target repository
 *   foreign     — author differs and nothing ties it to the account
 */
export function ownershipVerdict({ author = null, accountLogin = '', repositoryOwner = '', npmScope = '' } = {}) {
  const text = typeof author === 'string' ? author.trim() : ''
  const parts = typeof author === 'object' && author !== null ? author : null
  const name = parts ? String(parts.name || '').trim() : ''
  const email = parts ? String(parts.email || '').trim() : ''
  const login = String(accountLogin || '').trim().toLowerCase()
  const owner = String(repositoryOwner || '').trim().toLowerCase()
  const scope = String(npmScope || '').trim().replace(/^@/, '').toLowerCase()
  const declaredName = name || text.replace(/<[^>]*>/g, '').trim()
  const declaredEmail = email || (/<([^>]*)>/.exec(text) || [])[1] || ''
  if (declaredName === '' && declaredEmail === '') return { status: 'none', author: '', login, owner, scope, scopeDrift: false, reason: 'no-author' }
  const lowerName = declaredName.toLowerCase()
  const lowerEmail = declaredEmail.toLowerCase()
  // GitHub's noreply addresses embed the login: `1234+login@users.noreply.github.com`
  // or the older `login@users.noreply.github.com`.
  const noreplyLogin = /^(?:[0-9]+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(lowerEmail)
  const matchesLogin = (value) => login !== '' && value === login
  const tied =
    matchesLogin(lowerName) ||
    (noreplyLogin !== null && matchesLogin(noreplyLogin[1])) ||
    (lowerEmail !== '' && login !== '' && lowerEmail.indexOf(`${login}@`) === 0)
  const sameAsOwner = owner !== '' && (lowerName === owner || (noreplyLogin !== null && noreplyLogin[1] === owner))
  // npm records the *scope* owner as the package author; a different scope is
  // worth saying out loud even when GitHub ownership is consistent.
  const scopeDrift = scope !== '' && login !== '' && scope !== login
  if (tied) {
    return { status: 'own', author: declaredName, login, owner, scope, scopeDrift, reason: 'matches-account' }
  }
  if (login !== '' && (matchesLogin(owner) || sameAsOwner)) {
    return { status: 'fork', author: declaredName, login, owner, scope, scopeDrift, reason: 'account-owns-repo' }
  }
  return { status: 'foreign', author: declaredName, login, owner, scope, scopeDrift, reason: 'author-not-tied-to-account' }
}

export function versionGuardVerdict({ local, remote } = {}) {
  const version = String(local === undefined || local === null ? '' : local).trim()
  if (!version) return { ok: true, reason: 'no-local', next: null }
  if (!remote || !remote.exists) return { ok: true, reason: 'first-publish', next: null }
  const has = typeof remote.has === 'function' ? remote.has(version) : false
  if (has) return { ok: false, reason: 'duplicate', next: nextVersionAbove(version, remote.version) }
  if (remote.version && compareVersions(version, remote.version) < 0) {
    return { ok: true, reason: 'below-latest', next: nextVersionAbove(version, remote.version) }
  }
  return { ok: true, reason: 'ahead', next: null }
}

/** `1.2.3` + patch/minor/major → the next version, tolerant of pre-release tails. */export function bumpVersionString(current, mode) {
  const base = String(current || '0.0.0').trim().replace(/^v/, '')
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?(?:[-+].*)?$/.exec(base)
  if (!match) throw new PublisherError('bad-request', `无法解析现有版本号：${current}`)
  let major = Number(match[1] || 0)
  let minor = Number(match[2] || 0)
  let patch = Number(match[3] || 0)
  const which = String(mode || 'patch')
  if (which === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (which === 'minor') {
    minor += 1
    patch = 0
  } else if (which === 'patch') {
    patch += 1
  } else {
    throw new PublisherError('bad-request', `未知的版本模式：${mode}（可用 patch / minor / major / set）`)
  }
  return `${major}.${minor}.${patch}`
}

/** Compare a local version with a remote one into a drift state. */
function compareSyncState(local, remote) {
  if (!remote) return 'absent'
  if (!local) return 'unknown'
  const order = compareVersions(local, remote)
  if (order === 0) return 'in-sync'
  return order > 0 ? 'behind' : 'ahead'
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/** Remove secrets (tokens, long alphanumerics that look like tokens) from text. */
export function redactSecrets(text, secrets = []) {
  let value = String(text === undefined || text === null ? '' : text)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) value = value.split(secret).join('***')
  }
  return value
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\b[A-Za-z0-9]{40,}\b/g, (match) => (match.includes('@') ? match : '***'))
}

/** Discover scan roots without reaching into scanner internals from callers. */
export async function discoverRootsFor({ settings, env = process.env, workspacePaths = [], roots = null }) {
  const { discoverRoots } = await import('./scanner.mjs')
  if (Array.isArray(roots) && roots.length > 0) {
    const extraSettings = { scanRoots: roots.map((entry) => path.resolve(entry)) }
    return discoverRoots({
      settings: extraSettings,
      profileDir: env.DSH_PROFILE_DIR || (env.DSH_HOME ? path.join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : null),
      workspacePaths,
      cwd: env.DSH_GITHUB_PUBLISHER_CWD || process.cwd(),
    })
  }
  return discoverRoots({
    settings,
    profileDir: env.DSH_PROFILE_DIR || (env.DSH_HOME ? path.join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : null),
    workspacePaths,
    cwd: env.DSH_GITHUB_PUBLISHER_CWD || process.cwd(),
  })
}

async function scanWithRoots(roots) {
  const { scanPlugins } = await import('./scanner.mjs')
  return scanPlugins(roots, { maxDepth: 3, maxDirs: 400 })
}

/** Read identity defaults straight from git config (used by the UI form). */
export async function readGitIdentity(cwd = process.cwd()) {
  const name = await git.configGet(cwd, 'user.name', { global: true })
  const email = await git.configGet(cwd, 'user.email', { global: true })
  return { name: name || '', email: email || '' }
}
