/**
 * Version declarations across a DSH plugin.
 *
 * A plugin repeats its version in several places, and they drift the moment
 * only `package.json` is bumped: the client keeps showing the old version, the
 * Host half reports the old one in `/api/health`, and the generated tarball
 * contradicts itself. `package.json` is the single source of truth; every other
 * declaration must follow it.
 *
 * This module finds those declarations by walking the plugin's own source
 * (never `node_modules`, never tests) and rewrites only the version literal, so
 * nothing else in the file moves.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Directories that can never hold a declaration we should touch. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.pnpm-store', 'tests', 'test', '__tests__'])

/** Extensions worth scanning for a version literal. */
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs'])

/**
 * Declaration patterns, ordered so the first match in a file wins.
 *
 * Each pattern captures the version in group 1 while the surrounding text stays
 * byte-identical after substitution.
 */
const DECLARATIONS = [
  {
    id: 'client-version',
    label: 'client.js 的 CLIENT_VERSION',
    re: /(const\s+CLIENT_VERSION\s*=\s*['"])([^'"]+)(['"])/,
  },
  {
    id: 'publisher-version',
    label: 'publisher.mjs 的 VERSION',
    re: /(export\s+const\s+VERSION\s*=\s*['"])([^'"]+)(['"])/,
  },
  {
    id: 'user-agent',
    label: 'github.mjs 的 User-Agent 版本',
    // e.g. 'dsh-github-publisher/0.3.2'. The look-behind keeps documentation
    // examples (which are not preceded by a quote) from matching, so this
    // module's own sample text never reports itself as a declaration.
    re: /('dsh-github-publisher\/)(\d+\.\d+\.\d+[^']*)(')/,
  },
]

/** The module that performs the rewrite is never a declaration site itself. */
const SELF_FILE = 'version-sync.mjs'

async function walkSources(root, out = []) {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      await walkSources(full, out)
      continue
    }
    if (!entry.isFile()) continue
    // Skip this module: it mentions the patterns in its own doc comments.
    if (entry.name === SELF_FILE) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!SCAN_EXT.has(ext)) continue
    out.push(full)
  }
  return out
}

/**
 * Find every version declaration in a plugin.
 *
 * Returns `[{ file, id, label, version, rel }]`, sorted for stable output.
 */
export async function findVersionDeclarations(pluginPath) {
  const root = path.resolve(pluginPath)
  const files = await walkSources(root)
  const found = []
  for (const file of files) {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const decl of DECLARATIONS) {
      const match = decl.re.exec(text)
      if (!match) continue
      found.push({
        file,
        rel: path.relative(root, file).split(path.sep).join('/'),
        id: decl.id,
        label: decl.label,
        version: match[2],
      })
      // One declaration per pattern per file is enough; keep going to the next file.
      break
    }
  }
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return found
}

/**
 * Compare every declaration against `package.json`.
 *
 * `{ version, declarations, drifted, synced }`. `drifted` is what a bump must
 * fix; `version` is the canonical value read from the manifest.
 */
export async function inspectVersionDrift(pluginPath, expected = null) {
  const root = path.resolve(pluginPath)
  let version = expected
  if (typeof version !== 'string' || version.trim() === '') {
    const text = await fsp.readFile(path.join(root, 'package.json'), 'utf8').catch(() => null)
    if (text === null) return { version: null, declarations: [], drifted: [], synced: [], missing: ['package.json'] }
    try {
      version = String(JSON.parse(text).version || '').trim()
    } catch {
      version = ''
    }
  }
  const canonical = typeof version === 'string' ? version.trim() : ''
  const declarations = await findVersionDeclarations(root)
  const drifted = declarations.filter((entry) => canonical !== '' && entry.version !== canonical)
  const synced = declarations.filter((entry) => canonical !== '' && entry.version === canonical)
  return { version: canonical, declarations, drifted, synced, missing: [] }
}

/**
 * Rewrite every drifted declaration to `target`.
 *
 * Only the version literal is replaced; the rest of each file stays byte-identical.
 * Returns `{ rewritten, written }` where `written` lists what actually changed.
 * Files already at `target` are untouched, which makes this idempotent.
 */
export async function syncVersionDeclarations(pluginPath, target, { dryRun = false } = {}) {
  const root = path.resolve(pluginPath)
  const value = typeof target === 'string' ? target.trim() : ''
  if (value === '') throw new Error('syncVersionDeclarations: target 不能为空')
  const drift = await inspectVersionDrift(root, value)
  const planned = []
  for (const entry of drift.drifted) {
    let text
    try {
      text = await fsp.readFile(entry.file, 'utf8')
    } catch {
      continue
    }
    for (const decl of DECLARATIONS) {
      if (decl.id !== entry.id) continue
      const match = decl.re.exec(text)
      if (!match) continue
      const next = text.replace(decl.re, (whole, head, _old, tail) => {
        const tailPart = typeof tail === 'string' ? tail : ''
        return `${head}${value}${tailPart}`
      })
      if (next !== text) {
        planned.push({ file: entry.file, rel: entry.rel, id: entry.id, label: entry.label, from: entry.version, to: value, text: next })
      }
      break
    }
  }
  const written = []
  for (const item of planned) {
    if (dryRun) {
      written.push({ rel: item.rel, id: item.id, from: item.from, to: item.to, dryRun: true })
      continue
    }
    await fsp.writeFile(item.file, item.text, 'utf8')
    written.push({ rel: item.rel, id: item.id, from: item.from, to: item.to })
  }
  return { rewritten: written.length, written }
}
