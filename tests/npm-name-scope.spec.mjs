// npm publish names must not be shared between plugins.
//
// Regression: `platforms.npm.publishName` was a single global value, so setting
// it for one plugin made every other plugin claim the same npm package — the
// preflight then reported bogus "version X already exists in npm" failures for
// unrelated plugins.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Publisher } from '../lib/publisher.mjs'
import { ConfigStore } from '../lib/store.mjs'
import { npmPublishNameOf } from '../lib/platforms.mjs'

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

/** A minimal plugin whose manifest name is `name`. */
async function makePlugin(name, version) {
  const dir = tmpDir('pn')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({
      name,
      version,
      description: `${name} probe`,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: { '.': './index.js', './client': './client.js' },
    }, null, 2)}\n`,
    'utf8',
  )
  await fsp.writeFile(path.join(dir, 'index.js'), 'export const inject = []\nexport function apply() {}\n', 'utf8')
  await fsp.writeFile(path.join(dir, 'client.js'), "module.exports = {}\n", 'utf8')
  return dir
}

await test('npmPublishNameOf falls back to the manifest name when nothing is set', async () => {
  assert.equal(npmPublishNameOf('alpha', {}), 'alpha')
  assert.equal(npmPublishNameOf('alpha', { publishName: '' }), 'alpha')
  assert.equal(npmPublishNameOf('alpha', null), 'alpha')
})

await test('npmPublishNameOf honours a per-plugin override', async () => {
  assert.equal(npmPublishNameOf('alpha', { publishName: '@me/alpha' }), '@me/alpha')
})

await test('a publish name set for one plugin does not leak into another', async () => {
  const alphaDir = await makePlugin('alpha', '1.0.0')
  const betaDir = await makePlugin('beta', '2.0.0')
  const store = new ConfigStore(tmpDir('pn-store'))
  const publisher = new Publisher({ store })

  // Giving alpha an explicit npm name must not touch beta at all.
  await publisher.saveDraft(alphaDir, { publishName: '@me/alpha-renamed' })

  const alphaPlan = await publisher.preflight({ path: alphaDir, form: { platforms: ['npm'], dryRun: true } })
  const betaPlan = await publisher.preflight({ path: betaDir, form: { platforms: ['npm'], dryRun: true } })

  assert.equal(alphaPlan.plan.npm.name, '@me/alpha-renamed', 'alpha keeps its override')
  assert.equal(betaPlan.plan.npm.name, 'beta', 'beta must fall back to its own manifest name')

  await fsp.rm(alphaDir, { recursive: true, force: true })
  await fsp.rm(betaDir, { recursive: true, force: true })
})

await test('three plugins resolve three different npm names', async () => {
  const dirs = [
    await makePlugin('alpha', '1.0.0'),
    await makePlugin('beta', '1.0.0'),
    await makePlugin('gamma', '1.0.0'),
  ]
  const store = new ConfigStore(tmpDir('pn-store'))
  const publisher = new Publisher({ store })
  try {
    const names = []
    for (const dir of dirs) {
      const plan = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
      names.push(plan.plan.npm.name)
    }
    assert.deepEqual(names, ['alpha', 'beta', 'gamma'])
    assert.equal(new Set(names).size, 3, 'names must be unique per plugin')
  } finally {
    for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true })
  }
})

await test('a stale global publishName no longer hijacks other plugins', async () => {
  // This is the exact shape of the bug: the global platform config still holds
  // a name that belonged to one specific plugin.
  const alphaDir = await makePlugin('alpha', '1.0.0')
  const betaDir = await makePlugin('beta', '1.0.0')
  const store = new ConfigStore(tmpDir('pn-store'))
  const publisher = new Publisher({ store })
  await publisher.updatePlatforms({ npm: { publishName: '@me/only-for-alpha' } })
  try {
    const betaPlan = await publisher.preflight({ path: betaDir, form: { platforms: ['npm'], dryRun: true } })
    assert.notEqual(betaPlan.plan.npm.name, '@me/only-for-alpha', 'beta must not inherit alpha\'s name')
    assert.equal(betaPlan.plan.npm.name, 'beta')
  } finally {
    await fsp.rm(alphaDir, { recursive: true, force: true })
    await fsp.rm(betaDir, { recursive: true, force: true })
  }
})

await test('the draft override survives a round trip', async () => {
  const dir = await makePlugin('alpha', '1.0.0')
  const store = new ConfigStore(tmpDir('pn-store'))
  const publisher = new Publisher({ store })
  try {
    await publisher.saveDraft(dir, { publishName: '@me/alpha' })
    const drafts = await store.loadDrafts()
    assert.equal(drafts[dir].publishName, '@me/alpha')
  } finally {
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
