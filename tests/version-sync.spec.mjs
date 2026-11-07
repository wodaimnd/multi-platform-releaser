// Version-declaration consistency.
//
// `package.json` is the single source of truth. A bump must carry CLIENT_VERSION,
// the Host VERSION and the GitHub User-Agent along with it, otherwise the
// published tarball contradicts itself.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { Publisher } from '../lib/publisher.mjs'
import { ConfigStore } from '../lib/store.mjs'
import {
  findVersionDeclarations,
  inspectVersionDrift,
  syncVersionDeclarations,
} from '../lib/version-sync.mjs'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error && error.message })
  }
}

function tmpDir(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

/** A minimal plugin with all three declarations at the given version. */
async function makePlugin(version) {
  const dir = tmpDir('ver')
  await fsp.mkdir(path.join(dir, 'lib'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'probe', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n',
    'utf8',
  )
  await fsp.writeFile(path.join(dir, 'client.js'), `const CLIENT_VERSION = '${version}'\nmodule.exports = { CLIENT_VERSION }\n`, 'utf8')
  await fsp.writeFile(
    path.join(dir, 'lib', 'publisher.mjs'),
    `export const VERSION = '${version}'\nexport class Publisher {}\n`,
    'utf8',
  )
  await fsp.writeFile(
    path.join(dir, 'lib', 'github.mjs'),
    `const DEFAULT_USER_AGENT = 'dsh-github-publisher/${version}';\nexport default DEFAULT_USER_AGENT\n`,
    'utf8',
  )
  return dir
}

await test('finds all three declaration sites', async () => {
  const dir = await makePlugin('1.2.3')
  const decls = await findVersionDeclarations(dir)
  assert.equal(decls.length, 3, 'expected client + publisher + user-agent')
  const rels = decls.map((entry) => entry.rel).sort()
  assert.deepEqual(rels, ['client.js', 'lib/github.mjs', 'lib/publisher.mjs'])
  for (const entry of decls) assert.equal(entry.version, '1.2.3')
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('node_modules and tests are never scanned', async () => {
  const dir = await makePlugin('1.0.0')
  await fsp.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), `const CLIENT_VERSION = '9.9.9'\n`, 'utf8')
  await fsp.mkdir(path.join(dir, 'tests'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'tests', 't.mjs'), `const CLIENT_VERSION = '8.8.8'\n`, 'utf8')
  const decls = await findVersionDeclarations(dir)
  assert.equal(decls.length, 3, 'only the plugin own sources count')
  assert.ok(!decls.some((entry) => entry.rel.includes('node_modules')))
  assert.ok(!decls.some((entry) => entry.rel.includes('tests')))
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('drift is detected against package.json', async () => {
  const dir = await makePlugin('2.0.0')
  const clientPath = path.join(dir, 'client.js')
  await fsp.writeFile(clientPath, `const CLIENT_VERSION = '1.0.0'\n`, 'utf8')
  const drift = await inspectVersionDrift(dir)
  assert.equal(drift.version, '2.0.0')
  assert.equal(drift.drifted.length, 1)
  assert.equal(drift.drifted[0].rel, 'client.js')
  assert.equal(drift.synced.length, 2)
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('sync rewrites only the version literal', async () => {
  const dir = await makePlugin('1.0.0')
  await fsp.writeFile(
    path.join(dir, 'client.js'),
    `// header comment stays\nconst CLIENT_VERSION = '1.0.0'\nconst OTHER = 'keep me'\n`,
    'utf8',
  )
  const outcome = await syncVersionDeclarations(dir, '3.1.4')
  assert.equal(outcome.rewritten, 3)
  const after = await fsp.readFile(path.join(dir, 'client.js'), 'utf8')
  assert.ok(after.includes("const CLIENT_VERSION = '3.1.4'"))
  assert.ok(after.includes('// header comment stays'), 'comments must survive')
  assert.ok(after.includes("const OTHER = 'keep me'"), 'unrelated literals must survive')
  const drift = await inspectVersionDrift(dir, '3.1.4')
  assert.equal(drift.drifted.length, 0)
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('sync is idempotent', async () => {
  const dir = await makePlugin('4.0.0')
  const first = await syncVersionDeclarations(dir, '4.0.1')
  assert.equal(first.rewritten, 3)
  const second = await syncVersionDeclarations(dir, '4.0.1')
  assert.equal(second.rewritten, 0, 'a second sync must change nothing')
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('bumpVersion carries every declaration along', async () => {
  const dir = await makePlugin('0.5.0')
  const store = new ConfigStore(tmpDir('ver-store'))
  const publisher = new Publisher({ store })
  const result = await publisher.bumpVersion({ path: dir, mode: 'patch' })
  assert.equal(result.previous, '0.5.0')
  assert.equal(result.version, '0.5.1')
  assert.equal(result.synced.length, 3, 'all three followers must be reported')
  const drift = await inspectVersionDrift(dir)
  assert.equal(drift.version, '0.5.1')
  assert.equal(drift.drifted.length, 0, 'nothing may be left behind')
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.5.1')
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('bumpVersion with sync:false leaves followers alone', async () => {
  const dir = await makePlugin('0.6.0')
  const store = new ConfigStore(tmpDir('ver-store'))
  const publisher = new Publisher({ store })
  const result = await publisher.bumpVersion({ path: dir, mode: 'patch', sync: false })
  assert.equal(result.version, '0.6.1')
  assert.equal(result.synced.length, 0)
  const drift = await inspectVersionDrift(dir)
  assert.equal(drift.version, '0.6.1')
  assert.equal(drift.drifted.length, 3, 'followers intentionally untouched')
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('bumpVersion on a plugin without extra declarations still works', async () => {
  const dir = tmpDir('ver-bare')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'bare', version: '1.0.0' }, null, 2) + '\n', 'utf8')
  const store = new ConfigStore(tmpDir('ver-store'))
  const publisher = new Publisher({ store })
  const result = await publisher.bumpVersion({ path: dir, mode: 'minor' })
  assert.equal(result.version, '1.1.0')
  assert.deepEqual(result.synced, [])
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('a version collision offers a one-click bump, not a bare "fix"', async () => {
  // Point at a local registry that already holds this exact version, so the
  // npm-version check really fails. The point of the assertion is discoverability:
  // a failing row with no actionable fix is what left the user hunting.
  const dir = await makePlugin('1.0.0')
  const store = new ConfigStore(tmpDir('ver-store'))
  const publisher = new Publisher({ store })

  // Stand up a throwaway registry answer that reports the version as taken.
  // `npmRemoteState` now reads the whole packument, so the answer must list
  // `versions` — a bare `dist-tags.latest` cannot say whether 1.0.0 exists.
  // `/-/whoami` must also answer so `npm-auth` passes.
  const server = http.createServer((req, res) => {
    if (req.url.includes('/-/whoami')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'probe' }))
      return
    }
    if (req.url.startsWith('/probe')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'probe', version: '1.0.0' } },
      }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await publisher.updatePlatforms({ npm: { enabled: true, registry: `http://127.0.0.1:${port}`, token: 'probe-token' } })
    const preflight = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
    const check = preflight.checks.find((entry) => entry.id === 'npm-version')
    assert.ok(check, 'npm-version check must exist')
    assert.equal(check.status, 'fail', 'the collision must be a blocking failure')
    assert.equal(check.fix, 'bump', 'the fix must be an action, not just a section pointer')
    assert.equal(check.suggestion, '1.0.1', 'the fix must name the version it will write')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

let failed = 0
for (const row of results) {
  if (!row.ok) failed += 1
  console.log(`${row.ok ? 'PASS  ' : 'FAIL  '}${row.name}${row.ok || !row.error ? '' : ' — ' + row.error}`)
}
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
