/**
 * dsh-github-publisher — local plugin discovery.
 *
 * A "publishable plugin" is a directory whose package.json declares
 * `dsh.bundle` (it is a bundle) or `dsh.client` (it ships browser code). Roots
 * come from the user's extra scan roots, the active profile's `link:`/`file:`
 * dependencies, the registered workspace directories, and the Host cwd.
 *
 * The scanner is read-only: it never writes, installs or mutates a plugin.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { parseRemoteUrl } from './github.mjs'
import { repoSnapshot, gitFacts } from './git.mjs'

/** Directories never worth descending into while looking for plugin manifests. */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.pnpm',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'tmp',
  'temp',
  '.DS_Store',
  'Library',
])

/** File names recognized as a project README / license, in priority order. */
const README_NAMES = ['README.md', 'README.zh.md', 'README.zh-CN.md', 'README.MD', 'README.markdown', 'README.txt', 'README']
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.md']

const MAX_CANDIDATE_DIRS = 400
const MAX_DEPTH = 3
const MAX_SIZE_SCAN_FILES = 4000

const CJK_TEST = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff]/

/**
 * Collect the roots worth scanning, deduplicated by real path.
 * @returns {Promise<Array<{ path: string, source: string }>>}
 */
export async function discoverRoots({ settings = null, profileDir = null, workspacePaths = [], cwd = null } = {}) {
  const roots = []
  const seen = new Set()

  const add = async (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return
    const resolved = path.resolve(candidate)
    let key = resolved
    try {
      key = await fsp.realpath(resolved)
    } catch {
      /* keep the lexical path */
    }
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ path: key, source })
  }

  for (const entry of Array.isArray(settings?.scanRoots) ? settings.scanRoots : []) await add(entry, 'scan-root')

  if (profileDir) {
    try {
      const profilePackage = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
      const dependencies = { ...(profilePackage.dependencies || {}), ...(profilePackage.devDependencies || {}) }
      for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string') continue
        if (spec.startsWith('link:') || spec.startsWith('file:')) {
          const target = spec.slice(5)
          await add(path.isAbsolute(target) ? target : path.join(profileDir, target), 'profile-link')
        } else if (/^(workspace|portal):/.test(spec)) {
          await add(path.join(profileDir, 'node_modules', name), 'profile-link')
        }
      }
    } catch {
      /* a profile without a readable package.json simply contributes no roots */
    }
  }

  for (const workspace of Array.isArray(workspacePaths) ? workspacePaths : []) await add(workspace, 'workspace')
  if (cwd) await add(cwd, 'cwd')

  return roots
}

/**
 * Walk every root (bounded) and inspect the plugin directories found.
 * @returns {Promise<{ plugins: object[], roots: Array<{path:string, source:string, count:number}>,
 *   warnings: string[], scannedAt: number }>}
 */
export async function scanPlugins(roots, { maxDepth = MAX_DEPTH, maxDirs = MAX_CANDIDATE_DIRS, signal = null } = {}) {
  const warnings = []
  const plugins = []
  const rootReports = []
  const visited = new Set()
  let budget = Math.max(1, maxDirs)

  /**
   * Walk every root concurrently, one directory per task.
   *
   * Why: every git probe and stat is I/O bound. A sequential walk spent 4.8 s on
   * 16 roots where almost all of the time was waiting on `git` subprocesses;
   * overlapping directories turns that waiting into each other's headroom. The
   * cap keeps the process count sane and the machine responsive.
   *
   * Ordering is no longer guaranteed, so nothing below may depend on traversal
   * order — the final list is sorted by name afterwards, as before.
   */
  const CONCURRENCY = 8
  const queue = []

  function enqueue(dir, depth, report) {
    queue.push({ dir, depth, report })
  }

  async function visit({ dir, depth, report }) {
    let real = dir
    try {
      real = await fsp.realpath(dir)
    } catch {
      return
    }
    // Shared across every task: a duplicate means another walk already covered
    // this directory, or is covering it right now.
    if (visited.has(real)) return
    visited.add(real)
    if (budget <= 0) return
    budget -= 1

    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (depth === 0) warnings.push(`无法读取扫描目录 ${dir}：${error.code || error.message}`)
      return
    }

    // A manifest has to exist before the expensive git probe runs: four
    // subprocesses per directory for a folder that cannot be a plugin is pure
    // waste, and most directories the walker meets are ordinary folders.
    const hasManifest = entries.some((entry) => entry.isFile() && entry.name === 'package.json')
    if (hasManifest) {
      const plugin = await inspectPlugin(dir, { sources: [report.source], fast: true })
      if (plugin.isPlugin) {
        plugins.push(plugin)
        report.count += 1
        return // never descend into an existing plugin (node_modules, nested examples)
      }
    }

    if (depth >= maxDepth) return
    const childDirs = entries
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && !SKIP_DIR_NAMES.has(entry.name)))
      .map((entry) => entry.name)
      .filter((name) => !SKIP_DIR_NAMES.has(name) && !name.startsWith('.'))
      .sort()
    for (const name of childDirs) enqueue(path.join(dir, name), depth + 1, report)
  }

  for (const root of Array.isArray(roots) ? roots : []) {
    if (!root || typeof root.path !== 'string') continue
    const report = { path: root.path, source: root.source || 'root', count: 0 }
    rootReports.push(report)
    enqueue(root.path, 0, report)
  }

  // A fixed pool of workers drains the queue. Each worker keeps pulling until
  // the queue is empty, and the queue is only empty once no worker can enqueue
  // anything new — because a worker enqueues before it finishes.
  async function worker() {
    while (queue.length > 0 && budget > 0) {
      if (signal?.aborted) throw abortError()
      const task = queue.shift()
      await visit(task)
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, 16) }, () => worker())
  await Promise.all(workers)

  // A plugin can be reached from several roots: keep the first inspection but
  // merge the source tags.
  const byPath = new Map()
  for (const plugin of plugins) {
    const existing = byPath.get(plugin.realPath)
    if (!existing) {
      byPath.set(plugin.realPath, plugin)
      continue
    }
    for (const source of plugin.sources) if (!existing.sources.includes(source)) existing.sources.push(source)
  }

  const result = [...byPath.values()].sort((left, right) => {
    if (left.name !== right.name) return left.name.localeCompare(right.name)
    return left.path.localeCompare(right.path)
  })
  return { plugins: result, roots: rootReports, warnings, scannedAt: Date.now() }
}

/**
 * Read one plugin directory into the PluginScan shape (contract §4.2).
 * Never throws for a missing/invalid package.json: the returned object carries
 * `isPlugin: false` and `errors`.
 *
 * `fast: true` is what the bulk scan uses. It answers only "is this a git
 * repository, and does it have any commits?", because those two booleans are the
 * sole git facts the *list* view needs — the dirty counts, branch name and
 * remote URL are only consulted by single-plugin actions (preflight, publish,
 * sync plan), each of which re-inspects the one plugin it was given.
 *
 * That matters: a full inspection costs four git processes (≈180 ms), and the
 * scan ran one per directory on every load. The fast path costs at most one
 * `rev-parse`, and nothing at all for a directory without `.git`.
 */
export async function inspectPlugin(dir, { sources = [], fast = false } = {}) {
  const resolved = path.resolve(dir)
  const plugin = {
    path: resolved,
    realPath: resolved,
    isPlugin: false,
    name: '',
    displayName: '',
    version: '',
    description: '',
    descriptionZh: '',
    license: '',
    author: '',
    authorName: '',
    authorEmail: '',
    authorUrl: '',
    repositoryOwner: '',
    keywords: [],
    homepage: '',
    repository: null,
    iconPath: null,
    hasReadme: false,
    readmeFile: null,
    hasLicense: false,
    licenseFile: null,
    hasGitignore: false,
    hasClient: false,
    hasHost: false,
    exportsList: [],
    scripts: {},
    hasGit: false,
    parentRepo: null,
    hasCommits: false,
    branch: null,
    remote: null,
    gitStatus: { dirty: false, modified: 0, untracked: 0, staged: 0, ahead: 0, behind: 0 },
    sizeBytes: 0,
    fileCount: 0,
    sources: Array.isArray(sources) && sources.length > 0 ? [...sources] : ['manual'],
    errors: [],
  }

  try {
    plugin.realPath = await fsp.realpath(resolved)
  } catch {
    plugin.errors.push('目录不存在或无法访问')
    return plugin
  }

  let manifest = null
  try {
    const text = await fsp.readFile(path.join(resolved, 'package.json'), 'utf8')
    manifest = JSON.parse(text)
  } catch (error) {
    plugin.errors.push(error?.code === 'ENOENT' ? '缺少 package.json' : `package.json 无法解析：${error.message}`)
    return plugin
  }
  if (!manifest || typeof manifest !== 'object') {
    plugin.errors.push('package.json 不是对象')
    return plugin
  }
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  plugin.isPlugin = Boolean(dsh.bundle || dsh.client)
  plugin.name = typeof manifest.name === 'string' ? manifest.name : path.basename(resolved)
  plugin.displayName = plugin.name
  plugin.version = typeof manifest.version === 'string' ? manifest.version : ''
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  plugin.description = description
  plugin.descriptionZh = extractChineseDescription(description)
  plugin.license = normalizeLicenseField(manifest.license)
  const author = parseAuthorField(manifest.author)
  plugin.author = author.text
  plugin.authorName = author.name
  plugin.authorEmail = author.email
  plugin.authorUrl = author.url
  plugin.keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((k) => typeof k === 'string') : []
  plugin.homepage = typeof manifest.homepage === 'string' ? manifest.homepage : ''
  plugin.repository = normalizeRepositoryField(manifest.repository)
  plugin.repositoryOwner = repositoryOwnerOf(plugin.repository)

  const files = new Set()
  try {
    for (const entry of await fsp.readdir(resolved, { withFileTypes: true })) {
      if (entry.isFile() || entry.isSymbolicLink()) files.add(entry.name)
    }
  } catch {
    /* already reported by the manifest read */
  }
  plugin.readmeFile = README_NAMES.find((name) => files.has(name)) || null
  plugin.hasReadme = plugin.readmeFile !== null
  plugin.licenseFile = LICENSE_NAMES.find((name) => files.has(name)) || null
  plugin.hasLicense = plugin.licenseFile !== null
  plugin.hasGitignore = files.has('.gitignore')
  plugin.hasClient = Boolean(dsh.client)
  plugin.hasHost = typeof manifest.exports === 'object' && manifest.exports !== null
    ? Object.keys(manifest.exports).includes('.')
    : typeof manifest.main === 'string'
  plugin.exportsList = manifest.exports && typeof manifest.exports === 'object' ? Object.keys(manifest.exports) : []
  plugin.scripts = manifest.scripts && typeof manifest.scripts === 'object' ? { ...manifest.scripts } : {}
  for (const candidate of [typeof manifest.icon === 'string' ? manifest.icon : null, 'icon.svg', 'icon.png']) {
    if (!candidate) continue
    try {
      const stat = await fsp.stat(path.join(resolved, candidate))
      if (stat.isFile()) {
        plugin.iconPath = path.join(resolved, candidate)
        break
      }
    } catch {
      /* try the next candidate */
    }
  }

  // A plugin directory is only "its own git repository" when it is the top
  // level of a work tree. A plugin nested inside someone else's repository must
  // be published through a fresh nested repo, never by committing into the
  // parent — so it is reported as hasGit:false with the parent path recorded.
  //
  // One `repoSnapshot` call replaces six sequential git processes; that was
  // 90% of this function's runtime before (506 ms of 562 ms, measured).
  //
  // In `fast` mode only the two booleans the list view needs are fetched, and
  // they come from a single `rev-parse` — no status, no remotes, no commit walk.
  if (fast) {
    // Reach this line only for directories already recognised as plugins, so the
    // extra parent-repo probe costs one `rev-parse` per plugin rather than per
    // folder. Without it the list view showed `parentRepo: null` for every nested
    // plugin and the "this lives inside someone else's repo" warning never appeared
    // until preflight — the one place the user had already stopped reading.
    const facts = await gitFacts(resolved, { probeParent: true })
    plugin.hasGit = facts.hasGit
    plugin.hasCommits = facts.hasCommits
    plugin.parentRepo = facts.parentRepo
    plugin.deferred = true
  } else {
    const snapshot = await repoSnapshot(resolved)
    plugin.hasGit = Boolean(snapshot && snapshot.isOwnRepo)
    plugin.parentRepo = snapshot && !snapshot.isOwnRepo ? snapshot.topLevel : null
    if (snapshot && plugin.hasGit) {
      plugin.gitStatus = snapshot.status
      plugin.branch = snapshot.branch
      plugin.hasCommits = snapshot.hasCommits
      if (snapshot.remote) {
        const parsed = parseRemoteUrl(snapshot.remote.url)
        plugin.remote = parsed
          ? { name: snapshot.remote.name, url: snapshot.remote.url, ...parsed }
          : { name: snapshot.remote.name, url: snapshot.remote.url, host: '', owner: '', repo: '', isGitHub: false }
      }
    }
  }

  // Directory size is only ever shown as a hint on one plugin at a time, so the
  // bulk scan skips it (56 ms per plugin measured) and reports null — "not
  // measured", not "empty", so nothing can render a misleading 0 bytes.
  if (!fast) {
    const size = await measureDirectory(resolved)
    plugin.sizeBytes = size.bytes
    plugin.fileCount = size.files
  } else {
    plugin.sizeBytes = null
    plugin.fileCount = null
  }
  plugin.suggested = suggestFor(plugin)
  return plugin
}

/** Heuristic in-memory/on-disk "is this a publishable plugin" probe. */
export async function isPluginDir(dir) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    const dsh = manifest && typeof manifest === 'object' && manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    return Boolean(dsh.bundle || dsh.client)
  } catch {
    return false
  }
}

/** Default publish-form values derived from the inspected plugin. */
export function suggestFor(plugin) {
  const name = sanitizeRepoName(plugin.name)
  const topics = [...new Set([...(plugin.keywords || []), 'deepseek', 'dsh', 'dsh-plugin']
    .map((topic) => String(topic).toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-'))
    .filter((topic) => topic !== ''))].slice(0, 20)
  return {
    name,
    description: truncate(plugin.description, 350),
    descriptionZh: truncate(plugin.descriptionZh, 350),
    topics,
    license: plugin.license && plugin.license !== 'UNKNOWN' ? plugin.license : 'MIT',
    homepage: plugin.homepage || '',
  }
}

/** Repository names GitHub accepts; fall back to a deterministic slug. */
export function sanitizeRepoName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const slug = text
    .replace(/^@[^/]+\//, '') // scoped package → leaf name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'dsh-plugin'
}

function extractChineseDescription(description) {
  if (!description) return ''
  // Bundles in this repo write `English · 中文`; prefer an explicit CJK segment.
  const segments = description.split(/\s*[·|｜]\s*/).map((segment) => segment.trim()).filter(Boolean)
  const chinese = segments.find((segment) => CJK_TEST.test(segment))
  if (chinese && chinese !== description) return chinese
  if (CJK_TEST.test(description)) return description
  return ''
}

function normalizeLicenseField(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim()
  return ''
}

/**
 * Split a manifest `author` into its parts.
 *
 * The one-line string is still returned (that is what `package.json` carries and
 * what `buildPackageJson` writes back), but the UI needs the pieces: "is this
 * the person who owns the account I am about to publish under?" cannot be
 * answered from `"Somebody <x@y>"` without re-parsing it every render.
 */
function parseAuthorField(value) {
  const out = { name: '', email: '', url: '', text: '' }
  if (typeof value === 'string') out.text = value.trim()
  else if (value && typeof value === 'object') {
    out.name = typeof value.name === 'string' ? value.name.trim() : ''
    out.email = typeof value.email === 'string' ? value.email.trim() : ''
    out.url = typeof value.url === 'string' ? value.url.trim() : ''
    if (out.name && out.email) out.text = `${out.name} <${out.email}>`
    else out.text = out.name || out.email
  }
  // npm allows `author` as a single string, and historically it is `Name <email> (url)`.
  if (out.text !== '' && (out.name === '' || out.email === '')) {
    const match = /^(.*?)\s*(?:<([^>]*)>)?\s*(?:\(([^)]*)\))?\s*$/.exec(out.text)
    if (match) {
      if (out.name === '' && match[1].trim() !== '') out.name = match[1].trim()
      if (out.email === '' && match[2] !== undefined) out.email = match[2].trim()
      if (out.url === '' && match[3] !== undefined) out.url = match[3].trim()
    }
  }
  return out
}

function normalizeAuthorField(value) {
  return parseAuthorField(value).text
}

/** `owner` out of a GitHub repository field, for the ownership comparison. */
function repositoryOwnerOf(repository) {
  const url = typeof repository === 'string' ? repository : repository && typeof repository.url === 'string' ? repository.url : ''
  if (url === '') return ''
  const match = /github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\//.exec(url)
  return match ? match[1] : ''
}

function normalizeRepositoryField(value) {
  if (typeof value === 'string' && value.trim() !== '') return { type: 'git', url: value.trim() }
  if (value && typeof value === 'object' && typeof value.url === 'string') {
    return { ...value, url: value.url.trim() }
  }
  return null
}

async function measureDirectory(root) {
  let bytes = 0
  let files = 0
  const queue = [root]
  while (queue.length > 0 && files < MAX_SIZE_SCAN_FILES) {
    const dir = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files >= MAX_SIZE_SCAN_FILES) break
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(target)
      } else if (entry.isFile()) {
        files += 1
        try {
          const stat = await fsp.stat(target)
          bytes += stat.size
        } catch {
          /* vanished file */
        }
      }
    }
  }
  return { bytes, files }
}

function truncate(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function abortError() {
  const error = new Error('扫描已取消')
  error.name = 'AbortError'
  error.code = 'aborted'
  return error
}
