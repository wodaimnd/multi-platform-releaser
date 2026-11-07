// The npm version guard.
//
// A registry can answer two different questions and they are not the same one:
//   "is this exact version already published?"  → re-publishing is illegal
//   "what is the newest version?"               → publishing below it is legal
//
// Conflating them produced "版本 0.3.4 已存在于 npm / 远端最新为 1.0.1" — a
// self-contradicting refusal for a version that had never been published, with a
// one-click fix that walked straight back into the same wall (0.3.5 ≤ 1.0.1).
// These tests pin the two questions apart, and pin preflight and the publish-time
// guard to the same answer so they cannot drift again.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  npmRemoteState,
  nextVersionAbove,
} from '../lib/platforms.mjs'
import { Publisher, versionGuardVerdict } from '../lib/publisher.mjs'
import { ConfigStore } from '../lib/store.mjs'

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

/** A minimal npm-publishable plugin at the given version. */
async function makePlugin(version, name = 'probe') {
  const dir = tmpDir('guard')
  await fsp.mkdir(path.join(dir, 'lib'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, description: 'probe fixture', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n',
    'utf8',
  )
  await fsp.writeFile(path.join(dir, 'client.js'), `const CLIENT_VERSION = '${version}'\nmodule.exports = { CLIENT_VERSION }\n`, 'utf8')
  await fsp.writeFile(path.join(dir, 'lib', 'publisher.mjs'), `export const VERSION = '${version}'\nexport class Publisher {}\n`, 'utf8')
  return dir
}

/**
 * A throwaway registry. `versions` is what really answers the question — the
 * latest-tag-only document cannot say whether 0.3.4 exists.
 */
async function withRegistry({ name = 'probe', versions, latest }, fn) {
  const sorted = [...versions].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1))
  const server = http.createServer((req, res) => {
    if (req.url.includes('/-/whoami')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'probe' }))
      return
    }
    if (req.method === 'GET' && req.url.includes(encodeURIComponent(name).replace('%40', '@'))) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name,
        version: latest,
        'dist-tags': { latest },
        versions: Object.fromEntries(sorted.map((v) => [v, { name, version: v }])),
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(registry)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function drain(publisher, jobId, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let job = publisher.getJob(jobId)
  while (job && (job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    job = publisher.getJob(jobId)
  }
  return job
}

// ---------------------------------------------------------------------------

await test('nextVersionAbove always lands strictly above the higher of the two', () => {
  assert.equal(nextVersionAbove('0.3.4', '1.0.1'), '1.0.2', 'must leap past the remote latest')
  assert.equal(nextVersionAbove('1.0.1', '1.0.1'), '1.0.2', 'a taken version moves on')
  assert.equal(nextVersionAbove('0.3.4', '0.3.3'), '0.3.5', 'local ahead → local + patch')
  assert.equal(nextVersionAbove('0.3.4', null), '0.3.5', 'no remote → local + patch')
  assert.equal(nextVersionAbove('1.0.1', '1.0.1-rc.1'), '1.0.2', 'pre-release tails are stripped')
  assert.equal(nextVersionAbove('v1.2.3', '1.2.2'), '1.2.4', 'a v prefix does not poison the maths')
})

await test('versionGuardVerdict blocks a duplicate and only a duplicate', () => {
  const remote = {
    exists: true,
    version: '1.0.1',
    has: (v) => v === '0.3.2' || v === '1.0.1',
  }
  const taken = versionGuardVerdict({ local: '1.0.1', remote })
  assert.equal(taken.ok, false, 'an already-published version is illegal')
  assert.equal(taken.reason, 'duplicate')
  assert.equal(taken.next, '1.0.2')

  // The case the user hit: free, merely older. Legal, and the suggestion must
  // clear the remote — 0.3.5 would just re-enter the same refusal.
  const older = versionGuardVerdict({ local: '0.3.4', remote })
  assert.equal(older.ok, true, 'publishing below latest is legal')
  assert.equal(older.reason, 'below-latest')
  assert.equal(older.next, '1.0.2', 'the suggested bump must exceed the remote latest')

  const ahead = versionGuardVerdict({ local: '2.0.0', remote })
  assert.equal(ahead.ok, true)
  assert.equal(ahead.reason, 'ahead')
  assert.equal(ahead.next, null, 'nothing to bump when already ahead')
})

await test('versionGuardVerdict handles a missing remote and a missing local version', () => {
  const fresh = versionGuardVerdict({ local: '0.1.0', remote: { exists: false, has: () => false } })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.reason, 'first-publish')

  const noLocal = versionGuardVerdict({ local: '', remote: { exists: true, version: '9.9.9', has: () => true } })
  assert.equal(noLocal.ok, true, 'a version-less manifest is a different check\'s problem')
  assert.equal(noLocal.reason, 'no-local')
  assert.equal(noLocal.next, null)

  assert.equal(versionGuardVerdict({}).reason, 'no-local', 'no argument object must not throw')
})

await test('npmRemoteState reports every published version, not just the latest tag', async () => {
  await withRegistry({ versions: ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '1.0.0', '1.0.1'], latest: '1.0.1' }, async (registry) => {
    const state = await npmRemoteState({ name: 'probe', registry, token: 'probe-token' })
    assert.equal(state.exists, true)
    assert.equal(state.version, '1.0.1')
    assert.deepEqual(state.versions, ['1.0.1', '1.0.0', '0.3.3', '0.3.2', '0.3.1', '0.3.0'], 'versions must be listed newest-first')
    assert.equal(state.has('0.3.4'), false, 'the whole point: 0.3.4 is not published')
    assert.equal(state.has('1.0.1'), true)
    assert.ok(String(state.url).startsWith(registry), `the package page must stay on this registry: ${state.url}`)
  })
})

await test('a free-but-older version warns instead of blocking, and names a version past the remote', async () => {
  const dir = await makePlugin('0.3.4')
  const store = new ConfigStore(tmpDir('guard-store'))
  const publisher = new Publisher({ store })
  await withRegistry({ versions: ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '1.0.0', '1.0.1'], latest: '1.0.1' }, async (registry) => {
    await publisher.updatePlatforms({ npm: { enabled: true, registry, token: 'probe-token' } })
    const preflight = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
    const check = preflight.checks.find((entry) => entry.id === 'npm-version')
    assert.ok(check, 'npm-version check must exist')
    assert.equal(check.status, 'warn', 'a free older version must not be reported as "已存在"')
    assert.equal(check.fix, 'bump', 'the warning still offers the one-click path')
    assert.equal(check.suggestion, '1.0.2', 'and the suggestion clears the remote latest')
    const blocking = (preflight.blocking || []).map((entry) => (typeof entry === 'string' ? entry : entry.id))
    assert.ok(!blocking.includes('npm-version'), `npm-version must not block: blocking=${JSON.stringify(blocking)}`)
    assert.equal(preflight.plan.npm.versionOccupied, false)
    assert.equal(preflight.plan.npm.belowLatest, true)
    assert.equal(preflight.plan.npm.bumpSuggestion, '1.0.2')
    assert.equal(preflight.plan.npm.needsVersionBump, true)
  })
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('a genuinely taken version still blocks, with a one-click bump to the next free one', async () => {
  const dir = await makePlugin('1.0.1')
  const store = new ConfigStore(tmpDir('guard-store'))
  const publisher = new Publisher({ store })
  await withRegistry({ versions: ['1.0.0', '1.0.1'], latest: '1.0.1' }, async (registry) => {
    await publisher.updatePlatforms({ npm: { enabled: true, registry, token: 'probe-token' } })
    const preflight = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
    const check = preflight.checks.find((entry) => entry.id === 'npm-version')
    assert.equal(check.status, 'fail')
    assert.equal(check.fix, 'bump')
    assert.equal(check.suggestion, '1.0.2')
    assert.equal(preflight.canPublish, false, 'a duplicate version must stop the publish button')

    // The publish path must refuse the same way, before a single step runs.
    await assert.rejects(
      () => publisher.publish({ path: dir, form: { platforms: ['npm'], dryRun: true } }),
      (error) => error.code === 'preflight-failed',
      'publish must not even start a job on a blocking preflight',
    )
  })
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('publish carries a lower-but-unpublished version past the npm guard', async () => {
  const dir = await makePlugin('0.3.4')
  const store = new ConfigStore(tmpDir('guard-store'))
  const publisher = new Publisher({ store })
  await withRegistry({ versions: ['1.0.0', '1.0.1'], latest: '1.0.1' }, async (registry) => {
    await publisher.updatePlatforms({ npm: { enabled: true, registry, token: 'probe-token' } })
    const started = await publisher.publish({ path: dir, form: { platforms: ['npm'], dryRun: true } })
    const job = await drain(publisher, started.jobId)
    assert.ok(job, 'the job must be retrievable')
    const guard = (job.steps || []).find((entry) => entry.id === 'npm-guard')
    assert.ok(guard, 'npm-guard must have run')
    assert.equal(guard.status, 'done', `the guard must not refuse 0.3.4: ${JSON.stringify(guard)}`)
    assert.ok(String(guard.detail || '').includes('1.0.1'), `the guard should name the remote version: ${guard.detail}`)
    const refused = (job.steps || []).filter((entry) => entry.error && entry.error.code === 'version-exists')
    assert.equal(refused.length, 0, 'no step may report version-exists for an unpublished version')
  })
  await fsp.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

let failed = 0
for (const row of results) {
  if (!row.ok) failed += 1
  console.log(`${row.ok ? 'PASS  ' : 'FAIL  '}${row.name}${row.ok || !row.error ? '' : ' — ' + row.error}`)
}
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
