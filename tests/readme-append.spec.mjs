// Regression tests for the append-only changelog model.
//
// The product rule is: re-publishing must never destroy hand-written docs.
// `auto` keeps an existing README, `append` only adds a changelog block, and
// `regenerate` is the single destructive, opt-in mode.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  appendReleaseNotes,
  applyPreparation,
  buildReleaseNotesEntry,
  planPreparation,
  README_NOTES_BEGIN,
  README_NOTES_END,
} from '../lib/prepare.mjs'

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

function pluginFixture(overrides = {}) {
  return Object.assign({
    path: 'C:\\tmp',
    name: 'probe',
    version: '0.2.0',
    hasReadme: true,
    readmeFile: 'README.md',
    hasLicense: true,
    licenseFile: 'LICENSE',
    hasGit: true,
    manifestText: null,
    exportsList: [],
    description: 'a probe',
    descriptionZh: '',
    keywords: [],
    homepage: '',
    author: '',
    repository: null,
  }, overrides)
}

const HAND_WRITTEN = '# Hand written\n\nDo not touch this paragraph.\n\n## Usage\n\nsteps…\n'

await test('the three readme modes produce the expected plan', async () => {
  const base = { addReadme: true, license: 'MIT', addLicense: true, addGitignore: true, updatePackageJson: false }
  const cases = [
    ['auto', 'keep'],
    ['append', 'append-notes'],
    ['regenerate', 'update'],
  ]
  for (const [mode, expected] of cases) {
    const plan = planPreparation({ plugin: pluginFixture(), form: { ...base, readmeMode: mode } })
    const readme = plan.files.find((entry) => /^readme/i.test(entry.file))
    assert.ok(readme, `no README entry for mode=${mode}`)
    assert.equal(readme.action, expected, `mode=${mode}`)
  }
})

await test('a missing README is still generated (never "keep")', async () => {
  const base = { addReadme: true, license: 'MIT', addLicense: true, addGitignore: true, updatePackageJson: false }
  const plan = planPreparation({ plugin: pluginFixture({ hasReadme: false }), form: { ...base, readmeMode: 'append' } })
  const readme = plan.files.find((entry) => /^readme/i.test(entry.file))
  assert.equal(readme.action, 'create', 'no README on disk means we must create one')
  assert.ok(typeof readme.content === 'string' && readme.content.length > 0)
})

await test('append keeps every existing byte and adds a changelog block', async () => {
  const entry = buildReleaseNotesEntry({ plugin: { version: '0.2.0' }, form: { releaseNotes: '- fixed two bugs' }, tag: 'v0.2.0' })
  const out = appendReleaseNotes(HAND_WRITTEN, entry, 'v0.2.0')
  assert.equal(out.appended, true)
  assert.ok(out.text.includes('# Hand written'), 'original heading must survive')
  assert.ok(out.text.includes('Do not touch this paragraph.'), 'original prose must survive')
  assert.ok(out.text.includes(README_NOTES_BEGIN) && out.text.includes(README_NOTES_END), 'markers expected')
  assert.ok(out.text.includes('### v0.2.0'), 'the tag heading expected')
  assert.ok(out.text.includes('- fixed two bugs'), 'the notes expected')
})

await test('a second release prepends to the block and keeps the first entry', async () => {
  const first = appendReleaseNotes(HAND_WRITTEN, buildReleaseNotesEntry({ plugin: { version: '0.2.0' }, form: { releaseNotes: '- first' }, tag: 'v0.2.0' }), 'v0.2.0')
  const second = appendReleaseNotes(first.text, buildReleaseNotesEntry({ plugin: { version: '0.3.0' }, form: { releaseNotes: '- second' }, tag: 'v0.3.0' }), 'v0.3.0')
  assert.equal(second.appended, true)
  assert.ok(second.text.includes('### v0.2.0'), 'the earlier entry must not be dropped')
  assert.ok(second.text.includes('### v0.3.0'), 'the new entry expected')
  assert.ok(second.text.indexOf('### v0.3.0') < second.text.indexOf('### v0.2.0'), 'newest first')
  assert.ok(second.text.includes('Do not touch this paragraph.'), 'hand-written prose survives both releases')
})

await test('re-publishing the same tag is idempotent', async () => {
  const entry = buildReleaseNotesEntry({ plugin: { version: '0.2.0' }, form: { releaseNotes: '- x' }, tag: 'v0.2.0' })
  const once = appendReleaseNotes(HAND_WRITTEN, entry, 'v0.2.0')
  const twice = appendReleaseNotes(once.text, entry, 'v0.2.0')
  assert.equal(twice.appended, false, 'the same tag must not be appended twice')
  assert.equal(twice.text, once.text, 'the file must be byte-identical')
})

await test('applyPreparation appends in place and reports the delta', async () => {
  const dir = tmpDir('notes-apply')
  await fsp.mkdir(dir, { recursive: true })
  const readmePath = path.join(dir, 'README.md')
  await fsp.writeFile(readmePath, HAND_WRITTEN, 'utf8')

  const plan = { pluginPath: dir, files: [{ file: 'README.md', action: 'append-notes', content: null, bytes: 0, reason: 'append' }], warnings: [] }
  const entry = buildReleaseNotesEntry({ plugin: { version: '0.2.0' }, form: { releaseNotes: '- added' }, tag: 'v0.2.0' })
  const outcome = await applyPreparation(plan, { notesEntry: entry, tag: 'v0.2.0' })
  assert.equal(outcome.written.length, 1)
  assert.equal(outcome.written[0].action, 'append-notes')
  assert.ok(outcome.written[0].bytes > 0, 'should report the appended byte count')

  const after = await fsp.readFile(readmePath, 'utf8')
  assert.ok(after.includes('Do not touch this paragraph.'), 'the file on disk keeps the original text')
  assert.ok(after.includes('### v0.2.0'), 'and gains the entry')
  assert.ok(after.length > HAND_WRITTEN.length, 'the file grew, it was not replaced')

  // Re-applying the same tag must not change the file at all.
  const again = await applyPreparation(plan, { notesEntry: entry, tag: 'v0.2.0' })
  assert.equal(again.written[0].action, 'keep', 'second apply should be a no-op')
  assert.equal(await fsp.readFile(readmePath, 'utf8'), after)
  await fsp.rm(dir, { recursive: true, force: true })
})

await test('dry-run reports the append without writing', async () => {
  const dir = tmpDir('notes-dry')
  await fsp.mkdir(dir, { recursive: true })
  const readmePath = path.join(dir, 'README.md')
  await fsp.writeFile(readmePath, HAND_WRITTEN, 'utf8')
  const plan = { pluginPath: dir, files: [{ file: 'README.md', action: 'append-notes', content: null, bytes: 0, reason: 'append' }], warnings: [] }
  const entry = buildReleaseNotesEntry({ plugin: { version: '0.2.0' }, form: { releaseNotes: '- x' }, tag: 'v0.2.0' })
  const outcome = await applyPreparation(plan, { dryRun: true, notesEntry: entry, tag: 'v0.2.0' })
  assert.equal(outcome.written[0].dryRun, true)
  assert.equal(await fsp.readFile(readmePath, 'utf8'), HAND_WRITTEN, 'dry-run must not touch the file')
  await fsp.rm(dir, { recursive: true, force: true })
})

let failed = 0
for (const row of results) {
  if (!row.ok) failed += 1
  console.log(`${row.ok ? 'PASS  ' : 'FAIL  '}${row.name}${row.ok || !row.error ? '' : ' — ' + row.error}`)
}
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
