/**
 * dsh-multi-publisher — Host persistence.
 *
 * One small JSON store under `$DSH_HOME/github-publisher/` (kept at the historic
 * path so an existing GitHub token / account cache keeps working):
 *   config.json   settings + platforms + (only when the user saves it) tokens, 0600
 *   history.json  the last 50 publish records
 *   drafts.json   per-plugin form drafts, so half-filled release info survives
 *
 * Writes are atomic (tmp file + rename) and a corrupt file is backed up instead
 * of crashing the plugin. Node builtins only.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_PLATFORM_CONFIG, normalizePlatforms } from './platforms.mjs'

export const HISTORY_MAX = 50
export const DRAFTS_MAX = 200

/** License ids accepted by the publish form. */
export const LICENSE_IDS = Object.freeze(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'none'])

/** Visibility values accepted by the publish form. */
export const VISIBILITY_IDS = Object.freeze(['public', 'private'])

/** Everything the publish form starts from; also the settings.defaults shape. */
export const DEFAULT_DEFAULTS = Object.freeze({
  visibility: 'public',
  license: 'MIT',
  branch: 'main',
  tagPrefix: 'v',
  createRelease: true,
  addReadme: true,
  // Updating a published plugin must never rewrite its docs: append the
  // changelog instead. `regenerate` stays available as an explicit opt-in.
  readmeMode: 'append',
  addLicense: true,
  addGitignore: true,
  updatePackageJson: true,
  commitMessage: 'chore: publish {name} v{version}',
  authorName: '',
  authorEmail: '',
  apiBase: 'https://api.github.com',
  gitBase: 'https://github.com',
  repoExistsStrategy: 'reuse',
  topicPreset: ['deepseek', 'dsh', 'dsh-plugin'],
  platforms: ['github'],
  npmAccess: 'public',
  npmDistTag: 'latest',
})

/** The complete persisted config document shape. */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  token: null,
  account: null,
  defaults: DEFAULT_DEFAULTS,
  platforms: DEFAULT_PLATFORM_CONFIG,
  scanRoots: [],
  autoDetectToken: true,
  updatedAt: 0,
})

/**
 * Resolve the data directory. `DSH_GITHUB_PUBLISHER_DIR` is the explicit
 * override used by tests and by users who keep their DSH home elsewhere.
 */
export function resolveDataDir(env = process.env) {
  const override = typeof env.DSH_GITHUB_PUBLISHER_DIR === 'string' ? env.DSH_GITHUB_PUBLISHER_DIR.trim() : ''
  if (override) return path.resolve(override)
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'github-publisher')
}

/** Coerce arbitrary JSON into a valid config document (unknown keys dropped). */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const defaults = source.defaults && typeof source.defaults === 'object' ? source.defaults : {}
  const merged = { ...DEFAULT_DEFAULTS }
  for (const key of Object.keys(DEFAULT_DEFAULTS)) {
    if (defaults[key] === undefined) continue
    merged[key] = coerceDefault(key, defaults[key])
  }
  const account = normalizeAccountCache(source.account)
  const token = typeof source.token === 'string' && source.token.trim() !== '' ? source.token.trim() : null
  return {
    version: 1,
    token,
    account,
    defaults: merged,
    platforms: normalizePlatforms(source.platforms),
    scanRoots: Array.isArray(source.scanRoots)
      ? [...new Set(source.scanRoots.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => path.resolve(entry)))]
      : [],
    autoDetectToken: source.autoDetectToken !== false,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

/** Cached identity for a validated token, keyed by a token fingerprint. */
export function normalizeAccountCache(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const login = typeof raw.login === 'string' ? raw.login : ''
  if (login === '') return null
  return {
    login,
    id: Number.isFinite(raw.id) ? raw.id : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '',
    htmlUrl: typeof raw.htmlUrl === 'string' ? raw.htmlUrl : '',
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s) => typeof s === 'string') : [],
    isFineGrained: raw.isFineGrained === true,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    validatedAt: Number.isFinite(raw.validatedAt) ? raw.validatedAt : 0,
  }
}

function coerceDefault(key, value) {
  const base = DEFAULT_DEFAULTS[key]
  if (typeof base === 'boolean') return value === true
  if (Array.isArray(base)) {
    if (!Array.isArray(value)) return [...base]
    const list = value.filter((entry) => typeof entry === 'string')
    if (key === 'platforms') return list.slice(0, 8)
    return list.slice(0, 10)
  }
  if (typeof base === 'string') {
    if (typeof value !== 'string') return base
    if (key === 'visibility') return VISIBILITY_IDS.includes(value) ? value : base
    if (key === 'license') return LICENSE_IDS.includes(value) ? value : base
    if (key === 'repoExistsStrategy') return value === 'error' ? 'error' : 'reuse'
    if (key === 'npmAccess') return value === 'restricted' ? 'restricted' : 'public'
    return value
  }
  return base
}

/**
 * Stable, non-reversible fingerprint of a token, used only to tell "the same
 * token as last time" apart (account cache). The token itself stays in
 * config.json (0600) or Host memory and is never logged or returned by the API.
 */
export function fingerprintOf(token) {
  if (typeof token !== 'string' || token === '') return ''
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0
  }
  return `fp_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** Build the masked token hint shown in the UI: first 4 + … + last 4. */
export function tokenHint(token) {
  if (typeof token !== 'string' || token === '') return null
  if (token.length <= 10) return `${token.slice(0, 2)}…${token.slice(-2)}`
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** JSON file helpers with atomic writes and corrupt-file backup. */
async function readJson(file, fallback) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
  if (text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      await fsp.rename(file, backup)
    } catch {
      /* best effort */
    }
    return fallback
  }
}

async function writeJson(file, value, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await fsp.rename(tmp, file)
  try {
    await fsp.chmod(file, mode)
  } catch {
    /* platforms without POSIX modes */
  }
}

/** The plugin's persistence facade: config, history and per-plugin drafts. */
export class ConfigStore {
  #dataDir
  #config = null
  #configLoading = null
  #configQueue = Promise.resolve()

  constructor(dataDir) {
    this.#dataDir = dataDir || resolveDataDir()
  }

  get dataDir() {
    return this.#dataDir
  }

  get configFile() {
    return path.join(this.#dataDir, 'config.json')
  }

  get historyFile() {
    return path.join(this.#dataDir, 'history.json')
  }

  get draftsFile() {
    return path.join(this.#dataDir, 'drafts.json')
  }

  async ensure() {
    await fsp.mkdir(this.#dataDir, { recursive: true, mode: 0o700 })
  }

  async loadConfig() {
    if (this.#config) return this.#config
    if (this.#configLoading) return this.#configLoading
    this.#configLoading = (async () => {
      await this.ensure()
      const raw = await readJson(this.configFile, null)
      this.#config = normalizeConfig(raw)
      return this.#config
    })()
    try {
      return await this.#configLoading
    } finally {
      this.#configLoading = null
    }
  }

  /** Serialized read-modify-write so concurrent HTTP requests cannot lose updates. */
  async updateConfig(mutate) {
    this.#configQueue = this.#configQueue.then(async () => {
      const current = await this.loadConfig()
      const next = normalizeConfig({ ...current, ...(await mutate(structuredClone(current))), updatedAt: Date.now() })
      await writeJson(this.configFile, next)
      this.#config = next
      return next
    })
    return this.#configQueue
  }

  async saveConfig(patch) {
    return this.updateConfig(() => (patch && typeof patch === 'object' ? patch : {}))
  }

  async loadHistory() {
    await this.ensure()
    const raw = await readJson(this.historyFile, [])
    if (!Array.isArray(raw)) return []
    return raw
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
      .slice(0, HISTORY_MAX)
  }

  async appendHistory(entry) {
    const current = await this.loadHistory()
    const next = [entry, ...current].slice(0, HISTORY_MAX)
    await writeJson(this.historyFile, next)
    return next
  }

  async clearHistory() {
    await writeJson(this.historyFile, [])
    return []
  }

  async loadDrafts() {
    await this.ensure()
    const raw = await readJson(this.draftsFile, {})
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === 'string' && value && typeof value === 'object' && !Array.isArray(value)) out[key] = value
    }
    return out
  }

  async saveDraft(pluginPath, form) {
    const current = await this.loadDrafts()
    if (form === null || form === undefined) delete current[pluginPath]
    else current[pluginPath] = normalizeDraft(form)
    const entries = Object.entries(current).slice(0, DRAFTS_MAX)
    const next = Object.fromEntries(entries)
    await writeJson(this.draftsFile, next)
    return next
  }

  async clearDraft(pluginPath) {
    return this.saveDraft(pluginPath, null)
  }
}

/** Keep only known form fields in a draft, and drop empty values so a draft
 * cannot silently resurrect stale data after the defaults change. */
export function normalizeDraft(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const form = {}
  for (const key of FORM_KEYS) {
    if (source[key] === undefined) continue
    form[key] = source[key]
  }
  return form
}

/** Form keys (contract §4.3) used to sanitize drafts and merge requests. */
export const FORM_KEYS = Object.freeze([
  'owner',
  'name',
  'description',
  'descriptionZh',
  'homepage',
  'topics',
  'visibility',
  'license',
  'branch',
  'tagPrefix',
  'commitMessage',
  'authorName',
  'authorEmail',
  // A per-plugin acknowledgement of "yes, the author field names somebody
  // else and that is fine (I forked it)". Kept in the draft, keyed by plugin
  // path, so the same fork does not have to be re-confirmed on every visit.
  'confirmForeignAuthor',
  // The author/repo pair that confirmation was given for: it expires when the
  // declared author changes, so it cannot bless a different person later.
  'confirmForeignAuthorFor',
  'repoExistsStrategy',
  'addReadme',
  'readmeMode',
  'addLicense',
  'addGitignore',
  'updatePackageJson',
  'createRelease',
  'releaseNotes',
  'dryRun',
  'forceWithLease',
  'platforms',
  'npmAccess',
  'npmDistTag',
  'npmOtp',
  // The npm publish name belongs to one plugin, not to the whole workstation,
  // so it lives in the per-plugin draft rather than the global platform config.
  'publishName',
])

/** Fields an operator may override per publish target (kept in defaults too). */
export const PLATFORM_DEFAULT_KEYS = Object.freeze(['npmAccess', 'npmDistTag'])
