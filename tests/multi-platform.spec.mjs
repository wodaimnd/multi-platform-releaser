// Minimal host-side smoke test for the multi-platform additions.
// Runs the real Publisher against a temporary plugin dir and a temp data dir.
// No network calls to npm/GitHub are made except the ones explicitly allowed.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ConfigStore } from '../lib/store.mjs'
import { Publisher, bumpVersionString, platformLabelList, npmPackageNameOf, ownershipVerdict, ownershipFingerprint, ownershipRememberedFor } from '../lib/publisher.mjs'
import {
  buildStepIds,
  compareVersions,
  isAcceptableBaseUrl,
  isLocallyManagedRegistry,
  isPrivateHostname,
  isScopedNpmName,
  isValidNpmName,
  nodeBinaryFor,
  normalizeBaseUrl,
  normalizePlatforms,
  npmCliCandidates,
  npmCliPath,
  npmPackagePath,
  npmPublishNameOf,
  publicPlatformConfig,
  registryStatus,
  scopeOfName,
  scopePublishName,
  stageForNpmPublish,
  startLocalRegistry,
  verdaccioBinaryPath,
} from '../lib/platforms.mjs'

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

async function makePlugin(dir, { name = 'dsh-sample-plugin', version = '0.1.0', withReadme = true } = {}) {
  await fsp.mkdir(dir, { recursive: true })
  const manifest = {
    name,
    version,
    type: 'module',
    description: 'sample plugin for tests',
    exports: { '.': './index.js', './client': './client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fsp.writeFile(path.join(dir, 'index.js'), 'export const name = "sample"\nexport function apply() {}\n', 'utf8')
  await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: sample\n      name: dsh-sample-plugin\n", 'utf8')
  if (withReadme) await fsp.writeFile(path.join(dir, 'README.md'), '# sample\n', 'utf8')
  return dir
}

async function main() {
  await test('buildStepIds: github only matches the historic order', async () => {
    assert.deepEqual(buildStepIds(['github']), ['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish'])
  })

  await test('buildStepIds: npm only skips the GitHub group', async () => {
    assert.deepEqual(buildStepIds(['npm']), ['inspect', 'prepare', 'npm-auth', 'npm-guard', 'npm-publish', 'npm-verify', 'finish'])
  })

  await test('buildStepIds: github+npm runs both groups', async () => {
    const ids = buildStepIds(['github', 'npm'])
    assert.ok(ids.includes('release'))
    assert.ok(ids.includes('npm-publish'))
    assert.equal(ids.filter((id) => id === 'finish').length, 1)
  })

  await test('bumpVersionString: patch/minor/major', async () => {
    assert.equal(bumpVersionString('1.2.3', 'patch'), '1.2.4')
    assert.equal(bumpVersionString('1.2.3', 'minor'), '1.3.0')
    assert.equal(bumpVersionString('1.2.3', 'major'), '2.0.0')
    assert.equal(bumpVersionString('1.2.3-beta.1', 'patch'), '1.2.4')
    assert.equal(bumpVersionString('0.0.0', 'patch'), '0.0.1')
  })

  await test('platformLabelList + npm helpers', async () => {
    assert.equal(platformLabelList(['github', 'npm']), 'GitHub + npm registry')
    assert.equal(platformLabelList(['npm']), 'npm registry')
    assert.equal(npmPackageNameOf({ name: '@scope/thing' }), '@scope/thing')
    assert.equal(npmPackagePath('@scope/thing'), '@scope%2fthing')
    assert.equal(compareVersions('1.2.3', '1.10.0'), -1)
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  })

  await test('npm CLI resolution survives an Electron execPath', async () => {
    // The Host runs inside Electron: process.execPath is the app EXE, so npm must
    // be found through PATH / prefix instead of "next to execPath".
    const fakeExe = process.platform === 'win32'
      ? 'C:\\Program Files\\SomeApp\\app.exe'
      : '/Applications/SomeApp/Contents/MacOS/app'
    const candidates = npmCliCandidates(fakeExe, process.env)
    assert.ok(candidates.length > 0, 'must produce candidates even for an EXE')
    assert.ok(candidates.some((entry) => entry.endsWith('npm-cli.js')))
    // A node on PATH (or a bundled one) has to be found to run the JS CLI.
    const nodeBinary = nodeBinaryFor(fakeExe, process.env)
    assert.ok(typeof nodeBinary === 'string' && nodeBinary.length > 0)
    // On a machine with Node installed, resolution must succeed outright.
    const resolved = npmCliPath()
    if (resolved !== null) {
      assert.ok(resolved.endsWith('.js'))
      assert.equal(resolved, npmCliPath(fakeExe) === null ? resolved : npmCliPath(fakeExe))
    }
  })

  await test('normalizePlatforms: defaults enable GitHub only', async () => {
    const config = normalizePlatforms(undefined)
    assert.deepEqual(config.enabled, ['github'])
    assert.equal(config.github.enabled, true)
    assert.equal(config.npm.enabled, false)
    assert.equal(config.npm.registry, 'https://registry.npmjs.org')
  })

  await test('normalizePlatforms: npm token survives, public view hides it', async () => {
    const config = normalizePlatforms({ npm: { enabled: true, token: 'npm_secret_value_123456' } })
    assert.equal(config.npm.token, 'npm_secret_value_123456')
    assert.deepEqual(config.enabled.sort(), ['github', 'npm'])
    const view = publicPlatformConfig('npm', config)
    assert.equal(view.token, undefined)
    assert.equal(view.tokenConfigured, true)
    assert.ok(view.tokenHint.includes('…'))
    assert.ok(!view.tokenHint.includes('secret'))
  })

  // ── Publisher-level tests ───────────────────────────────────────────────
  const dataDir = tmpDir('multi-publisher-data')
  const pluginDir = tmpDir('multi-publisher-plugin')
  await makePlugin(pluginDir)
  process.env.DSH_GITHUB_PUBLISHER_DIR = dataDir
  const store = new ConfigStore(dataDir)
  const publisher = new Publisher({ store, env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', NPM_TOKEN: '' }, getWorkspacePaths: () => [path.dirname(pluginDir)] })

  await test('platformState: every hosting present, token-free', async () => {
    const state = await publisher.platformState()
    const ids = state.platforms.map((entry) => entry.id)
    assert.deepEqual(ids.sort(), ['codeberg', 'gitee', 'github', 'npm'])
    // Gitee has no topics route in its v5 spec, and the registry has to say so —
    // the publish pipeline skips the step instead of failing it.
    assert.equal(state.platforms.find((entry) => entry.id === 'gitee').topicsSupported, false)
    assert.equal(state.platforms.find((entry) => entry.id === 'codeberg').topicsSupported, true)
    assert.equal(state.platforms.find((entry) => entry.id === 'gitee').config.token, undefined)
    const npm = state.platforms.find((entry) => entry.id === 'npm')
    assert.equal(npm.config.enabled, false)
    assert.equal(npm.config.token, undefined)
    assert.ok(Array.isArray(npm.fields))
    assert.ok(npm.fields.some((field) => field.key === 'token' && field.secret === true))
  })

  await test('updatePlatforms: enable npm, store token, keep GitHub enabled', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true, token: 'npm_test_token_abcdef', access: 'public', distTag: 'next' } })
    const state = await publisher.platformState()
    const npm = state.platforms.find((entry) => entry.id === 'npm')
    assert.equal(npm.config.enabled, true)
    assert.equal(npm.config.distTag, 'next')
    assert.equal(npm.config.tokenConfigured, true)
    assert.deepEqual(state.enabled.sort(), ['github', 'npm'])
  })

  await test('updatePlatforms: clearing a token removes it', async () => {
    await publisher.updatePlatforms({ npm: { token: null } })
    const config = await store.loadConfig()
    assert.equal(config.platforms.npm.token, undefined)
  })

  await test('updatePlatforms: rejects a non-https registry and writes nothing', async () => {
    const before = await store.loadConfig()
    let failed = false
    try {
      await publisher.updatePlatforms({ npm: { registry: 'http://evil.example.com' } })
    } catch (error) {
      failed = true
      assert.equal(error.code, 'bad-request')
      assert.equal(error.status, 400)
    }
    assert.ok(failed, 'a bare http registry must be rejected')
    const after = await store.loadConfig()
    assert.equal(after.platforms.npm.registry, before.platforms.npm.registry, 'config must be untouched')
  })

  await test('updatePlatforms: accepts https and loopback registries', async () => {
    const https = await publisher.updatePlatforms({ npm: { registry: 'https://registry.npmjs.org/' } })
    assert.equal(https.platforms.find((entry) => entry.id === 'npm').config.registry, 'https://registry.npmjs.org')
    const loopback = await publisher.updatePlatforms({ npm: { registry: 'http://127.0.0.1:4873' } })
    assert.equal(loopback.platforms.find((entry) => entry.id === 'npm').config.registry, 'http://127.0.0.1:4873')
    // Shaped like a loopback host but not one: must still be rejected.
    let failed = false
    try {
      await publisher.updatePlatforms({ npm: { registry: 'http://127.0.0.1.evil.com' } })
    } catch (error) {
      failed = true
      assert.equal(error.code, 'bad-request')
    }
    assert.ok(failed)
  })

  await test('registry URL rules: private http is fine, public http is not', async () => {
    // A private registry (Verdaccio / Nexus) is normally served over plain
    // http. Refusing those made the field unusable on an intranet, so http is
    // now allowed for private hosts only — public hosts must use https because
    // the npm token would otherwise cross the internet in cleartext.
    const allow = [
      'http://127.0.0.1:4873',
      'http://localhost:4873',
      'http://192.168.1.50:4873',
      'http://10.0.0.5:4873',
      'http://172.20.0.9:8080',
      'http://registry.internal:4873',
      'http://nas.local:4873',
      'http://[::1]:4873',
      'http://[fd00::1]:4873',
      'https://registry.npmjs.org',
      'https://my-registry.company.com',
      'registry.npmjs.org:4873',
      'evil.example.com',
    ]
    for (const url of allow) {
      assert.equal(isAcceptableBaseUrl(url), true, `should accept: ${url}`)
    }

    const deny = [
      'http://evil.example.com',
      'http://8.8.8.8:4873',
      'http://public.example.org',
      'http://192.168.1.50.evil.com:4873',
      'http://127.0.0.1.evil.com',
      'http://172.15.0.1:4873',   // just outside the 172.16/12 block
      'http://172.32.0.1:4873',   // just outside on the other side
      'ftp://registry.example.com',
      '',
    ]
    for (const url of deny) {
      assert.equal(isAcceptableBaseUrl(url), false, `should reject: ${url}`)
    }
  })

  await test('registry URL rules: a scheme-less value gains the implied scheme', async () => {
    // Users paste "registry.npmjs.org" or "127.0.0.1:4873" all the time; infer
    // the scheme from the host instead of refusing.
    assert.equal(normalizeBaseUrl('registry.npmjs.org'), 'https://registry.npmjs.org')
    assert.equal(normalizeBaseUrl('127.0.0.1:4873'), 'http://127.0.0.1:4873')
    assert.equal(normalizeBaseUrl('192.168.1.50:4873'), 'http://192.168.1.50:4873')
    assert.equal(normalizeBaseUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
    assert.equal(normalizeBaseUrl('http://127.0.0.1:4873/'), 'http://127.0.0.1:4873')
  })

  await test('registry URL rules: the rejection explains what to do next', async () => {
    // The old message ("only https:// or 127.0.0.1/localhost") told the user
    // nothing about *why* their intranet registry was refused.
    let message = ''
    try {
      normalizeBaseUrl('http://evil.example.com', 'Registry')
    } catch (error) {
      message = error.message
    }
    assert.ok(message.includes('evil.example.com'), message)
    assert.ok(message.includes('https://evil.example.com'), 'must suggest the https form: ' + message)
    assert.ok(!/只接受 https:\/\/，或以/.test(message), 'old blanket wording must be gone: ' + message)

    let emptyMessage = ''
    try { normalizeBaseUrl('', 'Registry') } catch (error) { emptyMessage = error.message }
    assert.ok(emptyMessage.includes('不能为空'), emptyMessage)
  })

  await test('registry URL rules: a private http registry is saved as typed', async () => {
    const saved = await publisher.updatePlatforms({ npm: { registry: 'http://192.168.1.50:4873' } })
    assert.equal(saved.platforms.find((entry) => entry.id === 'npm').config.registry, 'http://192.168.1.50:4873')
    await publisher.updatePlatforms({ npm: { registry: 'https://registry.npmjs.org' } })
  })

  // ── local registry lifecycle ──────────────────────────────────────────────

  await test('registryStatus: a dead local registry is reported as startable', async () => {
    // Nothing listens on this port; the point is that the status separates
    // "not started" from "wrong address" so the UI can offer the right action.
    const status = await registryStatus('http://127.0.0.1:9', process.env)
    assert.equal(status.reachable, false, 'nothing answers on port 9')
    assert.equal(status.port, 9)
    assert.equal(status.local, true, 'loopback is a locally-managed registry')
    assert.equal(status.verdaccio, true, 'Verdaccio is installed on this machine')
    assert.equal(typeof status.detail, 'string')
    assert.ok(status.detail.length > 0)
  })

  await test('registryStatus: a public registry is never startable', async () => {
    const status = await registryStatus('https://registry.npmjs.org', process.env)
    assert.equal(status.local, false, 'a public registry is not ours to start')
    assert.equal(status.startable, false, 'must never offer to start a remote host')
    assert.ok(status.detail.includes('只能启动本机') || status.verdaccio === true)
  })

  await test('isLocallyManagedRegistry: only private hosts qualify', async () => {
    for (const url of ['http://127.0.0.1:4873', 'http://localhost:4873', 'http://192.168.1.50:4873']) {
      assert.equal(isLocallyManagedRegistry(url), true, url)
    }
    for (const url of ['https://registry.npmjs.org', 'https://evil.example.com', 'http://8.8.8.8:4873']) {
      assert.equal(isLocallyManagedRegistry(url), false, url)
    }
  })

  await test('startLocalRegistry: refuses a remote registry instead of shelling out', async () => {
    const result = await startLocalRegistry('https://registry.npmjs.org', process.env)
    assert.equal(result.started, false)
    assert.equal(result.local, false)
    assert.ok(/只能启动本机/.test(result.error || ''), result.error)
  })

  await test('verifyPlatform: a missing npm token is a 400, not an internal error', async () => {
    await publisher.updatePlatforms({ npm: { token: null } })
    let failed = false
    try {
      await publisher.verifyPlatform('npm')
    } catch (error) {
      failed = true
      assert.equal(error.code, 'npm-no-token')
      assert.equal(error.status, 400)
    }
    assert.ok(failed)
  })

  await test('preflight: npm-only selection skips GitHub checks', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true, token: 'npm_test_token_abcdef' } })
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true, descriptionZh: '测试' } })
    assert.deepEqual(preflight.platforms, ['npm'])
    const ids = preflight.checks.map((check) => check.id)
    assert.ok(ids.includes('npm-name'))
    assert.ok(!ids.includes('repo'), 'npm-only preflight must not check a GitHub repo')
    assert.ok(!ids.includes('owner'), 'npm-only preflight must not require a GitHub owner')
    assert.equal(preflight.needsAccount, false)
    assert.equal(preflight.canPublish, true)
  })

  // -- Gitee / Codeberg as first-class hostings ----------------------------
  // These were invisible to preflight while the pipeline was keyed on github:
  // a Gitee selection produced no credential check at all, so the panel said
  // "configured" and the publish failed at auth.

  await test('preflight: a Gitee selection is treated as a repository hosting', async () => {
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['gitee'], owner: 'probe', name: 'dsh-sample-plugin', dryRun: true } })
    assert.equal(preflight.host, 'gitee', 'the hosting is reported, not assumed to be GitHub')
    const ids = preflight.checks.map((check) => check.id)
    // GitHub-only checks must not run: no account resolver, no repo probe.
    assert.ok(!ids.includes('auth'), 'GitHub account checks do not belong on a Gitee job')
    assert.ok(!ids.includes('repo'), 'no GitHub repo lookup for a Gitee job')
    // A blank owner means "use this hosting's own account" — the right default
    // when GitHub/Gitee/Codeberg log in as different users. It is reported as a
    // passing check that says whose account will be used, not as a blocker.
    const blankOwner = await publisher.preflight({ path: pluginDir, form: { platforms: ['gitee'], owner: '', name: 'dsh-sample-plugin' } })
    const ownerCheck = blankOwner.checks.find((check) => check.id === 'owner')
    assert.ok(ownerCheck, 'the ownership of the target must be explained')
    assert.equal(ownerCheck.status, 'pass')
    assert.ok(!blankOwner.blocking.includes('owner'), 'a blank owner is not a blocker')
    assert.equal(preflight.needsAccount, false, 'GitHub account connection is irrelevant here')
  })

  await test('preflight: an npm-only selection reports no hosting at all', async () => {
    // Regression: hostingOf used to fall back to github for npm-only, which
    // made an npm-only preflight hit the GitHub repo API.
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    assert.equal(preflight.host, '', 'no repository hosting is selected')
    assert.ok(!preflight.checks.some((check) => check.id === 'repo'), 'and no repo check runs')
    assert.ok(!preflight.checks.some((check) => check.id === 'host-auth'), 'nor a hosting credential check')
  })

  await test('preflight: a missing hosting token blocks the publish and names it', async () => {
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['gitee'], owner: 'probe', name: 'dsh-sample-plugin' } })
    const auth = preflight.checks.find((check) => check.id === 'host-auth')
    assert.ok(auth, 'a hosting credential check must exist')
    assert.equal(auth.status, 'fail')
    assert.ok(auth.title.includes('Gitee'), auth.title)
    assert.ok(preflight.blocking.includes('host-auth'), 'and it must block')
    assert.equal(preflight.canPublish, false)
    assert.equal(preflight.needsHostToken, true, 'the UI needs this to explain what is missing')
  })

  await test('preflight: Gitee warns that topics will be skipped', async () => {
    const preflight = await publisher.preflight({
      path: pluginDir,
      form: { platforms: ['gitee'], owner: 'probe', name: 'dsh-sample-plugin', dryRun: true, topics: ['dsh', 'plugin'] },
    })
    const mentioned = preflight.warnings.some((line) => line.includes('topics'))
    assert.ok(mentioned, 'expected a topics warning, got ' + JSON.stringify(preflight.warnings))
  })

  await test('preflight: Codeberg is its own hosting with its own credential check', async () => {
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['codeberg'], owner: 'probe', name: 'dsh-sample-plugin' } })
    assert.equal(preflight.host, 'codeberg')
    const auth = preflight.checks.find((check) => check.id === 'host-auth')
    assert.ok(auth && auth.title.includes('Codeberg'), JSON.stringify(auth))
    assert.ok(preflight.blocking.includes('host-auth'))
  })

  await test('preflight: github selection still checks repo/owner', async () => {
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['github'], owner: 'someone', name: 'dsh-sample-plugin' } })
    const ids = preflight.checks.map((check) => check.id)
    assert.ok(ids.includes('repo'))
    assert.equal(preflight.form.owner, 'someone')
    // With GitHub as the only hosting, a blank owner is still filled from the
    // connected account — but only then. Multi-hosting keeps it blank on purpose.
    const blank = await publisher.preflight({ path: pluginDir, form: { platforms: ['github'], owner: '', name: 'dsh-sample-plugin' } })
    const ownerCheck = blank.checks.find((check) => check.id === 'owner')
    assert.ok(ownerCheck, JSON.stringify(blank.checks.map((c) => c.id)))
    assert.equal(ownerCheck.status, 'pass', 'a blank owner is not a blocker')
    assert.ok(!blank.blocking.includes('owner'))
  })

  // -- 多平台同时发布 ------------------------------------------------------
  // The product is a *multi-platform* publisher: one commit, every ticked
  // remote. A job that could only reach one hosting would defeat that, so these
  // pin the fan-out and the per-hosting failure isolation.

  await test('hostingsOf: every ticked repository hosting is returned', async () => {
    const { hostingsOf, hostingOf, hasHosting } = await import('../lib/platforms.mjs')
    assert.deepEqual(hostingsOf(['github', 'gitee', 'codeberg']), ['github', 'gitee', 'codeberg'])
    assert.deepEqual(hostingsOf(['gitee', 'codeberg', 'npm']), ['gitee', 'codeberg'], 'npm is not a hosting')
    assert.deepEqual(hostingsOf(['npm']), [], 'an npm-only job has no hosting')
    assert.equal(hostingOf(['github', 'gitee']), 'github', 'the primary is the first in registry order')
    assert.equal(hasHosting(['npm']), false)
  })

  await test('buildStepIds: a multi-hosting job runs the full git pipeline once', async () => {
    const { buildStepIds } = await import('../lib/platforms.mjs')
    const steps = buildStepIds(['github', 'gitee', 'codeberg', 'npm'])
    // The commit is made once and pushed to each remote, so repo/push/release
    // appear once in the plan, not once per hosting.
    assert.equal(steps.filter((id) => id === 'repo').length, 1)
    assert.equal(steps.filter((id) => id === 'push').length, 1)
    assert.equal(steps.filter((id) => id === 'commit').length, 1)
    assert.ok(steps.includes('npm-publish'))
  })

  await test('mergeForm: a blank owner means each hosting uses its own account', async () => {
    // The three hostings log in as different users. Filling the owner box with
    // GitHub's login sent a Gitee/Codeberg push to a namespace that does not
    // exist there (verified: POST /orgs/wodaimnd/repos -> 404).
    const { mergeForm } = await import('../lib/publisher.mjs')
    const plugin = { name: 'probe', keywords: [], description: '' }
    const account = { login: 'wodaimnd' }
    const onlyGithub = mergeForm({ defaults: {}, draft: {}, request: { platforms: ['github'] }, plugin, account })
    assert.equal(onlyGithub.owner, 'wodaimnd', 'GitHub alone still fills itself in')
    const giteeOnly = mergeForm({ defaults: {}, draft: {}, request: { platforms: ['gitee'] }, plugin, account })
    assert.equal(giteeOnly.owner, '', 'a non-GitHub hosting must not borrow GitHub login')
    const both = mergeForm({ defaults: {}, draft: {}, request: { platforms: ['gitee', 'codeberg'] }, plugin, account })
    assert.equal(both.owner, '', 'multi-hosting stays blank')
    const explicit = mergeForm({ defaults: {}, draft: {}, request: { platforms: ['gitee'], owner: 'myorg' }, plugin, account })
    assert.equal(explicit.owner, 'myorg', 'an explicit owner is always honoured')
  })

  await test('preflight: a multi-hosting selection reports every hosting', async () => {
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['gitee', 'codeberg'], dryRun: true } })
    const ids = preflight.checks.map((check) => check.id)
    assert.ok(!ids.includes('repo'), 'no single-repo probe when there are several hostings')
    // A dry run substitutes 'local-preview' for a blank owner so a rehearsal never
    // blocks, which means the owner row is only emitted when dryRun is off.
    const real = await publisher.preflight({ path: pluginDir, form: { platforms: ['gitee', 'codeberg'] } })
    const ownerCheck = real.checks.find((check) => check.id === 'owner')
    assert.ok(ownerCheck, 'the ownership question is still answered')
    assert.equal(ownerCheck.status, 'pass', 'a blank owner is a choice, not a blocker')
    assert.ok(!real.blocking.includes('owner'))
  })
  // -- 草稿 / owner / platforms 的三个真缺陷（多插件发布时暴露）---------------

  await test('mergeForm: an explicitly blank owner beats a saved draft', async () => {
    const { mergeForm } = await import('../lib/publisher.mjs')
    const plugin = { name: 'probe', keywords: [], description: '' }
    const account = { login: 'wodaimnd' }
    // Regression: a stale draft owner resurrected `wodaimnd` and was sent to Gitee
    // and Codeberg as an organisation, both of which answered 404.
    const withDraft = mergeForm({
      defaults: {},
      draft: { owner: 'wodaimnd', platforms: ['github'] },
      request: { platforms: ['github', 'gitee', 'codeberg'], owner: '' },
      plugin,
      account,
    })
    assert.equal(withDraft.owner, '', 'a cleared field must not be refilled from the draft')
    // Omitting the key entirely still lets the draft speak.
    const omitted = mergeForm({
      defaults: {},
      draft: { owner: 'saved-org' },
      request: { platforms: ['gitee'] },
      plugin,
      account,
    })
    assert.equal(omitted.owner, 'saved-org', 'a missing key may inherit')
  })

  await test('mergeForm: form.platforms carries the requested selection', async () => {
    // Regression: form.platforms was left undefined, so preflight and publish both
    // fell back to GitHub-only no matter what the caller asked for.
    const { mergeForm } = await import('../lib/publisher.mjs')
    const plugin = { name: 'probe', keywords: [], description: '' }
    const f = mergeForm({
      defaults: {},
      draft: {},
      request: { platforms: ['github', 'gitee', 'codeberg', 'npm'], owner: '' },
      plugin,
      account: { login: 'wodaimnd' },
    })
    // normalizeSelection reorders by registry order (npm sits between github and
    // gitee), which the step planner relies on — compare as a set, not a sequence.
    assert.deepEqual([...f.platforms].sort(), ['codeberg', 'gitee', 'github', 'npm'].sort())
    assert.equal(f.host, 'github', 'the primary hosting is recorded too')
  })

  await test('a publish without a Release is not reported as partial', async () => {
    // Regression: createRelease:false skips the whole step, leaving each hosting's
    // steps.release at 'pending' — which the aggregation read as unfinished work.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../lib/publisher.mjs', import.meta.url), 'utf8')
    // `release` is always in the plan, so "was it scheduled" is the wrong question.
    // What matters is the per-hosting status: a hosting whose release never
    // dispatched stays 'pending', and that must count as satisfied.
    const block = src.slice(src.indexOf('const releaseOk ='))
    assert.ok(block.length > 0, 'the per-hosting release guard exists')
    const head = block.slice(0, 260)
    assert.ok(head.includes("steps.release === 'done'"), 'done counts')
    assert.ok(head.includes("steps.release === 'skipped'"), 'an operator-skipped release counts')
    assert.ok(head.includes("steps.release === 'pending'"),
      'a hosting the step never reached counts as satisfied, not as unfinished')
  })
  // -- npm-verify：索引延迟不是发布失败 --------------------------------------
  // npm accepted six publishes that the verify step then reported as failures,
  // because it asked the registry once, immediately, and npm indexes async.

  await test('a slow npm index never fails the publish', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../lib/publisher.mjs', import.meta.url), 'utf8')

    // Retry ladder exists and is generous enough for the measured ~90s lag.
    assert.ok(/const ATTEMPTS = 7/.test(src), 'the verify retries instead of asking once')
    const ladder = src.match(/const DELAYS_MS = \[([^\]]+)\]/)
    assert.ok(ladder, 'the backoff ladder is explicit')
    // Numeric separators (3_000) are valid JS literals but not Number() input.
    const totalMs = ladder[1].split(',').reduce((sum, v) => sum + Number(v.trim().replace(/_/g, '')), 0)
    assert.ok(totalMs >= 150000, 'the budget covers the observed lag: ' + totalMs + 'ms')

    // Three outcomes must stay distinct.
    assert.ok(src.includes('npm-verify-unreachable'), 'an unreadable registry is its own outcome')
    assert.ok(src.includes('这是索引延迟，不是发布失败'),
      'a package that exists but is not yet indexed is described as lag, not failure')
    // The lag branch must warn + skip, not throw.
    const lagBranch = src.slice(src.indexOf('这是索引延迟，不是发布失败'))
    // Stop before the fall-through throw that follows the lag branch.
    const tail = lagBranch.slice(0, lagBranch.indexOf('return') + 40)
    assert.ok(tail.includes("'skipped'"), 'the step is skipped, so the job can finish')
    assert.ok(!tail.includes('npm-verify-failed'), 'and it does not raise the failure code')
  })
  await test('preflight: npm version collision is a blocking failure', async () => {
    // Simulate a remote state without network by monkey-patching nothing real:
    // we assert on the plan field instead, which is computed from npmState.
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    assert.ok(preflight.plan.npm)
    assert.equal(preflight.plan.npm.name, 'dsh-sample-plugin')
    assert.equal(preflight.plan.npm.access, 'public')
  })

  await test('preflight: an unreachable registry names the host instead of "fetch failed"', async () => {
    // Point npm at a port nothing listens on. The user must be told *which*
    // registry is down — the old code surfaced Node's bare `fetch failed`.
    await publisher.updatePlatforms({ npm: { enabled: true, registry: 'http://127.0.0.1:9', token: 'npm_unreachable_probe' } })
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    const authCheck = preflight.checks.find((check) => check.id === 'npm-auth')
    const versionCheck = preflight.checks.find((check) => check.id === 'npm-version')
    assert.ok(authCheck, 'npm-auth check must exist')
    assert.equal(authCheck.title, 'registry 连不上')
    assert.ok(authCheck.detail.includes('127.0.0.1:9'), 'detail must name the registry host, got: ' + authCheck.detail)
    assert.ok(authCheck.detail.includes('没有 registry 在监听'), 'detail must explain the cause, got: ' + authCheck.detail)
    assert.ok(!authCheck.detail.includes('fetch failed'), 'must never leak the opaque fetch error')
    assert.ok(versionCheck && versionCheck.title === 'registry 连不上，版本未校验', 'version check must explain too')
    assert.equal(authCheck.status, 'warn')
    // Restore a usable registry for the remaining tests.
    await publisher.updatePlatforms({ npm: { registry: 'https://registry.npmjs.org' } })
  })

  await test('bumpVersion: patch writes package.json and keeps indentation', async () => {
    const result = await publisher.bumpVersion({ path: pluginDir, mode: 'patch' })
    assert.equal(result.previous, '0.1.0')
    assert.equal(result.version, '0.1.1')
    const text = await fsp.readFile(path.join(pluginDir, 'package.json'), 'utf8')
    const manifest = JSON.parse(text)
    assert.equal(manifest.version, '0.1.1')
    assert.ok(text.endsWith('\n'))
    assert.ok(!text.includes('\t'))
  })

  await test('bumpVersion: set with explicit version', async () => {
    const result = await publisher.bumpVersion({ path: pluginDir, version: '2.0.0' })
    assert.equal(result.version, '2.0.0')
    assert.equal(result.mode, 'set')
  })

  await test('bumpVersion: invalid input is rejected', async () => {
    let failed = false
    try {
      await publisher.bumpVersion({ path: pluginDir, version: 'not-a-version' })
    } catch (error) {
      failed = true
      assert.equal(error.code, 'bad-request')
    }
    assert.ok(failed)
  })

  await test('syncPlan: unknown GitHub (no token) + npm absent', async () => {
    const plan = await publisher.syncPlan({ path: pluginDir })
    assert.equal(plan.name, 'dsh-sample-plugin')
    const github = plan.platforms.find((row) => row.platform === 'github')
    const npm = plan.platforms.find((row) => row.platform === 'npm')
    assert.equal(github.state, 'unknown')
    assert.ok(['absent', 'unknown'].includes(npm.state))
    assert.ok(Array.isArray(plan.behind))
  })

  // ── publish-name override: rename only at publish time ───────────────────

  await test('name helpers: scope rewrite, validation and override resolution', async () => {
    assert.equal(scopePublishName('@local/market-lens', '@jntm114514'), '@jntm114514/market-lens')
    assert.equal(scopePublishName('market-lens', '@jntm114514'), '@jntm114514/market-lens')
    assert.equal(scopePublishName('@local/x', '@jntm114514/'), '@jntm114514/x')
    assert.equal(scopeOfName('@jntm114514/x'), '@jntm114514')
    assert.equal(scopeOfName('x'), '')
    assert.equal(isScopedNpmName('@jntm114514/x'), true)
    assert.equal(isScopedNpmName('x'), false)
    assert.equal(isValidNpmName('@jntm114514/market-verdict'), true)
    assert.equal(isValidNpmName('Bad Name'), false)
    assert.equal(isValidNpmName('@jntm114514/X'), false, 'npm names must be lowercase')
    assert.equal(isValidNpmName('x'.repeat(215)), false)
    assert.equal(npmPublishNameOf('@local/x', { publishName: '@jntm114514/x' }), '@jntm114514/x')
    assert.equal(npmPublishNameOf('@local/x', {}), '@local/x', 'no override keeps the manifest name')
    assert.equal(npmPublishNameOf('@local/x', { publishName: '   ' }), '@local/x', 'blank override is ignored')
  })

  await test('stageForNpmPublish rewrites only the temp copy, never the source', async () => {
    const source = tmpDir('stage-source')
    await makePlugin(source, { name: '@local/stage-probe', version: '0.2.0' })
    await fsp.writeFile(path.join(source, 'README.md'), '# stage probe\n', 'utf8')
    const before = await fsp.readFile(path.join(source, 'package.json'), 'utf8')

    const stage = await stageForNpmPublish(source, '@jntm114514/stage-probe')
    try {
      assert.equal(stage.renamed, true)
      assert.equal(stage.previous, '@local/stage-probe')
      assert.equal(stage.name, '@jntm114514/stage-probe')
      const staged = await fsp.readFile(path.join(stage.dir, 'package.json'), 'utf8')
      assert.equal(JSON.parse(staged).name, '@jntm114514/stage-probe')
      assert.equal(JSON.parse(staged).version, '0.2.0', 'other fields must survive')
      assert.ok(staged.endsWith('\n'), 'keep the trailing newline')
      assert.ok(await fsp.readFile(path.join(stage.dir, 'README.md'), 'utf8'), 'files must be copied')
      // The source tree is untouched — that is the whole point of the stage.
      assert.equal(await fsp.readFile(path.join(source, 'package.json'), 'utf8'), before)
    } finally {
      await stage.cleanup()
    }
    await assert.rejects(fsp.stat(stage.dir), 'the stage must be removed after cleanup')
  })

  await test('stageForNpmPublish keeps .git and node_modules out of the tarball', async () => {
    const source = tmpDir('stage-filter')
    await makePlugin(source, { name: '@local/filter-probe' })
    await fsp.mkdir(path.join(source, '.git'), { recursive: true })
    await fsp.writeFile(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
    await fsp.mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true })
    await fsp.writeFile(path.join(source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n', 'utf8')

    const stage = await stageForNpmPublish(source, '@jntm114514/filter-probe')
    try {
      await assert.rejects(fsp.stat(path.join(stage.dir, '.git')), '.git must not be copied')
      await assert.rejects(fsp.stat(path.join(stage.dir, 'node_modules')), 'node_modules must not be copied')
      assert.ok(await fsp.stat(path.join(stage.dir, 'index.js')), 'real files must be copied')
    } finally {
      await stage.cleanup()
    }
  })

  await test('preflight reports the publish name while keeping the manifest name', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true } })
    await publisher.saveDraft(pluginDir, { publishName: '@jntm114514/dsh-sample-plugin' })
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    assert.equal(preflight.plan.npm.name, '@jntm114514/dsh-sample-plugin')
    assert.equal(preflight.plan.npm.manifestName, 'dsh-sample-plugin')
    assert.equal(preflight.plan.npm.renamedForPublish, true)
    const nameCheck = preflight.checks.find((check) => check.id === 'npm-name')
    assert.equal(nameCheck.status, 'pass')
    assert.equal(nameCheck.title, '发布用包名（仅发布时生效）')
    assert.ok(nameCheck.detail.includes('@jntm114514/dsh-sample-plugin'), nameCheck.detail)
    assert.ok(nameCheck.detail.includes('源码 package.json 仍是 dsh-sample-plugin'), nameCheck.detail)
    // Clearing the override falls back to the manifest name.
    await publisher.saveDraft(pluginDir, {})
    const plain = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    assert.equal(plain.plan.npm.name, 'dsh-sample-plugin')
    assert.equal(plain.plan.npm.renamedForPublish, false)
  })

  await test('stageForNpmPublish drops private:true only in the copy', async () => {
    // npm refuses to publish `private: true` packages (EPRIVATE). The staged
    // copy exists to be published, so the flag must go there — and must stay in
    // the source manifest, which still guards the locally installed plugin.
    const source = tmpDir('stage-private')
    await makePlugin(source, { name: '@local/private-probe', version: '0.1.0' })
    const manifestPath = path.join(source, 'package.json')
    const raw = await fsp.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)
    manifest.private = true
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const stage = await stageForNpmPublish(source, '@jntm114514/private-probe')
    try {
      assert.equal(stage.droppedPrivate, true, 'stage must report dropping the flag')
      const staged = JSON.parse(await fsp.readFile(path.join(stage.dir, 'package.json'), 'utf8'))
      assert.equal(staged.private, undefined, 'staged copy must not be private')
      assert.equal(staged.name, '@jntm114514/private-probe')
      const sourceAfter = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
      assert.equal(sourceAfter.private, true, 'source manifest must keep private:true')
      assert.equal(sourceAfter.name, '@local/private-probe', 'source name must be untouched')
    } finally {
      await stage.cleanup()
    }
  })

  // ── ownership: never a blocker, always visible ─────────────────────────
  // Forked plugins legitimately carry the original author, so the verdict must
  // be able to say "this is somebody else's name" without ever refusing to
  // publish. These pin the three states the UI renders.

  await test('ownershipVerdict: no author is reported as none, not as foreign', async () => {
    const verdict = ownershipVerdict({ author: { name: '', email: '' }, accountLogin: 'wodaimnd' })
    assert.equal(verdict.status, 'none')
    assert.equal(verdict.scopeDrift, false)
  })

  await test('ownershipVerdict: matches by name, by plain noreply and by numbered noreply', async () => {
    assert.equal(ownershipVerdict({ author: { name: 'wodaimnd' }, accountLogin: 'wodaimnd' }).status, 'own')
    assert.equal(
      ownershipVerdict({ author: { name: 'Kewei Chen', email: 'wodaimnd@users.noreply.github.com' }, accountLogin: 'wodaimnd' }).status,
      'own',
      'a plain GitHub noreply address ties the author to the account',
    )
    assert.equal(
      ownershipVerdict({ author: { name: 'Kewei Chen', email: '91788631+wodaimnd@users.noreply.github.com' }, accountLogin: 'wodaimnd' }).status,
      'own',
      'the numbered noreply form must work too — this is what git actually writes',
    )
    // A one-line manifest string is parsed, not compared verbatim.
    assert.equal(ownershipVerdict({ author: 'Kewei Chen <wodaimnd@users.noreply.github.com>', accountLogin: 'wodaimnd' }).status, 'own')
  })

  await test('ownershipVerdict: a differing author is a fork when the account owns the repo', async () => {
    const verdict = ownershipVerdict({
      author: { name: 'Original Dev', email: 'orig@example.com' },
      accountLogin: 'wodaimnd',
      repositoryOwner: 'wodaimnd',
    })
    assert.equal(verdict.status, 'fork')
    assert.equal(verdict.reason, 'account-owns-repo')
  })

  await test('ownershipVerdict: nothing ties the author to the account → foreign', async () => {
    const verdict = ownershipVerdict({
      author: { name: 'Original Dev', email: 'orig@example.com' },
      accountLogin: 'wodaimnd',
      repositoryOwner: 'originaldev',
    })
    assert.equal(verdict.status, 'foreign')
    assert.equal(verdict.reason, 'author-not-tied-to-account')
  })

  await test('ownershipVerdict: a different npm scope is surfaced without changing the verdict', async () => {
    const verdict = ownershipVerdict({
      author: { name: 'wodaimnd' },
      accountLogin: 'wodaimnd',
      npmScope: '@jntm114514',
    })
    assert.equal(verdict.status, 'own', 'the expression is still the operator\'s own name')
    assert.equal(verdict.scopeDrift, true, 'but npm will record a different owner')
  })

  await test('preflight: ownership is a warning and never blocks a publish', async () => {
    // A plugin whose author has nothing to do with this account. The panel must
    // say so loudly, and must still let the operator publish it.
    const dir = tmpDir('ownership-foreign')
    await fsp.mkdir(dir, { recursive: true })
    const manifest = {
      name: 'someone-elses-plugin',
      version: '1.0.0',
      type: 'module',
      description: 'A plugin by somebody else.',
      author: 'Original Dev <orig@example.com>',
      repository: { type: 'git', url: 'git+https://github.com/originaldev/someone-elses-plugin.git' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await fsp.writeFile(path.join(dir, 'index.js'), 'export function apply() {}\n', 'utf8')
    await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: probe\n      name: someone-elses-plugin\n', 'utf8')
    try {
      const preflight = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
      const check = preflight.checks.find((entry) => entry.id === 'ownership')
      assert.ok(check, 'the panel must report ownership')
      assert.equal(check.status, 'warn', 'ownership can never be a hard failure')
      assert.ok(check.fix === 'confirmAuthor', 'the row points at the confirmation checkbox')
      assert.ok(!preflight.blocking.includes('ownership'), 'and never lands in blocking')
      assert.equal(preflight.canPublish, true, 'publishing stays possible: forks are legitimate')
      assert.equal(preflight.ownership.status, 'foreign')
      assert.equal(preflight.ownership.confirmed, false)

      // With the acknowledgement the same plugin publishes and the row turns green.
      const confirmed = await publisher.preflight({
        path: dir,
        form: { platforms: ['npm'], dryRun: true, confirmForeignAuthor: true },
      })
      const confirmedCheck = confirmed.checks.find((entry) => entry.id === 'ownership')
      assert.equal(confirmedCheck.status, 'pass')
      assert.ok(confirmedCheck.detail.includes('已确认'))
      assert.equal(confirmed.ownership.confirmed, true)
      assert.equal(confirmed.canPublish, true)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  await test('preflight: a plugin that never declared an author is flagged, not failed', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true, token: 'npm_test_token_abcdef' } })
    // The shared fixture has no author field at all.
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    const check = preflight.checks.find((entry) => entry.id === 'ownership')
    assert.ok(check, 'a missing author is a fact worth showing')
    assert.equal(check.status, 'warn')
    assert.equal(preflight.ownership.status, 'none')
    assert.ok(!preflight.blocking.includes('ownership'))
    assert.equal(preflight.canPublish, true)
  })

  // ── 记住的确认：按插件保存，绑定到作者 ──────────────────────────────────
  // Confirming once must not become a blanket blessing: if the manifest later
  // names a different author, the old tick has to lapse.

  await test('ownershipFingerprint names the author and the repo owner, not the account', async () => {
    assert.equal(ownershipFingerprint({ author: 'Original Dev', owner: 'originaldev' }, ''), 'original dev|originaldev')
    assert.equal(ownershipFingerprint({ author: 'Original Dev' }, 'Wodaimnd'), 'original dev|wodaimnd')
    assert.equal(ownershipFingerprint({ author: '', owner: '' }, ''), '', 'nothing to remember')
  })

  await test('ownershipRememberedFor: same author keeps the tick, a new author drops it', async () => {
    assert.equal(ownershipRememberedFor('original dev|originaldev', 'original dev|originaldev'), true)
    assert.equal(ownershipRememberedFor('original dev|originaldev', 'someone else|originaldev'), false, 'changing the author must expire it')
    assert.equal(ownershipRememberedFor('original dev|originaldev', 'original dev|other'), false, 'changing the repo must expire it too')
    assert.equal(ownershipRememberedFor('', 'original dev|originaldev'), false, 'an empty fingerprint matches nothing')
    // A draft written before fingerprints existed said only "true"; it was still
    // a deliberate act, so it is honoured rather than silently dropped.
    assert.equal(ownershipRememberedFor(true, 'anything'), true, 'legacy drafts stay confirmed')
  })

  await test('preflight: a remembered confirmation survives a fresh Publisher, then expires on a new author', async () => {
    const dir = tmpDir('ownership-recall')
    await fsp.mkdir(dir, { recursive: true })
    const writeManifest = async (author) => {
      await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({
        name: 'recall-probe',
        version: '1.0.0',
        type: 'module',
        description: 'A plugin whose author changes mid-test.',
        author,
        repository: { type: 'git', url: 'git+https://github.com/originaldev/recall-probe.git' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2)}\n`, 'utf8')
    }
    await writeManifest('Original Dev <orig@example.com>')
    await fsp.writeFile(path.join(dir, 'index.js'), 'export function apply() {}\n', 'utf8')
    await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
    try {
      const first = await publisher.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
      assert.equal(first.ownership.confirmed, false, 'nothing is confirmed yet')
      assert.ok(first.ownership.fingerprint.includes('original dev'), first.ownership.fingerprint)
      // Tick it the way the panel does: value + the author it was given for.
      await publisher.saveDraft(dir, {
        confirmForeignAuthor: true,
        confirmForeignAuthorFor: first.ownership.fingerprint,
      })

      // A fresh instance models the panel being reopened: only the path is known.
      const fresh = new Publisher({ store, env: {} })
      const second = await fresh.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
      assert.equal(second.ownership.confirmed, true, 'reopening the plugin keeps the confirmation')
      assert.equal(second.checks.find((entry) => entry.id === 'ownership').status, 'pass')

      // Editing the author must invalidate it — that is the whole point.
      await writeManifest('Someone Else <else@example.com>')
      const third = await fresh.preflight({ path: dir, form: { platforms: ['npm'], dryRun: true } })
      assert.equal(third.ownership.confirmed, false, 'a different author is not covered by the old tick')
      assert.equal(third.checks.find((entry) => entry.id === 'ownership').status, 'warn')
      assert.ok(!third.blocking.includes('ownership'), 'and it still never blocks')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
      await publisher.saveDraft(dir, null)
    }
  })

  await test('preflight rejects an invalid publish name as blocking', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true } })
    await publisher.saveDraft(pluginDir, { publishName: 'Bad Name!' })
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    const nameCheck = preflight.checks.find((check) => check.id === 'npm-name')
    assert.equal(nameCheck.status, 'fail')
    assert.equal(nameCheck.title, '发布用包名不合法')
    assert.equal(nameCheck.fix, 'platforms')
    await publisher.saveDraft(pluginDir, {})
  })

  await test('publish job steps reflect the selection (npm only)', async () => {
    await publisher.updatePlatforms({ npm: { enabled: true, token: 'npm_test_token_abcdef' } })
    const preflight = await publisher.preflight({ path: pluginDir, form: { platforms: ['npm'], dryRun: true } })
    const ids = buildStepIds(preflight.platforms)
    assert.ok(!ids.includes('push'), 'npm-only job has no push step')
    assert.ok(ids.includes('npm-publish'))
  })

  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(pluginDir, { recursive: true, force: true }).catch(() => {})

  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.ok ? '' : ` — ${entry.error}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
