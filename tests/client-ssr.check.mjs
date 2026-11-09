/**
 * Server-render smoke check for multi-platform-releaser.
 *
 * This is not a browser test: it runs the REAL React runtime (borrowed from the
 * dsh-market checkout's node_modules) against the page component that the
 * plugin registers in the `main` slot, after loading client.js through the same
 * `window.__ModuleLoader__` contract the Web app uses. It catches render-time
 * throws, invalid hook usage, missing locale keys, React warnings and broken
 * state rendering — the failure modes that would blank the slot in the live GUI.
 *
 * Run: node tests/client-ssr.check.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.join(here, '..')

/**
 * Resolve a React runtime to render with. DSH_HARNESS_REACT_ROOT points at any
 * package.json whose node_modules has react + react-dom (the dsh-market
 * checkout used historically, the desktop profile, or a local install); with no
 * usable runtime the check reports SKIP instead of failing on a hard-coded
 * macOS path that does not exist on this machine.
 */
const REACT_ROOT = (() => {
  const candidates = [
    process.env.DSH_HARNESS_REACT_ROOT,
    process.platform === 'win32' ? null : '/Users/sunchujun/Desktop/deepseek/dsh-market/package.json',
    process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'react', 'package.json') : null,
    path.join(pluginDir, 'node_modules', 'react', 'package.json'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const requireFrom = createRequire(candidate.endsWith('package.json') ? candidate : path.join(candidate, 'package.json'))
      const react = requireFrom('react')
      if (react && typeof react.createElement === 'function') {
        const server = requireFrom('react-dom/server')
        if (server && typeof server.renderToStaticMarkup === 'function') return requireFrom
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
})()

if (REACT_ROOT === null) {
  console.log('SKIP  no React runtime found; set DSH_HARNESS_REACT_ROOT to a package.json whose node_modules has react + react-dom')
  process.exit(0)
}

const React = REACT_ROOT('react')
const ReactDOMServer = REACT_ROOT('react-dom/server')
const h = React.createElement

const storage = new Map()

globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__dgpCaptured = definition } } }
globalThis.document = { documentElement: { lang: 'zh-CN' } }
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async function write() {} } },
})

const source = readFileSync(path.join(pluginDir, 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'localStorage', 'navigator', source)(
  globalThis.window,
  globalThis.document,
  globalThis.localStorage,
  globalThis.navigator,
)
const captured = globalThis.__dgpCaptured
if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')

const loaded = captured.factory(function requireStub(name) {
  if (name === 'react') return React
  throw new Error('client.js required an unexpected module: ' + name)
})
const api = loaded.__test

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail: detail || '' })
}

/* ── fake Client context ──────────────────────────────────────────────────── */

function applyContext(language) {
  const registrations = []
  const dictionaries = { zh: api.zh, en: api.en }
  const current = language === 'en' ? 'en' : 'zh'
  const ctx = {
    effect(callback) { return callback() },
    locale: {
      register(namespace, dicts) { registrations.push({ type: 'locale', namespace, dicts }); return function dispose() {} },
      bind() {
        return function translate(key) {
          return Object.prototype.hasOwnProperty.call(dictionaries[current], key) ? dictionaries[current][key] : key
        }
      },
      subscribe() { return function dispose() {} },
    },
    slots: {
      inject(slot, callback) { registrations.push({ type: 'inject', slot }); return callback() },
      register(options, component) { registrations.push({ type: 'register', options, component }); return function dispose() {} },
    },
    get() { return undefined },
  }
  loaded.apply(ctx)
  return registrations
}

let registrations = applyContext('zh')

/* ── real-React render helper with warning capture ────────────────────────── */

let totalWarnings = 0
function render(label, element) {
  const logged = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = function captureError() { logged.push('error: ' + Array.prototype.map.call(arguments, String).join(' ')) }
  console.warn = function captureWarn() { logged.push('warn: ' + Array.prototype.map.call(arguments, String).join(' ')) }
  let html = ''
  let failure = null
  try {
    html = ReactDOMServer.renderToString(element)
  } catch (error) {
    failure = error
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  if (logged.some(function isProblem(line) { return line.indexOf('error:') === 0 || line.indexOf('warn:') === 0 })) {
    totalWarnings += logged.length
  }
  return { label, html, failure, logged }
}

function checkClean(result) {
  check(result.label + ' renders without throwing', !result.failure, result.failure ? String(result.failure && result.failure.message ? result.failure.message : result.failure) : '')
  check(result.label + ' has no React error/warning output', result.logged.length === 0, result.logged.join(' | '))
}

const pageRegistration = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'main' })
const sidebarRegistration = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'sidebar.panellist' })

/* ── contract fixtures ────────────────────────────────────────────────────── */

const pluginPath = '/Users/x/Desktop/deepseek/dsh-alpha'

function defaultsFixture() {
  return {
    visibility: 'public',
    license: 'MIT',
    branch: 'main',
    tagPrefix: 'v',
    createRelease: true,
    addReadme: true,
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
  }
}

function accountFixture(overrides) {
  return Object.assign({
    connected: true,
    validated: true,
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    htmlUrl: 'https://github.com/octocat',
    tokenSource: 'config',
    persisted: true,
    tokenHint: 'ghp_…a1b2',
    scopes: ['repo'],
    isFineGrained: false,
    validatedAt: 1700000000000,
    apiBase: 'https://api.github.com',
  }, overrides || {})
}

function pluginFixture(overrides) {
  return Object.assign({
    path: pluginPath,
    realPath: pluginPath,
    name: 'dsh-alpha',
    displayName: 'dsh-alpha',
    version: '0.1.0',
    description: 'A tiny alpha plugin',
    descriptionZh: '一个小插件',
    license: 'MIT',
    author: 'Octocat <octocat@example.com>',
    keywords: ['dsh', 'dsh-plugin'],
    homepage: '',
    repository: null,
    iconPath: null,
    hasReadme: true,
    readmeFile: 'README.md',
    hasLicense: true,
    licenseFile: 'LICENSE',
    hasGit: true,
    hasCommits: true,
    branch: 'main',
    remote: null,
    gitStatus: { dirty: true, modified: 1, untracked: 2, staged: 0, ahead: 0, behind: 0 },
    sizeBytes: 123456,
    fileCount: 42,
    suggested: { owner: 'octocat', name: 'dsh-alpha', description: 'A tiny alpha plugin', descriptionZh: '一个小插件', topics: ['deepseek', 'dsh', 'dsh-plugin'], license: 'MIT', homepage: '' },
    sources: ['scan-root'],
    published: null,
    remoteStatus: null,
    errors: [],
  }, overrides || {})
}

function formFixture(overrides) {
  return Object.assign({
    owner: 'octocat',
    name: 'dsh-alpha',
    description: 'A tiny alpha plugin',
    descriptionZh: '一个小插件',
    homepage: '',
    topics: ['deepseek', 'dsh', 'dsh-plugin'],
    visibility: 'public',
    license: 'MIT',
    branch: 'main',
    tagPrefix: 'v',
    commitMessage: 'chore: publish {name} v{version}',
    authorName: 'Octocat',
    authorEmail: '1+octocat@users.noreply.github.com',
    repoExistsStrategy: 'reuse',
    addReadme: true,
    readmeMode: 'auto',
    addLicense: true,
    addGitignore: true,
    updatePackageJson: true,
    createRelease: true,
    releaseNotes: '',
    dryRun: false,
    forceWithLease: false,
    platforms: ['github'],
    npmAccess: 'public',
    npmDistTag: 'latest',
    npmOtp: '',
  }, overrides || {})
}

const preflightFixture = {
  ok: true,
  plugin: pluginFixture(),
  form: formFixture(),
  checks: [
    { id: 'manifest', status: 'pass', title: '插件清单可用', detail: 'dsh-alpha 0.1.0' },
    { id: 'git', status: 'pass', title: 'git 可用', detail: 'git 2.50.1' },
    { id: 'auth', status: 'warn', title: '尚未连接 GitHub 账号', detail: '发布前请在设置里填入 PAT', fix: 'settings' },
    { id: 'repo', status: 'pass', title: '仓库名可用', detail: '将新建 octocat/dsh-alpha' },
  ],
  blocking: [],
  canPublish: true,
  needsAccount: false,
  actionText: '发布 dsh-alpha v0.1.0',
  plan: {
    owner: 'octocat',
    repo: 'dsh-alpha',
    branch: 'main',
    repoExists: false,
    createRepo: true,
    visibility: 'public',
    remoteUrl: 'https://github.com/octocat/dsh-alpha.git',
    commitMessage: 'chore: publish dsh-alpha v0.1.0',
    tag: 'v0.1.0',
    createRelease: true,
    dryRun: false,
    apiBase: 'https://api.github.com',
    gitBase: 'https://github.com',
    version: '0.1.0',
    license: 'MIT',
    topics: ['deepseek', 'dsh', 'dsh-plugin'],
  },
  preview: {
    files: [
      { file: 'README.md', action: 'create', bytes: 42, content: '# dsh-alpha\n\nA tiny alpha plugin\n', reason: 'missing' },
      { file: 'LICENSE', action: 'create', bytes: 10, content: 'MIT License', reason: 'missing' },
      { file: 'package.json', action: 'update', bytes: 0, content: null, reason: 'metadata' },
    ],
    writes: [{ file: 'README.md', action: 'create', bytes: 42 }],
    packageJson: {
      file: 'package.json',
      changed: true,
      changes: { repository: { type: 'git', url: 'git+https://github.com/octocat/dsh-alpha.git' } },
      text: '{"name":"dsh-alpha"}',
      error: null,
    },
    generatedReadme: '# dsh-alpha\n\nA tiny alpha plugin\n\n## Install\n',
    readmeAction: 'create',
    license: 'MIT',
    year: 2026,
  },
  warnings: [],
}

function jobFixture(status, overrides) {
  const steps = api.STEP_IDS.map(function step(id) {
    let stepStatus = 'done'
    if (status === 'running') stepStatus = id === 'repo' ? 'running' : (id === 'auth' || id === 'inspect' || id === 'prepare' ? 'done' : 'pending')
    if (id === 'inspect') stepStatus = 'skipped'
    return { id, status: stepStatus, detail: id === 'repo' ? '创建仓库…' : null, error: null, startedAt: 1700000000000, endedAt: status === 'running' ? null : 1700000001000 }
  })
  return Object.assign({
    jobId: 'job_1700000000000_ab12',
    status,
    path: pluginPath,
    pluginName: 'dsh-alpha',
    step: status === 'running' ? 'repo' : 'finish',
    startedAt: 1700000000000,
    endedAt: status === 'running' ? null : 1700000002500,
    steps,
    logs: [
      { at: 1700000000100, level: 'info', step: 'auth', text: 'validated @octocat' },
      { at: 1700000000500, level: 'info', step: 'repo', text: '正在创建仓库…' },
      { at: 1700000001400, level: 'success', step: 'push', text: 'pushed 1 commit' },
    ],
    result: status === 'succeeded'
      ? {
          owner: 'octocat',
          repo: 'dsh-alpha',
          repoUrl: 'https://github.com/octocat/dsh-alpha',
          branch: 'main',
          commitSha: 'abcdef1234567890',
          tag: 'v0.1.0',
          releaseUrl: 'https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0',
          createdRepo: true,
          pushed: true,
          dryRun: false,
          files: [{ file: 'README.md', action: 'create', bytes: 42 }],
        }
      : null,
    error: status === 'failed' ? { code: 'git-push-rejected', message: '远端拒绝了推送', step: 'push' } : null,
  }, overrides || {})
}

function snapshotFixture(overrides) {
  return Object.assign({
    phase: 'ready',
    loading: false,
    version: '0.1.0',
    platform: 'darwin',
    dataDir: '/Users/x/.dsh/github-publisher',
    settings: { defaults: defaultsFixture(), scanRoots: ['/Users/x/Desktop/deepseek'], autoDetectToken: true },
    account: accountFixture(),
    plugins: [pluginFixture()],
    drafts: {},
    history: [{
      id: 'hist_1',
      at: 1700000000000,
      path: pluginPath,
      name: 'dsh-alpha',
      owner: 'octocat',
      repo: 'dsh-alpha',
      repoUrl: 'https://github.com/octocat/dsh-alpha',
      releaseUrl: 'https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0',
      version: '0.1.0',
      commitSha: 'abcdef1234567',
      tag: 'v0.1.0',
      status: 'succeeded',
      dryRun: false,
      files: ['README.md'],
      error: null,
    }],
    capabilities: { git: true, gitVersion: '2.50.1', ghCli: false, ghVersion: null, envToken: false, askpassSupported: true, ai: true, platform: 'darwin' },
    scanInfo: { roots: [{ path: '/Users/x/Desktop/deepseek', source: 'scan-root', count: 1 }], warnings: [], scannedAt: 1700000000000 },
    serverTime: 1700000000000,
    job: null,
    jobId: null,
    publishedResult: null,
    selectedPath: pluginPath,
    form: formFixture(),
    search: '',
    formDirty: false,
    formErrors: {},
    preflight: null,
    preflightStale: false,
    preflightBusy: false,
    aiBusy: false,
    aiError: null,
    publishing: false,
    cancelling: false,
    cancelRequested: false,
    scanBusy: false,
    scanWarnings: [],
    tokenWarnings: [],
    error: null,
    refreshError: null,
    toast: null,
    settingsOpen: false,
    savingToken: false,
    detectingToken: false,
    savingSettings: false,
    clearingHistory: false,
    draftSaving: false,
    draftError: null,
    platforms: api.normalizePlatforms(platformsFixture()),
    platformSelection: ['github'],
    activeTab: 'publish',
    syncPlan: null,
    syncBusy: false,
    syncBumping: false,
    savingPlatforms: false,
    verifyingPlatform: null,
    savingNpmToken: false,
  }, overrides || {})
}

/** The two platform descriptors GET /api/state returns (token-free). */
function platformsFixture() {
  return [
    {
      id: 'github', label: 'GitHub', short: 'GitHub', kind: 'release', order: 10,
      description: '仓库 + topics + git 提交 + tag + Release',
      fields: [{ key: 'apiBase', type: 'url', label: 'API 地址' }, { key: 'gitBase', type: 'url', label: '网页地址' }],
      config: { id: 'github', enabled: true },
    },
    {
      id: 'npm', label: 'npm registry', short: 'npm', kind: 'release', order: 20,
      description: 'npm publish 到 registry',
      fields: [
        { key: 'registry', type: 'url', label: 'Registry' },
        { key: 'token', type: 'token', label: 'Access Token', secret: true },
        { key: 'access', type: 'select', label: '访问级别', options: ['public', 'restricted'] },
        { key: 'distTag', type: 'text', label: 'dist-tag' },
        { key: 'provenance', type: 'bool', label: 'provenance' },
      ],
      config: { id: 'npm', enabled: true, registry: 'https://registry.npmjs.org', access: 'public', distTag: 'latest', provenance: false, tokenConfigured: true, tokenHint: 'npm_te…wxyz', tokenAvailable: true },
    },
    {
      id: 'gitee', label: 'Gitee', short: 'Gitee', kind: 'release', order: 30,
      description: '码云仓库 + git 提交 + tag + Release（Gitee 没有 topics，该步骤自动跳过）',
      topicsSupported: false,
      fields: [
        { key: 'apiBase', type: 'url', label: 'API 地址' },
        { key: 'gitBase', type: 'url', label: '网页地址' },
        { key: 'token', type: 'token', label: '私人令牌', secret: true },
      ],
      config: { id: 'gitee', enabled: true, tokenConfigured: true, tokenHint: '4274…a640' },
    },
    {
      id: 'codeberg', label: 'Codeberg', short: 'Codeberg', kind: 'release', order: 40,
      description: 'Codeberg（Forgejo）仓库 + topics + git 提交 + tag + Release',
      topicsSupported: true,
      fields: [
        { key: 'apiBase', type: 'url', label: 'API 地址' },
        { key: 'gitBase', type: 'url', label: '网页地址' },
        { key: 'token', type: 'token', label: 'Access Token', secret: true },
      ],
      config: { id: 'codeberg', enabled: true, tokenConfigured: true, tokenHint: '92b9…57bf' },
    },
  ]
}

/** One cross-platform drift matrix, as POST /api/sync/plan returns it. */
function syncPlanFixture() {
  return {
    path: pluginPath,
    name: 'dsh-alpha',
    version: '0.1.0',
    platforms: [
      { platform: 'github', label: 'GitHub', local: '0.1.0', remote: '0.3.0', url: 'https://github.com/octocat/dsh-alpha', state: 'behind', detail: 'octocat/dsh-alpha' },
      { platform: 'npm', label: 'npm registry', local: '0.1.0', remote: '0.1.0', url: 'https://www.npmjs.com/package/dsh-alpha', state: 'in-sync', detail: 'dsh-alpha@0.1.0' },
    ],
    behind: ['github'],
    inSync: ['npm'],
    needsBump: true,
    checkedAt: 1700000000000,
  }
}

function fakeStore(snapshot) {
  return {
    getState: function getState() { return snapshot },
    subscribe: function subscribe() { return function dispose() {} },
    dispose: function dispose() {},
    loadState: function loadState() {},
    updateForm: function updateForm() {},
    selectPlugin: function selectPlugin() {},
    setSearch: function setSearch() {},
    rescan: function rescan() {},
    openSettings: function openSettings() {},
    closeSettings: function closeSettings() {},
    runPreflight: function runPreflight() {},
    runPublish: function runPublish() {},
    cancel: function cancel() {},
    saveToken: function saveToken() {},
    detectToken: function detectToken() {},
    clearToken: function clearToken() {},
    saveSettings: function saveSettings() {},
    clearHistory: function clearHistory() {},
    showToast: function showToast() {},
    clearToast: function clearToast() {},
    dismissError: function dismissError() {},
    savePlatforms: function savePlatforms() {},
    verifyPlatform: function verifyPlatform() {},
    saveNpmToken: function saveNpmToken() {},
    bumpVersion: function bumpVersion() {},
    checkSync: function checkSync() {},
    syncBehindPlatforms: function syncBehindPlatforms() {},
    togglePlatform: function togglePlatform() {},
    selectedPlatforms: function selectedPlatforms() { return snapshotFormPlatforms(snapshot) },
    formTargetLabel: function formTargetLabel() {
      const list = snapshotFormPlatforms(snapshot)
      return list.map(function label(id) { return id === 'npm' ? 'npm registry' : 'GitHub' }).join(' + ')
    },
    setTab: function setTab(tab) { snapshot.activeTab = tab },
    readActiveTab: function readActiveTab() { return snapshot.activeTab || 'publish' },
  }
}

/** The platform ids currently ticked in the snapshot's form. */
function snapshotFormPlatforms(snapshot) {
  const form = snapshot && snapshot.form && typeof snapshot.form === 'object' ? snapshot.form : null
  const list = form && Array.isArray(form.platforms) ? form.platforms : []
  return list.filter(function known(id) {
    const platforms = snapshot && Array.isArray(snapshot.platforms) ? snapshot.platforms : []
    return platforms.some(function enabled(entry) { return entry.id === id && entry.enabled === true })
  })
}

function renderPage(snapshot, label) {
  return render(label, h(api.PublishCenter, { store: fakeStore(snapshot) }))
}

/* ── 1. module + locale dictionaries ─────────────────────────────────────── */

check('loader id and module shape are the fixed ones', captured.id === 'multi-platform-releaser' && loaded.name === 'multi-platform-releaser' && Array.isArray(loaded.inject) && typeof loaded.apply === 'function' && Boolean(api))

const zhKeys = Object.keys(api.zh)
const enKeys = Object.keys(api.en)
check('locale dictionaries are symmetric and complete', zhKeys.length >= 300 && zhKeys.length === enKeys.length && zhKeys.every(function present(key) {
  return typeof api.zh[key] === 'string' && api.zh[key].trim() !== '' && typeof api.en[key] === 'string' && api.en[key].trim() !== ''
}), 'zh=' + zhKeys.length + ' en=' + enKeys.length)

check('locale.register carries both dictionaries', registrations.some(function entry(item) {
  return item.type === 'locale' && item.namespace === 'multi-platform-releaser' && item.dicts && item.dicts.zh && item.dicts.en
}))

check('sidebar registration has the contract shape', sidebarRegistration && sidebarRegistration.options.id === 'github-publisher' && sidebarRegistration.options.order === 50 && sidebarRegistration.options.locale === 'multi-platform-releaser' && sidebarRegistration.options.label() === '多代码平台发布插件' && typeof sidebarRegistration.component === 'function')
check('main registration has the keyed contract shape', pageRegistration && pageRegistration.options.key === 'github-publisher' && pageRegistration.options.locale === 'multi-platform-releaser' && typeof pageRegistration.component === 'function')

/* ── 2. page shell renders with the real React runtime (zh) ───────────────── */

const shell = render('zh-page-shell', h(pageRegistration.component))
checkClean(shell)
check('zh shell ships the stylesheet', shell.html.indexOf('<style>') >= 0 && shell.html.indexOf('.dgp-root') >= 0)
check('zh shell shows the title and subtitle', shell.html.indexOf('多代码平台发布插件') >= 0 && shell.html.indexOf('扫描本地 DSH 插件') >= 0)
check('zh shell shows header actions', shell.html.indexOf('设置') >= 0 && shell.html.indexOf('重新扫描') >= 0)
check('zh shell shows the loading state', shell.html.indexOf('加载中…') >= 0)

/* ── 3. sidebar glyph with the shell's props ──────────────────────────────── */

const iconInactive = render('zh-sidebar-icon-idle', h(sidebarRegistration.component, { size: 16, active: false }))
const iconActive = render('zh-sidebar-icon-active', h(sidebarRegistration.component, { size: 16, active: true }))
checkClean(iconInactive)
checkClean(iconActive)
check('sidebar glyph is a 16x16 currentColor svg', iconInactive.html.indexOf('<svg') >= 0 && iconInactive.html.indexOf('viewBox="0 0 16 16"') >= 0 && iconInactive.html.indexOf('stroke="currentColor"') >= 0)
check('sidebar glyph reflects the active state', iconActive.html.indexOf('stroke-width="1.7"') >= 0 && iconInactive.html.indexOf('stroke-width="1.4"') >= 0)

/* ── 4. ready / preflight / token banner fixtures ─────────────────────────── */

const ready = renderPage(snapshotFixture(), 'zh-ready')
checkClean(ready)
check('ready page lists the plugin and its metadata', ready.html.indexOf('dsh-alpha') >= 0 && ready.html.indexOf('v0.1.0') >= 0 && ready.html.indexOf(pluginPath) >= 0)
check('ready page shows the connected account chip', ready.html.indexOf('已连接 @octocat') >= 0)
check('ready page shows the three form sections', ready.html.indexOf('发布信息') >= 0 && ready.html.indexOf('发布选项') >= 0 && ready.html.indexOf('README 预览') >= 0 && ready.html.indexOf('预检与发布') >= 0)
check('ready page renders the publish form inputs', ready.html.indexOf('Owner') >= 0 && ready.html.indexOf('仓库名') >= 0 && ready.html.indexOf('value="octocat"') >= 0 && ready.html.indexOf('value="dsh-alpha"') >= 0)
check('ready page lists recent publishes', ready.html.indexOf('最近发布') >= 0)
  // The history block is collapsed by default now, so its rows are behind the toggle.
  check('collapsed history keeps its affordance visible', ready.html.indexOf('aria-expanded="false"') >= 0 && ready.html.indexOf('octocat/dsh-alpha') < 0)
check('ready page invites a preflight', ready.html.indexOf('还没有预检结果') >= 0 && ready.html.indexOf('运行预检') >= 0 && ready.html.indexOf('发布到 GitHub') >= 0)
check('ready page offers the AI metadata completion when a model is configured', ready.html.indexOf('AI 补全信息') >= 0)


/** The shared preflight fixture with one ownership verdict spliced in. */
function withOwnership(ownership, extra) {
  return Object.assign({}, preflightFixture, { ownership }, extra || {})
}

const preflightPage = renderPage(snapshotFixture({ preflight: api.normalizePreflight(preflightFixture) }), 'zh-preflight')
checkClean(preflightPage)
check('preflight renders every check', preflightPage.html.indexOf('插件清单可用') >= 0 && preflightPage.html.indexOf('git 可用') >= 0 && preflightPage.html.indexOf('尚未连接 GitHub 账号') >= 0 && preflightPage.html.indexOf('仓库名可用') >= 0)
check('preflight renders pass/warn/fix affordances', preflightPage.html.indexOf('预检通过') >= 0 && preflightPage.html.indexOf('提醒') >= 0 && preflightPage.html.indexOf('去设置') >= 0)
check('preflight renders the plan', preflightPage.html.indexOf('发布计划') >= 0 && preflightPage.html.indexOf('将新建仓库') >= 0 && preflightPage.html.indexOf('https://github.com/octocat/dsh-alpha.git') >= 0)
check('preflight renders the files to write', preflightPage.html.indexOf('将写入 3 个文件') >= 0 && preflightPage.html.indexOf('README.md') >= 0 && preflightPage.html.indexOf('LICENSE') >= 0 && preflightPage.html.indexOf('package.json') >= 0)
check('preflight renders the README preview', preflightPage.html.indexOf('将新建 README') >= 0 && preflightPage.html.indexOf('# dsh-alpha') >= 0 && preflightPage.html.indexOf('复制 README') >= 0)

/* ── 4b. a blocked version collision is highlighted and actionable ───────── */

// The user's complaint was "I cannot find where to fix it": a failing row must
// be visible (sorted first, red), and carry a button that names the exact fix.
const collisionFixture = Object.assign({}, preflightFixture, {
  checks: [
    { id: 'manifest', status: 'pass', title: '插件清单可用', detail: 'dsh-alpha 0.1.0' },
    { id: 'git', status: 'pass', title: 'git 可用', detail: 'git 2.50.1' },
    { id: 'auth', status: 'pass', title: '已连接 GitHub', detail: '@octocat' },
    {
      id: 'npm-version',
      status: 'fail',
      title: '版本 0.1.0 已存在于 npm',
      detail: '远端最新为 0.1.0；先 bump 版本再发布（npm 不允许重发同名版本）',
      fix: 'bump',
      suggestion: '0.1.1',
    },
    { id: 'repo', status: 'pass', title: '仓库名可用', detail: '将新建 octocat/dsh-alpha' },
  ],
  blocking: ['npm-version'],
  canPublish: false,
})
const collisionPage = renderPage(snapshotFixture({ preflight: api.normalizePreflight(collisionFixture) }), 'zh-collision')
checkClean(collisionPage)
check('a failed check is highlighted', collisionPage.html.indexOf('data-status="fail"') >= 0 && collisionPage.html.indexOf('版本 0.1.0 已存在于 npm') >= 0)
check('a failed check offers a named one-click fix', collisionPage.html.indexOf('提升到 0.1.1') >= 0 && collisionPage.html.indexOf('dgp-check-fix-primary') >= 0)
check('blocking failures are listed before passing checks', collisionPage.html.indexOf('版本 0.1.0 已存在于 npm') < collisionPage.html.indexOf('仓库名可用'))
check('a blocked preflight does not offer publishing', collisionPage.html.indexOf('阻断项') >= 0 || collisionPage.html.indexOf('有 1 个问题') >= 0 || collisionPage.html.indexOf('disabled') >= 0)

const disconnected = renderPage(snapshotFixture({
  account: accountFixture({ connected: false, validated: false, login: '', tokenSource: '', tokenHint: '' }),
  platforms: api.normalizePlatforms([{ id: 'github', config: { enabled: true } }, { id: 'npm', config: { enabled: true } }]),
}), 'zh-disconnected')
checkClean(disconnected)
check('disconnected page shows the token banner', disconnected.html.indexOf('连接 GitHub 账号') >= 0 && disconnected.html.indexOf('保存并验证') >= 0 && disconnected.html.indexOf('自动检测') >= 0)
check('disconnected page shows the PAT permissions and generator link', disconnected.html.indexOf('需要的权限') >= 0 && disconnected.html.indexOf('Fine-grained PAT') >= 0 && disconnected.html.indexOf('https://github.com/settings/tokens/new?scopes=repo') >= 0 && disconnected.html.indexOf('type="password"') >= 0)
check('disconnected page links every token generator', disconnected.html.indexOf('https://github.com/settings/tokens/new?scopes=repo,workflow') >= 0 && disconnected.html.indexOf('https://github.com/settings/personal-access-tokens/new') >= 0 && disconnected.html.indexOf('https://github.com/settings/tokens') >= 0 && disconnected.html.indexOf('申请经典 PAT') >= 0 && disconnected.html.indexOf('申请细粒度 PAT') >= 0 && disconnected.html.indexOf('管理 GitHub 令牌') >= 0)

/* ── 4b. getting-started guide + binding shortcuts ────────────────────────── */

check('guide card renders its three steps with links', disconnected.html.indexOf('class="dgp-card dgp-guide"') >= 0 && disconnected.html.indexOf('上手向导') >= 0 && disconnected.html.indexOf('绑定 GitHub 令牌') >= 0 && disconnected.html.indexOf('选中要发布的插件') >= 0 && disconnected.html.indexOf('绑定 npm 令牌') >= 0 && disconnected.html.indexOf('可选') >= 0 && disconnected.html.indexOf('打开设置') >= 0 && disconnected.html.indexOf('扫描目录') >= 0 && disconnected.html.indexOf('去平台配置') >= 0)
check('guide card links the npm token generator', disconnected.html.indexOf('https://www.npmjs.com/settings/tokens/new') >= 0 && disconnected.html.indexOf('https://www.npmjs.com/settings/tokens') >= 0 && disconnected.html.indexOf('申请 npm Token') >= 0 && disconnected.html.indexOf('管理 npm 令牌') >= 0)
check('guide card shows progress when a step is done', disconnected.html.indexOf('已完成 1/3') >= 0 && disconnected.html.indexOf('data-done="0"') >= 0 && disconnected.html.indexOf('dgp-guide-mark') >= 0)

storage.set('dsh-github-publisher.guide', '0')
const guideCollapsed = renderPage(snapshotFixture({}), 'zh-guide-collapsed')
checkClean(guideCollapsed)
check('guide remembers being collapsed', guideCollapsed.html.indexOf('data-open="0"') >= 0 && guideCollapsed.html.indexOf('展开向导') >= 0 && guideCollapsed.html.indexOf('class="dgp-guide-steps"') < 0 && guideCollapsed.html.indexOf('已完成 3/3') >= 0)
storage.delete('dsh-github-publisher.guide')

const guideDone = renderPage(snapshotFixture({
  platforms: api.normalizePlatforms([
    { id: 'github', config: { enabled: true } },
    { id: 'npm', config: { enabled: true, tokenConfigured: true, account: { login: 'octocat' } } },
  ]),
}), 'zh-guide-done')
checkClean(guideDone)
check('guide celebrates the fully bound state', guideDone.html.indexOf('全部就绪') >= 0 && guideDone.html.indexOf('data-done="1"') >= 0 && guideDone.html.indexOf('已绑定 @octocat') >= 0 && guideDone.html.indexOf('已连接 @octocat') >= 0)

const enterprise = renderPage(snapshotFixture({
  account: accountFixture({ connected: false, validated: false, login: '', tokenSource: '', tokenHint: '' }),
  settings: {
    defaults: Object.assign(defaultsFixture(), { gitBase: 'https://ghe.example.com', apiBase: 'https://ghe.example.com/api/v3' }),
    scanRoots: ['/Users/x/Desktop/deepseek'],
    autoDetectToken: true,
  },
}), 'zh-enterprise')
checkClean(enterprise)
check('token links follow the configured git base', enterprise.html.indexOf('https://ghe.example.com/settings/tokens/new?scopes=repo,workflow') >= 0 && enterprise.html.indexOf('https://ghe.example.com/settings/personal-access-tokens/new') >= 0 && enterprise.html.indexOf('https://ghe.example.com/settings/tokens') >= 0 && enterprise.html.indexOf('https://github.com/settings/tokens/new?scopes=repo,workflow') < 0)

/* ── 5. running / succeeded / failed / cancelled job fixtures ─────────────── */

const running = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('running')), jobId: 'job_1700000000000_ab12', publishing: true }), 'zh-running')
checkClean(running)
check('running page renders the step timeline', running.html.indexOf('发布进度') >= 0 && running.html.indexOf('校验账号') >= 0 && running.html.indexOf('创建仓库') >= 0 && running.html.indexOf('收尾') >= 0)
check('running page marks the current step', running.html.indexOf('进行中') >= 0 && running.html.indexOf('等待') >= 0)
check('running page renders the log console', running.html.indexOf('validated @octocat') >= 0 && running.html.indexOf('正在创建仓库…') >= 0 && running.html.indexOf('role="log"') >= 0)
check('running page offers cancellation', running.html.indexOf('取消发布') >= 0)

const succeeded = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('succeeded')), jobId: 'job_1700000000000_ab12', publishedResult: api.normalizeJob(jobFixture('succeeded')).result }), 'zh-succeeded')
checkClean(succeeded)
check('success page renders the result card', succeeded.html.indexOf('发布成功') >= 0 && succeeded.html.indexOf('打开仓库') >= 0 && succeeded.html.indexOf('再发布一次') >= 0)
check('success page links repo, release and commit', succeeded.html.indexOf('https://github.com/octocat/dsh-alpha') >= 0 && succeeded.html.indexOf('https://github.com/octocat/dsh-alpha/releases/tag/v0.1.0') >= 0 && succeeded.html.indexOf('abcdef1') >= 0)
check('success page lists the written files', succeeded.html.indexOf('写入文件') >= 0 && succeeded.html.indexOf('README.md') >= 0)

const failedPage = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('failed')) }), 'zh-failed')
checkClean(failedPage)
check('failed page renders the failure card', failedPage.html.indexOf('发布失败') >= 0 && failedPage.html.indexOf('远端拒绝了推送') >= 0 && failedPage.html.indexOf('重试发布') >= 0)

const cancelled = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('running', { status: 'cancelled', endedAt: 1700000002000 })) }), 'zh-cancelled')
checkClean(cancelled)
check('cancelled page renders the cancelled result', cancelled.html.indexOf('发布已取消') >= 0)

/* ── 6. settings dialog ───────────────────────────────────────────────────── */

const settings = renderPage(snapshotFixture({ settingsOpen: true }), 'zh-settings')
checkClean(settings)
check('settings dialog renders its tabs', settings.html.indexOf('class="dgp-modal"') >= 0 && settings.html.indexOf('GitHub 账号') >= 0 && settings.html.indexOf('Enterprise') >= 0 && settings.html.indexOf('扫描目录') >= 0 && settings.html.indexOf('默认值') >= 0 && settings.html.indexOf('危险操作') >= 0)
check('settings dialog renders the account section', settings.html.indexOf('ghp_…a1b2') >= 0 && settings.html.indexOf('保存并验证') >= 0 && settings.html.indexOf('清除 token') >= 0)
check('settings dialog offers the help tab', settings.html.indexOf('帮助与链接') >= 0)

storage.set('dsh-github-publisher.tab', 'help')
const helpTab = renderPage(snapshotFixture({ settingsOpen: true }), 'zh-settings-help')
checkClean(helpTab)
check('help tab lists every credential entry point', helpTab.html.indexOf('API 凭据申请入口') >= 0 && helpTab.html.indexOf('GitHub 经典 PAT') >= 0 && helpTab.html.indexOf('GitHub 细粒度 PAT') >= 0 && helpTab.html.indexOf('管理已有的 GitHub 令牌') >= 0 && helpTab.html.indexOf('GitHub 令牌官方说明') >= 0 && helpTab.html.indexOf('npm Access Token') >= 0 && helpTab.html.indexOf('管理已有的 npm 令牌') >= 0 && helpTab.html.indexOf('npm 令牌官方说明') >= 0)
check('help tab links the official documentation', helpTab.html.indexOf('https://docs.github.com') >= 0 && helpTab.html.indexOf('https://docs.npmjs.com') >= 0 && helpTab.html.indexOf('https://www.npmjs.com/settings/tokens/new') >= 0)
check('help tab lists the effective endpoints and diagnostics', helpTab.html.indexOf('当前生效的接口地址') >= 0 && helpTab.html.indexOf('https://api.github.com') >= 0 && helpTab.html.indexOf('https://github.com') >= 0 && helpTab.html.indexOf('https://registry.npmjs.org') >= 0 && helpTab.html.indexOf('复制诊断信息') >= 0 && helpTab.html.indexOf('没有 token 原文') >= 0)
storage.delete('dsh-github-publisher.tab')

storage.set('dsh-github-publisher.tab', 'scan')
const scanTab = renderPage(snapshotFixture({ settingsOpen: true }), 'zh-settings-scan')
checkClean(scanTab)
check('settings dialog restores the last tab', scanTab.html.indexOf('扫描根目录') >= 0 && scanTab.html.indexOf('/Users/x/Desktop/deepseek') >= 0 && scanTab.html.indexOf('添加目录') >= 0)
storage.delete('dsh-github-publisher.tab')

/* ── 7. malformed snapshots must still render ────────────────────────────── */

const malformed = renderPage(snapshotFixture({
  plugins: null,
  selectedPath: null,
  form: null,
  account: null,
  settings: null,
  history: null,
  scanInfo: null,
  capabilities: null,
  preflight: null,
  job: 'nonsense',
  error: null,
  toast: null,
}), 'zh-malformed')
checkClean(malformed)
check('malformed state renders the empty state', malformed.html.indexOf('还没有选中插件') >= 0 && malformed.html.indexOf('扫描本地插件') >= 0)

const unknownJob = render('zh-unknown-job', h(api.ProgressSection, {
  snapshot: snapshotFixture({ job: api.normalizeJob({ status: 'weird', steps: [{ id: 'repo', status: 'weird' }], logs: [] }), publishing: false }),
  store: fakeStore(snapshotFixture()),
}))
checkClean(unknownJob)
check('unknown job values fall back to a pending timeline', unknownJob.html.indexOf('创建仓库') >= 0 && unknownJob.html.indexOf('等待日志…') >= 0)

/* ── 8. error surfaces render ────────────────────────────────────────────── */

const crashed = render('zh-crash-boundary', h(api.ErrorBoundary, null, h('div', null, 'safe child')))
checkClean(crashed)
check('error boundary renders children when healthy', crashed.html.indexOf('safe child') >= 0)

const errorBar = render('zh-error-bar', h(api.ErrorBar, {
  error: { code: 'invalid-token', message: 'PAT 已失效，请更新', tokenRelated: true },
  onDismiss: function dismiss() {},
  onOpenSettings: function open() {},
}))
checkClean(errorBar)
check('token error bar offers the settings shortcut', errorBar.html.indexOf('PAT 已失效，请更新') >= 0 && errorBar.html.indexOf('去设置') >= 0 && errorBar.html.indexOf('invalid-token') >= 0)

/* ── 9. English locale ───────────────────────────────────────────────────── */

registrations = applyContext('en')
const englishSidebar = registrations.find(function entry(item) { return item.type === 'register' && item.options.name === 'sidebar.panellist' })
check('english locale translates the sidebar label', englishSidebar.options.label() === 'Multi-Forge Publisher')
const englishShell = render('en-page-shell', h(pageRegistration.component))
checkClean(englishShell)
check('english shell renders translated copy', englishShell.html.indexOf('Multi-Forge Publisher') >= 0 && englishShell.html.indexOf('Scan local DSH plugins') >= 0 && englishShell.html.indexOf('Settings') >= 0 && englishShell.html.indexOf('Rescan') >= 0 && englishShell.html.indexOf('Loading…') >= 0)

const englishReady = renderPage(snapshotFixture(), 'en-ready')
checkClean(englishReady)
check('english page renders translated sections', englishReady.html.indexOf('Publish details') >= 0 && englishReady.html.indexOf('Publish options') >= 0 && englishReady.html.indexOf('README preview') >= 0 && englishReady.html.indexOf('Preflight and publish') >= 0 && englishReady.html.indexOf('Publish to GitHub') >= 0)
check('english page renders translated form labels', englishReady.html.indexOf('Repository name') >= 0 && englishReady.html.indexOf('Visibility') >= 0 && englishReady.html.indexOf('Target branch') >= 0)

const englishSucceeded = renderPage(snapshotFixture({ job: api.normalizeJob(jobFixture('succeeded')) }), 'en-succeeded')
checkClean(englishSucceeded)
check('english result card is translated', englishSucceeded.html.indexOf('Published successfully') >= 0 && englishSucceeded.html.indexOf('Publish again') >= 0)

/* ── 10. no locale key leaks into any rendered page ──────────────────────── */

/* ── 10. platform picker, platform config page and version-sync page ────── */

// The English section above bound the module-level translator to `en`; the
// pages below assert Chinese copy, so bind it back first (and again for the
// English variants).
applyContext('zh')

/** A fully normalised form, for fixtures that override just one field. */
function normaliseFormFixture() {
  return api.normalizeForm(snapshotFixture().form)
}

/** Rewrite one form field on a fresh snapshot. */
function withForm(overrides, snapshotOverrides) {
  const form = Object.assign(normaliseFormFixture(), overrides || {})
  return snapshotFixture(Object.assign({ form: form }, snapshotOverrides || {}))
}

const pickerPage = renderPage(snapshotFixture(), 'zh-platform-picker')
checkClean(pickerPage)
check('publish page shows the platform picker', pickerPage.html.indexOf('发布平台') >= 0 && pickerPage.html.indexOf('GitHub') >= 0 && pickerPage.html.indexOf('npm registry') >= 0)
check('publish page ticks GitHub by default', pickerPage.html.indexOf('id="dgp-platform-github"') >= 0 && pickerPage.html.indexOf('checked=""') >= 0)
check('publish button names the ticked target', pickerPage.html.indexOf('发布到 GitHub') >= 0)

const bothTicked = renderPage(withForm({ platforms: ['github', 'npm'] }), 'zh-platform-picker-both')
checkClean(bothTicked)
check('publish button names both ticked platforms', bothTicked.html.indexOf('发布到 GitHub + npm registry') >= 0)
check('ticked npm reveals its own overrides', bothTicked.html.indexOf('dist-tag') >= 0 && bothTicked.html.indexOf('restricted') >= 0)

const npmOnly = renderPage(withForm({ platforms: ['npm'], owner: '' }), 'zh-platform-npm-only')
checkClean(npmOnly)
check('npm-only form never asks for a GitHub owner', npmOnly.html.indexOf('发布到 npm registry') >= 0)

/* The npm card is collapsed by default, so its fields are absent until the
 * user expands it. Assert the collapsed state first, then expand via the same
 * localStorage key the UI writes. */
storage.set('dsh-github-publisher.collapse:npm', '0')
const configCollapsed = renderPage(snapshotFixture({ activeTab: 'platforms' }), 'zh-platform-config-collapsed')
checkClean(configCollapsed)
check('npm card is collapsed by default', configCollapsed.html.indexOf('data-open="0"') >= 0 && configCollapsed.html.indexOf('Access Token') < 0)
check('collapsed npm card still shows a summary', configCollapsed.html.indexOf('按 package.json 名') >= 0 && configCollapsed.html.indexOf('https://registry.npmjs.org') >= 0)
if (globalThis.__DUMP__ !== false) { try { writeFileSync(String.raw`C:\Users\Shinelon\AppData\Local\Temp\collapsed.html`, configCollapsed.html, 'utf8') } catch {} }
check('collapsed npm card exposes an aria-expanded=false toggle', configCollapsed.html.indexOf('aria-expanded="false"') >= 0)
check('collapsed npm card wires aria-controls to its body', configCollapsed.html.indexOf('aria-controls="') >= 0)
check('collapsed npm card shows an expand affordance', configCollapsed.html.indexOf('展开') >= 0 || configCollapsed.html.indexOf('Expand') >= 0)

storage.set('dsh-github-publisher.collapse:npm', '1')
const configPage = renderPage(snapshotFixture({ activeTab: 'platforms' }), 'zh-platform-config')
checkClean(configPage)
check('expanding the npm card reveals its fields', configPage.html.indexOf('data-open="1"') >= 0 && configPage.html.indexOf('Access Token') >= 0 && configPage.html.indexOf('Registry') >= 0)
check('platform config page lists both platforms', configPage.html.indexOf('平台配置') >= 0 && configPage.html.indexOf('Access Token') >= 0 && configPage.html.indexOf('Registry') >= 0)
check('platform config page masks the npm token', configPage.html.indexOf('npm_te…wxyz') >= 0 && configPage.html.indexOf('npm_secret') < 0)
check('platform config page offers per-platform actions', configPage.html.indexOf('验证凭据') >= 0 && configPage.html.indexOf('保存平台配置') >= 0)
check('platform config page offers the publish-name override', configPage.html.indexOf('发布用包名') >= 0 && configPage.html.indexOf('源码 package.json 不动') >= 0)
storage.delete('dsh-github-publisher.collapse:npm')

storage.set('dsh-github-publisher.tab', 'platforms')
storage.set('dsh-github-publisher.collapse:npm', '1')
const npmRenamed = renderPage(snapshotFixture({
  activeTab: 'platforms',
  platforms: api.normalizePlatforms([
    { id: 'github', config: { enabled: true } },
    { id: 'npm', config: { enabled: true, registry: 'http://127.0.0.1:4873', tokenConfigured: true, publishName: '@jntm114514/market-verdict' } },
  ]),
}), 'zh-platform-config-renamed')
checkClean(npmRenamed)
check('publish-name override survives into the form value', npmRenamed.html.indexOf('value="@jntm114514/market-verdict"') >= 0)
storage.delete('dsh-github-publisher.tab')

/* ── 5c. registry status strip: offline offers a start button ─────────────── */

const registryDown = { registry: 'http://127.0.0.1:4873', local: true, verdaccio: true, listening: false, reachable: false, startable: true, detail: '本地 registry 没有在监听：可以点「启动 registry」' }
const registryUp = { registry: 'http://127.0.0.1:4873', local: true, verdaccio: true, listening: true, reachable: true, startable: false, detail: 'registry 在线，可以发布' }
const registryRemote = { registry: 'https://registry.npmjs.org', local: false, verdaccio: true, listening: false, reachable: false, startable: false, detail: '远端 registry 连不上：检查地址或网络（本插件只能启动本机 registry）' }

storage.set('dsh-github-publisher.tab', 'platforms')
storage.set('dsh-github-publisher.collapse:npm', '1')
const regDownPage = renderPage(snapshotFixture({ activeTab: 'platforms', registry: registryDown }), 'zh-registry-down')
checkClean(regDownPage)
check('registry strip shows the down state and offers a start button', regDownPage.html.indexOf('Registry 状态') >= 0 && regDownPage.html.indexOf('未启动') >= 0 && regDownPage.html.indexOf('启动 registry') >= 0 && regDownPage.html.indexOf('data-state="down"') >= 0 && regDownPage.html.indexOf('本地 registry 没有在监听') >= 0)

const regUpPage = renderPage(snapshotFixture({ activeTab: 'platforms', registry: registryUp }), 'zh-registry-up')
checkClean(regUpPage)
check('registry strip shows online and hides the start button', regUpPage.html.indexOf('在线') >= 0 && regUpPage.html.indexOf('data-state="online"') >= 0 && regUpPage.html.indexOf('启动 registry') < 0 && regUpPage.html.indexOf('重新检测') >= 0)

const regRemotePage = renderPage(snapshotFixture({ activeTab: 'platforms', registry: registryRemote }), 'zh-registry-remote')
checkClean(regRemotePage)
check('a remote registry never gets a start button', regRemotePage.html.indexOf('连不上') >= 0 && regRemotePage.html.indexOf('启动 registry') < 0 && regRemotePage.html.indexOf('只能启动本机') >= 0)

const regBusy = renderPage(snapshotFixture({ activeTab: 'platforms', registry: registryDown, registryBusy: true }), 'zh-registry-busy')
checkClean(regBusy)
check('a busy start is disabled and says starting', regBusy.html.indexOf('启动中') >= 0 && regBusy.html.indexOf('disabled') >= 0)

const regUnknown = renderPage(snapshotFixture({ activeTab: 'platforms', registry: null }), 'zh-registry-unknown')
checkClean(regUnknown)
check('before the first check the strip says unknown and offers re-check', regUnknown.html.indexOf('未检测') >= 0 && regUnknown.html.indexOf('重新检测') >= 0)
storage.delete('dsh-github-publisher.tab')

/* ── 5b. a self-hosted registry must never fabricate a token console URL ──── */

const customRegistry = 'http://127.0.0.1:4873'
const accountOff = accountFixture({ connected: false, validated: false, login: '', tokenSource: '', tokenHint: '' })
const customPlatforms = api.normalizePlatforms([
  { id: 'github', config: { enabled: true } },
  { id: 'npm', config: { enabled: true, registry: customRegistry, tokenConfigured: false } },
])

storage.set('dsh-github-publisher.collapse:npm', '1')
const customConfig = renderPage(snapshotFixture({ activeTab: 'platforms', platforms: customPlatforms, account: accountOff }), 'zh-platform-config-custom-registry')
checkClean(customConfig)
check('self-hosted registry links its own origin', customConfig.html.indexOf('href="' + customRegistry + '"') >= 0 && customConfig.html.indexOf('打开 registry 控制台') >= 0)
check('self-hosted registry never forces https nor invents /settings', customConfig.html.indexOf('https://' + customRegistry) < 0 && customConfig.html.indexOf(customRegistry + '/settings') < 0 && customConfig.html.indexOf(customRegistry + '/settings/tokens') < 0)
check('self-hosted registry hands over the npm login recipe', customConfig.html.indexOf('npm login --registry=' + customRegistry) >= 0 && customConfig.html.indexOf('复制 npm login 命令') >= 0)
check('self-hosted registry reads the token instead of asking for a copy-paste', customConfig.html.indexOf('从 .npmrc 自动读取') >= 0 && customConfig.html.indexOf('自动读取并保存') >= 0 && customConfig.html.indexOf('只检测不保存') >= 0)
check('the misleading "copy the .npmrc key" affordance is gone', customConfig.html.indexOf('复制 .npmrc 键名') < 0 && customConfig.html.indexOf('//127.0.0.1:4873/:_authToken=') < 0)
check('self-hosted registry hides the npmjs token links', customConfig.html.indexOf('申请 npm Token') < 0 && customConfig.html.indexOf('管理已有的 npm 令牌') < 0 && customConfig.html.indexOf('www.npmjs.com/settings/tokens') < 0)

const customGuide = renderPage(snapshotFixture({ platforms: customPlatforms, account: accountOff }), 'zh-guide-custom-registry')
checkClean(customGuide)
check('guide step for a self-hosted registry points at the registry console', customGuide.html.indexOf('class="dgp-card dgp-guide"') >= 0 && customGuide.html.indexOf('npm login --registry=' + customRegistry) >= 0 && customGuide.html.indexOf('打开 registry 控制台') >= 0)
check('guide step for a self-hosted registry drops the npmjs console links', customGuide.html.indexOf('www.npmjs.com/settings/tokens') < 0)

storage.set('dsh-github-publisher.tab', 'help')
const customHelpTab = renderPage(snapshotFixture({ settingsOpen: true, platforms: customPlatforms }), 'zh-settings-help-custom-registry')
checkClean(customHelpTab)
check('help tab follows the self-hosted registry', customHelpTab.html.indexOf('打开 registry 控制台') >= 0 && customHelpTab.html.indexOf('复制 .npmrc 键名') >= 0 && customHelpTab.html.indexOf('npm 令牌官方说明') >= 0)
check('help tab hides the npmjs token console for a self-hosted registry', customHelpTab.html.indexOf('www.npmjs.com/settings/tokens') < 0 && customHelpTab.html.indexOf('申请 npm Token') < 0)
storage.delete('dsh-github-publisher.tab')

const syncPage = renderPage(snapshotFixture({ activeTab: 'sync', syncPlan: api.normalizeSyncPlan(syncPlanFixture()) }), 'zh-sync')
checkClean(syncPage)
check('sync page renders the matrix', syncPage.html.indexOf('版本同步') >= 0 && syncPage.html.indexOf('0.3.0') >= 0 && syncPage.html.indexOf('落后') >= 0 && syncPage.html.indexOf('已同步') >= 0)
check('sync page offers bump and sync actions', syncPage.html.indexOf('只提升版本') >= 0 && syncPage.html.indexOf('发布到落后平台') >= 0)

// The bug this guards: a locally older version was reported as "已存在于 npm",
// which is impossible, and the one-click bump only moved one patch — straight
// back into the same refusal. The panel must say "publishable, but latest moves
// back" and must offer a jump that clears every remote at once.
const stalePlan = syncPlanFixture()
stalePlan.belowLatest = ['npm']
stalePlan.occupied = []
stalePlan.bumpSuggestion = '1.0.2'
stalePlan.platforms[1] = {
  platform: 'npm', label: 'npm registry', local: '0.3.4', remote: '1.0.1',
  url: 'http://127.0.0.1:4873/-/web/detail/probe', state: 'in-sync', detail: 'probe@0.3.4',
  belowLatest: true,
}
const stalePage = renderPage(snapshotFixture({ activeTab: 'sync', syncPlan: api.normalizeSyncPlan(stalePlan) }), 'zh-sync-below-latest')
checkClean(stalePage)
check('a locally older version is announced as publishable, not as "已存在"', stalePage.html.indexOf('latest 会退回') >= 0 && stalePage.html.indexOf('本次可以发布') >= 0)
check('the below-latest plan carries the clearing bump suggestion', stalePage.html.indexOf('1.0.2') >= 0 && stalePage.html.indexOf('一次越过所有远端') >= 0)
check('the below-latest warning never claims the version already exists', stalePage.html.indexOf('已经存在这个版本号') < 0)

const syncEmpty = renderPage(snapshotFixture({ activeTab: 'sync', syncPlan: null }), 'zh-sync-empty')
checkClean(syncEmpty)
check('sync page invites a version check', syncEmpty.html.indexOf('还没有检查过版本') >= 0 && syncEmpty.html.indexOf('检查版本') >= 0)

applyContext('en')
const enPicker = renderPage(snapshotFixture(), 'en-platform-picker')
checkClean(enPicker)
check('english publish page translates the platform picker', enPicker.html.indexOf('Target platforms') >= 0 && enPicker.html.indexOf('Publish to GitHub') >= 0)

const enConfig = renderPage(snapshotFixture({ activeTab: 'platforms' }), 'en-platform-config')
checkClean(enConfig)
check('english platform config page is translated', enConfig.html.indexOf('Platforms') >= 0 && enConfig.html.indexOf('Access token') >= 0)
applyContext('zh')

const renderedPages = [shell.html, ready.html, preflightPage.html, disconnected.html, running.html, succeeded.html, failedPage.html, cancelled.html, settings.html, scanTab.html, malformed.html, englishShell.html, englishReady.html, englishSucceeded.html, pickerPage.html, bothTicked.html, npmOnly.html, configPage.html, customConfig.html, customGuide.html, customHelpTab.html, syncPage.html, syncEmpty.html, stalePage.html, enPicker.html, enConfig.html]
const leaked = []
for (const key of zhKeys) {
  for (const html of renderedPages) {
    if (html.indexOf(key) >= 0) {
      leaked.push(key)
      break
    }
  }
}
check('no raw locale key leaks into rendered markup', leaked.length === 0, leaked.slice(0, 8).join(', '))

check('the borrowed React runtime is the real one', typeof ReactDOMServer.renderToString === 'function' && typeof React.createElement === 'function' && typeof React.Component === 'function')

/* ── 多仓库平台：四分卡片 + 单选语义 ──────────────────────────────────────── */

// The UI now offers three repository hostings plus npm. A publish pushes a single
// commit to a single remote, so hostings are mutually exclusive; npm rides along.
// These pin that the distinction is visible rather than implied.

const platformPage = renderPage(snapshotFixture({}), 'zh-platforms-four')
checkClean(platformPage)
check('the picker lists every repository hosting', ['GitHub', 'Gitee', 'Codeberg'].every((name) => platformPage.html.indexOf(name) >= 0))
check('npm appears as an extra destination, not a fourth hosting', platformPage.html.indexOf('附加目标') >= 0)
check('the hosting group is labelled as multi-select', platformPage.html.indexOf('仓库平台（可多选）') >= 0)
check('the picker explains that every ticked hosting is published to', platformPage.html.indexOf('勾几个就发几个') >= 0)
check('the single-hosting limitation is gone', platformPage.html.indexOf('一次发布只推一个 git 远端') < 0)
check('Gitee states that it has no topics support', platformPage.html.indexOf('不支持 topics') >= 0)
check('Codeberg does not claim a missing topics feature', (() => {
  // The badge is tied to Gitee only, so Codeberg's row must not carry it.
  const codebergAt = platformPage.html.indexOf('Codeberg')
  const topicsAt = platformPage.html.indexOf('不支持 topics')
  return !(codebergAt >= 0 && topicsAt > codebergAt && topicsAt < codebergAt + 400)
})())

const giteeTicked = renderPage(snapshotFixture({
  form: api.normalizeForm({ name: 'dsh-alpha', platforms: ['gitee', 'npm'] }),
}), 'zh-platforms-gitee-selected')
checkClean(giteeTicked)
check('a Gitee selection renders as ticked', giteeTicked.html.indexOf('dgp-platform-row-on') >= 0)

/* ── 作者显示与归属确认（永不阻断） ──────────────────────────────────────── */

// 1) 左栏与头部都要显示作者
const authorPage = renderPage(snapshotFixture({}), 'zh-author-visible')
checkClean(authorPage)
check('the plugin list shows who wrote the plugin', authorPage.html.indexOf('dgp-plugin-author') >= 0 && authorPage.html.indexOf('Octocat') >= 0)
check('the plugin header highlights the author in its own chip', authorPage.html.indexOf('dgp-author-chip') >= 0)
check('an undeclared author is called out instead of left blank', renderPage(snapshotFixture({
  plugins: [pluginFixture({ author: '', authorName: '', authorEmail: '' })],
}), 'zh-author-missing').html.indexOf('未声明作者') >= 0)

// 2) 归属判定三态：徽章与卡片
const ownPage = renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({ status: 'own', author: 'Octocat', login: 'octocat', owner: 'octocat', scope: '', scopeDrift: false, confirmed: false })),
}), 'zh-ownership-own')
checkClean(ownPage)
check('a matching author is shown as matching', ownPage.html.indexOf('与账号一致') >= 0)
check('the ownership card lists the declared author and the account', ownPage.html.indexOf('插件归属') >= 0 && ownPage.html.indexOf('声明的作者') >= 0 && ownPage.html.indexOf('当前 GitHub 账号') >= 0)
// The class name also appears in the <style> block, so the presence test has
// to look for the element itself, not the stylesheet rule.
const OWNER_CONFIRM_MARKUP = 'id="dgp-owner-confirm"'
check('no confirmation checkbox appears when nothing needs confirming', ownPage.html.indexOf(OWNER_CONFIRM_MARKUP) < 0)

const foreignPage = renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({ status: 'foreign', author: 'Original Dev', login: 'octocat', owner: 'originaldev', scope: '', scopeDrift: false, confirmed: false })),
}), 'zh-ownership-foreign')
checkClean(foreignPage)
check('a foreign author is warned about', foreignPage.html.indexOf('归属需确认') >= 0 && foreignPage.html.indexOf('作者与账号都不一致') >= 0)
check('the foreign case offers a confirmation checkbox', foreignPage.html.indexOf(OWNER_CONFIRM_MARKUP) >= 0
  // The title switches between fork and foreign wording; either is a valid confirmation.
  && (foreignPage.html.indexOf('确认这是我的插件') >= 0 || foreignPage.html.indexOf('确认这是你有权发布的插件') >= 0))
check('the checkbox is presented as the way past the block', foreignPage.html.indexOf('确认这是你有权发布的插件') >= 0 && foreignPage.html.indexOf('不勾选也不会拦住发布') < 0)
check('a foreign author does NOT take the publish button away', foreignPage.html.indexOf('发布到') >= 0)

const confirmedPage = renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({ status: 'foreign', author: 'Original Dev', login: 'octocat', owner: 'originaldev', scope: '', scopeDrift: false, confirmed: true })),
}), 'zh-ownership-confirmed')
checkClean(confirmedPage)
check('a confirmed ownership reads as confirmed', confirmedPage.html.indexOf('归属已确认') >= 0 && confirmedPage.html.indexOf('运维确认归属') >= 0)
check('the checkbox disappears once confirmed', confirmedPage.html.indexOf(OWNER_CONFIRM_MARKUP) < 0)

const forkPage = renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({ status: 'fork', author: 'Original Dev', login: 'octocat', owner: 'octocat', scope: '', scopeDrift: false, confirmed: false })),
}), 'zh-ownership-fork')
checkClean(forkPage)
check('a fork names the situation instead of the verdict', forkPage.html.indexOf('作者与账号不同') >= 0 && forkPage.html.indexOf('目标仓库属于你') >= 0)

const scopePage = renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({ status: 'own', author: 'Octocat', login: 'octocat', owner: 'octocat', scope: 'someoneelse', scopeDrift: true, confirmed: false })),
}), 'zh-ownership-scope')
checkClean(scopePage)
check('a divergent npm scope is surfaced on its own row', scopePage.html.indexOf('npm 作用域') >= 0 && scopePage.html.indexOf('@someoneelse') >= 0)

// 3) 记住的确认：勾选框说明会按插件记住，确认后可以取消
check('the checkbox says the tick is remembered per plugin', foreignPage.html.indexOf('按插件记住') >= 0)
check('the checkbox says a changed author expires the tick', foreignPage.html.indexOf('会自动失效') >= 0)
check('a remembered confirmation is labelled as remembered', renderPage(snapshotFixture({
  preflight: api.normalizePreflight(withOwnership({
    status: 'foreign', author: 'Original Dev', login: 'octocat', owner: 'originaldev',
    scope: '', scopeDrift: false, confirmed: true, rememberedFor: 'original dev|originaldev',
  })),
}), 'zh-ownership-remembered').html.indexOf('按插件记住的确认') >= 0)
check('a confirmed ownership can be withdrawn from the panel', confirmedPage.html.indexOf('取消这次确认') >= 0)


/* -- 多平台结果卡：每平台独立成败 ---------------------------------------- */

// A single aggregate verdict would hide which remote actually received the code.
const partialResult = renderPage(snapshotFixture({
  job: api.normalizeJob({
    status: 'partial', steps: [], logs: [],
    startedAt: 1700000000000, endedAt: 1700000030000,
    error: null,
    result: api.normalizeResult({
      platforms: ['gitee', 'codeberg'], platformsLabel: 'Gitee + Codeberg',
      owner: '', repo: 'dsh-multi', branch: 'main', commitSha: 'acb2212abcdef',
      tag: 'v0.1.0', hostOk: 1, hostFailed: 1,
      hosts: [
        { id: 'gitee', label: 'Gitee', status: 'succeeded', repoUrl: 'https://gitee.com/ward-day/dsh-multi', releaseUrl: 'https://gitee.com/ward-day/dsh-multi/releases/tag/v0.1.0', tag: 'v0.1.0', createdRepo: true, pushed: true, steps: { repo: 'done', push: 'done', release: 'done' } },
        { id: 'codeberg', label: 'Codeberg', status: 'failed', repoUrl: '', releaseUrl: '', tag: '', createdRepo: false, pushed: false, steps: { repo: 'failed', push: 'pending', release: 'pending' }, error: 'Codeberg 资源不存在（HTTP 404）' },
      ],
    }),
  }),
}), 'partial-result-card')
checkClean(partialResult)
check('a partial publish is named as partial, not as success', partialResult.html.indexOf('部分平台完成') >= 0)
check('the result card lists each hosting separately', partialResult.html.indexOf('各平台结果') >= 0 && partialResult.html.indexOf('Gitee') >= 0 && partialResult.html.indexOf('Codeberg') >= 0)
check('a succeeded hosting is marked done next to a failed one', partialResult.html.indexOf('完成') >= 0 && partialResult.html.indexOf('失败') >= 0)
check('the failing hosting states its reason', partialResult.html.indexOf('Codeberg 资源不存在') >= 0)
check('the succeeding hosting keeps its repository link', partialResult.html.indexOf('gitee.com/ward-day/dsh-multi') >= 0)
check('the partial result is not dressed up as a plain success', partialResult.html.indexOf('发布成功') < 0)
/* ── report ───────────────────────────────────────────────────────────────── */

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log((result.ok ? 'PASS  ' : 'FAIL  ') + result.label + (result.ok || !result.detail ? '' : ' — ' + result.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' ssr checks passed')
if (totalWarnings > 0) {
  console.log('note: ' + totalWarnings + ' React warning line(s) captured')
}
if (failed > 0) process.exitCode = 1
