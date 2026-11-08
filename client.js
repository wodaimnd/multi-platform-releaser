/**
 * multi-platform-releaser — browser half (single classic-JS module for the DSH Web loader).
 *
 * One page that turns a local DSH plugin into a GitHub repository. It contributes
 * two seats of the shipped shell:
 *   · a row in the left sidebar's global panel list (`sidebar.panellist`, id
 *     `github-publisher`, order 50), whose glyph this file draws at the shell's
 *     size and active state, and
 *   · the page that row selects, registered in the layout's keyed `main` slot
 *     under the same id.
 *
 * The page scans the local plugins through the Host HTTP surface, edits the
 * publish metadata, previews README/LICENSE/.gitignore/package.json changes,
 * runs a preflight, then starts the publish job and follows it live: the eight
 * step timeline, logs, cancellation, and the final repository / Release links.
 *
 * All wire shapes follow CONTRACT.md §3/§4. Nothing runs on its own: the token
 * comes from the page-injected global, all API paths are document-relative and
 * a 401 re-bootstraps the token once before failing. No build step: no
 * TypeScript, no JSX, no module statements. React is the only module-table entry
 * this file resolves.
 */
window.__ModuleLoader__.load({
  id: 'multi-platform-releaser',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef

    // ── fixed identifiers (CONTRACT §1) ───────────────────────────────────
    /** Locale namespace for the dictionary and the shell's label resolution. */
    const NS = 'multi-platform-releaser'
    /** Shared key: the sidebar row id and the keyed `main` occupant key. */
    const PANEL_ID = 'github-publisher'
    /** Row order among the shell's global panel rows (Plugins 0, Schedule 10). */
    const PANEL_ORDER = 50

    const CLIENT_VERSION = '0.4.0'
    const TOKEN_HEADER = 'x-dsh-github-publisher-token'
    const POLL_MS = 650
    const DRAFT_DEBOUNCE_MS = 400
    const REQUEST_TIMEOUT_MS = 20000
    const PREFLIGHT_TIMEOUT_MS = 90000
    const PUBLISH_TIMEOUT_MS = 45000
    const TOAST_MS = 3200
    const DESCRIPTION_MAX = 350
    const NAME_MAX_LEN = 100
    const TOPIC_MAX = 10
    const TOPIC_MAX_LEN = 50

    const STORAGE_SELECTED = 'dsh-github-publisher.selected'
    const STORAGE_TAB = 'dsh-github-publisher.tab'
    const STORAGE_ACTIVE_TAB = 'dsh-github-publisher.page'
    const STORAGE_GUIDE = 'dsh-github-publisher.guide'
    const STORAGE_SEARCH = 'dsh-github-publisher.search'

    const MONO_FONT = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace'

    /** Document-relative API paths: no leading slash, so sub-path deployments work. */
    const API = {
      token: 'dsh-github-publisher/api/token',
      state: 'dsh-github-publisher/api/state',
      scan: 'dsh-github-publisher/api/scan',
      settings: 'dsh-github-publisher/api/settings',
      platforms: 'dsh-github-publisher/api/platforms',
      platformsVerify: 'dsh-github-publisher/api/platforms/verify',
      npmToken: 'dsh-github-publisher/api/platforms/npm-token',
      npmTokenDetect: 'dsh-github-publisher/api/platforms/npm-token/detect',
      registryStatus: 'dsh-github-publisher/api/registry/status',
      registryStart: 'dsh-github-publisher/api/registry/start',
      versionBump: 'dsh-github-publisher/api/version/bump',
      versionDrift: 'dsh-github-publisher/api/version/drift',
      syncPlan: 'dsh-github-publisher/api/sync/plan',
      preflight: 'dsh-github-publisher/api/preflight',
      publish: 'dsh-github-publisher/api/publish',
      job: 'dsh-github-publisher/api/job',
      cancel: 'dsh-github-publisher/api/cancel',
      draft: 'dsh-github-publisher/api/draft',
      historyClear: 'dsh-github-publisher/api/history/clear',
      aiSuggest: 'dsh-github-publisher/api/ai/suggest',
    }

    /** Defaults for the settings section of CONTRACT §3.2 (DEFAULT_CONFIG half). */
    const BASE_DEFAULTS = {
      visibility: 'public',
      license: 'MIT',
      branch: 'main',
      tagPrefix: 'v',
      createRelease: true,
      addReadme: true,
      // Updating a published plugin must not rewrite its docs: append only.
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
    }

    /** The full PublishForm (CONTRACT §4.3) seeded from BASE_DEFAULTS. */
    const BASE_FORM = {
      owner: '',
      name: '',
      description: '',
      descriptionZh: '',
      homepage: '',
      topics: [],
      visibility: BASE_DEFAULTS.visibility,
      license: BASE_DEFAULTS.license,
      branch: BASE_DEFAULTS.branch,
      tagPrefix: BASE_DEFAULTS.tagPrefix,
      commitMessage: BASE_DEFAULTS.commitMessage,
      authorName: BASE_DEFAULTS.authorName,
      authorEmail: BASE_DEFAULTS.authorEmail,
      // Not a default: an acknowledgement belongs to one publish decision.
      confirmForeignAuthor: false,
      repoExistsStrategy: BASE_DEFAULTS.repoExistsStrategy,
      addReadme: BASE_DEFAULTS.addReadme,
      readmeMode: BASE_DEFAULTS.readmeMode,
      addLicense: BASE_DEFAULTS.addLicense,
      addGitignore: BASE_DEFAULTS.addGitignore,
      updatePackageJson: BASE_DEFAULTS.updatePackageJson,
      createRelease: BASE_DEFAULTS.createRelease,
      releaseNotes: '',
      dryRun: false,
      forceWithLease: false,
      platforms: BASE_DEFAULTS.platforms,
      npmAccess: BASE_DEFAULTS.npmAccess,
      npmDistTag: BASE_DEFAULTS.npmDistTag,
      npmOtp: '',
    }

    const LICENSE_IDS = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0', 'none']
    const VISIBILITY_IDS = ['public', 'private']
    const README_MODE_IDS = ['auto', 'append', 'regenerate']
    const REPO_STRATEGY_IDS = ['reuse', 'error']
    const PLATFORM_IDS = ['github', 'gitee', 'codeberg', 'npm']
    const NPM_ACCESS_IDS = ['public', 'restricted']

    /** Job step ids in contract order (CONTRACT §4.5); the snapshot may shorten it. */
    const STEP_IDS = ['auth', 'inspect', 'prepare', 'repo', 'topics', 'commit', 'push', 'release', 'finish']
    const STEP_LABEL_KEYS = {
      auth: 'step.auth',
      inspect: 'step.inspect',
      prepare: 'step.prepare',
      repo: 'step.repo',
      topics: 'step.topics',
      commit: 'step.commit',
      push: 'step.push',
      release: 'step.release',
      'npm-auth': 'step.npmAuth',
      'npm-guard': 'step.npmGuard',
      'npm-publish': 'step.npmPublish',
      'npm-verify': 'step.npmVerify',
      finish: 'step.finish',
    }

    /** Every drift state the sync matrix can report. */
    const SYNC_STATES = ['in-sync', 'behind', 'ahead', 'absent', 'unknown']

    /** Per-platform metadata mirrored from lib/platforms.mjs (labels only). */
    const PLATFORM_META = {
      github: { id: 'github', label: 'GitHub', short: 'GitHub' },
      gitee: { id: 'gitee', label: 'Gitee', short: 'Gitee' },
      codeberg: { id: 'codeberg', label: 'Codeberg', short: 'Codeberg' },
      npm: { id: 'npm', label: 'npm registry', short: 'npm' },
    }

    /**
     * Repository hostings, in the order they are offered.
     *
     * A publish targets **one** hosting: a single commit is pushed to a single
     * remote. `npm` is a second destination alongside a repository rather than a
     * hosting of its own, which is why it is not in this list. Keeping the two
     * groups separate is what stops the UI from offering "GitHub + Gitee" as if
     * one push could serve both.
     */
    const HOSTING_IDS = ['github', 'gitee', 'codeberg']

    // ── locale dictionaries ───────────────────────────────────────────────
    const zh = {
      'panel.label': '多代码平台发布插件',
      'panel.title': '多代码平台发布插件',
      'panel.subtitle': '扫描本地 DSH 插件，勾选平台，一键建仓 / 推送 / Release / npm publish',

      'header.settings': '设置',
      'header.platforms': '平台配置',
      'header.rescan': '重新扫描',
      'header.scanning': '扫描中…',
      'header.accountConnected': '已连接 @{login}',
      'header.accountDisconnected': 'GitHub 未连接',
      'header.accountValidated': '已验证',
      'header.accountUnvalidated': '未验证',
      'header.accountsSummary': '{github} · {npm}',

      'tab.publish': '发布',
      'tab.platforms': '平台配置',
      'tab.sync': '版本同步',

      'platform.title': '发布平台',
      'platform.hint': '勾选的仓库平台会同时发布：同一个 commit 推到每个远端，各自建仓、各自发 Release。某个平台失败不会影响其他平台。',
      'platform.empty': '没有可用平台',
      'platform.enabled': '已启用',
      'platform.disabled': '未启用',
      'platform.configure': '去配置',
      'platform.configured': '已配置',
      'platform.notConfigured': '未配置凭据',
      'platform.tokenConfigured': 'token {hint}',
      'platform.tokenMissing': '缺少 token',
      'platform.noTopics': '不支持 topics',
      'platform.hostingOne': '仓库平台（可多选）',
      'platform.registryOne': '附加目标',
      'platform.hostingHint': '勾几个就发几个；每个平台用自己账号的令牌与仓库。',
      'platform.tokenEach': '每个平台有独立的访问令牌，在「平台配置」里填写。',
      'platform.github': 'GitHub',
      'platform.npm': 'npm registry',
      'platform.npmHint': 'npm publish：版本必须高于远端；同名版本 registry 不接受重发',
      'platform.npmNotEnabled': 'npm 尚未在「平台配置」里启用',
      'platform.noneSelected': '至少勾选一个平台',

      'platforms.title': '平台配置',
      'platforms.subtitle': '每个平台的凭据与默认值；token 只保存在本机 Host 配置（0600），任何响应与日志都不回显完整值。',
      'platforms.sectionGithub': 'GitHub',
      'platforms.sectionNpm': 'npm registry',
      'platforms.githubTokenHint': 'GitHub 的 PAT 在「设置 → GitHub 账号」里管理；这里只配置 Enterprise 地址。',
      'platforms.npmRegistryUnset': '未设 registry',
      'platform.npmNoAccount': '未验证账号',
      'platforms.summaryPublishName': '发布名 {name}',
      'platforms.summaryManifestName': '按 package.json 名',
      'platforms.npmRegistry': 'Registry',
      'platforms.npmToken': 'Access Token',
      'platforms.npmTokenHint': 'classic 或 granular token，需要 publish 权限；保存时会向 registry 校验一次。',
      'platforms.npmTokenPlaceholder': '粘贴 npm Access Token',
      'platforms.npmAccess': '访问级别',
      'platforms.npmAccessHint': 'scoped 包可选 restricted；非 scoped 包 npm 会强制 public。',
      'platforms.npmDistTag': 'dist-tag',
      'platforms.npmDistTagHint': '例如 latest / next / beta',
      'platforms.npmPublishName': '发布用包名',
      'platforms.npmPublishNameHint': '留空就用 package.json 里的 name。填了只在发布时改写临时副本的 name，源码 package.json 不动（适合把 @local/* 发到自己 scope）。',
      'platforms.publishNameInvalid': '发布用包名不合法：必须小写、无空格，可带 @scope',
      'platforms.npmProvenance': 'provenance',
      'platforms.npmProvenanceHint': '需要 CI/OIDC 环境，本机发布通常关闭。',
      'platforms.npmOtp': '2FA OTP',
      'platforms.npmOtpHint': '开启 2FA 时每次发布填一次，只随命令传递，不写入配置文件。',
      'platforms.enabledToggle': '启用这个平台',
      'platforms.save': '保存平台配置',
      'platforms.saving': '保存中…',
      'platforms.saved': '平台配置已保存',
      'platforms.verify': '验证凭据',
      'platforms.verifying': '验证中…',
      'platforms.verified': '已验证：@{login}',
      'platforms.verifyFailed': '验证失败',
      'platforms.npmAccount': 'npm 账号',
      'platforms.npmCleared': 'npm token 已清除',
      'platforms.registryInvalid': 'Registry 只接受 https://，或指向内网主机的 http://（127.0.0.1 / 私网 IP / .local / .internal / 单段主机名）',
      'platforms.baseUrlEmpty': '{label} 不能为空',
      'platforms.baseUrlInvalid': '{label} 不是合法地址：{value}（应形如 https://registry.npmjs.org 或 http://127.0.0.1:4873）',
      'platforms.httpPublicHost': '{label} 用 http:// 指向公网主机 {host}：token 会明文上网。请改用 {https}，或确认这是内网地址',
      'registry.label': 'Registry 状态',
      'registry.online': '在线',
      'registry.down': '未启动',
      'registry.unreachable': '连不上',
      'registry.unknown': '未检测',
      'registry.start': '启动 registry',
      'registry.starting': '启动中…',
      'registry.recheck': '重新检测',
      'registry.started': 'registry 已启动，可以发布了',
      'registry.startFailed': 'registry 没能启动，看下方原因',
      'platforms.needToken': '请先填 npm Access Token',
      'platforms.advanced': '高级',

      'sync.title': '版本同步',
      'sync.subtitle': '对比本地版本与每个平台的远端版本，只对落后的平台补发；发布新版本前可一键 bump。',
      'sync.platform': '平台',
      'sync.local': '本地版本',
      'sync.remote': '远端版本',
      'sync.state': '状态',
      'sync.stateInSync': '已同步',
      'sync.stateBehind': '落后',
      'sync.stateAbsent': '未发布',
      'sync.stateAhead': '本地更新',
      'sync.stateUnknown': '未知',
      'sync.check': '检查版本',
      'sync.checking': '检查中…',
      'sync.emptyTitle': '还没有检查过版本',
      'sync.emptyHint': '选一个插件后点「检查版本」；GitHub 读最新 Release 的 tag，npm 读 registry 的 latest。',
      'sync.behindN': '{n} 个平台落后',
      'sync.belowLatest': '{n} 个平台的远端版本更新：本次可以发布，但 latest 会退回较低版本',
      'sync.occupiedN': '{n} 个平台已经存在这个版本号，需要先提升版本',
      'sync.allInSync': '所有平台都已是最新版本',
      'sync.bumpAndSync': '提升版本并同步',
      'sync.bumpOnly': '只提升版本',
      'sync.bumpHint': '同步前需要先把 package.json 的 version 提到高于所有远端版本。',
      'sync.bumped': '版本已提升到 {version}',
      'sync.startSync': '发布到落后平台',
      'sync.pickPlugin': '先在「发布」标签里选一个插件',
      'sync.needsBump': '远端已有同名版本：npm 不接受重发，GitHub 会复用已有 Release。建议先 bump 版本。',
      'sync.bumpTo': '本版本号已被占用或落后于远端——点「只提升版本」直接提到 {version}，一次越过所有远端。',

      'step.npmAuth': '校验 npm 凭据',
      'step.npmGuard': '版本守卫',
      'step.npmPublish': 'npm publish',
      'step.npmVerify': '回查 registry',
      'common.loading': '加载中…',
      'common.save': '保存',
      'common.saving': '保存中…',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.copyFailed': '复制失败，请手动选中文本复制',
      'common.remove': '移除',
      'common.add': '添加',
      'common.retry': '重试',
      'common.reload': '重新加载',
      'common.refresh': '刷新',
      'common.optional': '可选',
      'common.empty': '暂无内容',
      'common.dismiss': '知道了',
      'common.open': '打开',
      'common.openRepo': '打开仓库',
      'common.unknown': '未知',
      'common.none': '无',
      'common.yes': '是',
      'common.no': '否',
      'common.details': '详情',
      'common.expand': '展开',
      'common.collapse': '收起',

      'badge.published': '已发布',
      'badge.unpublished': '未发布',
      'badge.noReadme': '缺少 README',
      'badge.noToken': 'token 未连接',

      'left.searchPlaceholder': '搜索插件名称或路径',
      'left.emptyTitle': '还没有发现本地插件',
      'left.emptyBody': '插件需要在 package.json 里声明 dsh.bundle 或 dsh.client。确认后重新扫描，也可以到设置里添加扫描根目录。',
      'left.scan': '扫描插件',
      'left.count': '{n} 个插件',
      'left.filtered': '{n} / {total} 个匹配',
      'left.noMatch': '没有匹配的插件',
      'left.recent': '最近发布',
      'left.recentEmpty': '还没有发布记录',
      'left.openHistory': '打开仓库页面',

      'token.title': '连接 GitHub 账号',
      'token.body': '发布前需要一个有 repo 权限的 Personal Access Token（PAT）。token 只保存在本机 Host 配置（0600），任何响应与日志都不会回显完整 token。',
      'token.placeholder': '粘贴 GitHub PAT（ghp_… 或 github_pat_…）',
      'token.save': '保存并验证',
      'token.saving': '验证中…',
      'token.detect': '自动检测',
      'token.detecting': '检测中…',
      'token.permissionsTitle': '需要的权限',
      'token.permissionClassic': 'Classic PAT：勾选 repo（发布私有仓库需要完整 repo 权限）',
      'token.permissionFine': 'Fine-grained PAT：Contents 读写 + Administration 读写 + Metadata 只读',
      'token.generate': '生成新的 PAT',
      'token.validated': '已验证',
      'token.notValidated': '未验证',
      'token.source': '来源',
      'token.hint': '当前 token：{hint}',
      'token.generateClassic': '申请经典 PAT',
      'token.generateFine': '申请细粒度 PAT',
      'token.generateNpm': '申请 npm Token',
      'token.manageGithub': '管理 GitHub 令牌',
      'token.manageNpm': '管理 npm 令牌',
      'token.newTabHint': '在浏览器新标签页打开申请页，链接已按当前接口地址预填。',

      'guide.title': '上手向导',
      'guide.subtitle': '三步走完绑定，之后只需要一个按钮。',
      'guide.progress': '已完成 {done}/{total}',
      'guide.allDone': '全部就绪',
      'guide.collapse': '收起向导',
      'guide.expand': '展开向导',
      'guide.done': '已完成',
      'guide.optional': '可选',
      'guide.stepGithub': '绑定 GitHub 令牌',
      'guide.stepGithubDetail': '用于建仓库、推提交、发 Release。点下面的链接去申请，粘回来保存即可。',
      'guide.stepGithubDone': '已连接 @{login}',
      'guide.stepPlugin': '选中要发布的插件',
      'guide.stepPluginDetail': '在左侧列表点一个插件；列表是空的就先扫描目录。',
      'guide.stepPluginDone': '已选中 {name}',
      'guide.stepNpm': '绑定 npm 令牌',
      'guide.stepNpmDetail': '不发布到 npm 可以跳过。要用时在平台配置里填 Registry 与 Access Token。',
      'guide.stepNpmDone': '已绑定 @{login}',
      'guide.stepNpmCustom': '当前 registry（{registry}）是自建的：先在终端跑 npm login --registry={registry}，再到「平台配置 → npm」里点「复制 .npmrc 键名」把 token 粘进去。',
      'guide.openSettings': '打开设置',
      'guide.openPlatforms': '去平台配置',
      'guide.scan': '扫描目录',

      'help.title': '帮助与链接',
      'help.subtitle': '所有绑定入口集中在这里，点开就是官方的申请页；链接会跟着下面的接口地址一起变。',
      'help.credentials': 'API 凭据申请入口',
      'help.githubClassic': 'GitHub 经典 PAT（已预填 repo、workflow 权限）',
      'help.githubFine': 'GitHub 细粒度 PAT（Contents 读写 + Administration 读写）',
      'help.githubManage': '管理已有的 GitHub 令牌',
      'help.githubDocs': 'GitHub 令牌官方说明',
      'help.npmToken': 'npm Access Token（Automation 类型最省事）',
      'help.npmManage': '管理已有的 npm 令牌',
      'help.npmDocs': 'npm 令牌官方说明',
      'help.endpoints': '当前生效的接口地址',
      'help.endpointsHint': '这两个地址由「接口地址」页里的配置派生，改完保存这里同步变化。',
      'help.diagnostics': '诊断',
      'help.diagnosticsHint': '出问题时把这段贴给维护者；它只包含版本、接口地址与账号状态，没有 token 原文。',
      'help.copyDiagnostics': '复制诊断信息',
      'help.diagCopied': '诊断信息已复制',
      'help.npmRegistryHint': '当前 registry：{registry}',
      'help.npmConsole': '打开 registry 控制台',
      'help.copyNpmLogin': '复制 npm login 命令',
      'help.npmLoginCopied': 'npm login 命令已复制',
      'help.copyNpmrcEntry': '复制 .npmrc 键名',
      'help.npmrcCopied': '.npmrc 键名已复制',
      'help.npmCustomRegistry': '这是自建 registry：没有网页令牌页，token 由 npm login 写进 .npmrc，直接复制过来用即可。',
      'platforms.npmCustomSteps': '自建 registry（{host}）的 token 这样拿：',
      'platforms.npmCustomFinish': '把这段值粘到上面的 Access Token 输入框，再点「保存并验证」。',
      'platforms.npmrcAutoRead': '从 .npmrc 自动读取（推荐，省得手动复制出错）',
      'platforms.npmrcRead': '自动读取并保存',
      'platforms.npmrcReading': '读取中…',
      'platforms.npmrcCheck': '只检测不保存',
      'platforms.npmrcProbeFound': '找到 token {hint}，来源 {source}（未保存）',
      'platforms.npmrcProbeSaved': '已读取并保存 token {hint}，来源 {source}',
      'platforms.npmrcFound': '找到 token {hint}',
      'platforms.npmrcAdopted': '已从 .npmrc 读取并保存 npm token（{login}）',
      'platforms.npmrcMissing': '没在 .npmrc 里找到这个 registry 的 token：先在终端执行 npm login，或用只检测看它找了哪些文件',

      'plugin.version': 'v{version}',
      'plugin.copyPath': '复制路径',
      'plugin.path': '绝对路径',
      'plugin.branch': '分支 {branch}',
      'plugin.license': 'License {license}',
      'plugin.noReadme': '没有 README',
      'plugin.noAuthor': '未声明作者',
      'plugin.authorLabel': '作者',
      'plugin.authorAria': '插件作者：{author}',
      'plugin.ownMatch': '与账号一致',
      'plugin.ownConfirmed': '归属已确认',
      'plugin.ownFork': '作者与账号不同',
      'plugin.ownForeign': '归属需确认',
      'plugin.ownNone': '无作者信息',
      'plugin.published': '最近发布 {version}',

      'section.publishInfo': '发布信息',
      'section.options': '发布选项',
      'section.readme': 'README 预览',
      'section.preflight': '预检与发布',
      'section.progress': '发布进度',
      'section.result': '发布结果',
      'section.advanced': '高级选项',

      'field.owner': 'Owner',
      'field.ownerHint': 'GitHub 登录名（login，不是昵称）或组织登录名；个人账号就是你的 @用户名',
      'field.ownerPlaceholder': 'octocat',
      'field.ownerRequired': '请填写 owner',
      'field.ownerInvalid': 'owner 只能包含字母、数字和连字符',
      'field.name': '仓库名',
      'field.nameHint': '字母、数字、点、下划线、连字符，最多 100 字符',
      'field.namePlaceholder': 'my-plugin',
      'field.nameRequired': '请填写仓库名',
      'field.nameInvalid': '仓库名只能包含字母、数字、点、下划线和连字符',
      'field.description': '英文描述',
      'field.descriptionHint': 'GitHub 仓库描述，最多 350 字符',
      'field.descriptionPlaceholder': '一句话说明这个插件做什么',
      'field.descriptionTooLong': '描述最多 350 字符，当前 {n} 字符',
      'field.descriptionZh': '中文简介',
      'field.descriptionZhPlaceholder': '中文简介（可选，会写进 README）',
      'field.homepage': '主页 URL',
      'field.homepagePlaceholder': 'https://example.com/my-plugin',
      'field.topics': 'Topics',
      'field.topicsHint': '小写字母、数字、- 和 _，最多 10 个',
      'field.topicPlaceholder': '输入 topic 后按 Enter 添加',
      'field.topicsEmpty': '还没有 topic',
      'field.topicsTooMany': 'Topics 最多 10 个',
      'field.topicsInvalid': 'topic 只能包含小写字母、数字、- 和 _（≤50 字符）',
      'field.visibility': '可见性',
      'field.public': '公开',
      'field.private': '私有',
      'field.license': 'License',
      'field.licenseNone': '不使用 License',
      'field.branch': '目标分支',
      'field.branchRequired': '请填写目标分支',
      'field.tagPrefix': 'Tag 前缀',
      'field.tagPrefixInvalid': 'Tag 前缀只能包含字母、数字、点、下划线和连字符',
      'field.commitMessage': '提交信息',
      'field.commitHint': '可用 {name} 与 {version} 占位',
      'field.authorName': '提交作者名',
      'field.authorEmail': '提交作者邮箱',
      'field.repoStrategy': '仓库已存在时',
      'field.repoReuse': '复用已有仓库',
      'field.repoError': '报错停止',
      'field.releaseNotes': 'Release 说明',
      'field.releaseNotesPlaceholder': '留空则自动生成',
      'field.readmeMode': 'README 模式',
      'field.readmeModeHint': '推荐「追加更新日志」：只往现有 README 末尾加本次变更，原有内容一个字节都不动',
      'field.readmeAuto': '缺失时生成',
      'field.readmeAppend': '追加更新日志',
      'field.readmeRegenerate': '重新生成覆盖',

      'form.preflight': '预检',
      'form.preflighting': '预检中…',
      'form.publish': '一键发布',
      'form.publishTo': '发布到 {targets}',
      'form.publishing': '发布中…',
      'form.retryPlatforms': '重试失败平台',
      'form.platformsHint': '勾选目标平台后，这一个按钮会依次完成所有平台的发布。',
      'form.republish': '再发布一次',
      'form.retryPublish': '重试发布',
      'form.stale': '发布信息已修改，需要重新预检',
      'ai.button': 'AI 补全信息',
      'ai.busy': '正在生成…',
      'ai.hint': '用 DSH 已配置的 DeepSeek 模型，根据 package.json / README 生成英文描述、中文简介、topics 和 Release 说明；会覆盖这几项，发布前仍可修改',
      'ai.applied': '已用 {model} 生成发布信息，请检查后预检',
      'ai.failed': 'AI 补全失败',
      'ai.empty': '模型没有返回可用的发布信息',
      'ai.failedToast': 'AI 补全失败：{message}',
      'form.blocked': '预检未通过，请先处理失败项',
      'form.notPreflighted': '尚未预检：发布前会自动执行一次预检',
      'form.needRecheck': '需重新预检',

      'option.addReadme': '生成 README',
      'option.addLicense': '生成 LICENSE',
      'option.addGitignore': '生成 .gitignore',
      'option.updatePackageJson': '补全 package.json',
      'option.createRelease': '创建 GitHub Release',
      'option.dryRun': '演练模式',
      'option.dryRunHint': '只做本地准备与 commit，不建仓、不 push、不发布 Release',
      'option.forceWithLease': '推送冲突时使用 --force-with-lease',
      'option.forceWithLeaseHint': '仅当远端分支被改写时使用，存在覆盖风险',
      'option.advancedShow': '展开高级选项',
      'option.advancedHide': '收起高级选项',

      'preflight.title': '预检',
      'preflight.run': '运行预检',
      'preflight.rerun': '重新预检',
      'preflight.running': '正在预检…',
      'preflight.notRun': '还没有预检结果',
      'preflight.notRunHint': '点击「预检」检查 git、token、目录、仓库名与将写入的文件；预检不会写盘。',
      'preflight.passed': '预检通过，可以发布',
      'preflight.warned': '预检通过，但有 {n} 项提醒',
      'preflight.blocked': '预检未通过：{n} 项失败',
      'preflight.blockingLabel': '阻断项',
      'preflight.checkPass': '通过',
      'preflight.checkWarn': '提醒',
      'preflight.checkFail': '失败',
      'preflight.fix': '修复',
      'preflight.fixSettings': '去设置',
      'preflight.fixBump': '提升版本',
      'preflight.fixBumpTo': '提升到 {version}',
      'preflight.fixConfirmAuthor': '去确认归属',
      'preflight.ownership': '插件归属',
      'preflight.ownershipStatus.own': '与当前账号一致',
      'preflight.ownershipStatus.fork': '作者与账号不同 · 目标仓库属于你',
      'preflight.ownershipStatus.foreign': '作者与账号都不一致',
      'preflight.ownershipStatus.none': '未声明作者',
      'preflight.ownershipAuthor': '声明的作者',
      'preflight.ownershipAccount': '当前 GitHub 账号',
      'preflight.ownershipNoAccount': '（未连接）',
      'preflight.ownershipRepo': '目标仓库归属',
      'preflight.ownershipNpmScope': 'npm 作用域',
      'preflight.ownershipConfirm': '确认这是我的插件（作者字段写的是原作者 / fork 自他人）',
      'preflight.ownershipConfirmHint': '勾选后继续正常发布，并把这次确认记进发布记录。不勾选也不会拦住发布。',
      'preflight.ownershipRecallHint': '这个勾选会按插件记住（存在该插件的草稿里）；一旦 package.json 的 author 被改成另一个人，记住的确认会自动失效，需要重新勾选。',
      'preflight.ownershipConfirmedRemembered': '（按插件记住的确认）',
      'preflight.ownershipForget': '取消这次确认',
      'preflight.ownershipConfirmedNote': '这次发布已在记录里标注为「运维确认归属」',
      'preflight.plan': '发布计划',
      'preflight.files': '将写入的文件',
      'preflight.filesCount': '将写入 {n} 个文件',
      'preflight.fileCreate': '新建',
      'preflight.fileUpdate': '更新',
      'preflight.fileAppend': '追加',
      'preflight.fileKeep': '保留',
      'preflight.fileBytes': '{n} B',
      'preflight.planOwner': 'Owner',
      'preflight.planRepo': '仓库',
      'preflight.planBranch': '分支',
      'preflight.planVisibility': '可见性',
      'preflight.planTag': 'Tag',
      'preflight.planRelease': 'Release',
      'preflight.planRemote': '远端',
      'preflight.planCreate': '将新建仓库',
      'preflight.planReuse': '复用已有仓库',
      'preflight.planReleaseOn': '创建',
      'preflight.planReleaseOff': '不创建',
      'preflight.planDryRun': '演练（不推送）',
      'preflight.warnings': '警告',
      'preflight.packageChanges': 'package.json 变更',
      'preflight.showContent': '查看内容',
      'preflight.hideContent': '收起内容',
      'preflight.readmeMissing': '预检结果里没有 README 内容',
      'preflight.staleHint': '关键字段已修改：预检结果可能过期，请重新预检。',
      'preflight.needToken': '发布前需要先连接 GitHub 账号',
      'preflight.needAccountOrDryRun': '连接 GitHub 账号，或在发布选项里勾选演练模式',

      'readme.title': 'README 预览',
      'readme.hint': '预检后展示将写入的 README 内容',
      'readme.empty': '还没有 README 内容：先运行预检',
      'readme.copy': '复制 README',
      'readme.chars': '{n} 字符',
      'readme.actionCreate': '将新建 README',
      'readme.actionUpdate': '将更新 README',
      'readme.actionKeep': '保留现有 README',

      'progress.title': '发布进度',
      'progress.cancel': '取消发布',
      'progress.cancelling': '取消中…',
      'progress.logs': '日志',
      'progress.noLogs': '等待日志…',
      'progress.elapsed': '已用时 {text}',
      'progress.done': '完成',
      'progress.running': '进行中',
      'progress.pending': '等待',
      'progress.skipped': '跳过',
      'progress.failed': '失败',
      'progress.cancelled': '已取消',
      'progress.waiting': '等待发布',

      'step.auth': '校验账号',
      'step.inspect': '检查插件',
      'step.prepare': '准备文件',
      'step.repo': '创建仓库',
      'step.topics': '设置 Topics',
      'step.commit': '提交改动',
      'step.push': '推送代码',
      'step.release': '创建 Release',
      'step.npmAuth': '校验 npm 凭据',
      'step.npmGuard': '版本守卫',
      'step.npmPublish': 'npm publish',
      'step.npmVerify': '回查 registry',
      'step.finish': '收尾',

      'result.successTitle': '发布成功',
      'result.partialTitle': '部分平台完成',
      'result.hostsTitle': '各平台结果',
      'result.hostsCount': '{ok}/{total} 成功',
      'result.hostSucceeded': '完成',
      'result.hostFailed': '失败',
      'result.hostSkipped': '已跳过',
      'result.hostPartial': '部分完成',
      'result.dryRunTitle': '演练完成',
      'result.failedTitle': '发布失败',
      'result.cancelledTitle': '发布已取消',
      'result.repo': '仓库',
      'result.release': 'Release',
      'result.commit': 'Commit',
      'result.tag': 'Tag',
      'result.branch': '分支',
      'result.duration': '耗时',
      'result.files': '写入文件',
      'result.created': '新建仓库',
      'result.pushed': '已推送',
      'result.noRelease': '未创建 Release',
      'result.again': '再发布一次',
      'result.dryRunNote': '演练模式：未创建仓库、未推送、未发布 Release',
      'result.filesWritten': '{n} 个文件',
      'result.openRepo': '打开仓库',
      'result.copyCommit': '复制 commit SHA',
      'result.errorCode': '错误码',

      'settings.title': '设置',
      'settings.account': 'GitHub 账号',
      'settings.accountHint': 'token 只保存在本机 Host 配置（0600），不会出现在任何 API 响应、job 日志或 git 回显中。',
      'settings.saveToken': '保存并验证',
      'settings.clearToken': '清除 token',
      'settings.detectToken': '自动检测',
      'settings.tokenSaved': 'token 已验证并保存',
      'settings.tokenRemoved': 'token 已清除',
      'settings.tokenDetected': '已自动检测到可用 token',
      'settings.tokenNotDetected': '没有检测到可用的 token',
      'settings.enterprise': 'GitHub Enterprise',
      'settings.apiBase': 'API 地址（apiBase）',
      'settings.gitBase': '网页地址（gitBase）',
      'settings.enterpriseHint': '公共 GitHub 保持默认；Enterprise 填 https://ghe.example.com/api/v3 与 https://ghe.example.com',
      'settings.baseInvalid': 'apiBase / gitBase 只接受 https://，或指向内网主机的 http://（127.0.0.1 / 私网 IP / .local / .internal / 单段主机名）',
      'settings.scanRoots': '扫描根目录',
      'settings.scanRootsHint': '额外扫描的绝对路径目录；添加后保存，会去重并校验是否存在。',
      'settings.scanRootPlaceholder': '/绝对/路径/到/插件目录',
      'settings.scanRootInvalid': '请输入存在的绝对路径',
      'settings.scanRootAdd': '添加目录',
      'settings.defaults': '默认发布选项',
      'settings.defaultsHint': '新建插件的初始表单值；单个插件草稿会覆盖这里的默认值。',
      'settings.topicPreset': '默认 Topics',
      'settings.autoDetectToken': '自动检测本机 token（环境变量 / gh CLI / git credential）',
      'settings.danger': '危险操作',
      'settings.clearHistory': '清空发布历史',
      'settings.clearHistoryConfirm': '确定清空全部发布历史？该操作不可撤销。',
      'settings.clearHistoryYes': '确定清空',
      'settings.clearHistoryNo': '取消',
      'settings.saved': '设置已保存',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.sectionAccount': '账号',
      'settings.sectionEnterprise': 'Enterprise',
      'settings.sectionScan': '扫描目录',
      'settings.sectionDefaults': '默认值',
      'settings.sectionHelp': '帮助与链接',
      'settings.sectionDanger': '危险操作',
      'settings.validatedAt': '验证时间',
      'settings.noAccount': '未连接 GitHub 账号',
      'settings.persisted': '已持久化到配置文件',
      'settings.notPersisted': '仅在内存中',
      'settings.sourceConfig': '配置文件',
      'settings.sourceMemory': '内存',
      'settings.sourceEnv': '环境变量',
      'settings.sourceGhCli': 'gh CLI',
      'settings.sourceGitCredential': 'git credential',
      'settings.accountStatus': '账号状态',
      'settings.tokenType': 'PAT 类型',
      'settings.inlineError': '操作失败',

      'error.loadState': '加载页面状态失败',
      'error.scan': '扫描本地插件失败',
      'error.preflight': '预检失败',
      'error.publish': '发布失败',
      'error.cancel': '取消发布失败',
      'error.settings': '保存设置失败',
      'error.token': 'token 验证失败',
      'error.draft': '草稿保存失败',
      'error.copy': '复制失败',
      'error.network': '网络请求失败，请确认 DSH Web 服务仍在运行',
      'error.timeout': '请求超时：Host 可能正忙或未响应',
      'error.notMounted': 'Host 路由不可用：dsh-github-publisher 插件可能未启用或尚未加载',
      'error.http': 'Host 返回了 HTTP {status}',
      'error.badResponse': 'Host 返回了无法解析的响应',
      'error.unauthorized': '页面 token 校验失败，已尝试重新获取；如果仍失败请刷新页面',
      'error.noToken': '无法从 Host 获取 token：请刷新页面或确认插件已启用',
      'error.tokenRelated': 'token 相关错误，请到设置里更新 PAT',
      'error.goSettings': '去设置',
      'error.preflightBlocked': '预检未通过，无法发布',
      'error.crashed': '多代码平台发布插件出错了',
      'error.crashedHint': '页面其余功能不受影响；刷新页面即可恢复，已发布数据保存在 Host 端。',
      'error.reload': '重新加载',
      'error.detail': '详情',
      'error.retry': '重试',
      'error.jobRunning': '已有一个发布任务在运行，已接入该任务',
      'error.pickPlugin': '请先在左侧选择一个插件',
      'error.noPlugins': '没有可发布的插件',

      'toast.saved': '已保存',
      'toast.scanned': '已扫描到 {n} 个插件',
      'toast.tokenSaved': 'token 已验证',
      'toast.tokenCleared': 'token 已清除',
      'toast.settingsSaved': '设置已保存',
      'toast.historyCleared': '发布历史已清空',
      'toast.cancelled': '正在取消发布…',
      'toast.copied': '已复制',
      'toast.publishStarted': '开始发布 {name}',
      'toast.publishSucceeded': '{owner}/{repo} 发布成功',
      'toast.publishPartial': '部分平台完成：{ok}/{total} 个仓库平台已发布，详情见结果卡',
      'toast.publishFailed': '发布失败：{message}',
      'toast.publishCancelled': '发布已取消',
      'toast.draftSaved': '草稿已保存',

      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
      'time.seconds': '{n} 秒',
      'time.minutesSeconds': '{m} 分 {s} 秒',
      'time.hoursMinutes': '{h} 小时 {m} 分',

      'empty.title': '还没有选中插件',
      'empty.body': '从左侧选择一个本地 DSH 插件，勾选目标平台后一键发布到 GitHub / npm。',
      'empty.scan': '扫描本地插件',
      'empty.hint': '插件需要 package.json 里声明 dsh.bundle 或 dsh.client。',
    }

    const en = {
      'panel.label': 'Multi-Forge Publisher',
      'panel.title': 'Multi-Forge Publisher',
      'panel.subtitle': 'Scan local DSH plugins, tick the platforms, then publish in one go: repo, commit, push, Release, npm publish',

      'header.settings': 'Settings',
      'header.platforms': 'Platforms',
      'header.rescan': 'Rescan',
      'header.scanning': 'Scanning…',
      'header.accountConnected': 'Connected as @{login}',
      'header.accountDisconnected': 'GitHub not connected',
      'header.accountValidated': 'Validated',
      'header.accountUnvalidated': 'Not validated',
      'header.accountsSummary': '{github} · {npm}',

      'tab.publish': 'Publish',
      'tab.platforms': 'Platforms',
      'tab.sync': 'Version sync',

      'platform.title': 'Target platforms',
      'platform.hint': 'Every ticked repository hosting is published to: one commit is pushed to each remote, with its own repo and release. A failure on one does not stop the others.',
      'platform.empty': 'No platform available',
      'platform.enabled': 'Enabled',
      'platform.disabled': 'Disabled',
      'platform.github': 'GitHub',
      'platform.npm': 'npm registry',
      'platform.configure': 'Configure',
      'platform.configured': 'Configured',
      'platform.notConfigured': 'No credentials',
      'platform.tokenConfigured': 'token {hint}',
      'platform.tokenMissing': 'Token missing',
      'platform.noTopics': 'No topics support',
      'platform.hostingOne': 'Repository hostings (multi-select)',
      'platform.registryOne': 'Extra destination',
      'platform.hostingHint': 'Tick as many as you like; each uses its own account token and repository.',
      'platform.tokenEach': 'Each hosting has its own access token, configured under Platform config.',
      'platform.npmHint': 'npm publish: the version must be higher than the registry one; npm rejects re-publishing the same version',
      'platform.npmNotEnabled': 'npm is not enabled yet in the Platforms tab',
      'platform.noneSelected': 'Tick at least one platform',

      'platforms.title': 'Platforms',
      'platforms.subtitle': 'Credentials and defaults per platform. Tokens stay in the local Host config (0600) and are never echoed in responses or logs.',
      'platforms.sectionGithub': 'GitHub',
      'platforms.sectionNpm': 'npm registry',
      'platforms.githubTokenHint': 'The GitHub PAT lives under Settings → GitHub account; only the Enterprise bases are configured here.',
      'platforms.npmRegistryUnset': 'no registry set',
      'platform.npmNoAccount': 'account not verified',
      'platforms.summaryPublishName': 'publish name {name}',
      'platforms.summaryManifestName': 'uses package.json name',
      'platforms.npmRegistry': 'Registry',
      'platforms.npmToken': 'Access token',
      'platforms.npmTokenHint': 'A classic or granular token with publish permission; it is validated against the registry when saved.',
      'platforms.npmTokenPlaceholder': 'Paste the npm access token',
      'platforms.npmAccess': 'Access',
      'platforms.npmAccessHint': 'scoped packages may be restricted; npm forces public for unscoped names.',
      'platforms.npmDistTag': 'dist-tag',
      'platforms.npmDistTagHint': 'e.g. latest / next / beta',
      'platforms.npmPublishName': 'Publish name',
      'platforms.npmPublishNameHint': 'Leave blank to use the package.json name. When set, only the temporary publish copy is renamed — the source package.json is never touched (handy for publishing @local/* under your own scope).',
      'platforms.publishNameInvalid': 'Invalid publish name: lowercase, no spaces, optional @scope',
      'platforms.npmProvenance': 'provenance',
      'platforms.npmProvenanceHint': 'Requires CI/OIDC; usually off for local publishing.',
      'platforms.npmOtp': '2FA OTP',
      'platforms.npmOtpHint': 'One-shot code when 2FA is on; travels with the command only, never written to the config file.',
      'platforms.enabledToggle': 'Enable this platform',
      'platforms.save': 'Save platforms',
      'platforms.saving': 'Saving…',
      'platforms.saved': 'Platforms saved',
      'platforms.verify': 'Verify credentials',
      'platforms.verifying': 'Verifying…',
      'platforms.verified': 'Verified: @{login}',
      'platforms.verifyFailed': 'Verification failed',
      'platforms.npmAccount': 'npm account',
      'platforms.npmCleared': 'npm token cleared',
      'platforms.registryInvalid': 'Registry accepts https://, or http:// only for a private host (127.0.0.1 / RFC1918 / .local / .internal / single-label)',
      'platforms.baseUrlEmpty': '{label} cannot be empty',
      'platforms.baseUrlInvalid': '{label} is not a valid address: {value} (use e.g. https://registry.npmjs.org or http://127.0.0.1:4873)',
      'platforms.httpPublicHost': '{label} points http:// at the public host {host}: the token would travel in cleartext. Use {https}, or confirm this is an intranet address',
      'registry.label': 'Registry status',
      'registry.online': 'Online',
      'registry.down': 'Not running',
      'registry.unreachable': 'Unreachable',
      'registry.unknown': 'Not checked',
      'registry.start': 'Start registry',
      'registry.starting': 'Starting…',
      'registry.recheck': 'Re-check',
      'registry.started': 'Registry is up — ready to publish',
      'registry.startFailed': 'The registry did not start; see the reason above',
      'platforms.needToken': 'Fill in the npm access token first',
      'platforms.advanced': 'Advanced',

      'sync.title': 'Version sync',
      'sync.subtitle': 'Compare the local version with each platform, then re-publish only the ones that are behind. Bump first when a remote already has this version.',
      'sync.platform': 'Platform',
      'sync.local': 'Local',
      'sync.remote': 'Remote',
      'sync.state': 'State',
      'sync.stateInSync': 'In sync',
      'sync.stateBehind': 'Behind',
      'sync.stateAbsent': 'Not published',
      'sync.stateAhead': 'Local newer',
      'sync.stateUnknown': 'Unknown',
      'sync.check': 'Check versions',
      'sync.checking': 'Checking…',
      'sync.emptyTitle': 'No version check yet',
      'sync.emptyHint': 'Pick a plugin and press "Check versions": GitHub reads the latest Release tag, npm reads the registry latest.',
      'sync.behindN': '{n} platform(s) behind',
      'sync.belowLatest': '{n} platform(s) are further ahead: publishing now is allowed, but latest moves back to the lower version',
      'sync.occupiedN': '{n} platform(s) already hold this exact version — bump before publishing',
      'sync.allInSync': 'Every platform is up to date',
      'sync.bumpAndSync': 'Bump and sync',
      'sync.bumpOnly': 'Bump only',
      'sync.bumpHint': 'Sync needs the package.json version to be higher than every remote one.',
      'sync.bumped': 'Version bumped to {version}',
      'sync.startSync': 'Publish to platforms behind',
      'sync.pickPlugin': 'Pick a plugin in the Publish tab first',
      'sync.needsBump': 'A remote already has this version: npm rejects a re-publish, GitHub reuses the existing Release. Bump first.',
      'sync.bumpTo': 'This version is taken or trails a remote one — "Bump only" jumps straight to {version}, clearing every remote at once.',

      'common.loading': 'Loading…',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.copyFailed': 'Copy failed — please select and copy manually',
      'common.remove': 'Remove',
      'common.add': 'Add',
      'common.retry': 'Retry',
      'common.reload': 'Reload',
      'common.refresh': 'Refresh',
      'common.optional': 'Optional',
      'common.empty': 'Nothing here yet',
      'common.dismiss': 'Dismiss',
      'common.open': 'Open',
      'common.openRepo': 'Open repository',
      'common.unknown': 'Unknown',
      'common.none': 'None',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.details': 'Details',
      'common.expand': 'Expand',
      'common.collapse': 'Collapse',

      'badge.published': 'Published',
      'badge.unpublished': 'Not published',
      'badge.noReadme': 'No README',
      'badge.noToken': 'Token missing',

      'left.searchPlaceholder': 'Search plugins by name or path',
      'left.emptyTitle': 'No local plugins found yet',
      'left.emptyBody': 'A plugin declares dsh.bundle or dsh.client in package.json. Check that, rescan, or add a scan root in Settings.',
      'left.scan': 'Scan plugins',
      'left.count': '{n} plugins',
      'left.filtered': '{n} / {total} matching',
      'left.noMatch': 'No matching plugins',
      'left.recent': 'Recent publishes',
      'left.recentEmpty': 'No publish history yet',
      'left.openHistory': 'Open repository page',

      'token.title': 'Connect a GitHub account',
      'token.body': 'Publishing needs a Personal Access Token (PAT) with repo scope. The token stays in the local Host config (0600); no response or log ever echoes it.',
      'token.placeholder': 'Paste a GitHub PAT (ghp_… or github_pat_…)',
      'token.save': 'Save and validate',
      'token.saving': 'Validating…',
      'token.detect': 'Auto-detect',
      'token.detecting': 'Detecting…',
      'token.permissionsTitle': 'Required permissions',
      'token.permissionClassic': 'Classic PAT: tick repo (full repo scope for private repositories)',
      'token.permissionFine': 'Fine-grained PAT: Contents read/write + Administration read/write + Metadata read',
      'token.generate': 'Generate a new PAT',
      'token.validated': 'Validated',
      'token.notValidated': 'Not validated',
      'token.source': 'Source',
      'token.hint': 'Current token: {hint}',
      'token.generateClassic': 'Create a classic PAT',
      'token.generateFine': 'Create a fine-grained PAT',
      'token.generateNpm': 'Create an npm token',
      'token.manageGithub': 'Manage GitHub tokens',
      'token.manageNpm': 'Manage npm tokens',
      'token.newTabHint': 'Opens the issuance page in a new browser tab, pre-filled for the API base you configured.',

      'guide.title': 'Getting started',
      'guide.subtitle': 'Three steps to bind everything — then one button to publish.',
      'guide.progress': '{done} of {total} done',
      'guide.allDone': 'All set',
      'guide.collapse': 'Collapse guide',
      'guide.expand': 'Expand guide',
      'guide.done': 'Done',
      'guide.optional': 'Optional',
      'guide.stepGithub': 'Bind a GitHub token',
      'guide.stepGithubDetail': 'Creates the repo, pushes commits and publishes the Release. Use the links below to create one, then paste it back here.',
      'guide.stepGithubDone': 'Connected as @{login}',
      'guide.stepPlugin': 'Pick the plugin to publish',
      'guide.stepPluginDetail': 'Click a plugin in the left list; if the list is empty, scan your directories first.',
      'guide.stepPluginDone': 'Selected {name}',
      'guide.stepNpm': 'Bind an npm token',
      'guide.stepNpmDetail': 'Skip this if you do not publish to npm. When you need it, fill the Registry and Access Token on the Platforms page.',
      'guide.stepNpmDone': 'Bound to @{login}',
      'guide.stepNpmCustom': 'This registry ({registry}) is self-hosted: run npm login --registry={registry} in a terminal, then use Copy the .npmrc key on the npm platform card and paste the token.',
      'guide.openSettings': 'Open settings',
      'guide.openPlatforms': 'Open platforms',
      'guide.scan': 'Scan directories',

      'help.title': 'Help & links',
      'help.subtitle': 'Every binding entry point in one place — each one opens the official issuance page, derived from the API base below.',
      'help.credentials': 'Where to get API credentials',
      'help.githubClassic': 'GitHub classic PAT (repo + workflow pre-filled)',
      'help.githubFine': 'GitHub fine-grained PAT (Contents R/W + Administration R/W)',
      'help.githubManage': 'Manage existing GitHub tokens',
      'help.githubDocs': 'GitHub token documentation',
      'help.npmToken': 'npm Access Token (Automation type is the simplest)',
      'help.npmManage': 'Manage existing npm tokens',
      'help.npmDocs': 'npm token documentation',
      'help.endpoints': 'Effective API endpoints',
      'help.endpointsHint': 'Both values are derived from the Enterprise configuration tab; save there and these follow.',
      'help.diagnostics': 'Diagnostics',
      'help.diagnosticsHint': 'Paste this to a maintainer when something breaks. It carries versions, endpoints and account state only — never a token.',
      'help.copyDiagnostics': 'Copy diagnostics',
      'help.diagCopied': 'Diagnostics copied',
      'help.npmRegistryHint': 'Current registry: {registry}',
      'help.npmConsole': 'Open the registry console',
      'help.copyNpmLogin': 'Copy the npm login command',
      'help.npmLoginCopied': 'npm login command copied',
      'help.copyNpmrcEntry': 'Copy the .npmrc key',
      'help.npmrcCopied': '.npmrc key copied',
      'help.npmCustomRegistry': 'This is a self-hosted registry: there is no web token page — npm login writes the token into .npmrc, copy it from there.',
      'platforms.npmCustomSteps': 'Getting a token from a self-hosted registry ({host}):',
      'platforms.npmCustomFinish': 'Paste that value into the Access Token field above, then click Save and verify.',
      'platforms.npmrcAutoRead': 'Read it from .npmrc (recommended — no manual copying)',
      'platforms.npmrcRead': 'Read and save',
      'platforms.npmrcReading': 'Reading…',
      'platforms.npmrcCheck': 'Check only',
      'platforms.npmrcProbeFound': 'Found token {hint} from {source} (not saved)',
      'platforms.npmrcProbeSaved': 'Read and saved token {hint} from {source}',
      'platforms.npmrcFound': 'Found token {hint}',
      'platforms.npmrcAdopted': 'Read the npm token from .npmrc and saved it ({login})',
      'platforms.npmrcMissing': 'No token for this registry in .npmrc: run npm login first, or use Check only to see which files were searched',

      'plugin.version': 'v{version}',
      'plugin.copyPath': 'Copy path',
      'plugin.path': 'Absolute path',
      'plugin.branch': 'branch {branch}',
      'plugin.license': 'License {license}',
      'plugin.noReadme': 'No README',
      'plugin.noAuthor': 'No author declared',
      'plugin.authorLabel': 'Author',
      'plugin.authorAria': 'Plugin author: {author}',
      'plugin.ownMatch': 'Matches your account',
      'plugin.ownConfirmed': 'Ownership confirmed',
      'plugin.ownFork': 'Author differs',
      'plugin.ownForeign': 'Needs confirmation',
      'plugin.ownNone': 'No author info',
      'plugin.published': 'Last published {version}',

      'section.publishInfo': 'Publish details',
      'section.options': 'Publish options',
      'section.readme': 'README preview',
      'section.preflight': 'Preflight and publish',
      'section.progress': 'Publish progress',
      'section.result': 'Publish result',
      'section.advanced': 'Advanced options',

      'field.owner': 'Owner',
      'field.ownerHint': 'GitHub login (not your display name) or an organization login; for a personal account use your @username',
      'field.ownerPlaceholder': 'octocat',
      'field.ownerRequired': 'Owner is required',
      'field.ownerInvalid': 'Owner may contain letters, digits and hyphens only',
      'field.name': 'Repository name',
      'field.nameHint': 'Letters, digits, dots, underscores and hyphens; at most 100 characters',
      'field.namePlaceholder': 'my-plugin',
      'field.nameRequired': 'Repository name is required',
      'field.nameInvalid': 'Repository name may contain letters, digits, dots, underscores and hyphens only',
      'field.description': 'English description',
      'field.descriptionHint': 'GitHub repository description, at most 350 characters',
      'field.descriptionPlaceholder': 'One sentence about what this plugin does',
      'field.descriptionTooLong': 'Description is limited to 350 characters, currently {n}',
      'field.descriptionZh': 'Chinese summary',
      'field.descriptionZhPlaceholder': 'Chinese summary (optional, written into the README)',
      'field.homepage': 'Homepage URL',
      'field.homepagePlaceholder': 'https://example.com/my-plugin',
      'field.topics': 'Topics',
      'field.topicsHint': 'Lowercase letters, digits, - and _; at most 10',
      'field.topicPlaceholder': 'Type a topic and press Enter',
      'field.topicsEmpty': 'No topics yet',
      'field.topicsTooMany': 'At most 10 topics',
      'field.topicsInvalid': 'Topics may contain lowercase letters, digits, - and _ (max 50 characters)',
      'field.visibility': 'Visibility',
      'field.public': 'Public',
      'field.private': 'Private',
      'field.license': 'License',
      'field.licenseNone': 'No license',
      'field.branch': 'Target branch',
      'field.branchRequired': 'Target branch is required',
      'field.tagPrefix': 'Tag prefix',
      'field.tagPrefixInvalid': 'Tag prefix may contain letters, digits, dots, underscores and hyphens only',
      'field.commitMessage': 'Commit message',
      'field.commitHint': '{name} and {version} placeholders are supported',
      'field.authorName': 'Commit author name',
      'field.authorEmail': 'Commit author email',
      'field.repoStrategy': 'When the repository exists',
      'field.repoReuse': 'Reuse the existing repository',
      'field.repoError': 'Stop with an error',
      'field.releaseNotes': 'Release notes',
      'field.releaseNotesPlaceholder': 'Leave empty to generate automatically',
      'field.readmeMode': 'README mode',
      'field.readmeModeHint': '"Append changelog" is recommended: it only adds this release\'s changes at the end, leaving every existing byte untouched',
      'field.readmeAuto': 'Generate only when missing',
      'field.readmeAppend': 'Append changelog',
      'field.readmeRegenerate': 'Regenerate and overwrite',

      'form.preflight': 'Preflight',
      'form.preflighting': 'Prefighting…',
      'form.publish': 'Publish now',
      'form.publishTo': 'Publish to {targets}',
      'form.publishing': 'Publishing…',
      'form.retryPlatforms': 'Retry failed platforms',
      'form.platformsHint': 'Tick the target platforms: this single button runs every platform in turn.',
      'form.republish': 'Publish again',
      'form.retryPublish': 'Retry publish',
      'form.stale': 'Publish details changed — run the preflight again',
      'ai.button': 'AI fill',
      'ai.busy': 'Generating…',
      'ai.hint': 'Use the DeepSeek model configured in DSH to draft the English description, Chinese summary, topics and release notes from package.json / README. These fields are overwritten and stay editable before publishing.',
      'ai.applied': 'Draft generated with {model} — review it, then run the preflight',
      'ai.failed': 'AI fill failed',
      'ai.empty': 'The model returned no usable release metadata',
      'ai.failedToast': 'AI fill failed: {message}',
      'form.blocked': 'Preflight has failures — fix them before publishing',
      'form.notPreflighted': 'Not preflighted yet: a preflight runs automatically before publishing',
      'form.needRecheck': 'Recheck needed',

      'option.addReadme': 'Generate README',
      'option.addLicense': 'Generate LICENSE',
      'option.addGitignore': 'Generate .gitignore',
      'option.updatePackageJson': 'Complete package.json',
      'option.createRelease': 'Create GitHub Release',
      'option.dryRun': 'Dry run',
      'option.dryRunHint': 'Prepare locally and commit only: no repo creation, push or Release',
      'option.forceWithLease': 'Use --force-with-lease when the push is rejected',
      'option.forceWithLeaseHint': 'Only for rewritten remote branches; may overwrite history',
      'option.advancedShow': 'Show advanced options',
      'option.advancedHide': 'Hide advanced options',

      'preflight.title': 'Preflight',
      'preflight.run': 'Run preflight',
      'preflight.rerun': 'Run preflight again',
      'preflight.running': 'Running preflight…',
      'preflight.notRun': 'No preflight result yet',
      'preflight.notRunHint': 'Press Preflight to check git, token, paths, repository name and the files to be written. Preflight never writes to disk.',
      'preflight.passed': 'Preflight passed — ready to publish',
      'preflight.warned': 'Preflight passed with {n} warning(s)',
      'preflight.blocked': 'Preflight failed: {n} blocking issue(s)',
      'preflight.blockingLabel': 'Blocking issues',
      'preflight.checkPass': 'Pass',
      'preflight.checkWarn': 'Warning',
      'preflight.checkFail': 'Fail',
      'preflight.fix': 'Fix',
      'preflight.fixSettings': 'Open settings',
      'preflight.fixBump': 'Raise version',
      'preflight.fixBumpTo': 'Raise to {version}',
      'preflight.fixConfirmAuthor': 'Confirm ownership',
      'preflight.ownership': 'Plugin ownership',
      'preflight.ownershipStatus.own': 'Matches your account',
      'preflight.ownershipStatus.fork': 'Author differs · the target repo is yours',
      'preflight.ownershipStatus.foreign': 'Author and account disagree',
      'preflight.ownershipStatus.none': 'No author declared',
      'preflight.ownershipAuthor': 'Declared author',
      'preflight.ownershipAccount': 'Signed-in GitHub account',
      'preflight.ownershipNoAccount': '(not connected)',
      'preflight.ownershipRepo': 'Target repo owner',
      'preflight.ownershipNpmScope': 'npm scope',
      'preflight.ownershipConfirm': 'I confirm this is my plugin (the author field names the original project or a fork)',
      'preflight.ownershipConfirmHint': 'Ticking this publishes normally and records the confirmation. Leaving it unticked does not block publishing.',
      'preflight.ownershipRecallHint': 'This tick is remembered per plugin (kept in that plugin\'s draft). If package.json later names a different author, the remembered confirmation expires and has to be given again.',
      'preflight.ownershipConfirmedRemembered': '(confirmation remembered for this plugin)',
      'preflight.ownershipForget': 'Withdraw this confirmation',
      'preflight.ownershipConfirmedNote': 'This publish is recorded as "ownership confirmed by operator"',
      'preflight.plan': 'Publish plan',
      'preflight.files': 'Files to write',
      'preflight.filesCount': '{n} file(s) to write',
      'preflight.fileCreate': 'create',
      'preflight.fileUpdate': 'update',
      'preflight.fileAppend': 'append',
      'preflight.fileKeep': 'keep',
      'preflight.fileBytes': '{n} B',
      'preflight.planOwner': 'Owner',
      'preflight.planRepo': 'Repository',
      'preflight.planBranch': 'Branch',
      'preflight.planVisibility': 'Visibility',
      'preflight.planTag': 'Tag',
      'preflight.planRelease': 'Release',
      'preflight.planRemote': 'Remote',
      'preflight.planCreate': 'A new repository will be created',
      'preflight.planReuse': 'The existing repository will be reused',
      'preflight.planReleaseOn': 'create',
      'preflight.planReleaseOff': 'skip',
      'preflight.planDryRun': 'dry run (no push)',
      'preflight.warnings': 'Warnings',
      'preflight.packageChanges': 'package.json changes',
      'preflight.showContent': 'Show content',
      'preflight.hideContent': 'Hide content',
      'preflight.readmeMissing': 'The preflight result has no README content',
      'preflight.staleHint': 'Key fields changed: the preflight result may be stale, run it again.',
      'preflight.needToken': 'Connect a GitHub account before publishing',
      'preflight.needAccountOrDryRun': 'Connect a GitHub account, or enable dry run in the publish options',

      'readme.title': 'README preview',
      'readme.hint': 'Run the preflight to preview the README that will be written',
      'readme.empty': 'No README content yet: run the preflight first',
      'readme.copy': 'Copy README',
      'readme.chars': '{n} characters',
      'readme.actionCreate': 'README will be created',
      'readme.actionUpdate': 'README will be updated',
      'readme.actionKeep': 'Existing README will be kept',

      'progress.title': 'Publish progress',
      'progress.cancel': 'Cancel publish',
      'progress.cancelling': 'Cancelling…',
      'progress.logs': 'Logs',
      'progress.noLogs': 'Waiting for logs…',
      'progress.elapsed': 'Elapsed {text}',
      'progress.done': 'Done',
      'progress.running': 'Running',
      'progress.pending': 'Pending',
      'progress.skipped': 'Skipped',
      'progress.failed': 'Failed',
      'progress.cancelled': 'Cancelled',
      'progress.waiting': 'Waiting to publish',

      'step.auth': 'Validate account',
      'step.inspect': 'Inspect plugin',
      'step.prepare': 'Prepare files',
      'step.repo': 'Create repository',
      'step.topics': 'Set topics',
      'step.commit': 'Commit changes',
      'step.push': 'Push code',
      'step.release': 'Create Release',
      'step.npmAuth': 'Validate npm credentials',
      'step.npmGuard': 'Version guard',
      'step.npmPublish': 'npm publish',
      'step.npmVerify': 'Verify on registry',
      'step.finish': 'Finish',

      'result.successTitle': 'Published successfully',
      'result.partialTitle': 'Some platforms finished',
      'result.hostsTitle': 'Per-platform result',
      'result.hostsCount': '{ok}/{total} succeeded',
      'result.hostSucceeded': 'done',
      'result.hostFailed': 'failed',
      'result.hostSkipped': 'skipped',
      'result.hostPartial': 'partial',
      'result.dryRunTitle': 'Dry run finished',
      'result.failedTitle': 'Publish failed',
      'result.cancelledTitle': 'Publish cancelled',
      'result.repo': 'Repository',
      'result.release': 'Release',
      'result.commit': 'Commit',
      'result.tag': 'Tag',
      'result.branch': 'Branch',
      'result.duration': 'Duration',
      'result.files': 'Written files',
      'result.created': 'Repository created',
      'result.pushed': 'Pushed',
      'result.noRelease': 'No Release created',
      'result.again': 'Publish again',
      'result.dryRunNote': 'Dry run: no repository, push or Release was created',
      'result.filesWritten': '{n} file(s)',
      'result.openRepo': 'Open repository',
      'result.copyCommit': 'Copy commit SHA',
      'result.errorCode': 'Error code',

      'settings.title': 'Settings',
      'settings.account': 'GitHub account',
      'settings.accountHint': 'The token stays in the local Host config (0600) and never appears in API responses, job logs or git output.',
      'settings.saveToken': 'Save and validate',
      'settings.clearToken': 'Clear token',
      'settings.detectToken': 'Auto-detect',
      'settings.tokenSaved': 'Token validated and saved',
      'settings.tokenRemoved': 'Token cleared',
      'settings.tokenDetected': 'A usable token was detected',
      'settings.tokenNotDetected': 'No usable token was detected',
      'settings.enterprise': 'GitHub Enterprise',
      'settings.apiBase': 'API base (apiBase)',
      'settings.gitBase': 'Web base (gitBase)',
      'settings.enterpriseHint': 'Keep the defaults for public GitHub; for Enterprise use https://ghe.example.com/api/v3 and https://ghe.example.com',
      'settings.baseInvalid': 'apiBase / gitBase must be https://, or http:// only for a private host (127.0.0.1 / RFC1918 / .local / .internal / single-label)',
      'settings.scanRoots': 'Scan roots',
      'settings.scanRootsHint': 'Extra absolute directories to scan; saved roots are deduplicated and checked for existence.',
      'settings.scanRootPlaceholder': '/absolute/path/to/plugins',
      'settings.scanRootInvalid': 'Enter an existing absolute path',
      'settings.scanRootAdd': 'Add directory',
      'settings.defaults': 'Default publish options',
      'settings.defaultsHint': 'Initial form values for new plugins; a plugin draft overrides these defaults.',
      'settings.topicPreset': 'Default topics',
      'settings.autoDetectToken': 'Auto-detect a local token (environment / gh CLI / git credential)',
      'settings.danger': 'Danger zone',
      'settings.clearHistory': 'Clear publish history',
      'settings.clearHistoryConfirm': 'Clear the whole publish history? This cannot be undone.',
      'settings.clearHistoryYes': 'Clear it',
      'settings.clearHistoryNo': 'Cancel',
      'settings.saved': 'Settings saved',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.sectionAccount': 'Account',
      'settings.sectionEnterprise': 'Enterprise',
      'settings.sectionScan': 'Scan roots',
      'settings.sectionDefaults': 'Defaults',
      'settings.sectionHelp': 'Help & links',
      'settings.sectionDanger': 'Danger zone',
      'settings.validatedAt': 'Validated at',
      'settings.noAccount': 'No GitHub account connected',
      'settings.persisted': 'Persisted to the config file',
      'settings.notPersisted': 'In memory only',
      'settings.sourceConfig': 'Config file',
      'settings.sourceMemory': 'Memory',
      'settings.sourceEnv': 'Environment',
      'settings.sourceGhCli': 'gh CLI',
      'settings.sourceGitCredential': 'git credential',
      'settings.accountStatus': 'Account status',
      'settings.tokenType': 'PAT type',
      'settings.inlineError': 'The operation failed',

      'error.loadState': 'Failed to load the page state',
      'error.scan': 'Failed to scan local plugins',
      'error.preflight': 'Preflight failed',
      'error.publish': 'Publish failed',
      'error.cancel': 'Failed to cancel the publish',
      'error.settings': 'Failed to save settings',
      'error.token': 'Token validation failed',
      'error.draft': 'Failed to save the draft',
      'error.copy': 'Copy failed',
      'error.network': 'Network request failed — check that the DSH Web server is still running',
      'error.timeout': 'Request timed out: the Host may be busy or unresponsive',
      'error.notMounted': 'Host route unavailable: the dsh-github-publisher plugin may be disabled or not loaded',
      'error.http': 'The Host returned HTTP {status}',
      'error.badResponse': 'The Host returned an unreadable response',
      'error.unauthorized': 'Page token validation failed and a fresh token was requested; reload the page if it keeps failing',
      'error.noToken': 'Could not obtain a token from the Host: reload the page or check that the plugin is enabled',
      'error.tokenRelated': 'Token related error — update the PAT in Settings',
      'error.goSettings': 'Open settings',
      'error.preflightBlocked': 'Preflight has blocking issues; publishing is not possible',
      'error.crashed': 'The Multi-Forge Publisher page crashed',
      'error.crashedHint': 'The rest of the app is unaffected; reload the page to recover. Publish data lives on the Host.',
      'error.reload': 'Reload',
      'error.detail': 'Details',
      'error.retry': 'Retry',
      'error.jobRunning': 'A publish job is already running; attached to it',
      'error.pickPlugin': 'Select a plugin on the left first',
      'error.noPlugins': 'No plugin available to publish',

      'toast.saved': 'Saved',
      'toast.scanned': 'Found {n} plugin(s)',
      'toast.tokenSaved': 'Token validated',
      'toast.tokenCleared': 'Token cleared',
      'toast.settingsSaved': 'Settings saved',
      'toast.historyCleared': 'Publish history cleared',
      'toast.cancelled': 'Cancelling the publish…',
      'toast.copied': 'Copied',
      'toast.publishStarted': 'Publishing {name}',
      'toast.publishSucceeded': '{owner}/{repo} published successfully',
      'toast.publishPartial': 'Partly finished: {ok}/{total} repository hostings published — see the result card',
      'toast.publishFailed': 'Publish failed: {message}',
      'toast.publishCancelled': 'Publish cancelled',
      'toast.draftSaved': 'Draft saved',

      'time.justNow': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',
      'time.seconds': '{n}s',
      'time.minutesSeconds': '{m}m {s}s',
      'time.hoursMinutes': '{h}h {m}m',

      'empty.title': 'No plugin selected',
      'empty.body': 'Pick a local DSH plugin on the left, tick the target platforms, then publish to GitHub / npm in one click.',
      'empty.scan': 'Scan local plugins',
      'empty.hint': 'A plugin must declare dsh.bundle or dsh.client in package.json.',
    }
    // ── locale plumbing ──────────────────────────────────────────────────
    let localeService = null
    let boundTranslate = null

    function wireLocale(service, boundCandidate) {
      localeService = service || null
      let bound = typeof boundCandidate === 'function' ? boundCandidate : null
      if (bound === null && localeService && typeof localeService.bind === 'function') {
        try {
          bound = localeService.bind(NS)
        } catch (error) {
          bound = null
        }
      }
      boundTranslate = typeof bound === 'function' ? bound : null
    }

    function fallbackDictionary() {
      let language = ''
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          language = String(document.documentElement.lang || '')
        }
      } catch (error) {
        language = ''
      }
      return language.toLowerCase().indexOf('en') === 0 ? en : zh
    }

    function interpolate(text, params) {
      if (!params || typeof params !== 'object') return text
      return String(text).replace(/\{(\w+)\}/g, function replaceToken(match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      })
    }

    /** Translate a dictionary key, interpolating `{name}` placeholders. */
    function t(key, params) {
      let text = null
      if (boundTranslate !== null) {
        try {
          text = boundTranslate(key)
        } catch (error) {
          text = null
        }
      }
      if (typeof text !== 'string' || text === '') {
        const dictionary = fallbackDictionary()
        text = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key
      }
      return interpolate(text, params)
    }

    /** Re-render when the shell's locale changes. */
    function useLocaleTick() {
      const state = useState(0)
      const setTick = state[1]
      useEffect(function subscribeLocale() {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        const dispose = localeService.subscribe(function onLocaleChange() {
          setTick(function bump(value) {
            return value + 1
          })
        })
        return typeof dispose === 'function' ? dispose : undefined
      }, [])
      return state[0]
    }

    // ── safe browser storage ──────────────────────────────────────────────
    function readStorage(key) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return null
        const value = localStorage.getItem(key)
        return typeof value === 'string' ? value : null
      } catch (error) {
        return null
      }
    }

    function writeStorage(key, value) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return
        localStorage.setItem(key, String(value))
      } catch (error) {
        /* storage is optional: ignore quota / privacy failures */
      }
    }

    // ── error model ──────────────────────────────────────────────────────
    const TOKEN_ERROR_CODES = ['unauthorized', 'invalid-token', 'insufficient-scope']

    function makeError(code, message, extra) {
      const details = extra && typeof extra === 'object' ? extra : {}
      return {
        name: 'PublisherError',
        code: typeof code === 'string' && code !== '' ? code : 'internal',
        message: typeof message === 'string' && message !== '' ? message : t('error.http', { status: details.status || 0 }),
        status: typeof details.status === 'number' ? details.status : 0,
        tokenRelated: details.tokenRelated === true,
        details: details.details && typeof details.details === 'object' ? details.details : null,
      }
    }

    function isTokenError(error) {
      if (!error) return false
      if (error.tokenRelated === true) return true
      return TOKEN_ERROR_CODES.indexOf(String(error.code || '')) >= 0
    }

    function errorMessageOf(error, fallbackKey) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return t(fallbackKey || 'error.network')
    }

    // ── formatting helpers ───────────────────────────────────────────────
    function toText(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      return String(value)
    }

    function toBool(value, fallback) {
      if (value === true || value === false) return value
      return fallback === true
    }

    function toNumber(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }

    function toStringList(value) {
      if (!Array.isArray(value)) return []
      const out = []
      for (let index = 0; index < value.length; index += 1) {
        const item = toText(value[index]).trim()
        if (item !== '' && out.indexOf(item) < 0) out.push(item)
      }
      return out
    }

    function pickId(value, ids, fallback) {
      const text = toText(value)
      return ids.indexOf(text) >= 0 ? text : fallback
    }

    function clampText(text, max) {
      const value = toText(text)
      if (value.length <= max) return value
      return value.slice(0, Math.max(0, max - 1)) + '…'
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && isFinite(bytes) ? bytes : Number(bytes)
      if (!isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return Math.round(value) + ' B'
      const kb = value / 1024
      if (kb < 1024) return (kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)) + ' KB'
      const mb = kb / 1024
      return (mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)) + ' MB'
    }

    function formatDuration(ms) {
      const value = typeof ms === 'number' && isFinite(ms) && ms > 0 ? ms : 0
      const seconds = Math.max(0, Math.round(value / 1000))
      if (seconds < 60) return t('time.seconds', { n: seconds })
      if (seconds < 3600) return t('time.minutesSeconds', { m: Math.floor(seconds / 60), s: seconds % 60 })
      return t('time.hoursMinutes', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) })
    }

    function formatRelativeTime(timestamp, now) {
      const value = typeof timestamp === 'number' && isFinite(timestamp) ? timestamp : 0
      if (value <= 0) return ''
      const current = typeof now === 'number' && isFinite(now) ? now : Date.now()
      const diff = Math.max(0, current - value)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      return t('time.days', { n: Math.floor(hours / 24) })
    }

    function basename(target) {
      const value = toText(target).replace(/[\\/]+$/, '')
      if (value === '') return ''
      const parts = value.split(/[\\/]/)
      return parts[parts.length - 1] || value
    }

    function shortSha(sha) {
      const value = toText(sha)
      return value.length > 8 ? value.slice(0, 7) : value
    }

    function validateTopicText(topic) {
      return /^[a-z0-9][a-z0-9_-]{0,49}$/.test(topic)
    }

    function sanitizeTopics(value) {
      const list = toStringList(value)
      const out = []
      for (let index = 0; index < list.length && out.length < TOPIC_MAX; index += 1) {
        const topic = list[index].toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, TOPIC_MAX_LEN)
        if (topic !== '' && out.indexOf(topic) < 0) out.push(topic)
      }
      return out
    }

    // ── data normalizers (CONTRACT §3.2, §4.2–§4.6) ─────────────────────
    function normalizeDefaults(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        visibility: pickId(source.visibility, VISIBILITY_IDS, BASE_DEFAULTS.visibility),
        license: pickId(source.license, LICENSE_IDS, BASE_DEFAULTS.license),
        branch: toText(source.branch) !== '' ? toText(source.branch).trim() : BASE_DEFAULTS.branch,
        tagPrefix: source.tagPrefix === undefined ? BASE_DEFAULTS.tagPrefix : toText(source.tagPrefix),
        createRelease: toBool(source.createRelease, BASE_DEFAULTS.createRelease),
        addReadme: toBool(source.addReadme, BASE_DEFAULTS.addReadme),
        readmeMode: pickId(source.readmeMode, README_MODE_IDS, BASE_DEFAULTS.readmeMode),
        addLicense: toBool(source.addLicense, BASE_DEFAULTS.addLicense),
        addGitignore: toBool(source.addGitignore, BASE_DEFAULTS.addGitignore),
        updatePackageJson: toBool(source.updatePackageJson, BASE_DEFAULTS.updatePackageJson),
        commitMessage: toText(source.commitMessage) !== '' ? toText(source.commitMessage) : BASE_DEFAULTS.commitMessage,
        authorName: toText(source.authorName),
        authorEmail: toText(source.authorEmail),
        apiBase: toText(source.apiBase) !== '' ? toText(source.apiBase) : BASE_DEFAULTS.apiBase,
        gitBase: toText(source.gitBase) !== '' ? toText(source.gitBase) : BASE_DEFAULTS.gitBase,
        repoExistsStrategy: pickId(source.repoExistsStrategy, REPO_STRATEGY_IDS, BASE_DEFAULTS.repoExistsStrategy),
        topicPreset: Array.isArray(source.topicPreset) ? sanitizeTopics(source.topicPreset) : BASE_DEFAULTS.topicPreset.slice(),
        platforms: source.platforms === undefined ? BASE_DEFAULTS.platforms.slice() : sanitizePlatformSelection(source.platforms),
        npmAccess: pickId(source.npmAccess, NPM_ACCESS_IDS, BASE_DEFAULTS.npmAccess),
        npmDistTag: toText(source.npmDistTag) !== '' ? toText(source.npmDistTag) : BASE_DEFAULTS.npmDistTag,
      }
    }

    /** Keep only known platform ids, de-duplicated, in registry order. */
    function sanitizePlatformSelection(value) {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
      const known = list.map(toText).filter(function keep(id) { return PLATFORM_IDS.indexOf(id) >= 0 })
      const unique = []
      for (let index = 0; index < PLATFORM_IDS.length; index += 1) {
        if (known.indexOf(PLATFORM_IDS[index]) >= 0) unique.push(PLATFORM_IDS[index])
      }
      return unique
    }

    /** One platform descriptor as returned by GET /api/state (token-free). */
    function normalizePlatformEntry(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = toText(raw.id)
      if (PLATFORM_IDS.indexOf(id) < 0) return null
      const meta = PLATFORM_META[id]
      const config = raw.config && typeof raw.config === 'object' ? raw.config : {}
      const fields = Array.isArray(raw.fields) ? raw.fields.filter(function keep(field) {
        return field && typeof field === 'object' && toText(field.key) !== ''
      }).map(function mapField(field) {
        return {
          key: toText(field.key),
          type: toText(field.type) || 'text',
          label: toText(field.label),
          hint: toText(field.hint),
          secret: field.secret === true,
          optional: field.optional === true,
          options: Array.isArray(field.options) ? field.options.map(toText) : [],
          placeholder: toText(field.placeholder),
        }
      }) : []
      return {
        id: id,
        label: toText(raw.label) || meta.label,
        short: toText(raw.short) || meta.short,
        kind: toText(raw.kind) || 'release',
        order: toNumber(raw.order) || 0,
        description: toText(raw.description),
        // Whether this hosting has a topics feature at all. Gitee does not, and
        // the card says so instead of letting the publish step surprise the user.
        // Defaults to true so a Host that predates the field keeps working.
        topicsSupported: raw.topicsSupported !== false,
        fields: fields,
        enabled: config.enabled === true,
        registry: toText(config.registry),
        access: pickId(config.access, NPM_ACCESS_IDS, 'public'),
        distTag: toText(config.distTag) || 'latest',
        provenance: config.provenance === true,
        publishName: toText(config.publishName),
        tokenConfigured: config.tokenConfigured === true,
        tokenHint: toText(config.tokenHint) !== '' ? toText(config.tokenHint) : null,
        tokenAvailable: config.tokenAvailable === true,
        tokenSource: toText(config.tokenSource) !== '' ? toText(config.tokenSource) : null,
        account: config.account && typeof config.account === 'object' ? { login: toText(config.account.login) } : null,
      }
    }

    function normalizePlatforms(raw) {
      const list = Array.isArray(raw) ? raw : []
      return list.map(normalizePlatformEntry).filter(Boolean).sort(function byOrder(left, right) {
        return left.order - right.order
      })
    }

    /** One row of the cross-platform version matrix. */
    function normalizeSyncRow(raw) {
      if (!raw || typeof raw !== 'object') return null
      const platform = toText(raw.platform)
      if (platform === '') return null
      const meta = PLATFORM_META[platform]
      return {
        platform: platform,
        label: toText(raw.label) || (meta ? meta.label : platform),
        local: toText(raw.local),
        remote: toText(raw.remote) !== '' ? toText(raw.remote) : null,
        url: toText(raw.url),
        state: SYNC_STATES.indexOf(toText(raw.state)) >= 0 ? toText(raw.state) : 'unknown',
        detail: toText(raw.detail),
      }
    }

    function normalizeSyncPlan(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        path: toText(raw.path),
        name: toText(raw.name),
        version: toText(raw.version),
        platforms: Array.isArray(raw.platforms) ? raw.platforms.map(normalizeSyncRow).filter(Boolean) : [],
        behind: Array.isArray(raw.behind) ? raw.behind.map(toText).filter(Boolean) : [],
        occupied: Array.isArray(raw.occupied) ? raw.occupied.map(toText).filter(Boolean) : [],
        belowLatest: Array.isArray(raw.belowLatest) ? raw.belowLatest.map(toText).filter(Boolean) : [],
        inSync: Array.isArray(raw.inSync) ? raw.inSync.map(toText).filter(Boolean) : [],
        needsBump: raw.needsBump === true,
        bumpSuggestion: toText(raw.bumpSuggestion) !== '' ? toText(raw.bumpSuggestion) : null,
        checkedAt: toNumber(raw.checkedAt) || 0,
      }
    }

    function syncStateKey(state) {
      if (state === 'in-sync') return 'sync.stateInSync'
      if (state === 'behind') return 'sync.stateBehind'
      if (state === 'absent') return 'sync.stateAbsent'
      if (state === 'ahead') return 'sync.stateAhead'
      return 'sync.stateUnknown'
    }

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        defaults: normalizeDefaults(source.defaults),
        scanRoots: toStringList(source.scanRoots),
        autoDetectToken: toBool(source.autoDetectToken, true),
      }
    }

    function normalizeAccount(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        connected: source.connected === true,
        validated: source.validated === true,
        login: toText(source.login),
        name: toText(source.name),
        avatarUrl: toText(source.avatarUrl),
        htmlUrl: toText(source.htmlUrl),
        tokenSource: toText(source.tokenSource),
        persisted: source.persisted === true,
        tokenHint: toText(source.tokenHint),
        scopes: toStringList(source.scopes),
        isFineGrained: source.isFineGrained === true,
        validatedAt: toNumber(source.validatedAt),
        apiBase: toText(source.apiBase) !== '' ? toText(source.apiBase) : BASE_DEFAULTS.apiBase,
      }
    }

    function normalizePlugin(raw) {
      if (!raw || typeof raw !== 'object' || toText(raw.path) === '') return null
      const source = raw
      return {
        path: toText(source.path),
        realPath: toText(source.realPath) !== '' ? toText(source.realPath) : toText(source.path),
        name: toText(source.name) !== '' ? toText(source.name) : basename(source.path),
        displayName: toText(source.displayName) !== '' ? toText(source.displayName) : toText(source.name),
        version: toText(source.version),
        description: toText(source.description),
        descriptionZh: toText(source.descriptionZh),
        license: toText(source.license),
        author: toText(source.author),
        authorName: toText(source.authorName),
        authorEmail: toText(source.authorEmail),
        authorUrl: toText(source.authorUrl),
        repositoryOwner: toText(source.repositoryOwner),
        keywords: toStringList(source.keywords),
        homepage: toText(source.homepage),
        repository: source.repository && typeof source.repository === 'object' ? source.repository : null,
        iconPath: source.iconPath ? toText(source.iconPath) : null,
        hasReadme: source.hasReadme === true,
        readmeFile: toText(source.readmeFile),
        hasLicense: source.hasLicense === true,
        licenseFile: toText(source.licenseFile),
        hasGit: source.hasGit === true,
        hasCommits: source.hasCommits === true,
        branch: toText(source.branch),
        remote: source.remote && typeof source.remote === 'object' ? source.remote : null,
        gitStatus: source.gitStatus && typeof source.gitStatus === 'object' ? source.gitStatus : null,
        sizeBytes: toNumber(source.sizeBytes),
        fileCount: toNumber(source.fileCount),
        suggested: source.suggested && typeof source.suggested === 'object' ? source.suggested : {},
        sources: toStringList(source.sources),
        published: source.published && typeof source.published === 'object' ? source.published : null,
        remoteStatus: source.remoteStatus && typeof source.remoteStatus === 'object' ? source.remoteStatus : null,
        errors: toStringList(source.errors),
      }
    }

    function normalizePlugins(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let index = 0; index < raw.length; index += 1) {
        const plugin = normalizePlugin(raw[index])
        if (plugin !== null) out.push(plugin)
      }
      return out
    }

    function normalizeHistoryEntry(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        id: toText(raw.id),
        at: toNumber(raw.at) || 0,
        path: toText(raw.path),
        name: toText(raw.name),
        owner: toText(raw.owner),
        repo: toText(raw.repo),
        repoUrl: toText(raw.repoUrl),
        releaseUrl: toText(raw.releaseUrl),
        version: toText(raw.version),
        commitSha: toText(raw.commitSha),
        tag: toText(raw.tag),
        status: ['succeeded', 'failed', 'cancelled'].indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'failed',
        dryRun: raw.dryRun === true,
        files: toStringList(raw.files),
        error: raw.error && typeof raw.error === 'object' ? raw.error : null,
      }
    }

    function normalizeHistory(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (let index = 0; index < raw.length && out.length < 50; index += 1) {
        const entry = normalizeHistoryEntry(raw[index])
        if (entry !== null) out.push(entry)
      }
      return out
    }

    function normalizeDrafts(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const out = {}
      const keys = Object.keys(source)
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        const value = source[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = value
      }
      return out
    }

    // `partial` is a real terminal state: at least one hosting succeeded and at
    // least one did not. Omitting it here made the panel treat a finished
    // multi-host publish as still running.
    const JOB_STATUSES = ['running', 'succeeded', 'partial', 'failed', 'cancelled']
    const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']
    const LOG_LEVELS = ['info', 'success', 'warn', 'error']

    function normalizeJobStep(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = toText(raw.id)
      if (id === '') return null
      return {
        id: id,
        status: STEP_STATUSES.indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'pending',
        startedAt: toNumber(raw.startedAt),
        endedAt: toNumber(raw.endedAt),
        detail: raw.detail === null || raw.detail === undefined ? null : toText(raw.detail),
        error: raw.error === null || raw.error === undefined ? null : toText(raw.error),
      }
    }

    function normalizeJobLog(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        at: toNumber(raw.at) || 0,
        level: LOG_LEVELS.indexOf(toText(raw.level)) >= 0 ? toText(raw.level) : 'info',
        step: toText(raw.step),
        text: clampText(raw.text, 2000),
      }
    }

    function normalizeResult(raw) {
      if (!raw || typeof raw !== 'object') return null
      const files = Array.isArray(raw.files)
        ? raw.files.map(function mapFile(file) {
            if (!file || typeof file !== 'object') return null
            return { file: toText(file.file), action: toText(file.action), bytes: toNumber(file.bytes) }
          }).filter(Boolean)
        : []
      const perPlatform = raw.perPlatform && typeof raw.perPlatform === 'object' ? raw.perPlatform : {}
      // Per-hosting outcome table. This is what lets the result card say
      // "GitHub ✓ / Gitee ✓ / Codeberg ✗" instead of one aggregate verdict that
      // hides which remote actually got the code.
      const hosts = Array.isArray(raw.hosts)
        ? raw.hosts.map(function mapHost(entry) {
            if (!entry || typeof entry !== 'object') return null
            const stepsRaw = entry.steps && typeof entry.steps === 'object' ? entry.steps : {}
            return {
              id: toText(entry.id),
              label: toText(entry.label) || toText(entry.id),
              status: ['succeeded', 'partial', 'failed', 'skipped'].indexOf(toText(entry.status)) >= 0 ? toText(entry.status) : 'failed',
              repoUrl: toText(entry.repoUrl),
              releaseUrl: toText(entry.releaseUrl),
              tag: toText(entry.tag),
              createdRepo: entry.createdRepo === true,
              pushed: entry.pushed === true,
              error: toText(entry.error),
              code: toText(entry.code),
              steps: {
                repo: toText(stepsRaw.repo) || 'pending',
                push: toText(stepsRaw.push) || 'pending',
                release: toText(stepsRaw.release) || 'pending',
              },
            }
          }).filter(Boolean)
        : []
      return {
        platforms: Array.isArray(raw.platforms) ? raw.platforms.map(toText).filter(Boolean) : [],
        platformsLabel: toText(raw.platformsLabel),
        owner: toText(raw.owner),
        repo: toText(raw.repo),
        repoUrl: toText(raw.repoUrl),
        branch: toText(raw.branch),
        commitSha: toText(raw.commitSha),
        tag: toText(raw.tag),
        releaseUrl: toText(raw.releaseUrl),
        createdRepo: raw.createdRepo === true,
        pushed: raw.pushed === true,
        dryRun: raw.dryRun === true,
        files: files,
        hosts: hosts,
        hostedOk: toNumber(raw.hostedOk),
        hostedFailed: toNumber(raw.hostedFailed),
        npm: normalizeNpmResult(raw.npm),
        github: perPlatform.github && typeof perPlatform.github === 'object'
          ? { status: toText(perPlatform.github.status), repoUrl: toText(perPlatform.github.repoUrl), releaseUrl: toText(perPlatform.github.releaseUrl) }
          : null,
      }
    }

    /** One platform's npm outcome (published version, URL, dry-run flag). */
    function normalizeNpmResult(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        status: STEP_STATUSES.indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : toText(raw.status),
        name: toText(raw.name),
        version: toText(raw.version),
        access: toText(raw.access),
        distTag: toText(raw.distTag),
        registry: toText(raw.registry),
        previousVersion: toText(raw.previousVersion) !== '' ? toText(raw.previousVersion) : null,
        published: raw.published === true,
        url: toText(raw.url),
      }
    }

    function normalizeJob(raw) {
      if (!raw || typeof raw !== 'object') return null
      const steps = Array.isArray(raw.steps) ? raw.steps.map(normalizeJobStep).filter(Boolean) : []
      const logs = Array.isArray(raw.logs) ? raw.logs.map(normalizeJobLog).filter(Boolean).slice(-400) : []
      let jobError = null
      if (raw.error && typeof raw.error === 'object') {
        jobError = {
          code: toText(raw.error.code) !== '' ? toText(raw.error.code) : 'internal',
          message: toText(raw.error.message),
          step: toText(raw.error.step),
        }
      }
      const platformResults = raw.platformResults && typeof raw.platformResults === 'object' ? raw.platformResults : {}
      return {
        jobId: toText(raw.jobId),
        status: JOB_STATUSES.indexOf(toText(raw.status)) >= 0 ? toText(raw.status) : 'running',
        path: toText(raw.path),
        pluginName: toText(raw.pluginName),
        platforms: Array.isArray(raw.platforms) ? raw.platforms.map(toText).filter(Boolean) : [],
        step: toText(raw.step),
        startedAt: toNumber(raw.startedAt),
        endedAt: toNumber(raw.endedAt),
        steps: steps,
        logs: logs,
        result: normalizeResult(raw.result),
        platformResults: {
          github: platformResults.github && typeof platformResults.github === 'object' ? platformResults.github : null,
          npm: normalizeNpmResult(platformResults.npm),
        },
        error: jobError,
      }
    }

    function isTerminalStatus(status) {
      // `partial` is final: some remotes succeeded, at least one did not. Treating
      // it as non-terminal would leave the panel polling forever.
      return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'cancelled'
    }

    function jobSteps(job) {
      if (job && Array.isArray(job.steps) && job.steps.length > 0) return job.steps
      return STEP_IDS.map(function makePending(id) {
        return { id: id, status: 'pending', startedAt: null, endedAt: null, detail: null, error: null }
      })
    }

    function stepLabel(stepId) {
      const key = STEP_LABEL_KEYS[stepId]
      return key ? t(key) : String(stepId || '')
    }

    function stepStatusKey(status) {
      if (status === 'done') return 'progress.done'
      if (status === 'running') return 'progress.running'
      if (status === 'failed') return 'progress.failed'
      if (status === 'skipped') return 'progress.skipped'
      if (status === 'cancelled') return 'progress.cancelled'
      return 'progress.pending'
    }

    function actionLabelKey(action) {
      if (action === 'create') return 'preflight.fileCreate'
      if (action === 'update') return 'preflight.fileUpdate'
      if (action === 'append-notes') return 'preflight.fileAppend'
      return 'preflight.fileKeep'
    }

    // ── form model (CONTRACT §4.3) ───────────────────────────────────────
    function normalizeForm(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const defaults = BASE_FORM
      return {
        owner: toText(source.owner === undefined ? defaults.owner : source.owner).trim(),
        name: toText(source.name === undefined ? defaults.name : source.name).trim(),
        description: toText(source.description === undefined ? defaults.description : source.description),
        descriptionZh: toText(source.descriptionZh === undefined ? defaults.descriptionZh : source.descriptionZh),
        homepage: toText(source.homepage === undefined ? defaults.homepage : source.homepage).trim(),
        topics: sanitizeTopics(source.topics === undefined ? defaults.topics : source.topics),
        visibility: pickId(source.visibility, VISIBILITY_IDS, defaults.visibility),
        license: pickId(source.license, LICENSE_IDS, defaults.license),
        branch: toText(source.branch === undefined ? defaults.branch : source.branch).trim(),
        tagPrefix: source.tagPrefix === undefined ? defaults.tagPrefix : toText(source.tagPrefix),
        commitMessage: toText(source.commitMessage) !== '' ? toText(source.commitMessage) : defaults.commitMessage,
        authorName: toText(source.authorName === undefined ? defaults.authorName : source.authorName),
        authorEmail: toText(source.authorEmail === undefined ? defaults.authorEmail : source.authorEmail),
        confirmForeignAuthor: source.confirmForeignAuthor === true,
        // `null` = no fingerprint recorded (a tick from an older draft); `''` =
        // explicitly withdrawn. Collapsing the two would make every fresh tick
        // look like a withdrawal.
        confirmForeignAuthorFor: source.confirmForeignAuthorFor === undefined || source.confirmForeignAuthorFor === null
          ? null
          : toText(source.confirmForeignAuthorFor),
        repoExistsStrategy: pickId(source.repoExistsStrategy, REPO_STRATEGY_IDS, defaults.repoExistsStrategy),
        addReadme: toBool(source.addReadme, defaults.addReadme),
        readmeMode: pickId(source.readmeMode, README_MODE_IDS, defaults.readmeMode),
        addLicense: toBool(source.addLicense, defaults.addLicense),
        addGitignore: toBool(source.addGitignore, defaults.addGitignore),
        updatePackageJson: toBool(source.updatePackageJson, defaults.updatePackageJson),
        createRelease: toBool(source.createRelease, defaults.createRelease),
        releaseNotes: toText(source.releaseNotes === undefined ? defaults.releaseNotes : source.releaseNotes),
        dryRun: toBool(source.dryRun, defaults.dryRun),
        forceWithLease: toBool(source.forceWithLease, defaults.forceWithLease),
        platforms: sanitizePlatformSelection(source.platforms === undefined ? defaults.platforms : source.platforms),
        npmAccess: pickId(source.npmAccess, NPM_ACCESS_IDS, defaults.npmAccess),
        npmDistTag: toText(source.npmDistTag) !== '' ? toText(source.npmDistTag) : defaults.npmDistTag,
        npmOtp: toText(source.npmOtp === undefined ? defaults.npmOtp : source.npmOtp),
      }
    }

    /** Keep only known platform ids, de-duplicated, in registry order. */
    function sanitizePlatformSelection(value) {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []
      const known = list.map(toText).filter(function keep(id) { return PLATFORM_IDS.indexOf(id) >= 0 })
      const unique = []
      for (let index = 0; index < PLATFORM_IDS.length; index += 1) {
        if (known.indexOf(PLATFORM_IDS[index]) >= 0) unique.push(PLATFORM_IDS[index])
      }
      return unique
    }

    function mergeForm(base, overlay) {
      const baseForm = base && typeof base === 'object' ? base : {}
      const patch = overlay && typeof overlay === 'object' ? overlay : {}
      const keys = Object.keys(BASE_FORM)
      const out = {}
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        out[key] = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : baseForm[key]
      }
      return out
    }

    /** DEFAULT_FORM ← settings.defaults → plugin.suggested → draft (CONTRACT §4.3). */
    function buildForm(plugin, settings, draft, account) {
      const normalizedSettings = normalizeSettings(settings)
      const defaults = normalizedSettings.defaults
      const suggested = plugin && plugin.suggested && typeof plugin.suggested === 'object' ? plugin.suggested : {}
      const seed = {
        owner: toText(suggested.owner) !== '' ? toText(suggested.owner) : toText(account && account.login),
        name: toText(suggested.name) !== '' ? toText(suggested.name) : toText(plugin && plugin.name),
        description: toText(suggested.description) !== '' ? toText(suggested.description) : toText(plugin && plugin.description),
        descriptionZh: toText(suggested.descriptionZh) !== '' ? toText(suggested.descriptionZh) : toText(plugin && plugin.descriptionZh),
        homepage: toText(suggested.homepage) !== '' ? toText(suggested.homepage) : toText(plugin && plugin.homepage),
        topics: Array.isArray(suggested.topics) && suggested.topics.length > 0
          ? suggested.topics
          : (plugin && Array.isArray(plugin.keywords) && plugin.keywords.length > 0 ? plugin.keywords : defaults.topicPreset),
        visibility: defaults.visibility,
        license: toText(suggested.license) !== '' ? toText(suggested.license) : (toText(plugin && plugin.license) !== '' ? plugin.license : defaults.license),
        branch: defaults.branch,
        tagPrefix: defaults.tagPrefix,
        commitMessage: defaults.commitMessage,
        authorName: defaults.authorName,
        authorEmail: defaults.authorEmail,
        repoExistsStrategy: defaults.repoExistsStrategy,
        addReadme: defaults.addReadme,
        readmeMode: defaults.readmeMode,
        addLicense: defaults.addLicense,
        addGitignore: defaults.addGitignore,
        updatePackageJson: defaults.updatePackageJson,
        createRelease: defaults.createRelease,
        releaseNotes: '',
        dryRun: false,
        forceWithLease: false,
      }
      return normalizeForm(mergeForm(seed, draft))
    }

    function validateForm(form) {
      const errors = {}
      if (!form || typeof form !== 'object') return errors
      const owner = toText(form.owner).trim()
      const name = toText(form.name).trim()
      const description = toText(form.description)
      const branch = toText(form.branch).trim()
      const tagPrefix = toText(form.tagPrefix)
      const topics = Array.isArray(form.topics) ? form.topics : []
      const platforms = Array.isArray(form.platforms) ? form.platforms : []
      const wantsGithub = platforms.indexOf('github') >= 0
      const wantsNpm = platforms.indexOf('npm') >= 0
      if (platforms.length === 0) errors.platforms = t('platform.noneSelected')
      // GitHub-only fields are flagged only when GitHub is one of the targets:
      // an npm-only publish must not be blocked by an empty repository owner.
      if (wantsGithub) {
        if (owner === '') errors.owner = t('field.ownerRequired')
        else if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) || owner.length > 100) errors.owner = t('field.ownerInvalid')
        if (description.length > DESCRIPTION_MAX) errors.description = t('field.descriptionTooLong', { n: description.length })
        if (branch === '') errors.branch = t('field.branchRequired')
        if (!/^[A-Za-z0-9._-]*$/.test(tagPrefix)) errors.tagPrefix = t('field.tagPrefixInvalid')
      }
      if (wantsNpm) {
        if (toText(form.npmDistTag).trim() === '') errors.npmDistTag = t('platforms.npmDistTag')
      }
      if (name === '') errors.name = t('field.nameRequired')
      else if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) errors.name = t('field.nameInvalid')
      if (topics.length > TOPIC_MAX) errors.topics = t('field.topicsTooMany')
      else {
        for (let index = 0; index < topics.length; index += 1) {
          if (!validateTopicText(toText(topics[index]))) {
            errors.topics = t('field.topicsInvalid')
            break
          }
        }
      }
      return errors
    }

    function hasFormErrors(errors) {
      if (!errors || typeof errors !== 'object') return false
      const keys = Object.keys(errors)
      for (let index = 0; index < keys.length; index += 1) {
        if (errors[keys[index]]) return true
      }
      return false
    }

    function findPlugin(plugins, path) {
      if (!Array.isArray(plugins) || typeof path !== 'string' || path === '') return null
      for (let index = 0; index < plugins.length; index += 1) {
        if (plugins[index] && plugins[index].path === path) return plugins[index]
      }
      return null
    }

    function filterPlugins(plugins, query) {
      const list = Array.isArray(plugins) ? plugins : []
      const needle = toText(query).trim().toLowerCase()
      if (needle === '') return list
      return list.filter(function matches(plugin) {
        if (!plugin) return false
        const haystack = [plugin.name, plugin.displayName, plugin.path, plugin.description, plugin.version]
          .concat(plugin.keywords || [])
          .join(' ')
          .toLowerCase()
        return haystack.indexOf(needle) >= 0
      })
    }

    function readmeFromPreflight(preflight) {
      if (!preflight || !preflight.preview) return null
      const preview = preflight.preview
      // The Host always returns the README it would generate (even when an
      // existing README is kept), so the preview is never empty after preflight.
      if (typeof preview.generatedReadme === 'string' && preview.generatedReadme !== '') {
        return {
          file: 'README.md',
          action: preview.readmeAction === 'update' ? 'update' : preview.readmeAction === 'keep' ? 'keep' : 'create',
          content: preview.generatedReadme,
          bytes: preview.generatedReadme.length,
          reason: preview.readmeAction,
        }
      }
      if (!Array.isArray(preview.files)) return null
      const files = preview.files
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (!file) continue
        const name = toText(file.file).toLowerCase()
        if ((name === 'readme.md' || name === 'readme' || name === 'readme.markdown') && typeof file.content === 'string') return file
      }
      return null
    }

    // ── HTTP layer (CONTRACT §3; token bootstrap §5.3) ──────────────────
    let cachedToken = null
    let distrustInjectedToken = false
    let bootstrapPromise = null

    function readInjectedHolder() {
      try {
        if (typeof window === 'undefined' || !window) return null
        const holder = window.__DSH_GITHUB_PUBLISHER__
        return holder && typeof holder === 'object' ? holder : null
      } catch (error) {
        return null
      }
    }

    function readInjectedToken() {
      const holder = readInjectedHolder()
      if (holder && typeof holder.token === 'string' && holder.token !== '') return holder.token
      return null
    }

    function fetchImpl() {
      if (typeof fetch !== 'function') throw makeError('network', t('error.network'))
      return fetch
    }

    function parseJsonBody(text) {
      if (typeof text !== 'string' || text === '') return null
      try {
        return JSON.parse(text)
      } catch (error) {
        return null
      }
    }

    function isFailedResponse(response) {
      if (!response) return true
      if (response.ok === false) return true
      if (response.ok === true) return false
      return typeof response.status === 'number' && response.status >= 400
    }

    function responseError(response, text) {
      const status = response && typeof response.status === 'number' ? response.status : 0
      const payload = parseJsonBody(text)
      if (payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object') {
        const code = toText(payload.error.code) !== '' ? toText(payload.error.code) : 'internal'
        const message = toText(payload.error.message) !== ''
          ? toText(payload.error.message)
          : t('error.http', { status: status })
        return makeError(code, message, {
          status: status,
          details: payload.error.details || null,
          tokenRelated: status === 401 || TOKEN_ERROR_CODES.indexOf(code) >= 0,
        })
      }
      if (status === 404) return makeError('not-mounted', t('error.notMounted'), { status: 404 })
      if (status === 401) return makeError('unauthorized', t('error.unauthorized'), { status: 401, tokenRelated: true })
      if (!payload) return makeError('bad-response', t('error.badResponse'), { status: status })
      return makeError('http', t('error.http', { status: status }), { status: status })
    }

    /** fetch + text read with a hard timeout; never rejects. */
    function fetchTextWithTimeout(path, init, timeoutMs) {
      const requestInit = Object.assign({}, init)
      let controller = null
      let timedOut = false
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        requestInit.signal = controller.signal
      }
      const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS
      const timer = setTimeout(function onTimeout() {
        timedOut = true
        if (controller !== null) {
          try {
            controller.abort()
          } catch (error) {
            /* already aborted */
          }
        }
      }, limit)
      return fetchImpl()(path, requestInit).then(function onResponse(response) {
        return response.text().then(function onText(text) {
          return { response: response, text: typeof text === 'string' ? text : '', timedOut: timedOut, failed: false, readFailed: false }
        }, function onTextFailure() {
          return { response: response, text: '', timedOut: timedOut, failed: false, readFailed: true }
        })
      }, function onFetchFailure() {
        return { response: null, text: '', timedOut: timedOut, failed: true, readFailed: false }
      }).then(function onSettled(result) {
        clearTimeout(timer)
        return result
      })
    }

    function sendJson(method, path, token, body, options) {
      const settings = options && typeof options === 'object' ? options : {}
      const headers = { accept: 'application/json' }
      headers[TOKEN_HEADER] = token
      const init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' }
      if (body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : REQUEST_TIMEOUT_MS
      return fetchTextWithTimeout(path, init, timeoutMs).then(function onResult(result) {
        if (result.failed) {
          if (result.timedOut) throw makeError('timeout', t('error.timeout'))
          throw makeError('network', t('error.network'))
        }
        if (result.readFailed) throw makeError('bad-response', t('error.badResponse'), { status: result.response ? result.response.status : 0 })
        const response = result.response
        if (isFailedResponse(response)) throw responseError(response, result.text)
        const payload = parseJsonBody(result.text)
        if (!payload || typeof payload !== 'object' || payload.ok !== true) {
          throw makeError('bad-response', t('error.badResponse'), { status: response && response.status })
        }
        return payload
      })
    }

    function resolveToken(force) {
      if (force === true) {
        cachedToken = null
        distrustInjectedToken = true
      } else if (cachedToken !== null) {
        return Promise.resolve(cachedToken)
      } else if (!distrustInjectedToken) {
        const injected = readInjectedToken()
        if (injected !== null) {
          cachedToken = injected
          return Promise.resolve(injected)
        }
      }
      if (bootstrapPromise !== null) return bootstrapPromise
      bootstrapPromise = fetchBootstrapToken().then(function onToken(token) {
        bootstrapPromise = null
        cachedToken = token
        return token
      }, function onFailure(error) {
        bootstrapPromise = null
        throw error
      })
      return bootstrapPromise
    }

    function fetchBootstrapToken() {
      const init = { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' }
      return fetchTextWithTimeout(API.token, init, REQUEST_TIMEOUT_MS).then(function onResult(result) {
        if (result.failed) {
          if (result.timedOut) throw makeError('timeout', t('error.timeout'), { tokenRelated: true })
          throw makeError('network', t('error.network'), { tokenRelated: true })
        }
        if (result.readFailed) throw makeError('no-token', t('error.noToken'), { tokenRelated: true })
        const payload = parseJsonBody(result.text)
        const status = result.response && typeof result.response.status === 'number' ? result.response.status : 0
        if (!payload || payload.ok !== true || typeof payload.token !== 'string' || payload.token === '') {
          if (status === 404) throw makeError('not-mounted', t('error.notMounted'), { status: 404, tokenRelated: true })
          throw makeError('no-token', t('error.noToken'), { status: status, tokenRelated: true })
        }
        return payload.token
      })
    }

    function requestJson(method, path, body, options) {
      const settings = options && typeof options === 'object' ? options : {}
      return resolveToken(false).then(function withToken(token) {
        return sendJson(method, path, token, body, settings)
      }).catch(function onFailure(error) {
        if (error && error.code === 'unauthorized' && settings.retryOnUnauthorized !== false) {
          return resolveToken(true).then(function withFreshToken(token) {
            return sendJson(method, path, token, body, settings)
          })
        }
        throw error
      })
    }

    function currentHttpToken() {
      return cachedToken
    }

    function resetHttp() {
      cachedToken = null
      distrustInjectedToken = false
      bootstrapPromise = null
    }
    // ── preflight normalizers (CONTRACT §3.6 + Host v1 actual shape) ────
    function normalizePlan(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        owner: toText(source.owner),
        repo: toText(source.repo),
        branch: toText(source.branch),
        repoExists: source.repoExists === true,
        createRepo: source.createRepo === true,
        visibility: pickId(source.visibility, VISIBILITY_IDS, 'public'),
        remoteUrl: toText(source.remoteUrl),
        commitMessage: toText(source.commitMessage),
        tag: toText(source.tag),
        createRelease: source.createRelease === true,
        dryRun: source.dryRun === true,
        apiBase: toText(source.apiBase),
        gitBase: toText(source.gitBase),
        version: toText(source.version),
        license: toText(source.license),
        topics: toStringList(source.topics),
      }
    }

    function normalizePreviewFile(raw) {
      if (!raw || typeof raw !== 'object') return null
      const file = toText(raw.file)
      if (file === '') return null
      const actionValue = toText(raw.action)
      return {
        file: file,
        action: actionValue === 'create' ? 'create' : actionValue === 'update' ? 'update' : 'keep',
        content: typeof raw.content === 'string' ? raw.content : null,
        bytes: toNumber(raw.bytes) || 0,
        reason: toText(raw.reason),
      }
    }

    function normalizePackageJsonPreview(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        file: toText(raw.file) !== '' ? toText(raw.file) : 'package.json',
        changed: raw.changed === true,
        changes: raw.changes && typeof raw.changes === 'object' ? raw.changes : null,
        text: typeof raw.text === 'string' ? raw.text : null,
        error: toText(raw.error) !== '' ? toText(raw.error) : null,
      }
    }

    function normalizePreflight(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      const checks = Array.isArray(source.checks) ? source.checks.map(function mapCheck(check) {
        if (!check || typeof check !== 'object') return null
        const status = toText(check.status)
        return {
          id: toText(check.id) !== '' ? toText(check.id) : 'check',
          status: status === 'fail' ? 'fail' : status === 'warn' ? 'warn' : 'pass',
          title: toText(check.title) !== '' ? toText(check.title) : toText(check.id),
          detail: toText(check.detail),
          fix: toText(check.fix) !== '' ? toText(check.fix) : null,
          // `suggestion` carries the value a one-click fix would apply (e.g. the
          // next version a `bump` fix should write), so the label can name it.
          suggestion: toText(check.suggestion) !== '' ? toText(check.suggestion) : null,
        }
      }).filter(Boolean) : []
      const blocking = Array.isArray(source.blocking)
        ? toStringList(source.blocking)
        : checks.filter(function onlyFail(check) { return check.status === 'fail' }).map(function idOf(check) { return check.id })
      const ownershipRaw = source.ownership && typeof source.ownership === 'object' ? source.ownership : null
      const ownership = ownershipRaw
        ? {
            status: ['own', 'fork', 'foreign', 'none'].indexOf(toText(ownershipRaw.status)) >= 0 ? toText(ownershipRaw.status) : 'none',
            author: toText(ownershipRaw.author),
            login: toText(ownershipRaw.login),
            owner: toText(ownershipRaw.owner),
            scope: toText(ownershipRaw.scope),
            scopeDrift: ownershipRaw.scopeDrift === true,
            confirmed: ownershipRaw.confirmed === true,
            // The fingerprint the confirmation is currently bound to, and the
            // one it was originally remembered for. Both are compared by the Host;
            // the UI only needs them to explain why a tick may have lapsed.
            fingerprint: toText(ownershipRaw.fingerprint),
            rememberedFor: toText(ownershipRaw.rememberedFor),
            reason: toText(ownershipRaw.reason),
          }
        : null
      const previewRaw = source.preview && typeof source.preview === 'object' ? source.preview : {}
      const files = Array.isArray(previewRaw.files) ? previewRaw.files.map(normalizePreviewFile).filter(Boolean) : []
      const writes = Array.isArray(previewRaw.writes) ? previewRaw.writes.map(normalizePreviewFile).filter(Boolean) : files
      return {
        ok: source.ok !== false,
        plugin: normalizePlugin(source.plugin),
        form: source.form && typeof source.form === 'object' ? normalizeForm(source.form) : null,
        checks: checks,
        blocking: blocking,
        canPublish: typeof source.canPublish === 'boolean' ? source.canPublish : blocking.length === 0,
        ownership: ownership,
        needsAccount: source.needsAccount === true,
        actionText: toText(source.actionText),
        plan: source.plan && typeof source.plan === 'object' ? normalizePlan(source.plan) : null,
        preview: {
          files: files,
          writes: writes,
          packageJson: normalizePackageJsonPreview(previewRaw.packageJson),
          generatedReadme: toText(previewRaw.generatedReadme),
          readmeAction: toText(previewRaw.readmeAction),
          license: toText(previewRaw.license),
          year: toNumber(previewRaw.year),
        },
        warnings: toStringList(source.warnings),
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Page store — one plain-JS state machine shared by the React page and the
    // Node smoke test. Every network call, timeout and transition lives here;
    // the page only renders the snapshot and forwards user intent.
    // ══════════════════════════════════════════════════════════════════════
    const defaultApi = {
      getState: function getState() {
        return requestJson('GET', API.state)
      },
      scan: function scan() {
        return requestJson('POST', API.scan, {}, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
      },
      preflight: function preflight(body) {
        return requestJson('POST', API.preflight, body, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
      },
      publish: function publish(body) {
        return requestJson('POST', API.publish, body, { timeoutMs: PUBLISH_TIMEOUT_MS })
      },
      getJob: function getJob(jobId) {
        const suffix = typeof jobId === 'string' && jobId !== '' ? '?jobId=' + encodeURIComponent(jobId) : ''
        return requestJson('GET', API.job + suffix)
      },
      cancel: function cancel(body) {
        return requestJson('POST', API.cancel, body || {})
      },
      saveDraft: function saveDraft(body) {
        return requestJson('POST', API.draft, body)
      },
      saveToken: function saveToken(body) {
        return requestJson('POST', API.token, body)
      },
      saveSettings: function saveSettings(body) {
        return requestJson('POST', API.settings, body)
      },
      savePlatforms: function savePlatforms(body) {
        return requestJson('POST', API.platforms, body)
      },
      verifyPlatform: function verifyPlatform(body) {
        return requestJson('POST', API.platformsVerify, body)
      },
      saveNpmToken: function saveNpmToken(body) {
        return requestJson('POST', API.npmToken, body)
      },
      registryStatus: function registryStatus(registry) {
        const query = typeof registry === 'string' && registry.trim() !== '' ? '?registry=' + encodeURIComponent(registry.trim()) : ''
        return requestJson('GET', API.registryStatus + query)
      },
      registryStart: function registryStart(body) {
        return requestJson('POST', API.registryStart, body || {}, { timeoutMs: 60000 })
      },
      detectNpmToken: function detectNpmToken(adopt) {
        return requestJson('POST', API.npmTokenDetect, { adopt: adopt === true }, { timeoutMs: 60000 })
      },
      bumpVersion: function bumpVersion(body) {
        return requestJson('POST', API.versionBump, body)
      },
      syncPlan: function syncPlan(body) {
        return requestJson('POST', API.syncPlan, body, { timeoutMs: PREFLIGHT_TIMEOUT_MS })
      },
      clearHistory: function clearHistory() {
        return requestJson('POST', API.historyClear, {})
      },
      aiSuggest: function aiSuggest(body) {
        return requestJson('POST', API.aiSuggest, body, { timeoutMs: 60000 })
      },
    }

    function initialState() {
      return {
        phase: 'loading',
        loading: false,
        version: '',
        platform: '',
        dataDir: '',
        settings: normalizeSettings(null),
        account: normalizeAccount(null),
        platforms: [],
        platformSelection: [],
        plugins: [],
        drafts: {},
        history: [],
        capabilities: {},
        scanInfo: { roots: [], warnings: [], scannedAt: 0 },
        serverTime: 0,
        job: null,
        jobId: null,
        publishedResult: null,
        selectedPath: null,
        form: null,
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
        savingPlatforms: false,
        verifyingPlatform: null,
        savingNpmToken: false,
        detectingNpmToken: false,
        npmrcProbe: null,
        registry: null,
        registryBusy: false,
        registryAutoTried: false,
        clearingHistory: false,
        draftSaving: false,
        draftError: null,
        activeTab: 'publish',
        syncPlan: null,
        syncBusy: false,
        syncBumping: false,
      }
    }

    function createStore(options) {
      const config = options && typeof options === 'object' ? options : {}
      const api = config.api && typeof config.api === 'object' ? config.api : defaultApi
      const pollMs = typeof config.pollMs === 'number' && config.pollMs >= 0 ? config.pollMs : POLL_MS
      const draftDelay = typeof config.debounceMs === 'number' && config.debounceMs >= 0 ? config.debounceMs : DRAFT_DEBOUNCE_MS

      let state = initialState()
      const listeners = new Set()
      let disposed = false
      let draftTimer = null
      let draftPromise = null
      let draftPayload = null
      let pollTimer = null
      /**
       * Adaptive poll interval.
       *
       * Fixed 650ms polled ~50 times during a four-platform publish, and the long
       * steps (push / release / npm) return an unchanged snapshot for seconds at a
       * time. Start fast — the first seconds are where visible progress happens —
       * then widen, and snap back whenever a step or its status actually changes.
       */
      let pollBackoff = 0
      function nextPollDelay(baseMs) {
        const base = typeof baseMs === 'number' && baseMs > 0 ? baseMs : 650
        const ladder = [1, 1, 1.5, 2, 3, 4]
        const factor = ladder[Math.min(pollBackoff, ladder.length - 1)]
        return Math.round(base * factor)
      }
      let pollSeq = 0
      let jobWaiters = []
      let toastTimer = null

      function getState() {
        return state
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function noop() {}
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function emit() {
        if (disposed) return
        const current = Array.from(listeners)
        for (let index = 0; index < current.length; index += 1) {
          try {
            current[index]()
          } catch (error) {
            /* one broken listener must not break the page */
          }
        }
      }

      function setState(patch) {
        const next = typeof patch === 'function' ? patch(state) : patch
        if (!next || typeof next !== 'object') return state
        state = Object.assign({}, state, next)
        emit()
        return state
      }

      function setError(error) {
        const normalized = error && typeof error === 'object'
          ? error
          : makeError('internal', t('error.network'))
        setState({ error: normalized })
      }

      function showToast(message, tone) {
        const text = toText(message)
        if (text === '') return
        setState({ toast: { message: text, tone: tone || 'info', at: Date.now() } })
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(function clearToastTimer() {
          toastTimer = null
          setState({ toast: null })
        }, TOAST_MS)
        if (toastTimer && typeof toastTimer.unref === 'function') toastTimer.unref()
      }

      function clearToast() {
        if (toastTimer !== null) {
          clearTimeout(toastTimer)
          toastTimer = null
        }
        setState({ toast: null })
      }

      function dismissError() {
        setState({ error: null })
      }

      function readScanInfo(raw) {
        if (!raw || typeof raw !== 'object') return null
        return {
          roots: Array.isArray(raw.roots) ? raw.roots : [],
          warnings: toStringList(raw.warnings),
          scannedAt: toNumber(raw.scannedAt) || 0,
        }
      }

      function applyStatePayload(payload, options) {
        const settings = options && typeof options === 'object' ? options : {}
        const silent = settings.silent === true
        const source = payload && typeof payload === 'object' ? payload : {}
        const plugins = normalizePlugins(source.plugins)
        const nextSettings = normalizeSettings(source.settings)
        const account = normalizeAccount(source.account)
        const history = normalizeHistory(source.history)
        const drafts = normalizeDrafts(source.drafts)
        const scanInfo = readScanInfo(source.scanInfo) || state.scanInfo
        const capabilities = source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {}
        const platforms = normalizePlatforms(source.platforms)
        const platformSelection = Array.isArray(source.platformSelection)
          ? sanitizePlatformSelection(source.platformSelection)
          : (platforms.filter(function enabled(entry) { return entry.enabled }).map(function id(entry) { return entry.id }))
        const shared = {
          phase: 'ready',
          version: toText(source.version) !== '' ? toText(source.version) : CLIENT_VERSION,
          platform: toText(source.platform),
          dataDir: toText(source.dataDir),
          settings: nextSettings,
          account: account,
          platforms: platforms,
          platformSelection: platformSelection,
          plugins: plugins,
          history: history,
          drafts: drafts,
          scanInfo: scanInfo,
          capabilities: capabilities,
          serverTime: toNumber(source.serverTime) || Date.now(),
          loading: false,
          refreshError: null,
        }
        if (silent) {
          // A silent refresh (after preflight / publish / scan) must not wipe
          // what the user has open. Only the server-owned slices are replaced;
          // selection, form edits, search, tab and preflight stay as they are.
          const keep = {
            selectedPath: state.selectedPath,
            form: state.form,
            formDirty: state.formDirty,
            formErrors: state.formErrors,
            search: state.search,
            preflight: state.preflight,
            preflightStale: state.preflightStale,
            preflightBusy: state.preflightBusy,
            activeTab: state.activeTab,
            settingsOpen: state.settingsOpen,
            toast: state.toast,
          }
          setState(Object.assign({}, shared, keep))
          return
        }
        let selectedPath = null
        const storedSelected = readStorage(STORAGE_SELECTED)
        if (storedSelected !== null && findPlugin(plugins, storedSelected)) selectedPath = storedSelected
        else if (plugins.length > 0) selectedPath = plugins[0].path
        // A surface that never had a plugin selected still restores the last
        // search phrase, so reloading keeps the list filtered as it was.
        const storedSearch = readStorage(STORAGE_SEARCH)
        const plugin = findPlugin(plugins, selectedPath)
        const form = plugin ? buildForm(plugin, nextSettings, drafts[selectedPath], account) : null
        const job = normalizeJob(source.job)
        const next = Object.assign({}, shared, {
          selectedPath: selectedPath,
          form: form,
          formDirty: false,
          formErrors: validateForm(form),
          search: storedSearch === null ? '' : storedSearch,
          preflight: null,
          preflightStale: false,
          preflightBusy: false,
          publishing: false,
          cancelling: false,
          cancelRequested: false,
          job: job,
          jobId: job && job.jobId !== '' ? job.jobId : null,
          publishedResult: job && job.status === 'succeeded' ? job.result : null,
          error: null,
          draftError: null,
          tokenWarnings: [],
          scanWarnings: scanInfo.warnings,
        })
        if (job && job.status === 'running' && job.jobId !== '') {
          next.publishing = true
          next.jobId = job.jobId
        }
        setState(next)
        if (job && job.status === 'running' && job.jobId !== '') startPolling(job.jobId)
      }

      async function loadState(options) {
        const settings = options && typeof options === 'object' ? options : {}
        const silent = settings.silent === true
        if (!silent) setState({ loading: true, phase: state.plugins.length > 0 ? 'ready' : 'loading' })
        try {
          const payload = await api.getState()
          applyStatePayload(payload, { silent: silent })
          // The first successful load also checks (and if needed starts) the
          // registry, so a stale npm destination never blocks a publish.
          void checkRegistryOnLoad()
          return true
        } catch (error) {
          if (silent) {
            setState({ refreshError: error })
            return false
          }
          setState({
            loading: false,
            phase: state.plugins.length > 0 ? 'ready' : 'error',
            error: error,
          })
          return false
        }
      }

      function getSelectedPlugin() {
        return findPlugin(state.plugins, state.selectedPath)
      }

      function selectPlugin(path) {
        if (state.publishing) return false
        const plugin = findPlugin(state.plugins, path)
        if (!plugin) return false
        if (state.selectedPath === path && state.form !== null) return true
        if (draftTimer !== null || draftPayload !== null) fireDraftNow()
        const form = buildForm(plugin, state.settings, state.drafts[path], state.account)
        writeStorage(STORAGE_SELECTED, path)
        setState({
          selectedPath: path,
          form: form,
          formDirty: false,
          formErrors: validateForm(form),
          preflight: null,
          preflightStale: false,
          preflightBusy: false,
          publishing: false,
          cancelling: false,
          cancelRequested: false,
          job: null,
          jobId: null,
          publishedResult: null,
          error: null,
        })
        return true
      }

      function setSearch(value) {
        const text = toText(value)
        writeStorage(STORAGE_SEARCH, text)
        setState({ search: text })
      }

      /** Switch the page tab (publish / platforms / sync) and remember it. */
      function setTab(tab) {
        const next = ['publish', 'platforms', 'sync'].indexOf(toText(tab)) >= 0 ? toText(tab) : 'publish'
        writeStorage(STORAGE_ACTIVE_TAB, next)
        setState({ activeTab: next })
        return next
      }

      function readActiveTab() {
        const stored = readStorage(STORAGE_ACTIVE_TAB)
        return stored !== null && ['publish', 'platforms', 'sync'].indexOf(stored) >= 0 ? stored : 'publish'
      }

      /** Tick / untick one platform in the publish form (single button, N targets). */
      /**
       * Tick or untick a platform.
       *
       * Repository hostings are independent: a publish pushes one commit to every
       * ticked hosting, each with its own repo and release. `npm` rides along
       * with any of them. Nothing here is mutually exclusive.
       */
      function togglePlatform(platformId) {
        const id = toText(platformId)
        if (PLATFORM_IDS.indexOf(id) < 0) return null
        if (!state.form) return null
        const current = Array.isArray(state.form.platforms) ? state.form.platforms.slice() : []
        const index = current.indexOf(id)
        if (index >= 0) current.splice(index, 1)
        else current.push(id)
        return updateForm({ platforms: sanitizePlatformSelection(current) })
      }

      /** Platforms ticked in the current form that are also enabled in config. */
      function selectedPlatforms() {
        const form = state.form
        const list = form && Array.isArray(form.platforms) ? form.platforms : []
        return list.filter(function enabled(id) {
          const entry = state.platforms.find(function find(item) { return item.id === id })
          return Boolean(entry && entry.enabled)
        })
      }

      function formTargetLabel() {
        const list = selectedPlatforms()
        if (list.length === 0) return ''
        return list.map(function label(id) {
          const meta = PLATFORM_META[id]
          return meta ? meta.label : id
        }).join(' + ')
      }

      function updateForm(patch) {
        if (!state.form) return null
        const form = normalizeForm(Object.assign({}, state.form, patch && typeof patch === 'object' ? patch : {}))
        const errors = validateForm(form)
        setState(function compute(previous) {
          const nextError = previous.error && previous.error.code === 'preflight-failed' ? null : previous.error
          return {
            form: form,
            formDirty: true,
            formErrors: errors,
            preflightStale: previous.preflight !== null,
            error: nextError,
          }
        })
        scheduleDraft()
        return form
      }

      /** Persist the platform section (tokens, registry, defaults, enabled flags). */
      async function savePlatforms(patch) {
        if (state.savingPlatforms) return false
        setState({ savingPlatforms: true, error: null })
        try {
          const payload = await api.savePlatforms(patch && typeof patch === 'object' ? patch : {})
          const platforms = normalizePlatforms(payload && payload.platforms)
          setState({
            savingPlatforms: false,
            platforms: platforms,
            platformSelection: sanitizePlatformSelection(payload && payload.enabled),
          })
          showToast(t('platforms.saved'), 'success')
          return true
        } catch (error) {
          setState({ savingPlatforms: false, error: error })
          return false
        }
      }

      /** Validate one platform's credentials against the real endpoint. */
      async function verifyPlatform(platformId) {
        const id = toText(platformId)
        if (PLATFORM_IDS.indexOf(id) < 0) return false
        setState({ verifyingPlatform: id, error: null })
        try {
          const payload = await api.verifyPlatform({ platformId: id })
          const account = payload && payload.account ? payload.account : null
          const login = account && account.login ? account.login : ''
          setState({ verifyingPlatform: null })
          showToast(login !== '' ? t('platforms.verified', { login: login }) : t('platforms.verifyFailed'), login !== '' ? 'success' : 'warn')
          await loadState({ silent: true })
          return payload
        } catch (error) {
          setState({ verifyingPlatform: null, error: error })
          return false
        }
      }

      /** Save one platform's token (npm only; GitHub PAT uses the settings modal). */
      async function saveNpmToken(token) {
        if (state.savingNpmToken) return false
        const value = typeof token === 'string' ? token.trim() : ''
        setState({ savingNpmToken: true, error: null })
        try {
          const payload = await api.saveNpmToken(value === '' ? { token: null } : { token: value })
          setState({ savingNpmToken: false })
          showToast(value === '' ? t('platforms.npmCleared') : t('platforms.verified', { login: (payload && payload.account && payload.account.login) || 'npm' }), 'success')
          await loadState({ silent: true })
          return true
        } catch (error) {
          setState({ savingNpmToken: false, error: error })
          return false
        }
      }

      /**
       * Read the npm token that `npm login` already wrote into an .npmrc.
       *
       * `adopt=false` only reports what was found (so the user can see the hint
       * and source file first); `adopt=true` verifies it against the registry
       * and persists it. This exists because copying that value by hand is how
       * the `.npmrc` *key* used to end up pasted as the token.
       */
      async function detectNpmToken(adopt) {
        if (state.detectingNpmToken === true) return false
        setState({ detectingNpmToken: true, error: null })
        try {
          const payload = await api.detectNpmToken(adopt === true)
          const warnings = toStringList(payload && payload.warnings)
          setState({
            detectingNpmToken: false,
            npmrcProbe: {
              hint: toText(payload && payload.hint),
              source: toText(payload && payload.source),
              account: toText(payload && payload.account && payload.account.login),
              saved: payload && payload.saved === true,
            },
            tokenWarnings: warnings,
          })
          const login = payload && payload.account && payload.account.login ? payload.account.login : ''
          showToast(
            payload && payload.saved === true
              ? t('platforms.npmrcAdopted', { login: login !== '' ? '@' + login : 'npm' })
              : t('platforms.npmrcFound', { hint: toText(payload && payload.hint) }),
            warnings.length > 0 ? 'warn' : 'success',
          )
          if (payload && payload.saved === true) await loadState({ silent: true })
          return true
        } catch (error) {
          const code = error && error.code ? error.code : ''
          setState({ detectingNpmToken: false, error: error })
          if (code === 'npm-no-npmrc') showToast(t('platforms.npmrcMissing'), 'warn')
          return false
        }
      }

      /** Bump package.json's version (patch by default) and return the diff. */
      async function bumpVersion(mode, version) {
        if (state.syncBumping) return null
        const path = state.selectedPath
        if (!path) {
          setError(makeError('bad-request', t('sync.pickPlugin')))
          return null
        }
        setState({ syncBumping: true, error: null })
        try {
          // An explicit `version` wins over `mode`: a blind patch bump cannot
          // clear a collision whose remote latest is far ahead of the local one.
          const payload = await api.bumpVersion(
            version ? { path: path, mode: mode || 'patch', version: version } : { path: path, mode: mode || 'patch' },
          )
          setState({ syncBumping: false })
          showToast(t('sync.bumped', { version: toText(payload && payload.version) }), 'success')
          await rescan()
          if (state.syncPlan !== null) await checkSync()
          return payload
        } catch (error) {
          setState({ syncBumping: false, error: error })
          return null
        }
      }

      /** Compare the local version with every platform's remote state. */
      async function checkSync() {
        if (state.syncBusy) return null
        const path = state.selectedPath
        if (!path) {
          setError(makeError('bad-request', t('sync.pickPlugin')))
          return null
        }
        setState({ syncBusy: true, error: null })
        try {
          const payload = await api.syncPlan({ path: path })
          const plan = normalizeSyncPlan(payload)
          setState({ syncBusy: false, syncPlan: plan })
          return plan
        } catch (error) {
          setState({ syncBusy: false, error: error })
          return null
        }
      }

      /** Publish only to the platforms the sync matrix reports as behind. */
      async function syncBehindPlatforms() {
        const plan = state.syncPlan
        if (!plan || plan.behind.length === 0) return null
        if (state.form) updateForm({ platforms: sanitizePlatformSelection(plan.behind) })
        setTab('publish')
        return runPublish()
      }

      function scheduleDraft() {
        if (!state.selectedPath || !state.form) return undefined
        draftPayload = { path: state.selectedPath, form: normalizeForm(state.form) }
        if (draftTimer !== null) clearTimeout(draftTimer)
        if (draftDelay <= 0) {
          draftTimer = null
          fireDraftNow()
          return undefined
        }
        draftTimer = setTimeout(function onDraftTimer() {
          draftTimer = null
          fireDraftNow()
        }, draftDelay)
        return undefined
      }

      function fireDraftNow() {
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
        const payload = draftPayload
        draftPayload = null
        if (!payload || payload.path === '') return Promise.resolve(false)
        setState({ draftSaving: true })
        const request = Promise.resolve(api.saveDraft({ path: payload.path, form: payload.form })).then(function onSaved() {
          const drafts = Object.assign({}, state.drafts)
          drafts[payload.path] = payload.form
          setState({ drafts: drafts, draftSaving: false, draftError: null })
          return true
        }, function onSaveFailed(error) {
          setState({ draftSaving: false, draftError: error })
          return false
        })
        draftPromise = request
        request.then(function clearPending() {
          if (draftPromise === request) draftPromise = null
        })
        return request
      }

      async function flushDraft() {
        if (draftTimer !== null || draftPayload !== null) fireDraftNow()
        const pending = draftPromise
        if (pending !== null) {
          try {
            await pending
          } catch (error) {
            /* already captured in draftError */
          }
        }
        return true
      }

      async function runPreflight() {
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        if (state.preflightBusy) return state.preflight
        setState({
          preflightBusy: true,
          error: state.error && (state.error.code === 'preflight-failed' || state.error.code === 'preflight') ? null : state.error,
        })
        try {
          const payload = await api.preflight({ path: path, form: form })
          const preflight = normalizePreflight(payload)
          setState(function applyPreflight(previous) {
            const nextForm = preflight.form ? normalizeForm(preflight.form) : previous.form
            return {
              preflight: preflight,
              preflightBusy: false,
              preflightStale: false,
              form: nextForm,
              formErrors: validateForm(nextForm),
              scanWarnings: preflight.warnings.length > 0 ? preflight.warnings : previous.scanWarnings,
            }
          })
          return preflight
        } catch (error) {
          setState({ preflightBusy: false, error: error })
          return null
        }
      }

      /**
       * Ask the DeepSeek model configured in DSH for release metadata and apply
       * it to the form. The Host never writes anything here; the user reviews
       * and can edit every field before the preflight/publish.
       */
      async function aiSuggest() {
        if (state.aiBusy) return null
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        setState({ aiBusy: true, aiError: null })
        try {
          const payload = await api.aiSuggest({ path: path, form: form })
          const raw = payload && payload.suggestion && typeof payload.suggestion === 'object' ? payload.suggestion : null
          if (!raw) throw makeError('llm-empty', t('ai.empty'))
          const patch = {}
          const description = toText(raw.description).trim()
          const descriptionZh = toText(raw.descriptionZh).trim()
          const releaseNotes = toText(raw.releaseNotes).trim()
          const topics = sanitizeTopics(raw.topics)
          if (description !== '') patch.description = description.slice(0, DESCRIPTION_MAX)
          if (descriptionZh !== '') patch.descriptionZh = descriptionZh
          if (topics.length > 0) patch.topics = topics
          if (releaseNotes !== '') patch.releaseNotes = releaseNotes
          if (Object.keys(patch).length === 0) throw makeError('llm-empty', t('ai.empty'))
          updateForm(patch)
          const model = toText(payload.model)
          setState({ aiBusy: false, aiError: null })
          showToast(t('ai.applied', { model: model || 'DeepSeek' }), 'success')
          return patch
        } catch (error) {
          const normalized = error && typeof error === 'object' && error.message ? error : makeError('internal', t('ai.failed'))
          setState({ aiBusy: false, aiError: normalized })
          showToast(t('ai.failedToast', { message: normalized.message }), 'error')
          return null
        }
      }

      function settleJobWaiters(job) {
        const waiters = jobWaiters
        jobWaiters = []
        for (let index = 0; index < waiters.length; index += 1) {
          try {
            waiters[index](job)
          } catch (error) {
            /* waiter errors are not ours */
          }
        }
      }

      function waitForJob() {
        return new Promise(function register(resolve) {
          jobWaiters.push(resolve)
        })
      }

      function stopPolling() {
        pollSeq += 1
        if (pollTimer !== null) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
      }

      async function pollOnce(jobId) {
        try {
          const payload = await api.getJob(jobId)
          const job = normalizeJob(payload.job)
          if (!job) {
            stopPolling()
            setState({ publishing: false, cancelling: false, error: makeError('job-not-found', t('error.badResponse')) })
            settleJobWaiters(null)
            return null
          }
          const resolvedId = job.jobId !== '' ? job.jobId : jobId
          setState({ job: job, jobId: resolvedId, publishing: job.status === 'running' })
          return job
        } catch (error) {
          let failure = error
          if (failure && failure.code === 'not-found') {
            failure = makeError('job-not-found', failure.message || t('error.publish'), { status: failure.status })
          }
          stopPolling()
          setState({ publishing: false, cancelling: false, error: failure })
          settleJobWaiters(null)
          return null
        }
      }

      async function finishJob(job) {
        stopPolling()
        setState({
          job: job,
          jobId: job.jobId !== '' ? job.jobId : state.jobId,
          publishing: false,
          cancelling: false,
          cancelRequested: job.status === 'cancelled',
        })
        if (job.status === 'succeeded') {
          const result = job.result
          setState({ publishedResult: result, error: null })
          setState({ preflightStale: true })
          if (result && result.dryRun) {
            showToast(t('result.dryRunTitle'), 'success')
          } else {
            showToast(t('toast.publishSucceeded', {
              owner: result ? result.owner : '',
              repo: result ? result.repo : '',
            }), 'success')
          }
          await loadState({ silent: true })
        } else if (job.status === 'partial') {
          /*
           * Some remotes took the code and some did not. Show the result card so
           * the per-host table is visible, but announce it as a warning with counts
           * — never as "cancelled", which read as "nothing happened".
           */
          const result = job.result
          setState({ publishedResult: result, error: null })
          setState({ preflightStale: true })
          const hosts = result && Array.isArray(result.hosts) ? result.hosts : []
          const okCount = hosts.filter(function fine(entry) { return entry.status === 'succeeded' }).length
          showToast(t('toast.publishPartial', { ok: String(okCount), total: String(hosts.length) }), 'warn')
          await loadState({ silent: true })
        } else if (job.status === 'failed') {
          const info = job.error || {}
          const message = toText(info.message) !== '' ? toText(info.message) : t('error.publish')
          setState({ error: makeError(toText(info.code) !== '' ? toText(info.code) : 'internal', message) })
          showToast(t('toast.publishFailed', { message: message }), 'error')
        } else {
          showToast(t('toast.publishCancelled'), 'warn')
        }
        settleJobWaiters(job)
      }

      function startPolling(jobId) {
        stopPolling()
        const sequence = pollSeq
        pollBackoff = 0
        /**
         * Reset the backoff whenever the job actually moved — a step turning over,
         * a step finishing, or a new log line. Without this the interval only ever
         * grows, and the tail of a publish would feel unresponsive exactly when the
         * user is waiting for the last step.
         */
        let lastShape = ''
        const shapeOf = function shape(snapshot) {
          if (!snapshot) return ''
          const steps = Array.isArray(snapshot.steps) ? snapshot.steps : []
          const moved = steps.map(function one(step) { return step.id + ':' + step.status }).join(',')
          const logs = Array.isArray(snapshot.logs) ? snapshot.logs.length : 0
          return moved + '|' + logs + '|' + (snapshot.status || '')
        }
        const loop = async function pollLoop() {
          if (disposed || sequence !== pollSeq) return
          const snapshot = await pollOnce(jobId)
          if (disposed || sequence !== pollSeq) return
          if (!snapshot) return
          if (isTerminalStatus(snapshot.status)) {
            try {
              await finishJob(snapshot)
            } catch (error) {
              setState({ publishing: false, error: makeError('internal', t('error.publish')) })
              settleJobWaiters(null)
            }
            return
          }
          const shape = shapeOf(snapshot)
          if (shape !== lastShape) {
            lastShape = shape
            pollBackoff = 0
          } else {
            pollBackoff = Math.min(pollBackoff + 1, 5)
          }
          pollTimer = setTimeout(function nextPoll() {
            loop()
          }, nextPollDelay(pollMs))
        }
        loop()
      }

      function waitForJobAndPoll(jobId) {
        setState({ publishing: true, cancelling: false, cancelRequested: false, jobId: jobId })
        const done = waitForJob()
        startPolling(jobId)
        return done
      }

      async function adoptRunningJob() {
        try {
          const payload = await api.getJob('')
          const job = normalizeJob(payload.job)
          if (job && job.status === 'running' && job.jobId !== '') {
            setState({ job: job, jobId: job.jobId, publishing: true })
            return job.jobId
          }
        } catch (error) {
          setState({ publishing: false, error: error })
        }
        return ''
      }

      async function runPublish() {
        if (state.publishing) return null
        const path = state.selectedPath
        const form = state.form
        if (!path || !form) {
          setError(makeError('bad-request', t('error.pickPlugin')))
          return null
        }
        let preflight = state.preflight
        if (!preflight || state.preflightStale) preflight = await runPreflight()
        if (!preflight) return null
        if (preflight.canPublish !== true) {
          const message = preflight.needsAccount ? t('preflight.needToken') : t('error.preflightBlocked')
          setError(makeError('preflight-failed', message, { details: { checks: preflight.checks } }))
          return null
        }
        setState({
          publishing: true,
          cancelling: false,
          cancelRequested: false,
          error: null,
          publishedResult: null,
          job: null,
          jobId: null,
        })
        showToast(t('toast.publishStarted', { name: form.name !== '' ? form.name : basename(path) }), 'info')
        let payload = null
        try {
          payload = await api.publish({ path: path, form: form })
        } catch (error) {
          if (error && error.code === 'job-running') {
            const adoptedId = await adoptRunningJob()
            if (adoptedId !== '') {
              showToast(t('error.jobRunning'), 'warn')
              return waitForJobAndPoll(adoptedId)
            }
          }
          setState({ publishing: false, error: error })
          return null
        }
        const jobId = payload && typeof payload.jobId === 'string' ? payload.jobId : ''
        if (jobId === '') {
          setState({ publishing: false, error: makeError('bad-response', t('error.badResponse')) })
          return null
        }
        return waitForJobAndPoll(jobId)
      }

      async function cancel() {
        if (state.cancelling) return false
        const jobId = state.jobId !== null && state.jobId !== ''
          ? state.jobId
          : (state.job && state.job.jobId ? state.job.jobId : '')
        if (jobId === '' && state.publishing !== true) return false
        setState({ cancelling: true })
        try {
          const payload = await api.cancel(jobId !== '' ? { jobId: jobId } : {})
          const cancelled = payload && payload.cancelled === true
          setState({ cancelling: false, cancelRequested: cancelled })
          showToast(cancelled ? t('toast.cancelled') : t('toast.publishCancelled'), cancelled ? 'info' : 'warn')
          return cancelled
        } catch (error) {
          setState({ cancelling: false, error: error })
          return false
        }
      }

      async function rescan() {
        if (state.scanBusy) return false
        setState({
          scanBusy: true,
          error: state.error && state.error.code === 'scan' ? null : state.error,
        })
        try {
          const payload = await api.scan()
          const plugins = normalizePlugins(payload.plugins)
          const scanInfo = readScanInfo({
            roots: payload.roots,
            warnings: payload.warnings,
            scannedAt: payload.scannedAt,
          }) || state.scanInfo
          let selectedPath = state.selectedPath
          if (selectedPath !== null && !findPlugin(plugins, selectedPath)) {
            selectedPath = plugins.length > 0 ? plugins[0].path : null
          }
          const selectionChanged = selectedPath !== state.selectedPath
          const form = selectedPath === null
            ? null
            : (selectionChanged || state.form === null
                ? buildForm(findPlugin(plugins, selectedPath), state.settings, state.drafts, state.account)
                : state.form)
          setState({
            scanBusy: false,
            plugins: plugins,
            scanInfo: scanInfo,
            selectedPath: selectedPath,
            form: form,
            formErrors: validateForm(form),
            preflight: selectionChanged ? null : state.preflight,
            preflightStale: selectionChanged ? false : state.preflightStale,
            scanWarnings: scanInfo.warnings,
          })
          showToast(t('toast.scanned', { n: plugins.length }), 'success')
          return true
        } catch (error) {
          setState({ scanBusy: false, error: error })
          return false
        }
      }

      async function saveToken(token) {
        if (state.savingToken) return false
        const value = typeof token === 'string' ? token.trim() : ''
        setState({ savingToken: true, error: null })
        try {
          const payload = await api.saveToken(value === '' ? { token: null } : { token: value })
          setState({
            savingToken: false,
            account: normalizeAccount(payload.account),
            tokenWarnings: toStringList(payload.warnings),
          })
          showToast(value === '' ? t('toast.tokenCleared') : t('toast.tokenSaved'), 'success')
          return true
        } catch (error) {
          setState({ savingToken: false, error: error })
          return false
        }
      }

      async function detectToken(persist) {
        if (state.detectingToken) return false
        setState({ detectingToken: true, error: null })
        try {
          const payload = await api.saveToken({ detect: true, persist: persist === true })
          const account = normalizeAccount(payload.account)
          setState({
            detectingToken: false,
            account: account,
            tokenWarnings: toStringList(payload.warnings),
          })
          showToast(
            account.connected ? t('settings.tokenDetected') : t('settings.tokenNotDetected'),
            account.connected ? 'success' : 'warn',
          )
          return account.connected
        } catch (error) {
          setState({ detectingToken: false, error: error })
          return false
        }
      }

      /* ── local registry lifecycle ──────────────────────────────────────── */

      function registryTarget() {
        const platforms = Array.isArray(state.platforms) ? state.platforms : []
        const npm = platforms.filter(function pickNpm(entry) { return entry && entry.id === 'npm' })[0] || null
        return npm && typeof npm.registry === 'string' ? npm.registry.trim() : ''
      }

      /**
       * Ask the Host whether the configured registry is up. Read-only; safe to
       * call on load and to poll.
       */
      async function checkRegistry() {
        const registry = registryTarget()
        if (registry === '') return null
        try {
          const payload = await api.registryStatus(registry)
          const status = payload && typeof payload === 'object' ? payload : null
          setState({ registry: status })
          return status
        } catch (error) {
          setState({ registry: null, refreshError: error })
          return null
        }
      }

      /**
       * Start the local registry and report the outcome. Only a loopback /
       * private registry is eligible — the Host refuses to shell out for a
       * remote host, so the panel never pretends it can.
       */
      async function startRegistry() {
        if (state.registryBusy === true) return false
        const registry = registryTarget()
        setState({ registryBusy: true, error: null })
        try {
          const payload = await api.registryStart({ registry: registry })
          const status = payload && typeof payload === 'object' ? payload : null
          setState({ registry: status, registryBusy: false })
          if (status && status.reachable === true) {
            showToast(t('registry.started'), 'success')
            return true
          }
          showToast(toText(status && status.error) !== '' ? toText(status.error) : t('registry.startFailed'), 'warn')
          return false
        } catch (error) {
          setState({ registryBusy: false, error: error })
          return false
        }
      }

      /**
       * On first load: if the registry is down and startable, start it without
       * asking. This is the "运行自动检验是否启动，若没有则先运行" behaviour —
       * it runs once per store instance so a failed start does not loop.
       */
      async function checkRegistryOnLoad() {
        if (state.registryAutoTried === true) return
        const registry = registryTarget()
        if (registry === '') return
        setState({ registryAutoTried: true })
        const status = await checkRegistry()
        if (!status) return
        if (status.reachable === true) return
        if (status.startable !== true) return
        await startRegistry()
      }

      async function saveSettings(patch) {
        if (state.savingSettings) return false
        setState({ savingSettings: true, error: null })
        try {
          const payload = await api.saveSettings(patch && typeof patch === 'object' ? patch : {})
          const settings = payload && payload.settings && typeof payload.settings === 'object'
            ? payload.settings
            : (payload && payload.defaults ? payload : null)
          setState({
            savingSettings: false,
            settings: normalizeSettings(settings),
          })
          showToast(t('toast.settingsSaved'), 'success')
          return true
        } catch (error) {
          setState({ savingSettings: false, error: error })
          return false
        }
      }

      async function clearHistory() {
        if (state.clearingHistory) return false
        setState({ clearingHistory: true, error: null })
        try {
          const payload = await api.clearHistory()
          setState({ clearingHistory: false, history: normalizeHistory(payload.history) })
          showToast(t('toast.historyCleared'), 'success')
          return true
        } catch (error) {
          setState({ clearingHistory: false, error: error })
          return false
        }
      }

      function openSettings() {
        setState({ settingsOpen: true })
      }

      function closeSettings() {
        setState({ settingsOpen: false })
      }

      function dispose() {
        disposed = true
        stopPolling()
        if (draftTimer !== null) {
          clearTimeout(draftTimer)
          draftTimer = null
        }
        if (toastTimer !== null) {
          clearTimeout(toastTimer)
          toastTimer = null
        }
        draftPayload = null
        jobWaiters = []
        listeners.clear()
      }

      return {
        getState: getState,
        subscribe: subscribe,
        dispose: dispose,
        loadState: loadState,
        applyStatePayload: applyStatePayload,
        selectPlugin: selectPlugin,
        getSelectedPlugin: getSelectedPlugin,
        setSearch: setSearch,
        updateForm: updateForm,
        scheduleDraft: scheduleDraft,
        flushDraft: flushDraft,
        runPreflight: runPreflight,
        aiSuggest: aiSuggest,
        runPublish: runPublish,
        cancel: cancel,
        rescan: rescan,
        saveToken: saveToken,
        detectToken: detectToken,
        clearToken: function clearToken() {
          return saveToken('')
        },
        saveSettings: saveSettings,
        savePlatforms: savePlatforms,
        verifyPlatform: verifyPlatform,
        saveNpmToken: saveNpmToken,
        detectNpmToken: detectNpmToken,
        checkRegistry: checkRegistry,
        startRegistry: startRegistry,
        checkRegistryOnLoad: checkRegistryOnLoad,
        bumpVersion: bumpVersion,
        checkSync: checkSync,
        syncBehindPlatforms: syncBehindPlatforms,
        togglePlatform: togglePlatform,
        selectedPlatforms: selectedPlatforms,
        formTargetLabel: formTargetLabel,
        setTab: setTab,
        readActiveTab: readActiveTab,
        clearHistory: clearHistory,
        openSettings: openSettings,
        closeSettings: closeSettings,
        dismissError: dismissError,
        showToast: showToast,
        clearToast: clearToast,
        refresh: function refresh() {
          return loadState({ silent: true })
        },
      }
    }
    // ══════════════════════════════════════════════════════════════════════
    // UI atoms
    // ══════════════════════════════════════════════════════════════════════
    const ICON_PATHS = {
      search: ['M7 2.6a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8z', 'M10.3 10.3 14 14'],
      refresh: ['M13 8a5 5 0 1 1-1.46-3.53', 'M13.2 2.4v3.1h-3.1'],
      settings: ['M8 5.7a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z', 'M8 1.6v1.8', 'M8 12.6v1.8', 'M1.6 8h1.8', 'M12.6 8h1.8', 'M3.5 3.5l1.3 1.3', 'M11.2 11.2l1.3 1.3', 'M12.5 3.5l-1.3 1.3', 'M4.8 11.2l-1.3 1.3'],
      copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
      external: ['M9.5 2.5h4v4', 'M13.5 2.5 7.8 8.2', 'M13 9.6v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3'],
      check: ['M3 8.5 6.2 11.7 13 4.5'],
      warn: ['M8 2.1 14.4 13.4H1.6z', 'M8 6.2v3.2', 'M8 11.3v.6'],
      fail: ['M8 2.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2z', 'M5.9 5.9l4.2 4.2', 'M10.1 5.9l-4.2 4.2'],
      close: ['M3.5 3.5 12.5 12.5', 'M12.5 3.5 3.5 12.5'],
      plus: ['M8 3v10', 'M3 8h10'],
      trash: ['M3 4.5h10', 'M6 4.5V3h4v1.5', 'M4.6 4.5l.6 8.5h5.6l.6-8.5'],
      folder: ['M2 3.5h4l1.3 1.5H14v7.5H2z'],
      branch: ['M4 3.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', 'M4 10.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', 'M4 5.8v4.4', 'M5.3 4.5H9a2.5 2.5 0 0 1 2.5 2.5v5'],
      code: ['M5.5 5 2.5 8l3 3', 'M10.5 5l3 3-3 3'],
      user: ['M8 2.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z', 'M3 13.4c0-2.3 2.2-3.9 5-3.9s5 1.6 5 3.9'],
      history: ['M8 2.2a5.8 5.8 0 1 1-5.4 3.9', 'M8 4.6V8l2.4 1.4', 'M2.4 2.6v3.4h3.4'],
      lock: ['M4 7.5h8v6H4z', 'M5.8 7.5V5.6a2.2 2.2 0 0 1 4.4 0v1.9'],
      play: ['M5 3.4 12.2 8 5 12.6z'],
      externalRepo: ['M2.5 3.5h5', 'M2.5 3.5v9h9v-5', 'M8.5 2.5h5v5', 'M13.5 2.5 6.8 9.2'],
      dot: ['M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'],
      spark: ['M8 1.9 9.4 6.6 14.1 8 9.4 9.4 8 14.1 6.6 9.4 1.9 8 6.6 6.6z'],
      chevron: ['M5 3.2 9.8 8 5 12.8'],
    }

    function Icon(props) {
      const p = props || {}
      const name = toText(p.name)
      const size = typeof p.size === 'number' && p.size > 0 ? p.size : 14
      const paths = ICON_PATHS[name] || ICON_PATHS.branch
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map(function renderPath(d, index) {
        return h('path', { key: String(index), d: d })
      }))
    }

    function Spinner() {
      return h('span', { className: 'dgp-spinner', 'aria-hidden': 'true' })
    }

    function Btn(props) {
      const p = props || {}
      const variant = p.variant || 'default'
      let className = 'dgp-btn'
      if (variant === 'primary') className += ' dgp-btn-primary'
      else if (variant === 'ghost') className += ' dgp-btn-ghost'
      else if (variant === 'danger') className += ' dgp-btn-danger'
      else if (variant === 'link') className += ' dgp-btn-link'
      if (p.className) className += ' ' + p.className
      const children = p.children !== undefined && p.children !== null ? p.children : null
      return h('button', {
        type: 'button',
        className: className,
        onClick: p.disabled === true ? undefined : p.onClick,
        disabled: p.disabled === true,
        title: p.title || undefined,
        'aria-label': p.ariaLabel || undefined,
      },
        p.busy === true ? h(Spinner, null) : (p.icon ? h(Icon, { name: p.icon, size: p.iconSize || 13 }) : null),
        children !== null ? h('span', { className: 'dgp-btn-label' }, children) : null)
    }

    function IconBtn(props) {
      const p = props || {}
      return h('button', {
        type: 'button',
        className: 'dgp-icon-btn' + (p.className ? ' ' + p.className : ''),
        title: p.title || p.ariaLabel || undefined,
        'aria-label': p.ariaLabel || p.title || undefined,
        disabled: p.disabled === true,
        onClick: p.disabled === true ? undefined : p.onClick,
      }, h(Icon, { name: p.icon || 'dot', size: typeof p.size === 'number' ? p.size : 13 }))
    }

    function Badge(props) {
      const p = props || {}
      return h('span', { className: 'dgp-badge', 'data-tone': p.tone || 'muted' }, p.children)
    }

    function Field(props) {
      const p = props || {}
      // A stable id per field so the message can be referenced by the control.
      const msgId = React.useMemo(function makeMsgId() {
        return 'dgp-field-msg-' + Math.random().toString(36).slice(2, 8)
      }, [])
      const message = p.error || p.hint || null
      const hint = message
        ? h('span', {
            className: p.error ? 'dgp-field-error' : 'dgp-field-hint',
            id: msgId,
          }, message)
        : null

      /*
       * Attach the description to the control itself. Without this a screen
       * reader reads "Owner, edit text" and never "this owner does not exist".
       * Cloning keeps every existing call site working and leaves controls that
       * carry their own aria attributes alone.
       */
      let children = p.children
      if (message && React.isValidElement) {
        /*
         * Attach the description to the actual control.
         *
         * Some fields pass a single input, some pass an array (input + action
         * button), some pass a wrapper. React.isValidElement is false for arrays,
         * which silently skipped every multi-child field — 4 message ids rendered
         * and 0 descriptions attached before this walked the tree.
         */
        const describe = function describe(node) {
          if (Array.isArray(node)) {
            let attached = false
            const mapped = node.map(function one(child, index) {
              const next = attached ? child : describe(child)
              if (next !== child) attached = true
              // A Field's children never reorder, so the index is a stable key —
              // React warns about unkeyed elements in an array rendered as siblings.
              if (React.isValidElement(next)) return React.cloneElement(next, { key: 'field-child-' + index })
              return next
            })
            return attached ? mapped : node
          }
          if (!React.isValidElement(node)) return node
          const props = node.props || {}
          const looksLikeControl = node.type === 'input'
            || node.type === 'select'
            || node.type === 'textarea'
            || typeof props.onChange === 'function'
            || props.value !== undefined
            || props['aria-describedby'] !== undefined
          if (looksLikeControl) {
            const existing = props['aria-describedby']
            return React.cloneElement(node, {
              'aria-describedby': existing ? existing + ' ' + msgId : msgId,
              'aria-invalid': p.error ? true : props['aria-invalid'],
            })
          }
          if (props.children !== undefined) {
            const inner = describe(props.children)
            if (inner !== props.children) return React.cloneElement(node, { children: inner })
          }
          return node
        }
        children = describe(p.children)
      }

      return h('div', { className: 'dgp-field' + (p.className ? ' ' + p.className : '') },
        h('div', { className: 'dgp-field-head' },
          h('label', { className: 'dgp-field-label', htmlFor: p.htmlFor || undefined }, p.label),
          p.optional ? h('span', { className: 'dgp-field-optional' }, t('common.optional')) : null),
        children,
        hint)
    }

    function TextInput(props) {
      const p = props || {}
      let className = 'dgp-input'
      if (p.mono) className += ' dgp-mono'
      if (p.invalid) className += ' dgp-input-invalid'
      return h('input', {
        className: className,
        type: p.type || 'text',
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        placeholder: p.placeholder || undefined,
        disabled: p.disabled === true,
        id: p.id || undefined,
        autoComplete: p.autoComplete || 'off',
        spellCheck: false,
        'aria-describedby': p['aria-describedby'] || undefined,
        'aria-invalid': p['aria-invalid'] || undefined,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      })
    }

    function TextArea(props) {
      const p = props || {}
      return h('textarea', {
        className: 'dgp-input dgp-textarea' + (p.invalid ? ' dgp-input-invalid' : ''),
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        placeholder: p.placeholder || undefined,
        disabled: p.disabled === true,
        id: p.id || undefined,
        rows: typeof p.rows === 'number' ? p.rows : 3,
        spellCheck: false,
        'aria-describedby': p['aria-describedby'] || undefined,
        'aria-invalid': p['aria-invalid'] || undefined,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      })
    }

    function Select(props) {
      const p = props || {}
      const options = Array.isArray(p.options) ? p.options : []
      return h('select', {
        className: 'dgp-input dgp-select',
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        disabled: p.disabled === true,
        id: p.id || undefined,
        'aria-describedby': p['aria-describedby'] || undefined,
        'aria-invalid': p['aria-invalid'] || undefined,
        onChange: function onChange(event) {
          if (typeof p.onChange === 'function') p.onChange(event && event.target ? event.target.value : '')
        },
      }, options.map(function renderOption(option) {
        return h('option', { key: String(option.value), value: String(option.value) }, option.label)
      }))
    }

    function Segmented(props) {
      const p = props || {}
      const options = Array.isArray(p.options) ? p.options : []
      return h('div', { className: 'dgp-seg', role: 'group', 'aria-label': p.label || undefined },
        options.map(function renderOption(option) {
          const on = option.value === p.value
          return h('button', {
            key: String(option.value),
            type: 'button',
            className: 'dgp-seg-btn',
            'data-on': on ? '1' : '0',
            'aria-pressed': on === true,
            disabled: p.disabled === true,
            title: option.hint || undefined,
            onClick: p.disabled === true || typeof p.onChange !== 'function'
              ? undefined
              : function selectOption() { p.onChange(option.value) },
          }, option.label)
        }))
    }

    function Toggle(props) {
      const p = props || {}
      const checked = p.checked === true
      const text = p.label
        ? h('span', { className: 'dgp-toggle-text' },
            h('span', { className: 'dgp-toggle-label' }, p.label),
            p.hint ? h('span', { className: 'dgp-toggle-hint' }, p.hint) : null)
        : null
      return h('button', {
        type: 'button',
        className: 'dgp-toggle' + (checked ? ' dgp-toggle-on' : ''),
        role: 'switch',
        'aria-checked': checked,
        'data-on': checked ? '1' : '0',
        disabled: p.disabled === true,
        onClick: p.disabled === true || typeof p.onChange !== 'function'
          ? undefined
          : function flip() { p.onChange(!checked) },
      },
        h('span', { className: 'dgp-toggle-track' }, h('span', { className: 'dgp-toggle-knob' })),
        text)
    }

    function ChipInput(props) {
      const p = props || {}
      const valueState = useState('')
      const draft = valueState[0]
      const setDraft = valueState[1]
      const topics = Array.isArray(p.value) ? p.value : []
      const disabled = p.disabled === true
      function addTopic() {
        const candidate = sanitizeTopics([draft])
        setDraft('')
        if (candidate.length === 0 || disabled) return
        const next = sanitizeTopics(topics.concat(candidate))
        if (next.length !== topics.length && typeof p.onChange === 'function') p.onChange(next)
      }
      return h('div', { id: p.id || undefined, className: 'dgp-chips' + (p.invalid ? ' dgp-chips-invalid' : '') },
        topics.length === 0
          ? h('span', { className: 'dgp-chips-empty' }, t('field.topicsEmpty'))
          : topics.map(function renderChip(topic, index) {
              return h('span', { key: topic + '-' + index, className: 'dgp-chip' },
                h('span', { className: 'dgp-chip-text' }, topic),
                h('button', {
                  type: 'button',
                  className: 'dgp-chip-x',
                  'aria-label': t('common.remove') + ' ' + topic,
                  disabled: disabled,
                  onClick: disabled || typeof p.onChange !== 'function'
                    ? undefined
                    : function remove() { p.onChange(topics.slice(0, index).concat(topics.slice(index + 1))) },
                }, h(Icon, { name: 'close', size: 9 })))
            }),
        h('input', {
          className: 'dgp-chip-input',
          value: draft,
          placeholder: p.placeholder || '',
          disabled: disabled,
          'aria-describedby': p['aria-describedby'] || undefined,
          'aria-invalid': p['aria-invalid'] || undefined,
          onChange: function onChange(event) { setDraft(event && event.target ? event.target.value : '') },
          onKeyDown: function onKeyDown(event) {
            if (!event || event.key !== 'Enter') return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            addTopic()
          },
        }))
    }

    function LinkOut(props) {
      const p = props || {}
      return h('a', {
        className: 'dgp-link' + (p.className ? ' ' + p.className : ''),
        href: p.href || undefined,
        target: '_blank',
        rel: 'noreferrer',
        title: p.title || undefined,
      }, p.children)
    }

    /**
     * A vertically stacked group of external links. Used wherever the answer to
     * “where do I get this credential?” is a URL — the token banner, the
     * settings account tab and the help tab all render this same component.
     */
    function HelpLinks(props) {
      const p = props || {}
      const items = Array.isArray(p.items) ? p.items.filter(function keep(item) {
        return item && toText(item.href) !== ''
      }) : []
      if (items.length === 0) return null
      return h('ul', { className: 'dgp-help-links' + (p.className ? ' ' + p.className : '') },
        items.map(function renderItem(item, index) {
          return h('li', { key: toText(item.href) + '-' + String(index), className: 'dgp-help-link' },
            h(LinkOut, { href: item.href, title: item.label },
              h(Icon, { name: 'external', size: 11 }),
              h('span', { className: 'dgp-help-link-label' }, item.label)))
        }))
    }

    function readGuideOpen() {
      return readStorage(STORAGE_GUIDE) !== '0'
    }

    /**
     * The onboarding card at the top of the publish page: three steps, each one
     * carrying both the external link that produces the credential and the
     * in-app shortcut that consumes it. The collapsed state is remembered.
     */
    function QuickStartCard(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const account = snapshot.account || normalizeAccount(null)
      const platforms = Array.isArray(snapshot.platforms) ? snapshot.platforms : []
      const links = helpLinks(snapshot.settings, platforms)
      const state = useState(readGuideOpen)
      const open = state[0]
      const setOpen = state[1]
      const npm = platforms.filter(function pickNpm(entry) {
        return entry && entry.id === 'npm'
      })[0] || null
      const plugin = findPlugin(snapshot.plugins, snapshot.selectedPath)
      const githubDone = account.connected === true
      const pluginDone = Boolean(plugin)
      const npmDone = Boolean(npm && npm.tokenConfigured === true)
      const busy = snapshot.scanBusy === true
      const steps = [
        {
          id: 'github',
          done: githubDone,
          title: t('guide.stepGithub'),
          detail: githubDone && account.login !== ''
            ? t('guide.stepGithubDone', { login: account.login })
            : t('guide.stepGithubDetail'),
          items: githubDone
            ? [{ href: links.githubTokens, label: t('token.manageGithub') }]
            : [
                { href: links.githubTokenClassic, label: t('token.generateClassic') },
                { href: links.githubTokenFine, label: t('token.generateFine') },
                { href: links.githubTokens, label: t('token.manageGithub') },
              ],
          action: {
            label: t('guide.openSettings'),
            icon: 'settings',
            onClick: function goSettings() { store.openSettings() },
          },
        },
        {
          id: 'plugin',
          done: pluginDone,
          title: t('guide.stepPlugin'),
          detail: pluginDone
            ? t('guide.stepPluginDone', { name: plugin.displayName || plugin.name || basename(plugin.path) })
            : t('guide.stepPluginDetail'),
          items: [],
          action: {
            label: t('guide.scan'),
            icon: 'refresh',
            busy: busy,
            disabled: busy,
            onClick: function rescanNow() { store.rescan() },
          },
        },
        {
          id: 'npm',
          done: npmDone,
          optional: true,
          title: t('guide.stepNpm'),
          detail: npmDone && npm.account && npm.account.login
            ? t('guide.stepNpmDone', { login: npm.account.login })
            : (links.npmCustomRegistry ? t('guide.stepNpmCustom', { registry: links.npmRegistry }) : t('guide.stepNpmDetail')),
          items: links.npmCustomRegistry
            ? [{ href: links.npmConsole, label: t('help.npmConsole') }]
            : [
                { href: links.npmToken, label: t('token.generateNpm') },
                { href: links.npmTokens, label: t('token.manageNpm') },
              ],
          action: {
            label: t('guide.openPlatforms'),
            icon: 'settings',
            onClick: function goPlatforms() { store.setTab('platforms') },
          },
        },
      ]
      const doneCount = steps.filter(function countDone(step) { return step.done }).length
      const allDone = doneCount === steps.length
      function toggle() {
        const next = !open
        setOpen(next)
        writeStorage(STORAGE_GUIDE, next ? '1' : '0')
      }
      return h('section', {
        className: 'dgp-card dgp-guide',
        'data-open': open ? '1' : '0',
        'data-done': allDone ? '1' : '0',
        'aria-label': t('guide.title'),
      },
        h('div', { className: 'dgp-guide-head' },
          h('span', { className: 'dgp-guide-icon' }, h(Icon, { name: allDone ? 'check' : 'spark', size: 16 })),
          h('div', { className: 'dgp-guide-heading' },
            h('h2', { className: 'dgp-guide-title' }, t('guide.title')),
            h('p', { className: 'dgp-guide-sub' },
              open ? t('guide.subtitle') : t('guide.progress', { done: doneCount, total: steps.length }))),
          h('span', { className: 'dgp-spacer' }),
          allDone
            ? h(Badge, { tone: 'success' }, t('guide.allDone'))
            : h(Badge, { tone: 'muted' }, t('guide.progress', { done: doneCount, total: steps.length })),
          h(Btn, {
            icon: open ? 'close' : 'play',
            ariaLabel: open ? t('guide.collapse') : t('guide.expand'),
            onClick: toggle,
          }, open ? t('guide.collapse') : t('guide.expand'))),
        open
          ? h('ol', { className: 'dgp-guide-steps' }, steps.map(function renderStep(step, index) {
              return h('li', { key: step.id, className: 'dgp-guide-step', 'data-done': step.done ? '1' : '0' },
                h('span', { className: 'dgp-guide-mark', 'aria-hidden': 'true' },
                  step.done ? h(Icon, { name: 'check', size: 11 }) : String(index + 1)),
                h('div', { className: 'dgp-guide-body' },
                  h('div', { className: 'dgp-guide-line' },
                    h('span', { className: 'dgp-guide-label' }, step.title),
                    step.optional ? h('span', { className: 'dgp-guide-tag' }, t('guide.optional')) : null,
                    step.done ? h('span', { className: 'dgp-guide-flag' }, t('guide.done')) : null),
                  h('p', { className: 'dgp-guide-detail' }, step.detail),
                  h('div', { className: 'dgp-guide-actions' },
                    h(HelpLinks, { items: step.items }),
                    step.action
                      ? h(Btn, {
                          icon: step.action.icon,
                          busy: step.action.busy === true,
                          disabled: step.action.disabled === true,
                          onClick: step.action.onClick,
                        }, step.action.label)
                      : null)))
            }))
          : null)
    }

    /**
     * A dialog that behaves like one.
     *
     * Three things a floating layer owes the user, none of which were here:
     *   · Esc closes it — only the backdrop and the X worked, so a keyboard user
     *     had no way out;
     *   · focus stays inside while open — otherwise Tab walks onto the page behind
     *     the backdrop, where the focus ring is invisible;
     *   · focus returns to whatever opened it, instead of resetting to the top of
     *     the document.
     *
     * The listener lives on document rather than on the dialog: a keydown inside a
     * child input never bubbles to a sibling that was never focused.
     */
    function Modal(props) {
      const p = props || {}
      const layerRef = React.useRef(null)
      const restoreRef = React.useRef(null)
      const titleId = React.useMemo(function makeId() {
        return 'dgp-modal-title-' + Math.random().toString(36).slice(2, 8)
      }, [])

      React.useEffect(function trapAndDismiss() {
        if (typeof document === 'undefined') return undefined
        restoreRef.current = document.activeElement

        function focusables() {
          const root = layerRef.current
          if (!root || typeof root.querySelectorAll !== 'function') return []
          const found = root.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
          )
          return Array.prototype.slice.call(found).filter(function visible(el) {
            return el.offsetParent !== null || el === document.activeElement
          })
        }

        function onKeyDown(event) {
          if (!event) return
          if (event.key === 'Escape') {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof p.onClose === 'function') p.onClose()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (layerRef.current && typeof layerRef.current.focus === 'function') layerRef.current.focus()
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || active === layerRef.current)) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            first.focus()
          }
        }

        document.addEventListener('keydown', onKeyDown, true)
        const items = focusables()
        if (items.length > 0 && typeof items[0].focus === 'function') items[0].focus()
        else if (layerRef.current && typeof layerRef.current.focus === 'function') layerRef.current.focus()

        return function release() {
          document.removeEventListener('keydown', onKeyDown, true)
          const back = restoreRef.current
          if (back && typeof back.focus === 'function' && typeof document.contains === 'function' && document.contains(back)) {
            back.focus()
          }
        }
      }, [p.onClose])

      return h('div', {
        className: 'dgp-modal-layer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        tabIndex: -1,
        ref: layerRef,
      },
        h('div', { className: 'dgp-modal-backdrop', onClick: p.onClose || undefined, 'aria-hidden': 'true' }),
        h('div', { className: 'dgp-modal' },
          h('div', { className: 'dgp-modal-head' },
            h('h2', { className: 'dgp-modal-title', id: titleId }, p.title || ''),
            h('span', { className: 'dgp-spacer' }),
            h(IconBtn, { icon: 'close', title: t('common.close'), onClick: p.onClose || undefined })
          ),
          h('div', { className: 'dgp-modal-body' }, p.children),
          p.footer ? h('div', { className: 'dgp-modal-foot' }, p.footer) : null))
    }

    function EmptyState(props) {
      const p = props || {}
      return h('div', { className: 'dgp-empty' },
        h('div', { className: 'dgp-empty-icon' }, h(Icon, { name: p.icon || 'folder', size: 22 })),
        h('p', { className: 'dgp-empty-title' }, p.title || ''),
        p.body ? h('p', { className: 'dgp-empty-body' }, p.body) : null,
        p.hint ? h('p', { className: 'dgp-empty-hint' }, p.hint) : null,
        p.action ? h('div', { className: 'dgp-empty-actions' }, p.action) : null)
    }

    function ErrorBar(props) {
      const p = props || {}
      const error = p.error
      if (!error) return null
      const tokenRelated = isTokenError(error)
      return h('div', { className: 'dgp-errorbar', role: 'alert' },
        h('span', { className: 'dgp-errorbar-icon' }, h(Icon, { name: 'fail', size: 14 })),
        h('div', { className: 'dgp-errorbar-body' },
          h('div', { className: 'dgp-errorbar-msg' }, toText(error.message) !== '' ? toText(error.message) : t('error.network')),
          h('div', { className: 'dgp-errorbar-meta' },
            toText(error.code) !== '' ? h('span', { className: 'dgp-mono dgp-errorbar-code' }, toText(error.code)) : null,
            tokenRelated ? h('span', { className: 'dgp-errorbar-hint' }, t('error.tokenRelated')) : null)),
        tokenRelated && typeof p.onOpenSettings === 'function'
          ? h('button', { type: 'button', className: 'dgp-btn dgp-btn-ghost', onClick: p.onOpenSettings }, h('span', { className: 'dgp-btn-label' }, t('error.goSettings')))
          : null,
        h(IconBtn, { icon: 'close', title: t('common.dismiss'), onClick: p.onDismiss || undefined }))
    }

    function Toast(props) {
      const p = props || {}
      const toast = p.toast
      if (!toast) return null
      return h('div', { className: 'dgp-toast', 'data-tone': toast.tone || 'info', role: 'status' },
        h('span', { className: 'dgp-toast-text' }, toast.message),
        h(IconBtn, { icon: 'close', title: t('common.dismiss'), onClick: p.onDismiss || undefined }))
    }

    /**
     * Card with an optional collapsible body.
     *
     * `collapsible` adds a disclosure button in the header. When collapsed the
     * header still shows `summary` (a short line of live values) so the card
     * keeps telling you what is configured without occupying the page.
     *
     * `forceOpen` overrides the saved state — used when a platform has a
     * blocking problem, because hiding the very fields that must be fixed is
     * worse than a tall page.
     */
    function SectionCard(props) {
      const p = props || {}
      const storageKey = p.storageKey ? 'dsh-github-publisher.collapse:' + p.storageKey : null
      const readOpen = function readOpen() {
        if (p.forceOpen === true) return true
        if (storageKey === null) return p.defaultOpen !== false
        const saved = readStorage(storageKey)
        if (saved === '0') return false
        if (saved === '1') return true
        return p.defaultOpen !== false
      }
      const openState = useState(readOpen)
      const open = openState[0]
      const setOpen = openState[1]
      useEffect(function syncForceOpen() {
        if (p.forceOpen === true && !open) setOpen(true)
      }, [p.forceOpen === true])
      const collapsible = p.collapsible === true
      // `aria-controls` needs a real id on the body, so derive one from the
      // storage key when the caller did not supply an explicit section id.
      const bodyId = p.id
        ? p.id + '-body'
        : (p.storageKey ? 'dgp-card-' + String(p.storageKey).replace(/[^a-zA-Z0-9_-]+/g, '-') + '-body' : undefined)
      function toggle() {
        setOpen(function next(current) {
          const nextValue = !current
          if (storageKey !== null) writeStorage(storageKey, nextValue ? '1' : '0')
          return nextValue
        })
      }
      const summary = collapsible && !open && p.summary ? p.summary : null
      return h('section', {
        id: p.id || undefined,
        className: 'dgp-card' + (p.className ? ' ' + p.className : '') + (collapsible ? ' dgp-card-collapsible' : ''),
        'data-open': collapsible ? (open ? '1' : '0') : undefined,
      },
        h('div', { className: 'dgp-card-head' },
          h('div', { className: 'dgp-card-heading' },
            h('h2', { className: 'dgp-card-title' },
              collapsible
                ? h('button', {
                    type: 'button',
                    className: 'dgp-card-toggle',
                    'aria-expanded': open ? 'true' : 'false',
                    'aria-controls': bodyId,
                    title: open ? t('common.collapse') : t('common.expand'),
                    onClick: toggle,
                  },
                    h(Icon, { name: 'chevron', size: 12 }),
                    h('span', null, p.title))
                : p.title),
            summary
              ? h('p', { className: 'dgp-card-sum' }, summary)
              : (p.subtitle ? h('p', { className: 'dgp-card-sub' }, p.subtitle) : null),
            collapsible && open && p.subtitle ? h('p', { className: 'dgp-card-sub' }, p.subtitle) : null),
          h('div', { className: 'dgp-card-actions' },
            p.actions || null,
            collapsible
              ? h('button', {
                  type: 'button',
                  className: 'dgp-btn dgp-btn-ghost dgp-card-toggle-btn',
                  'aria-expanded': open ? 'true' : 'false',
                  'aria-controls': bodyId,
                  onClick: toggle,
                }, open ? t('common.collapse') : t('common.expand'))
              : null)),
        collapsible && !open ? null : h('div', { className: 'dgp-card-body', id: bodyId }, p.children))
    }

    function KVGrid(props) {
      const p = props || {}
      const rows = Array.isArray(p.rows) ? p.rows : []
      return h('dl', { className: 'dgp-kv' }, rows.map(function renderRow(row, index) {
        if (!row) return null
        const content = row.href
          ? h(LinkOut, { href: row.href, className: 'dgp-kv-link' }, row.value)
          : h('span', { className: row.mono ? 'dgp-mono' : '' }, row.value)
        return h('div', {
          key: String(index),
          className: 'dgp-kv-row',
          'data-tone': row.tone || undefined,
        },
          h('dt', { className: 'dgp-kv-label' }, row.label),
          h('dd', { className: 'dgp-kv-value' }, content))
      }))
    }

    // ══════════════════════════════════════════════════════════════════════
    // Clipboard
    // ══════════════════════════════════════════════════════════════════════
    function copyText(text) {
      const value = toText(text)
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return Promise.resolve(navigator.clipboard.writeText(value)).then(function copied() {
            return true
          }, function copyFailed() {
            return false
          })
        }
      } catch (error) {
        return Promise.resolve(false)
      }
      return Promise.resolve(false)
    }

    // ══════════════════════════════════════════════════════════════════════
    // Header and left sidebar
    // ══════════════════════════════════════════════════════════════════════
    function Header(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const account = snapshot.account || normalizeAccount(null)
      const connected = account.connected === true
      const scanBusy = snapshot.scanBusy === true
      const publishing = snapshot.publishing === true
      const accountLabel = connected && account.login !== ''
        ? t('header.accountConnected', { login: account.login })
        : t('header.accountDisconnected')
      return h('header', { className: 'dgp-header' },
        h('span', { className: 'dgp-brand' }, h(Icon, { name: 'branch', size: 17 })),
        h('div', { className: 'dgp-head-text' },
          h('h1', { className: 'dgp-title' }, t('panel.title')),
          h('p', { className: 'dgp-sub' }, t('panel.subtitle'))),
        h('span', { className: 'dgp-spacer' }),
        h('button', {
          type: 'button',
          className: 'dgp-account' + (connected ? ' dgp-account-on' : ' dgp-account-off'),
          title: t('settings.title'),
          onClick: function openAccountSettings() { store.openSettings() },
        },
          h('span', { className: 'dgp-account-dot', 'data-on': connected ? '1' : '0' }),
          h('span', { className: 'dgp-account-label' }, accountLabel),
          connected && account.validated === false
            ? h('span', { className: 'dgp-account-warn' }, t('header.accountUnvalidated'))
            : null),
        h('button', {
          type: 'button',
          className: 'dgp-btn dgp-header-btn',
          disabled: scanBusy || publishing,
          onClick: function rescan() { store.rescan() },
        },
          scanBusy ? h(Spinner, null) : h(Icon, { name: 'refresh', size: 13 }),
          h('span', { className: 'dgp-btn-label' }, scanBusy ? t('header.scanning') : t('header.rescan'))),
        h('button', {
          type: 'button',
          className: 'dgp-btn dgp-header-btn',
          onClick: function openSettings() { store.openSettings() },
        },
          h(Icon, { name: 'settings', size: 13 }),
          h('span', { className: 'dgp-btn-label' }, t('header.settings'))))
    }

    function PluginRow(props) {
      const p = props || {}
      const plugin = p.plugin || {}
      const badges = []
      if (plugin.published) badges.push({ key: 'published', tone: 'success', text: t('badge.published') })
      else badges.push({ key: 'unpublished', tone: 'muted', text: t('badge.unpublished') })
      if (plugin.hasReadme !== true) badges.push({ key: 'readme', tone: 'warn', text: t('badge.noReadme') })
      if (p.connected !== true) badges.push({ key: 'token', tone: 'danger', text: t('badge.noToken') })
      return h('button', {
        type: 'button',
        role: 'listitem',
        className: 'dgp-plugin-row' + (p.selected === true ? ' dgp-plugin-row-on' : ''),
        'aria-pressed': p.selected === true,
        disabled: p.disabled === true,
        onClick: p.disabled === true || typeof p.onSelect !== 'function'
          ? undefined
          : function select() { p.onSelect() },
      },
        h('span', { className: 'dgp-plugin-icon' }, h(Icon, { name: 'code', size: 15 })),
        h('span', { className: 'dgp-plugin-main' },
          h('span', { className: 'dgp-plugin-name' }, plugin.displayName || plugin.name || basename(plugin.path)),
          // Whose plugin this is, one line, above the path — so a list of similar
          // names cannot be mistaken for one another.
          h('span', {
            className: 'dgp-plugin-author' + (plugin.authorName !== '' || plugin.authorEmail !== '' ? '' : ' dgp-plugin-author-none'),
            title: plugin.author !== '' ? plugin.author : t('plugin.noAuthor'),
          }, h(Icon, { name: 'user', size: 10 }), plugin.authorName !== '' ? plugin.authorName : (plugin.authorEmail !== '' ? plugin.authorEmail : t('plugin.noAuthor'))),
          h('span', { className: 'dgp-plugin-meta' },
            h('span', { className: 'dgp-plugin-ver' }, plugin.version !== '' ? t('plugin.version', { version: plugin.version }) : ''),
            h('span', { className: 'dgp-plugin-path' }, plugin.path))),
        h('span', { className: 'dgp-plugin-badges' }, badges.map(function renderBadge(badge) {
          return h(Badge, { key: badge.key, tone: badge.tone }, badge.text)
        })))
    }

    function HistoryList(props) {
      const p = props || {}
      const history = Array.isArray(p.history) ? p.history.slice(0, 8) : []
      return h('div', { className: 'dgp-history' },
        h('div', { className: 'dgp-history-head' },
          h(Icon, { name: 'history', size: 12 }),
          h('span', { className: 'dgp-history-title' }, t('left.recent'))),
        history.length === 0
          ? h('p', { className: 'dgp-history-empty' }, t('left.recentEmpty'))
          : history.map(function renderEntry(entry, index) {
              return h('a', {
                key: entry.id !== '' ? entry.id : (entry.repoUrl || entry.name) + '@' + entry.at + '-' + index,
                className: 'dgp-history-row',
                href: entry.repoUrl || undefined,
                target: '_blank',
                rel: 'noreferrer',
                title: entry.repoUrl !== '' ? t('left.openHistory') + ' — ' + entry.repoUrl : entry.name,
              },
                h('span', { className: 'dgp-history-dot', 'data-status': entry.status }),
                h('span', { className: 'dgp-history-name' }, entry.repo !== '' ? entry.owner + '/' + entry.repo : entry.name),
                entry.version !== '' ? h('span', { className: 'dgp-history-ver' }, t('plugin.version', { version: entry.version })) : null,
                entry.dryRun ? h('span', { className: 'dgp-history-dry' }, t('option.dryRun')) : null,
                h('span', { className: 'dgp-history-time' }, formatRelativeTime(entry.at)))
            }))
    }

    function LeftPane(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const plugins = Array.isArray(snapshot.plugins) ? snapshot.plugins : []
      const filtered = filterPlugins(plugins, snapshot.search)
      const account = snapshot.account || normalizeAccount(null)
      const publishing = snapshot.publishing === true
      const scanWarnings = Array.isArray(snapshot.scanWarnings) ? snapshot.scanWarnings : []
      return h('aside', { className: 'dgp-left' },
        h('div', { className: 'dgp-search' },
          h(Icon, { name: 'search', size: 13 }),
          h('input', {
            className: 'dgp-search-input',
            type: 'search',
            value: snapshot.search || '',
            placeholder: t('left.searchPlaceholder'),
            'aria-label': t('left.searchPlaceholder'),
            onChange: function onSearch(event) { store.setSearch(event && event.target ? event.target.value : '') },
          })),
        h('div', { className: 'dgp-left-meta' },
          h('span', { className: 'dgp-left-count' }, t('left.count', { n: plugins.length })),
          snapshot.search ? h('span', { className: 'dgp-left-count' }, t('left.filtered', { n: filtered.length, total: plugins.length })) : null),
        plugins.length === 0
          ? h('div', { className: 'dgp-left-empty' },
              h(EmptyState, {
                icon: 'folder',
                title: t('left.emptyTitle'),
                body: t('left.emptyBody'),
                action: h(Btn, {
                  variant: 'primary',
                  icon: 'refresh',
                  busy: snapshot.scanBusy === true,
                  disabled: snapshot.scanBusy === true,
                  onClick: function scan() { store.rescan() },
                }, t('left.scan')),
              }))
          : filtered.length === 0
            ? h('p', { className: 'dgp-left-nomatch' }, t('left.noMatch'))
            : h('div', { className: 'dgp-plugin-list', role: 'list' }, filtered.map(function renderRow(plugin) {
                return h(PluginRow, {
                  key: plugin.path,
                  plugin: plugin,
                  selected: plugin.path === snapshot.selectedPath,
                  connected: account.connected === true,
                  disabled: publishing,
                  onSelect: function select() { store.selectPlugin(plugin.path) },
                })
              })),
        scanWarnings.length > 0
          ? h('div', { className: 'dgp-scan-warn' }, scanWarnings.slice(0, 3).map(function renderWarning(warning, index) {
              return h('p', { key: String(index), className: 'dgp-scan-warn-line' }, warning)
            }))
          : null,
        h(HistoryList, { history: snapshot.history }))
    }
    // ══════════════════════════════════════════════════════════════════════
    // Right column — selected plugin, token banner, forms, preview, preflight
    // ══════════════════════════════════════════════════════════════════════
    function PluginHead(props) {
      const p = props || {}
      const plugin = p.plugin || {}
      const store = p.store
      const publishing = p.publishing === true
      const published = plugin.published
      const ownership = p.ownership || null
      function copyPath() {
        copyText(plugin.path).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      // The author is the one fact that answers "am I about to publish somebody
      // else's work?", so it gets a highlighted chip, not grey small print.
      const authorLabel = plugin.authorName !== ''
        ? plugin.authorName
        : plugin.authorEmail !== '' ? plugin.authorEmail : t('plugin.noAuthor')
      const authorChip = h('span', {
        className: 'dgp-author-chip' + (plugin.authorName === '' && plugin.authorEmail === '' ? ' dgp-author-chip-none' : ''),
        title: plugin.author !== '' ? plugin.author : t('plugin.noAuthor'),
        'aria-label': t('plugin.authorAria', { author: authorLabel }),
      },
        h(Icon, { name: 'user', size: 11 }),
        h('span', { className: 'dgp-author-chip-label' }, t('plugin.authorLabel')),
        h('span', { className: 'dgp-author-chip-name' }, authorLabel))
      const ownershipBadge = ownership
        ? ownership.confirmed === true
          ? h(Badge, { tone: 'success' }, t('plugin.ownConfirmed'))
          : ownership.status === 'own'
            ? h(Badge, { tone: 'success' }, t('plugin.ownMatch'))
            : ownership.status === 'fork'
              ? h(Badge, { tone: 'warn' }, t('plugin.ownFork'))
              : ownership.status === 'foreign'
                ? h(Badge, { tone: 'warn' }, t('plugin.ownForeign'))
                : h(Badge, { tone: 'muted' }, t('plugin.ownNone'))
        : null
      return h('div', { className: 'dgp-plugin-head' },
        h('span', { className: 'dgp-plugin-head-icon' }, h(Icon, { name: 'code', size: 18 })),
        h('div', { className: 'dgp-plugin-head-main' },
          h('div', { className: 'dgp-plugin-head-line' },
            h('h2', { className: 'dgp-plugin-head-name' }, plugin.displayName || plugin.name || basename(plugin.path)),
            plugin.version !== '' ? h('span', { className: 'dgp-plugin-head-ver' }, t('plugin.version', { version: plugin.version })) : null,
            authorChip,
            ownershipBadge,
            plugin.license !== '' ? h(Badge, { tone: 'muted' }, t('plugin.license', { license: plugin.license })) : null,
            plugin.hasReadme !== true ? h(Badge, { tone: 'warn' }, t('badge.noReadme')) : null,
            published && published.repoUrl
              ? h(LinkOut, { href: published.repoUrl, className: 'dgp-plugin-head-link' }, t('badge.published'))
              : null),
          h('div', { className: 'dgp-plugin-head-meta' },
            h('span', { className: 'dgp-plugin-head-path dgp-mono' }, plugin.path),
            h('button', {
              type: 'button',
              className: 'dgp-link dgp-copy-path',
              disabled: publishing,
              onClick: publishing ? undefined : copyPath,
            }, h(Icon, { name: 'copy', size: 11 }), t('plugin.copyPath')))),
        published && published.lastPublishedAt
          ? h('span', { className: 'dgp-plugin-head-published' }, t('plugin.published', { version: toText(published.lastVersion) }))
          : null)
    }

    function TokenBanner(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const account = snapshot.account || normalizeAccount(null)
      const saving = snapshot.savingToken === true
      const detecting = snapshot.detectingToken === true
      const tokenState = useState('')
      const token = tokenState[0]
      const setToken = tokenState[1]
      const tokenError = snapshot.error && isTokenError(snapshot.error) ? snapshot.error : null
      const warnings = Array.isArray(snapshot.tokenWarnings) ? snapshot.tokenWarnings : []
      const links = helpLinks(snapshot.settings, snapshot.platforms)
      function save() {
        if (toText(token).trim() === '') {
          store.showToast(t('token.placeholder'), 'warn')
          return
        }
        store.saveToken(token).then(function onSaved(ok) {
          if (ok) setToken('')
        })
      }
      return h('section', { className: 'dgp-card dgp-token-banner' },
        h('div', { className: 'dgp-token-head' },
          h('span', { className: 'dgp-token-icon' }, h(Icon, { name: 'lock', size: 16 })),
          h('div', { className: 'dgp-token-heading' },
            h('h2', { className: 'dgp-card-title' }, t('token.title')),
            h('p', { className: 'dgp-card-sub' }, t('token.body')))),
        h('div', { className: 'dgp-token-form' },
          h(TextInput, {
            type: 'password',
            value: token,
            placeholder: t('token.placeholder'),
            autoComplete: 'off',
            onChange: function onChange(value) { setToken(value) },
          }),
          h(Btn, {
            variant: 'primary',
            icon: 'check',
            busy: saving,
            disabled: saving || detecting,
            onClick: save,
          }, saving ? t('token.saving') : t('token.save')),
          h(Btn, {
            icon: 'search',
            busy: detecting,
            disabled: saving || detecting,
            onClick: function detect() { store.detectToken(false) },
          }, detecting ? t('token.detecting') : t('token.detect'))),
        h('div', { className: 'dgp-token-hint' },
          h('div', { className: 'dgp-token-perm' },
            h('span', { className: 'dgp-token-perm-title' }, t('token.permissionsTitle')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionClassic')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionFine'))),
          h('div', { className: 'dgp-token-links' },
            h(LinkOut, {
              href: links.githubTokenClassic,
              className: 'dgp-token-generate',
              title: t('token.newTabHint'),
            }, h(Icon, { name: 'external', size: 11 }), t('token.generateClassic')),
            h(LinkOut, {
              href: links.githubTokenFine,
              className: 'dgp-token-generate',
              title: t('token.newTabHint'),
            }, h(Icon, { name: 'external', size: 11 }), t('token.generateFine')),
            h(LinkOut, {
              href: links.githubTokens,
              className: 'dgp-token-generate',
              title: t('token.newTabHint'),
            }, h(Icon, { name: 'external', size: 11 }), t('token.manageGithub')))),
        tokenError ? h('p', { className: 'dgp-token-error' }, tokenError.message) : null,
        warnings.length > 0
          ? h('ul', { className: 'dgp-token-warnings' }, warnings.map(function renderWarning(warning, index) {
              return h('li', { key: String(index), className: 'dgp-token-warning' }, warning)
            }))
          : null,
        account.tokenHint !== '' ? h('p', { className: 'dgp-token-current' }, t('token.hint', { hint: account.tokenHint })) : null)
    }

    function FormSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const form = snapshot.form || normalizeForm(null)
      const errors = snapshot.formErrors || {}
      const disabled = p.disabled === true
      const licenseOptions = LICENSE_IDS.map(function licenseOption(id) {
        return { value: id, label: id === 'none' ? t('field.licenseNone') : id }
      })
      const aiAvailable = Boolean(snapshot.capabilities && snapshot.capabilities.ai === true)
      const aiBusy = snapshot.aiBusy === true
      return h(SectionCard, {
        title: t('section.publishInfo'),
        id: 'dgp-section-publish',
        actions: aiAvailable
          ? h(Btn, {
              variant: 'secondary',
              icon: 'spark',
              busy: aiBusy,
              disabled: disabled || aiBusy,
              title: t('ai.hint'),
              onClick: function aiFill() { if (store && typeof store.aiSuggest === 'function') store.aiSuggest() },
            }, aiBusy ? t('ai.busy') : t('ai.button'))
          : null,
      },
        snapshot.aiError
          ? h('p', { className: 'dgp-ai-error', role: 'status' }, snapshot.aiError.message)
          : null,
        h('div', { className: 'dgp-form-grid' },
          h(Field, {
            label: t('field.owner'),
            hint: t('field.ownerHint'),
            error: errors.owner || null,
            htmlFor: 'dgp-field-owner',
          }, h(TextInput, {
            id: 'dgp-field-owner',
            value: form.owner,
            invalid: Boolean(errors.owner),
            placeholder: t('field.ownerPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ owner: value }) },
          })),
          h(Field, {
            label: t('field.name'),
            hint: t('field.nameHint'),
            error: errors.name || null,
            htmlFor: 'dgp-field-name',
          }, h(TextInput, {
            id: 'dgp-field-name',
            value: form.name,
            invalid: Boolean(errors.name),
            placeholder: t('field.namePlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ name: value }) },
          })),
          h(Field, {
            label: t('field.description'),
            hint: t('field.descriptionHint'),
            error: errors.description || null,
            htmlFor: 'dgp-field-description',
            className: 'dgp-span-2',
          }, h(TextArea, {
            id: 'dgp-field-description',
            value: form.description,
            rows: 2,
            invalid: Boolean(errors.description),
            placeholder: t('field.descriptionPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ description: value }) },
          })),
          h(Field, {
            label: t('field.descriptionZh'),
            optional: true,
            htmlFor: 'dgp-field-description-zh',
            className: 'dgp-span-2',
          }, h(TextArea, {
            id: 'dgp-field-description-zh',
            value: form.descriptionZh,
            rows: 2,
            placeholder: t('field.descriptionZhPlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ descriptionZh: value }) },
          })),
          h(Field, {
            label: t('field.homepage'),
            optional: true,
            htmlFor: 'dgp-field-homepage',
            className: 'dgp-span-2',
          }, h(TextInput, {
            id: 'dgp-field-homepage',
            value: form.homepage,
            placeholder: t('field.homepagePlaceholder'),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ homepage: value }) },
          })),
          h(Field, {
            label: t('field.topics'),
            hint: t('field.topicsHint'),
            error: errors.topics || null,
            className: 'dgp-span-2',
          }, h(ChipInput, {
            id: 'dgp-field-topics',
            value: form.topics,
            placeholder: t('field.topicPlaceholder'),
            invalid: Boolean(errors.topics),
            disabled: disabled,
            onChange: function onChange(topics) { store.updateForm({ topics: topics }) },
          })),
          h(Field, { label: t('field.visibility') },
            h(Segmented, {
              label: t('field.visibility'),
              value: form.visibility,
              disabled: disabled,
              options: [
                { value: 'public', label: t('field.public') },
                { value: 'private', label: t('field.private') },
              ],
              onChange: function onChange(value) { store.updateForm({ visibility: value }) },
            })),
          h(Field, { label: t('field.license') },
            h(Select, {
              value: form.license,
              disabled: disabled,
              options: licenseOptions,
              onChange: function onChange(value) { store.updateForm({ license: value }) },
            })),
          h(Field, { label: t('field.branch'), error: errors.branch || null },
            h(TextInput, {
              value: form.branch,
              invalid: Boolean(errors.branch),
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ branch: value }) },
            })),
          h(Field, {
            label: t('field.tagPrefix'),
            error: errors.tagPrefix || null,
          }, h(TextInput, {
            value: form.tagPrefix,
            invalid: Boolean(errors.tagPrefix),
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ tagPrefix: value }) },
          }))))
    }

    function OptionsSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const form = snapshot.form || normalizeForm(null)
      const disabled = p.disabled === true
      const advancedState = useState(false)
      const advanced = advancedState[0]
      const setAdvanced = advancedState[1]
      const toggles = [
        { key: 'addReadme', label: t('option.addReadme'), checked: form.addReadme },
        { key: 'addLicense', label: t('option.addLicense'), checked: form.addLicense },
        { key: 'addGitignore', label: t('option.addGitignore'), checked: form.addGitignore },
        { key: 'updatePackageJson', label: t('option.updatePackageJson'), checked: form.updatePackageJson },
        { key: 'createRelease', label: t('option.createRelease'), checked: form.createRelease },
        { key: 'dryRun', label: t('option.dryRun'), hint: t('option.dryRunHint'), checked: form.dryRun },
      ]
      const toggleNodes = toggles.map(function renderToggle(item) {
        const patch = {}
        patch[item.key] = !item.checked
        return h(Toggle, {
          key: item.key,
          checked: item.checked,
          label: item.label,
          hint: item.hint || null,
          disabled: disabled,
          onChange: function onChange() { store.updateForm(patch) },
        })
      })
      return h(SectionCard, {
        id: 'dgp-section-options',
        title: t('section.options'),
        actions: h(Btn, {
          variant: 'ghost',
          onClick: function flipAdvanced() { setAdvanced(!advanced) },
        }, advanced ? t('option.advancedHide') : t('option.advancedShow')),
      },
        h('div', { className: 'dgp-toggle-grid' }, toggleNodes),
        form.addReadme
          ? h('div', { className: 'dgp-option-row' },
              h(Field, { label: t('field.readmeMode'), hint: t('field.readmeModeHint') },
                h(Segmented, {
                  label: t('field.readmeMode'),
                  value: form.readmeMode,
                  disabled: disabled,
                  options: [
                    { value: 'auto', label: t('field.readmeAuto') },
                    { value: 'append', label: t('field.readmeAppend') },
                    { value: 'regenerate', label: t('field.readmeRegenerate') },
                  ],
                  onChange: function onChange(value) { store.updateForm({ readmeMode: value }) },
                })))
          : null,
        h('div', { className: 'dgp-option-row' },
          h(Field, { label: t('field.repoStrategy') },
            h(Segmented, {
              label: t('field.repoStrategy'),
              value: form.repoExistsStrategy,
              disabled: disabled,
              options: [
                { value: 'reuse', label: t('field.repoReuse') },
                { value: 'error', label: t('field.repoError') },
              ],
              onChange: function onChange(value) { store.updateForm({ repoExistsStrategy: value }) },
            }))),
        h('div', { className: 'dgp-form-grid' },
          h(Field, {
            label: t('field.commitMessage'),
            hint: t('field.commitHint'),
            className: 'dgp-span-2',
          }, h(TextInput, {
            value: form.commitMessage,
            disabled: disabled,
            onChange: function onChange(value) { store.updateForm({ commitMessage: value }) },
          })),
          h(Field, { label: t('field.authorName'), optional: true },
            h(TextInput, {
              value: form.authorName,
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ authorName: value }) },
            })),
          h(Field, { label: t('field.authorEmail'), optional: true },
            h(TextInput, {
              type: 'email',
              value: form.authorEmail,
              disabled: disabled,
              onChange: function onChange(value) { store.updateForm({ authorEmail: value }) },
            }))),
        advanced
          ? h('div', { className: 'dgp-advanced' },
              h('div', { className: 'dgp-toggle-grid' },
                h(Toggle, {
                  checked: form.forceWithLease,
                  label: t('option.forceWithLease'),
                  hint: t('option.forceWithLeaseHint'),
                  disabled: disabled,
                  onChange: function onChange() { store.updateForm({ forceWithLease: !form.forceWithLease }) },
                })),
              h(Field, {
                label: t('field.releaseNotes'),
                hint: t('field.releaseNotesPlaceholder'),
              }, h(TextArea, {
                value: form.releaseNotes,
                rows: 2,
                disabled: disabled,
                placeholder: t('field.releaseNotesPlaceholder'),
                onChange: function onChange(value) { store.updateForm({ releaseNotes: value }) },
              })))
          : null)
    }

    // ══════════════════════════════════════════════════════════════════════
    // Platforms — the tick-box matrix on the publish page, the config page,
    // and the version-sync matrix.
    // ══════════════════════════════════════════════════════════════════════

    /** Small platform glyph: GitHub gets the mark, npm a package box. */
    /** Per-hosting glyphs so four cards are distinguishable at a glance. */
    const PLATFORM_GLYPH_PATHS = {
      github: [
        ['trunk', 'M5 12.2V4.4'],
        ['branch', 'M5 8.4c0-1.9 1.5-3.4 3.4-3.4h1.2'],
        ['arrow', 'M11.9 12V4.9'],
        ['head', 'M9.6 7.1 11.9 4.8l2.3 2.3'],
      ],
      // Gitee: a rounded square with a dot, echoing its mark without copying it.
      gitee: [
        ['box', 'M3.2 3.2h9.6v9.6H3.2z'],
        ['tail', 'M3.2 8h9.6'],
        ['dot', 'M6.2 5.6h3.6'],
      ],
      // Codeberg: stacked bars, standing for a forge/planet motif.
      codeberg: [
        ['bar1', 'M2.8 9.6h10.4'],
        ['bar2', 'M2.8 6.4h10.4'],
        ['bar3', 'M2.8 3.2h6.4'],
      ],
    }

    function PlatformGlyph(props) {
      const p = props || {}
      const id = toText(p.id)
      const size = typeof p.size === 'number' && p.size > 0 ? p.size : 15
      if (id === 'npm') {
        return h('svg', {
          viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
        }, [
          h('path', { key: 'box', d: 'M2.4 4.6 8 1.8l5.6 2.8v6.8L8 14.2 2.4 11.4z' }),
          h('path', { key: 'seam', d: 'M2.4 4.6 8 7.4l5.6-2.8' }),
          h('path', { key: 'drop', d: 'M8 7.4v6.8' }),
        ])
      }
      const paths = PLATFORM_GLYPH_PATHS[id] || PLATFORM_GLYPH_PATHS.github
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      }, paths.map(function toPath(entry) {
        return h('path', { key: entry[0], d: entry[1] })
      }))
    }

    /**
     * The publish page's platform tick-box matrix. Each row: a checkbox bound to
     * `form.platforms`, the platform identity, its credential state, and — once
     * ticked — that platform's own overrides (npm access / dist-tag / OTP).
     */
    function PlatformPicker(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const form = snapshot.form || normalizeForm(null)
      const platforms = Array.isArray(snapshot.platforms) ? snapshot.platforms : []
      const disabled = p.disabled === true
      const selected = Array.isArray(form.platforms) ? form.platforms : []
      if (platforms.length === 0) {
        return h(SectionCard, { title: t('platform.title') },
          h('p', { className: 'dgp-muted' }, t('platform.empty')))
      }
      const rows = platforms.map(function renderRow(entry) {
        const ticked = selected.indexOf(entry.id) >= 0
        const npmEntry = entry.id === 'npm'
        const isHosting = HOSTING_IDS.indexOf(entry.id) >= 0
        // Each entry carries its own credential state from the Host: `npm`
        // reports tokenConfigured/tokenAvailable, GitHub reports the account
        // connection, and Gitee/Codeberg report their own token. Reading them
        // uniformly here is what lets one card layout serve four hostings.
        const credentialsOk = npmEntry
          ? entry.tokenConfigured === true || entry.tokenAvailable === true
          : isHosting && entry.id !== 'github'
            ? entry.tokenConfigured === true
            : (snapshot.account && snapshot.account.connected === true)
        const badges = []
        if (!ticked) badges.push({ key: 'off', tone: 'muted', text: entry.enabled ? t('platform.disabled') : t('platform.disabled') })
        if (entry.enabled !== true) badges.push({ key: 'notEnabled', tone: 'warn', text: t('platform.npmNotEnabled') })
        else if (!credentialsOk) badges.push({ key: 'creds', tone: 'danger', text: t('platform.notConfigured') })
        else if (npmEntry && entry.tokenConfigured) badges.push({ key: 'hint', tone: 'success', text: t('platform.tokenConfigured', { hint: entry.tokenHint || '***' }) })
        else if (isHosting && entry.id !== 'github' && entry.tokenConfigured) {
          badges.push({ key: 'hint', tone: 'success', text: t('platform.tokenConfigured', { hint: entry.tokenHint || '***' }) })
        }
        // Gitee has no topics endpoint at all; saying so on the card beats
        // letting the topics step surprise the user later.
        if (isHosting && entry.topicsSupported === false) {
          badges.push({ key: 'noTopics', tone: 'muted', text: t('platform.noTopics') })
        }
        const checkboxId = 'dgp-platform-' + entry.id
        const body = h('div', { className: 'dgp-platform-main' },
          h('div', { className: 'dgp-platform-line' },
            h('label', { className: 'dgp-platform-label', htmlFor: checkboxId },
              h('span', { className: 'dgp-platform-glyph' }, h(PlatformGlyph, { id: entry.id })),
              h('span', { className: 'dgp-platform-name' }, entry.label)),
            h('span', { className: 'dgp-platform-badges' }, badges.map(function renderBadge(badge) {
              return h(Badge, { key: badge.key, tone: badge.tone }, badge.text)
            }))),
          entry.description ? h('p', { className: 'dgp-platform-desc' }, entry.description) : null)
        const overrides = ticked && npmEntry
          ? h('div', { className: 'dgp-platform-overrides' },
              h('div', { className: 'dgp-form-grid' },
                h(Field, { label: t('platforms.npmAccess'), hint: t('platforms.npmAccessHint') },
                  h(Select, {
                    value: form.npmAccess,
                    disabled: disabled,
                    options: [
                      { value: 'public', label: 'public' },
                      { value: 'restricted', label: 'restricted' },
                    ],
                    onChange: function onChange(value) { store.updateForm({ npmAccess: value }) },
                  })),
                h(Field, { label: t('platforms.npmDistTag'), hint: t('platforms.npmDistTagHint') },
                  h(TextInput, {
                    value: form.npmDistTag,
                    disabled: disabled,
                    placeholder: 'latest',
                    onChange: function onChange(value) { store.updateForm({ npmDistTag: value }) },
                  })),
                h(Field, { label: t('platforms.npmOtp'), hint: t('platforms.npmOtpHint'), optional: true, className: 'dgp-span-2' },
                  h(TextInput, {
                    type: 'text',
                    value: form.npmOtp,
                    disabled: disabled,
                    placeholder: '123456',
                    onChange: function onChange(value) { store.updateForm({ npmOtp: value }) },
                  }))))
          : null
        return h('div', {
          key: entry.id,
          className: 'dgp-platform-row' + (ticked ? ' dgp-platform-row-on' : '') + (entry.enabled !== true ? ' dgp-platform-row-off' : ''),
        },
          h('div', { className: 'dgp-platform-head' },
            h('input', {
              id: checkboxId,
              className: 'dgp-platform-check',
              type: 'checkbox',
              checked: ticked,
              disabled: disabled,
              onChange: function onToggle() { store.togglePlatform(entry.id) },
            }),
            body),
          overrides)
      })
      const hint = selected.length === 0 ? t('platform.noneSelected') : t('platform.hint')
      // Two groups, because the two kinds behave differently: one hosting
      // (mutually exclusive, since a publish pushes a single remote) and npm
      // (an extra destination that can accompany any hosting).
      const hostingRows = rows.filter(function pickHosting(_, index) {
        return HOSTING_IDS.indexOf(platforms[index].id) >= 0
      })
      const registryRows = rows.filter(function pickRegistry(_, index) {
        return HOSTING_IDS.indexOf(platforms[index].id) < 0
      })
      return h(SectionCard, {
        title: t('platform.title'),
        subtitle: t('platform.hint'),
        actions: h(Btn, {
          variant: 'ghost',
          icon: 'settings',
          disabled: snapshot.publishing === true,
          onClick: function goPlatforms() { store.setTab('platforms') },
        }, t('header.platforms')),
      },
        hostingRows.length > 0
          ? h('div', { className: 'dgp-platform-group' },
              h('div', { className: 'dgp-platform-group-head' },
                h('span', { className: 'dgp-platform-group-title' }, t('platform.hostingOne')),
                h('span', { className: 'dgp-platform-group-note' }, t('platform.hostingHint'))),
              h('div', { className: 'dgp-platforms' }, hostingRows))
          : null,
        registryRows.length > 0
          ? h('div', { className: 'dgp-platform-group' },
              h('div', { className: 'dgp-platform-group-head' },
                h('span', { className: 'dgp-platform-group-title' }, t('platform.registryOne')),
                h('span', { className: 'dgp-platform-group-note' }, t('platform.tokenEach'))),
              h('div', { className: 'dgp-platforms' }, registryRows))
          : null,
        h('p', { className: 'dgp-field-hint dgp-platforms-hint' }, hint))
    }

    /** The run step label of one job step, tolerant of the npm group ids. */
    function stepLabelSafe(step) {
      const id = step && typeof step === 'object' ? toText(step.id) : toText(step)
      return stepLabel(id)
    }

    function ReadmePreview(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const preflight = snapshot.preflight || null
      const readme = readmeFromPreflight(preflight)
      const action = preflight && preflight.preview ? toText(preflight.preview.readmeAction) : ''
      function copyReadme() {
        if (!readme) return
        copyText(readme.content).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      let actionBadge = null
      if (readme && action === 'keep') actionBadge = h(Badge, { tone: 'muted' }, t('readme.actionKeep'))
      else if (readme && action === 'update') actionBadge = h(Badge, { tone: 'warn' }, t('readme.actionUpdate'))
      else if (readme && action !== '') actionBadge = h(Badge, { tone: 'success' }, t('readme.actionCreate'))
      const actions = readme
        ? h('div', { className: 'dgp-card-actions' },
            actionBadge,
            h(Btn, { icon: 'copy', onClick: copyReadme }, t('readme.copy')))
        : null
      return h(SectionCard, { title: t('section.readme'), subtitle: t('readme.hint'), actions: actions },
        readme
          ? h('div', { className: 'dgp-readme' },
              h('div', { className: 'dgp-readme-meta' },
                h('span', { className: 'dgp-mono' }, readme.file || 'README.md'),
                h('span', { className: 'dgp-readme-chars' }, t('readme.chars', { n: toText(readme.content).length }))),
              h('pre', { className: 'dgp-pre dgp-readme-pre' }, readme.content))
          : h('p', { className: 'dgp-muted' }, t('readme.empty')))
    }

    function CheckRow(props) {
      const p = props || {}
      const check = p.check || {}
      const status = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'pass'
      const icon = status === 'pass' ? 'check' : status === 'warn' ? 'warn' : 'fail'
      const statusText = status === 'pass' ? t('preflight.checkPass') : status === 'warn' ? t('preflight.checkWarn') : t('preflight.checkFail')
      // Name the fix when we know exactly what it will do, so the button is
      // self-explanatory instead of a generic "修复".
      let fixLabel = null
      if (check.fix === 'settings') fixLabel = t('preflight.fixSettings')
      else if (check.fix === 'bump') fixLabel = check.suggestion ? t('preflight.fixBumpTo', { version: check.suggestion }) : t('preflight.fixBump')
      else if (check.fix === 'confirmAuthor') fixLabel = t('preflight.fixConfirmAuthor')
      else if (check.fix) fixLabel = t('preflight.fix')
      return h('li', {
        className: 'dgp-check',
        'data-status': status,
        id: 'dgp-check-' + toText(check.id),
      },
        h('span', { className: 'dgp-check-icon' }, h(Icon, { name: icon, size: 12 })),
        h('div', { className: 'dgp-check-body' },
          h('div', { className: 'dgp-check-head' },
            h('span', { className: 'dgp-check-title' }, check.title),
            h('span', { className: 'dgp-check-status' }, statusText)),
          check.detail ? h('p', { className: 'dgp-check-detail' }, check.detail) : null),
        fixLabel
          ? h('button', {
              type: 'button',
              className: 'dgp-btn dgp-btn-ghost dgp-check-fix' + (check.fix === 'bump' ? ' dgp-check-fix-primary' : ''),
              onClick: function fix() { if (typeof p.onFix === 'function') p.onFix(check) },
            }, h('span', { className: 'dgp-btn-label' }, fixLabel))
          : null)
    }

    /**
     * Translated labels for the ownership verdict, spelled out as literal keys.
     * A template string here would pass every test at runtime and still hide the
     * keys from the static locale check, so the table is deliberate.
     */
    const OWNERSHIP_STATUS_LABEL = {
      own: 'preflight.ownershipStatus.own',
      fork: 'preflight.ownershipStatus.fork',
      foreign: 'preflight.ownershipStatus.foreign',
      none: 'preflight.ownershipStatus.none',
    }

    function PreflightSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const preflight = snapshot.preflight || null
      const busy = snapshot.preflightBusy === true
      const publishing = snapshot.publishing === true
      const stale = snapshot.preflightStale === true
      const errors = snapshot.formErrors || {}
      const formInvalid = hasFormErrors(errors)
      let passCount = 0
      let warnCount = 0
      let failCount = 0
      const plan = preflight ? preflight.plan : null
      let files = []
      let packageJson = null
      let warnings = []
      let checks = []
      const ownership = preflight && preflight.ownership ? preflight.ownership : null
      if (preflight) {
        checks = preflight.checks
        warnings = preflight.warnings
        files = preflight.preview.files
        packageJson = preflight.preview.packageJson
        for (let index = 0; index < checks.length; index += 1) {
          if (checks[index].status === 'fail') failCount += 1
          else if (checks[index].status === 'warn') warnCount += 1
          else passCount += 1
        }
      }
      // Blocking problems first: a failed check buried under twelve passing rows
      // is effectively invisible, which is exactly why "where do I fix this?"
      // had no answer. `fail` then `warn` then `pass`, original order preserved
      // inside each group.
      const STATUS_RANK = { fail: 0, warn: 1, pass: 2 }
      const sortedChecks = checks
        .map(function withIndex(check, index) { return { check: check, index: index } })
        .sort(function byStatusThenOrder(a, b) {
          const ra = STATUS_RANK[a.check.status] === undefined ? 3 : STATUS_RANK[a.check.status]
          const rb = STATUS_RANK[b.check.status] === undefined ? 3 : STATUS_RANK[b.check.status]
          return ra === rb ? a.index - b.index : ra - rb
        })
        .map(function unwrap(entry) { return entry.check })
      const FIELD_ID_BY_CHECK = {
        owner: 'dgp-field-owner',
        name: 'dgp-field-name',
        description: 'dgp-field-description',
        descriptionZh: 'dgp-field-description-zh',
        homepage: 'dgp-field-homepage',
        topics: 'dgp-field-topics',
      }
      function focusElement(id) {
        try {
          if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return
          const target = document.getElementById(id)
          if (!target) return
          if (typeof target.focus === 'function') target.focus()
          if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' })
        } catch (error) {
          /* focusing is a convenience only */
        }
      }
      function fixCheck(check) {
        if (!check) return
        if (check.fix === 'settings' || check.id === 'auth') {
          store.openSettings()
          return
        }
        // A version collision cannot be fixed by "going to the form": the fix is
        // to raise package.json's version, so run it right here.
        if (check.fix === 'bump') {
          // Write the version the check suggested, not a blind patch bump: when
          // the local version trails the remote latest, `0.3.4 → 0.3.5` reproduces
          // the exact same collision, so the row could never be cleared.
          if (typeof store.bumpVersion === 'function') store.bumpVersion('patch', check.suggestion)
          return
        }
        // "Author is somebody else" is not a form mistake to focus — it is a
        // statement the operator has to confirm, so scroll them to the checkbox.
        if (check.fix === 'confirmAuthor') {
          focusElement('dgp-owner-confirm')
          return
        }
        const fieldId = FIELD_ID_BY_CHECK[check.id]
        if (fieldId) {
          focusElement(fieldId)
          return
        }
        focusElement(check.id === 'identity' ? 'dgp-section-options' : 'dgp-section-publish')
      }
      let summary = null
      if (preflight) {
        if (failCount > 0) summary = { tone: 'fail', text: t('preflight.blocked', { n: failCount }) }
        else if (warnCount > 0) summary = { tone: 'warn', text: t('preflight.warned', { n: warnCount }) }
        else summary = { tone: 'pass', text: t('preflight.passed') }
      }
      const planRows = plan
        ? [
            { label: t('preflight.planOwner'), value: plan.owner, mono: true },
            { label: t('preflight.planRepo'), value: plan.repo, mono: true },
            { label: t('preflight.planBranch'), value: plan.branch, mono: true },
            { label: t('preflight.planVisibility'), value: plan.visibility === 'private' ? t('field.private') : t('field.public') },
            { label: t('preflight.planTag'), value: plan.tag, mono: true },
            { label: t('preflight.planRelease'), value: plan.createRelease ? t('preflight.planReleaseOn') : t('preflight.planReleaseOff') },
            { label: t('preflight.planRemote'), value: plan.remoteUrl, mono: true },
            plan.dryRun ? { label: t('option.dryRun'), value: t('preflight.planDryRun') } : null,
            plan.topics.length > 0 ? { label: t('field.topics'), value: plan.topics.join(', ') } : null,
          ].filter(Boolean)
        : []
      const planDescription = plan
        ? (plan.dryRun
            ? t('preflight.planDryRun')
            : (plan.createRepo ? t('preflight.planCreate') : t('preflight.planReuse')))
        : ''
      const publishBlocked = preflight !== null && preflight.canPublish !== true
      const publishDisabled = publishing || busy || formInvalid || publishBlocked
      const targetsLabel = typeof store.formTargetLabel === 'function' ? store.formTargetLabel() : ''
      let publishHint = null
      if (stale) publishHint = { tone: 'warn', text: t('form.stale') }
      else if (targetsLabel === '') publishHint = { tone: 'fail', text: t('platform.noneSelected') }
      else if (publishBlocked) publishHint = { tone: 'fail', text: preflight.needsAccount ? t('preflight.needAccountOrDryRun') : (preflight.needsNpmToken ? t('platforms.needToken') : t('form.blocked')) }
      else if (!preflight) publishHint = { tone: 'muted', text: t('form.notPreflighted') }
      else if (warnCount > 0) publishHint = { tone: 'warn', text: t('preflight.warned', { n: warnCount }) }
      else publishHint = { tone: 'pass', text: t('preflight.passed') }
      return h(SectionCard, {
        title: t('section.preflight'),
        actions: h('div', { className: 'dgp-card-actions' },
          stale ? h(Badge, { tone: 'warn' }, t('form.needRecheck')) : null,
          h(Btn, {
            icon: 'check',
            busy: busy,
            disabled: busy || publishing,
            onClick: function runPreflight() { store.runPreflight() },
          }, busy ? t('preflight.running') : (preflight ? t('preflight.rerun') : t('preflight.run')))),
      },
        !preflight
          ? h('div', { className: 'dgp-preflight-empty' },
              h('p', { className: 'dgp-muted' }, t('preflight.notRun')),
              h('p', { className: 'dgp-field-hint' }, t('preflight.notRunHint')))
          : h('div', { className: 'dgp-preflight' },
              h('div', { className: 'dgp-preflight-summary', 'data-tone': summary.tone },
                h(Icon, { name: summary.tone === 'fail' ? 'fail' : summary.tone === 'warn' ? 'warn' : 'check', size: 14 }),
                h('span', { className: 'dgp-preflight-summary-text' }, summary.text),
                h('span', { className: 'dgp-preflight-counts' },
                  t('preflight.checkPass') + ' ' + passCount + ' · ' + t('preflight.checkWarn') + ' ' + warnCount + ' · ' + t('preflight.checkFail') + ' ' + failCount)),
              stale ? h('p', { className: 'dgp-preflight-stale' }, t('preflight.staleHint')) : null,
              checks.length > 0
                ? h('ul', { className: 'dgp-checks' }, sortedChecks.map(function renderCheck(check) {
                    return h(CheckRow, { key: check.id, check: check, onFix: fixCheck })
                  }))
                : null,
              ownership
                ? h('div', { className: 'dgp-preflight-block dgp-ownership' },
                    h('div', { className: 'dgp-block-head' },
                      h('h3', { className: 'dgp-block-title' },
                        h(Icon, { name: 'user', size: 12 }),
                        t('preflight.ownership')),
                      h('span', { className: 'dgp-block-note' },
                        OWNERSHIP_STATUS_LABEL[ownership.status] ? t(OWNERSHIP_STATUS_LABEL[ownership.status]) : t('preflight.ownershipStatus.none'))),
                    h(KVGrid, {
                      rows: [
                        { label: t('preflight.ownershipAuthor'), value: ownership.author !== '' ? ownership.author : t('plugin.noAuthor'), tone: ownership.status === 'none' ? 'warn' : undefined },
                        { label: t('preflight.ownershipAccount'), value: ownership.login !== '' ? ownership.login : t('preflight.ownershipNoAccount') },
                        ownership.owner !== '' ? { label: t('preflight.ownershipRepo'), value: ownership.owner, mono: true } : null,
                        ownership.scope !== '' ? { label: t('preflight.ownershipNpmScope'), value: '@' + ownership.scope, mono: true, tone: ownership.scopeDrift ? 'warn' : undefined } : null,
                      ].filter(Boolean),
                    }),
                    // Only offered when there is something to acknowledge. The
                    // checkbox never blocks a publish; it records that a human
                    // looked at this and said "yes, mine to publish".
                    ownership.confirmed !== true && (ownership.status === 'fork' || ownership.status === 'foreign')
                      ? h('label', {
                          className: 'dgp-owner-confirm',
                          id: 'dgp-owner-confirm',
                        },
                          h('input', {
                            type: 'checkbox',
                            className: 'dgp-owner-confirm-box',
                            checked: ownership.confirmed === true,
                            disabled: publishing,
                            onChange: function onConfirm(event) {
                              const checked = event && event.target ? event.target.checked : false
                              // Record the author this confirmation is given for. The
                              // Host expires it when the declared author changes, so
                              // un-ticking does not even need to clear the trampoline.
                              store.updateForm({
                                confirmForeignAuthor: checked,
                                confirmForeignAuthorFor: checked ? (ownership.fingerprint || '') : '',
                              })                            },
                          }),
                          h('span', { className: 'dgp-owner-confirm-text' },
                            h('span', { className: 'dgp-owner-confirm-title' }, t('preflight.ownershipConfirm')),
                            h('span', { className: 'dgp-owner-confirm-hint' }, t('preflight.ownershipConfirmHint')),
                            h('span', { className: 'dgp-owner-confirm-hint' }, t('preflight.ownershipRecallHint'))))
                      : null,
                    ownership.confirmed === true
                      ? h('div', { className: 'dgp-owner-confirmed-note' },
                          h(Icon, { name: 'check', size: 11 }),
                          t('preflight.ownershipConfirmedNote'),
                          ownership.rememberedFor && ownership.rememberedFor !== ''
                            ? h('span', { className: 'dgp-owner-confirmed-remembered' }, t('preflight.ownershipConfirmedRemembered'))
                            : null,
                          h('button', {
                            type: 'button',
                            className: 'dgp-link dgp-owner-forget',
                            disabled: publishing,
                            onClick: function forget() {
                              store.updateForm({ confirmForeignAuthor: false, confirmForeignAuthorFor: '' })
                            },
                          }, t('preflight.ownershipForget')))
                      : null)
                : null,
              plan
                ? h('div', { className: 'dgp-preflight-block' },
                    h('div', { className: 'dgp-block-head' },
                      h('h3', { className: 'dgp-block-title' }, t('preflight.plan')),
                      h('span', { className: 'dgp-block-note' }, planDescription)),
                    h(KVGrid, { rows: planRows }))
                : null,              files.length > 0
                ? h('div', { className: 'dgp-preflight-block' },
                    h('div', { className: 'dgp-block-head' },
                      h('h3', { className: 'dgp-block-title' }, t('preflight.files')),
                      h('span', { className: 'dgp-block-note' }, t('preflight.filesCount', { n: files.length }))),
                    h('ul', { className: 'dgp-files' }, files.map(function renderFile(file, index) {
                      const meta = h('span', { className: 'dgp-file-meta' },
                        h(Badge, { tone: file.action === 'keep' ? 'muted' : file.action === 'create' ? 'success' : 'warn' }, t(actionLabelKey(file.action))),
                        file.bytes > 0 ? h('span', { className: 'dgp-file-bytes' }, t('preflight.fileBytes', { n: file.bytes })) : null)
                      if (!file.content) {
                        return h('li', { key: file.file + '-' + index, className: 'dgp-file' },
                          h('span', { className: 'dgp-file-name dgp-mono' }, file.file),
                          meta)
                      }
                      return h('li', { key: file.file + '-' + index, className: 'dgp-file' },
                        h('details', { className: 'dgp-file-details' },
                          h('summary', { className: 'dgp-file-summary' },
                            h('span', { className: 'dgp-file-name dgp-mono' }, file.file),
                            meta),
                          h('pre', { className: 'dgp-pre dgp-file-pre' }, file.content)))
                    })))
                : null,
              packageJson && packageJson.changed
                ? h('div', { className: 'dgp-preflight-block' },
                    h('details', { className: 'dgp-file-details dgp-package-json' },
                      h('summary', { className: 'dgp-file-summary' },
                        h('span', { className: 'dgp-file-name dgp-mono' }, t('preflight.packageChanges')),
                        h(Icon, { name: 'chevron', size: 12 })),
                      packageJson.error
                        ? h('p', { className: 'dgp-field-error' }, packageJson.error)
                        : h('pre', { className: 'dgp-pre' }, packageJson.changes ? JSON.stringify(packageJson.changes, null, 2) : toText(packageJson.text))))
                : null,
              warnings.length > 0
                ? h('div', { className: 'dgp-preflight-block' },
                    h('h3', { className: 'dgp-block-title' }, t('preflight.warnings')),
                    h('ul', { className: 'dgp-warnings' }, warnings.map(function renderWarning(warning, index) {
                      return h('li', { key: String(index), className: 'dgp-warning' }, warning)
                    })))
                : null),
        h('div', { className: 'dgp-publish-bar' },
          h('div', { className: 'dgp-publish-info' },
            publishHint ? h('span', { className: 'dgp-publish-hint', 'data-tone': publishHint.tone }, publishHint.text) : null),
          h('div', { className: 'dgp-publish-actions' },
            h(Btn, {
              variant: 'primary',
              icon: 'play',
              busy: publishing,
              disabled: publishDisabled,
              onClick: function publish() { store.runPublish() },
            }, publishing
              ? t('form.publishing')
              : (targetsLabel !== '' ? t('form.publishTo', { targets: targetsLabel }) : t('form.publish'))))),
        preflight && preflight.needsAccount
          ? h('p', { className: 'dgp-preflight-note' }, t('preflight.needAccountOrDryRun'))
          : null)
    }    // ══════════════════════════════════════════════════════════════════════
    // Run progress, result card, settings dialog, right column, page shell
    // ══════════════════════════════════════════════════════════════════════
    function formatClock(timestamp) {
      const value = toNumber(timestamp)
      if (value === null || value <= 0) return ''
      const date = new Date(value)
      const time = date.getTime()
      if (!isFinite(time)) return ''
      function pad(number) {
        return number < 10 ? '0' + number : String(number)
      }
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function ProgressSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const job = snapshot.job || null
      const steps = jobSteps(job)
      const logs = job && Array.isArray(job.logs) ? job.logs : []
      const logRef = useRef(null)
      useEffect(function scrollLogsToEnd() {
        const node = logRef.current
        if (node && typeof node.scrollTop === 'number') node.scrollTop = node.scrollHeight
      }, [logs.length])
      const running = Boolean(job && job.status === 'running') || snapshot.publishing === true
      const cancelling = snapshot.cancelling === true
      const cancelRequested = snapshot.cancelRequested === true
      const elapsed = job && job.startedAt
        ? (job.endedAt !== null ? job.endedAt : Date.now()) - job.startedAt
        : 0
      const cancelButton = running
        ? h(Btn, {
            variant: 'danger',
            icon: 'close',
            busy: cancelling,
            disabled: cancelling || cancelRequested,
            onClick: function cancelPublish() { store.cancel() },
          }, cancelling ? t('progress.cancelling') : t('progress.cancel'))
        : null
      return h(SectionCard, {
        title: t('section.progress'),
        subtitle: job && job.pluginName !== '' ? job.pluginName : t('progress.waiting'),
        actions: cancelButton,
      },
        h('ol', { className: 'dgp-timeline' }, steps.map(function renderStep(step, index) {
          const status = step.status || 'pending'
          let mark = null
          if (status === 'done') mark = h(Icon, { name: 'check', size: 9 })
          else if (status === 'failed') mark = h(Icon, { name: 'close', size: 9 })
          else if (status === 'skipped') mark = h('span', { className: 'dgp-step-skip' })
          else if (status === 'running') mark = h(Spinner, null)
          return h('li', { key: step.id + '-' + index, className: 'dgp-step', 'data-status': status },
            h('span', { className: 'dgp-step-rail' }, h('span', { className: 'dgp-step-dot' }, mark)),
            h('div', { className: 'dgp-step-body' },
              h('span', { className: 'dgp-step-name' }, stepLabel(step.id)),
              h('span', { className: 'dgp-step-status' }, t(stepStatusKey(status))),
              step.detail ? h('span', { className: 'dgp-step-detail' }, step.detail) : null,
              step.error ? h('span', { className: 'dgp-step-error' }, step.error) : null))
        })),
        h('div', { className: 'dgp-log-console', role: 'log', 'aria-label': t('progress.logs'), ref: logRef },
          logs.length === 0
            ? h('p', { className: 'dgp-log-empty' }, t('progress.noLogs'))
            : logs.map(function renderLog(log, index) {
                return h('div', { key: String(index), className: 'dgp-log-line', 'data-level': log.level },
                  h('span', { className: 'dgp-log-time' }, formatClock(log.at)),
                  log.step !== '' ? h('span', { className: 'dgp-log-step' }, log.step) : null,
                  h('span', { className: 'dgp-log-text' }, log.text))
              })),
        h('div', { className: 'dgp-progress-foot' },
          h('span', { className: 'dgp-progress-elapsed' }, t('progress.elapsed', { text: formatDuration(elapsed) })),
          h('span', { className: 'dgp-spacer' }),
          cancelButton))
    }

    function ResultSection(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const job = snapshot.job || null
      if (!job || !isTerminalStatus(job.status)) return null
      const result = job.result || snapshot.publishedResult || null
      const dryRun = job.status === 'succeeded' && Boolean(result && result.dryRun)
      const status = job.status
      // `partial` reads as a warn, not a fail: some remotes did receive the code.
      const tone = status === 'succeeded' ? (dryRun ? 'warn' : 'success') : status === 'partial' ? 'warn' : status === 'failed' ? 'fail' : 'warn'
      const iconName = tone === 'success' ? 'check' : tone === 'fail' ? 'fail' : 'warn'
      const title = status === 'failed'
        ? t('result.failedTitle')
        : status === 'partial'
          ? t('result.partialTitle')
          : status === 'cancelled'
            ? t('result.cancelledTitle')
            : (dryRun ? t('result.dryRunTitle') : t('result.successTitle'))
      const duration = job.startedAt ? (job.endedAt !== null ? job.endedAt : job.startedAt) - job.startedAt : 0
      const files = result && Array.isArray(result.files) ? result.files : []
      const report = job.error
      function copySha() {
        if (!result || result.commitSha === '') return
        copyText(result.commitSha).then(function onCopied(ok) {
          store.showToast(ok ? t('common.copied') : t('common.copyFailed'), ok ? 'success' : 'warn')
        })
      }
      const rows = []
      if (result) {
        if (result.repoUrl !== '' || result.repo !== '') {
          rows.push({ label: t('result.repo'), value: result.owner + '/' + result.repo, href: result.repoUrl })
        }
        if (result.releaseUrl !== '') {
          rows.push({ label: t('result.release'), value: result.tag !== '' ? result.tag : result.releaseUrl, href: result.releaseUrl })
        } else if (status === 'succeeded' && !dryRun) {
          rows.push({ label: t('result.release'), value: t('result.noRelease') })
        }
        if (result.commitSha !== '') rows.push({ label: t('result.commit'), value: shortSha(result.commitSha), mono: true })
        if (result.tag !== '') rows.push({ label: t('result.tag'), value: result.tag, mono: true })
        if (result.branch !== '') rows.push({ label: t('result.branch'), value: result.branch, mono: true })
        if (duration > 0) rows.push({ label: t('result.duration'), value: formatDuration(duration) })
        rows.push({
          label: t('result.files'),
          value: files.length > 0 ? t('result.filesWritten', { n: files.length }) : t('common.none'),
        })
        rows.push({ label: t('result.created'), value: result.createdRepo ? t('common.yes') : t('common.no') })
        rows.push({ label: t('result.pushed'), value: result.pushed ? t('common.yes') : t('common.no') })
      }
      const actions = h('div', { className: 'dgp-result-actions' },
        result && result.repoUrl !== '' ? h(LinkOut, { href: result.repoUrl, className: 'dgp-btn' }, h(Icon, { name: 'external', size: 12 }), h('span', { className: 'dgp-btn-label' }, t('result.openRepo'))) : null,
        result && result.commitSha !== '' ? h(Btn, { icon: 'copy', onClick: copySha }, t('result.copyCommit')) : null,
        h(Btn, {
          variant: status === 'failed' ? 'primary' : 'default',
          icon: 'refresh',
          disabled: snapshot.publishing === true,
          onClick: function publishAgain() { store.runPublish() },
        }, status === 'failed' ? t('form.retryPublish') : t('result.again')))
      return h(SectionCard, { title: t('section.result'), actions: actions, className: 'dgp-result-card' },
        h('div', { className: 'dgp-result', 'data-tone': tone },
          h('div', { className: 'dgp-result-head' },
            h('span', { className: 'dgp-result-icon' }, h(Icon, { name: iconName, size: 16 })),
            h('div', { className: 'dgp-result-heading' },
              h('h3', { className: 'dgp-result-title' }, title),
              report && report.message ? h('p', { className: 'dgp-result-error' }, report.message) : null)),
          result ? h('div', { className: 'dgp-result-body' },
            rows.length > 0 ? h(KVGrid, { rows: rows }) : null,
            // Per-hosting outcome. With several remotes a single verdict hides
            // which one actually received the code, so each hosting gets its own
            // row: label, status, and the reason when it failed.
            result.hosts.length > 0
              ? h('div', { className: 'dgp-result-hosts' },
                  h('div', { className: 'dgp-result-hosts-head' },
                    h('span', { className: 'dgp-result-hosts-title' }, t('result.hostsTitle')),
                    h('span', { className: 'dgp-result-hosts-count' },
                      t('result.hostsCount', { ok: String(result.hostedOk === null ? result.hosts.filter(function isOk(h2) { return h2.status === 'succeeded' }).length : result.hostedOk), total: String(result.hosts.length) }))),
                  h('ul', { className: 'dgp-result-hosts-list' }, result.hosts.map(function renderHost(host) {
                    const hostTone = host.status === 'succeeded' ? 'success' : host.status === 'failed' ? 'fail' : 'warn'
                    const statusText = host.status === 'succeeded' ? t('result.hostSucceeded')
                      : host.status === 'failed' ? t('result.hostFailed')
                        : host.status === 'skipped' ? t('result.hostSkipped')
                          : t('result.hostPartial')
                    return h('li', {
                      key: host.id,
                      className: 'dgp-result-host',
                      'data-tone': hostTone,
                    },
                      h('span', { className: 'dgp-result-host-icon' }, h(Icon, { name: hostTone === 'success' ? 'check' : hostTone === 'fail' ? 'fail' : 'warn', size: 13 })),
                      h('span', { className: 'dgp-result-host-label' }, host.label),
                      h('span', { className: 'dgp-result-host-status' }, statusText),
                      host.repoUrl !== ''
                        ? h('a', {
                            className: 'dgp-result-host-link dgp-mono',
                            href: host.repoUrl,
                            target: '_blank',
                            rel: 'noreferrer',
                            title: host.repoUrl,
                          }, host.repoUrl.replace(/^https?:\/\//, ''))
                        : null,
                      host.error !== ''
                        ? h('span', { className: 'dgp-result-host-error' }, host.error.split('\n')[0])
                        : null)
                  })))
              : null,
            files.length > 0
              ? h('ul', { className: 'dgp-result-files' }, files.map(function renderFile(file, index) {
                  return h('li', { key: (file.file || 'file') + '-' + index, className: 'dgp-result-file' },
                    h('span', { className: 'dgp-mono' }, file.file),
                    h('span', { className: 'dgp-result-file-action' }, t(actionLabelKey(file.action))),
                    h('span', { className: 'dgp-result-file-size' }, formatBytes(file.bytes)))
                }))
              : null,
            dryRun ? h('p', { className: 'dgp-result-note' }, t('result.dryRunNote')) : null)
          : null))
    }

    function tokenSourceLabel(source) {
      if (source === 'config') return t('settings.sourceConfig')
      if (source === 'memory') return t('settings.sourceMemory')
      if (source === 'env') return t('settings.sourceEnv')
      if (source === 'gh-cli') return t('settings.sourceGhCli')
      if (source === 'git-credential') return t('settings.sourceGitCredential')
      return toText(source) !== '' ? toText(source) : t('common.unknown')
    }

    function isAbsoluteDirectory(value) {
      const text = toText(value).trim()
      if (text === '') return false
      if (text.charAt(0) === '/') return true
      return /^[A-Za-z]:[\\/]/.test(text)
    }

    /** Mirror of lib/platforms.mjs#isValidNpmName so the field validates before saving. */
    function isValidNpmName(value) {
      const text = toText(value).trim()
      if (text === '' || text.length > 214) return false
      if (text !== text.toLowerCase()) return false
      return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(text)
    }

    /**
     * Mirror of lib/platforms.mjs#isPrivateHostname. A private registry is
     * normally served over plain http (Verdaccio on 192.168.x, Nexus on 10.x,
     * an intranet name), so http is only refused for *public* hosts — there the
     * npm token would travel in cleartext.
     */
    function isIpv4Host(host) {
      const parts = toText(host).split('.')
      if (parts.length !== 4) return false
      return parts.every(function each(part) {
        return /^\d{1,3}$/.test(part) && Number(part) <= 255
      })
    }

    function isPrivateHostname(hostname) {
      const host = toText(hostname).toLowerCase().replace(/^\[|\]$/g, '')
      if (host === '') return false
      if (isIpv4Host(host)) {
        if (/^127\./.test(host)) return true
        if (/^10\./.test(host)) return true
        if (/^192\.168\./.test(host)) return true
        if (/^169\.254\./.test(host)) return true
        const second = Number(host.split('.')[1])
        return /^172\./.test(host) && second >= 16 && second <= 31
      }
      if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
      if (/^fe[89ab][0-9a-f]:/.test(host)) return true
      if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
      if (host === 'localhost' || host.indexOf('.localhost') >= 0) return true
      if (/\.local$/.test(host) || /\.internal$/.test(host) || /\.lan$/.test(host)) return true
      if (host.indexOf('.') < 0) return true
      return false
    }

    function hostOfAuthority(authority) {
      const value = toText(authority)
      if (value.charAt(0) === '[') {
        const close = value.indexOf(']')
        return close < 0 ? value : value.slice(1, close)
      }
      const colon = value.lastIndexOf(':')
      return colon < 0 ? value : value.slice(0, colon)
    }

    /**
     * Accepts any https://, and http:// only when the host is private. A value
     * without a scheme is accepted (the host decides the scheme), so users can
     * paste `registry.npmjs.org` or `127.0.0.1:4873`.
     */
    function isAllowedBaseUrl(value) {
      const text = toText(value).trim()
      if (text === '') return false
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(text)
        if (!m) return false
        const host = hostOfAuthority(m[2])
        if (host === '') return false
        if (m[1].toLowerCase() === 'https') return true
        if (m[1].toLowerCase() === 'http') return isPrivateHostname(host)
        return false
      }
      if (!/^(\[[0-9a-f:]+\]|[a-z0-9._-]+)(:\d+)?(\/.*)?$/i.test(text)) return false
      return true
    }

    /** Why a value was rejected, phrased so the user knows the next step. */
    function baseUrlProblem(value, label) {
      const text = toText(value).trim()
      const name = label || t('platforms.npmRegistry')
      if (text === '') return t('platforms.baseUrlEmpty', { label: name })
      const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(text)
      if (m && m[1].toLowerCase() === 'http') {
        const host = hostOfAuthority(m[2])
        if (!isPrivateHostname(host)) {
          return t('platforms.httpPublicHost', { label: name, host: host, https: 'https://' + m[2] + m[3] })
        }
      }
      return t('platforms.baseUrlInvalid', { label: name, value: text })
    }

    /* ══════════════════════════════════════════════════════════════════════
       External “go and bind the API” links.

       Everything below is pure: given the settings + platform snapshot it
       returns the exact URLs a user needs to obtain a credential. Deriving
       them (instead of hardcoding github.com / npmjs.com) is what makes an
       Enterprise install point at its own host.
       ══════════════════════════════════════════════════════════════════════ */

    const TOKEN_LINK_DESCRIPTION = 'DSH%20Plugin%20Publisher'
    const GITHUB_TOKEN_SCOPES = 'repo,workflow'
    const GITHUB_TOKEN_DOCS = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
    const NPM_TOKEN_DOCS = 'https://docs.npmjs.com/creating-and-viewing-access-tokens'
    const NPM_PUBLIC_CONSOLE = 'https://www.npmjs.com'
    const BASE_NPM_REGISTRY = 'https://registry.npmjs.org'

    function trimTrailingSlash(value) {
      return toText(value).trim().replace(/\/+$/, '')
    }

    function hostOfUrl(value) {
      const match = /^https?:\/\/([^/?#]+)/i.exec(toText(value).trim())
      return match ? match[1].toLowerCase() : ''
    }

    /**
     * The origin of a registry URL, keeping its own scheme. `https://` must not
     * be forced on a self-hosted registry — `http://127.0.0.1:4873` is the norm
     * for a local Verdaccio.
     */
    function npmRegistryOrigin(registry) {
      const match = /^(https?:\/\/[^/?#]+)/i.exec(toText(registry).trim())
      return match ? match[1].replace(/\/+$/, '') : ''
    }

    /**
     * Where the tokens of a given registry are issued. npmjs has a real console
     * page; a self-hosted registry owns its own root URL and has no
     * `/settings/tokens` route at all, so it must never be built by appending.
     */
    function npmConsoleUrl(registry) {
      const origin = npmRegistryOrigin(registry)
      if (origin === '' || origin.toLowerCase().indexOf('npmjs.org') >= 0) return NPM_PUBLIC_CONSOLE
      return origin
    }

    function isCustomNpmRegistry(registry) {
      return hostOfUrl(registry).indexOf('npmjs.org') < 0
    }

    /**
     * Every external URL the panel can send the user to, derived from the
     * endpoints actually in force. Null-safe: a malformed snapshot falls back
     * to the public defaults rather than to an empty href.
     */
    function helpLinks(settings, platforms) {
      const resolved = normalizeSettings(settings)
      const defaults = resolved.defaults
      const gitBase = trimTrailingSlash(isAllowedBaseUrl(defaults.gitBase) ? defaults.gitBase : BASE_DEFAULTS.gitBase)
      const apiBase = trimTrailingSlash(isAllowedBaseUrl(defaults.apiBase) ? defaults.apiBase : BASE_DEFAULTS.apiBase)
      const list = Array.isArray(platforms) ? platforms : []
      const npm = list.filter(function pickNpm(entry) {
        return entry && entry.id === 'npm'
      })[0] || null
      const registry = npm && isAllowedBaseUrl(npm.registry) ? trimTrailingSlash(npm.registry) : BASE_NPM_REGISTRY
      const custom = isCustomNpmRegistry(registry)
      const npmConsole = npmConsoleUrl(registry)
      const npmHost = hostOfUrl(registry)
      const npmLogin = npm && npm.account && toText(npm.account.login) !== '' ? toText(npm.account.login) : ''
      return {
        gitBase: gitBase,
        apiBase: apiBase,
        githubTokenClassic: gitBase + '/settings/tokens/new?scopes=' + GITHUB_TOKEN_SCOPES + '&description=' + TOKEN_LINK_DESCRIPTION,
        githubTokenFine: gitBase + '/settings/personal-access-tokens/new',
        githubTokens: gitBase + '/settings/tokens',
        githubTokenDocs: GITHUB_TOKEN_DOCS,
        // A self-hosted registry has no token console page: its root is the only
        // honest destination, so both npm links collapse onto it.
        npmToken: custom ? npmConsole : npmConsole + '/settings/tokens/new',
        npmTokens: custom ? npmConsole : npmConsole + '/settings/tokens',
        npmTokenDocs: NPM_TOKEN_DOCS,
        npmRegistry: registry,
        npmConsole: npmConsole,
        npmHost: npmHost,
        npmLogin: npmLogin,
        npmLoginCommand: 'npm login --registry=' + registry,
        npmrcEntry: npmHost === '' ? '' : '//' + npmHost + '/:_authToken=',
        npmCustomRegistry: custom,
      }
    }

    /** One flat list of credential links; shared by the settings page and the guide. */
    function credentialLinkItems(links) {
      const l = links || helpLinks(null, null)
      const npmItems = l.npmCustomRegistry
        ? [
            { href: l.npmConsole, label: t('help.npmConsole'), group: 'npm' },
            { href: l.npmTokenDocs, label: t('help.npmDocs'), group: 'npm' },
          ]
        : [
            { href: l.npmToken, label: t('help.npmToken'), group: 'npm' },
            { href: l.npmTokens, label: t('help.npmManage'), group: 'npm' },
            { href: l.npmTokenDocs, label: t('help.npmDocs'), group: 'npm' },
          ]
      return [
        { href: l.githubTokenClassic, label: t('help.githubClassic'), group: 'github' },
        { href: l.githubTokenFine, label: t('help.githubFine'), group: 'github' },
        { href: l.githubTokens, label: t('help.githubManage'), group: 'github' },
        { href: l.githubTokenDocs, label: t('help.githubDocs'), group: 'github' },
      ].concat(npmItems)
    }

    /**
     * The three concrete moves that turn an existing `npm login` into the token
     * this plugin needs. Only rendered for a self-hosted registry, where the
     * token lives in `~/.npmrc` rather than behind a web page.
     */
    /**
     * The registry health strip on the npm card: a status badge, the reason in
     * words, and a "start registry" button that appears only when the Host says
     * the address is a local registry it can actually start.
     */
    function RegistryStatusRow(props) {
      const p = props || {}
      const status = p.registry || null
      const busy = p.busy === true
      const store = p.store || null
      if (!status || typeof status !== 'object') {
        return h('div', { className: 'dgp-registry dgp-registry-unknown' },
          h('span', { className: 'dgp-registry-label' }, t('registry.label')),
          h(Badge, { tone: 'muted' }, t('registry.unknown')),
          h(Btn, {
            icon: 'refresh',
            className: 'dgp-registry-action',
            disabled: busy || store === null,
            onClick: function recheck() { if (store) store.checkRegistry() },
          }, t('registry.recheck')))
      }
      const reachable = status.reachable === true
      const startable = status.startable === true
      const tone = reachable ? 'success' : (startable ? 'warn' : 'danger')
      const stateText = reachable
        ? t('registry.online')
        : startable
          ? t('registry.down')
          : t('registry.unreachable')
      return h('div', {
        className: 'dgp-registry',
        'data-state': reachable ? 'online' : startable ? 'down' : 'unreachable',
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', { className: 'dgp-registry-label' }, t('registry.label')),
        h(Badge, { tone: tone }, stateText),
        h('span', { className: 'dgp-registry-detail' }, toText(status.detail)),
        h('span', { className: 'dgp-spacer' }),
        startable
          ? h(Btn, {
              variant: 'primary',
              icon: 'play',
              busy: busy,
              disabled: busy || store === null,
              onClick: function start() { if (store) store.startRegistry() },
            }, busy ? t('registry.starting') : t('registry.start'))
          : null,
        h(Btn, {
          icon: 'refresh',
          className: 'dgp-registry-action',
          disabled: busy || store === null,
          onClick: function recheck() { if (store) store.checkRegistry() },
        }, t('registry.recheck')))
    }

    function NpmCustomRegistryHelp(props) {
      const p = props || {}
      const links = p.links || helpLinks(null, null)
      const store = p.store
      const probe = p.probe || null
      const detecting = p.detecting === true
      if (links.npmCustomRegistry !== true) return null
      function copyOnce(text, okKey) {
        copyText(text).then(function settled(ok) {
          if (store && typeof store.showToast === 'function') {
            store.showToast(ok ? t(okKey) : t('common.copyFailed'), ok ? 'success' : 'warn')
          }
        })
      }
      return h('div', { className: 'dgp-npm-help' },
        h('p', { className: 'dgp-npm-help-title' }, t('platforms.npmCustomSteps', { host: links.npmHost })),
        h('ol', { className: 'dgp-npm-help-steps' },
          h('li', null,
            h('code', { className: 'dgp-mono' }, links.npmLoginCommand),
            h(Btn, {
              icon: 'copy',
              onClick: function copyLogin() { copyOnce(links.npmLoginCommand, 'help.npmLoginCopied') },
            }, t('help.copyNpmLogin'))),
          // Reading the value for the user is the whole point: copying the
          // `.npmrc` *key* by hand is exactly how it used to be pasted wrong.
          h('li', null,
            h('span', null, t('platforms.npmrcAutoRead')),
            h(Btn, {
              variant: 'primary',
              icon: 'search',
              busy: detecting,
              disabled: detecting || store === null,
              onClick: function readNow() { if (store) store.detectNpmToken(true) },
            }, detecting ? t('platforms.npmrcReading') : t('platforms.npmrcRead')),
            h(Btn, {
              icon: 'check',
              disabled: detecting || store === null,
              onClick: function justCheck() { if (store) store.detectNpmToken(false) },
            }, t('platforms.npmrcCheck'))),
          probe !== null
            ? h('li', null,
                h('span', { className: 'dgp-npmrc-probe' },
                  probe.saved
                    ? t('platforms.npmrcProbeSaved', { hint: probe.hint, source: probe.source })
                    : t('platforms.npmrcProbeFound', { hint: probe.hint, source: probe.source })))
            : null,
          h('li', null, h('span', null, t('platforms.npmCustomFinish')))),
        h('p', { className: 'dgp-field-hint' }, t('help.npmCustomRegistry')))
    }

    const SETTINGS_TABS = ['account', 'enterprise', 'scan', 'defaults', 'help', 'danger']

    function readSettingsTab() {
      const stored = readStorage(STORAGE_TAB)
      return stored !== null && SETTINGS_TABS.indexOf(stored) >= 0 ? stored : 'account'
    }

    function SettingsModal(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const settings = snapshot.settings || normalizeSettings(null)
      const account = snapshot.account || normalizeAccount(null)
      const tabState = useState(readSettingsTab)
      const tab = tabState[0]
      const setTab = tabState[1]
      const tokenState = useState('')
      const token = tokenState[0]
      const setToken = tokenState[1]
      const rootsState = useState(settings.scanRoots.slice())
      const scanRoots = rootsState[0]
      const setScanRoots = rootsState[1]
      const rootInputState = useState('')
      const rootInput = rootInputState[0]
      const setRootInput = rootInputState[1]
      const draftState = useState(function initialDraft() { return normalizeDefaults(settings.defaults) })
      const draft = draftState[0]
      const setDraft = draftState[1]
      const autoState = useState(settings.autoDetectToken === true)
      const autoDetect = autoState[0]
      const setAutoDetect = autoState[1]
      const confirmState = useState(false)
      const confirmClear = confirmState[0]
      const setConfirmClear = confirmState[1]
      const saving = snapshot.savingSettings === true
      const tokenSaving = snapshot.savingToken === true
      const detecting = snapshot.detectingToken === true
      const clearing = snapshot.clearingHistory === true
      const links = helpLinks(settings, snapshot.platforms)
      const draftLinks = helpLinks({ defaults: draft }, snapshot.platforms)
      function switchTab(next) {
        setTab(next)
        writeStorage(STORAGE_TAB, next)
      }
      function patchDefault(key, value) {
        const next = Object.assign({}, draft)
        next[key] = value
        setDraft(next)
      }
      function addRoot() {
        const value = toText(rootInput).trim()
        if (!isAbsoluteDirectory(value)) {
          store.showToast(t('settings.scanRootInvalid'), 'warn')
          return
        }
        if (scanRoots.indexOf(value) < 0) setScanRoots(scanRoots.concat([value]))
        setRootInput('')
      }
      function saveSettings() {
        if (!isAllowedBaseUrl(draft.apiBase)) {
          store.showToast(baseUrlProblem(draft.apiBase, t('settings.apiBase')), 'warn')
          return
        }
        if (!isAllowedBaseUrl(draft.gitBase)) {
          store.showToast(baseUrlProblem(draft.gitBase, t('settings.gitBase')), 'warn')
          return
        }
        store.saveSettings({
          defaults: draft,
          scanRoots: scanRoots,
          autoDetectToken: autoDetect,
        })
      }
      function saveToken() {
        if (toText(token).trim() === '') {
          store.showToast(t('token.placeholder'), 'warn')
          return
        }
        store.saveToken(token).then(function onSaved(ok) {
          if (ok) setToken('')
        })
      }
      const tabs = [
        { id: 'account', label: t('settings.sectionAccount') },
        { id: 'enterprise', label: t('settings.sectionEnterprise') },
        { id: 'scan', label: t('settings.sectionScan') },
        { id: 'defaults', label: t('settings.sectionDefaults') },
        { id: 'help', label: t('settings.sectionHelp') },
        { id: 'danger', label: t('settings.sectionDanger') },
      ]
      let content = null
      if (tab === 'account') {
        const accountRows = [
          { label: t('settings.accountStatus'), value: account.connected ? (account.login !== '' ? '@' + account.login : t('common.yes')) : t('settings.noAccount') },
          { label: t('token.source'), value: tokenSourceLabel(account.tokenSource) },
          { label: t('token.hint'), value: account.tokenHint !== '' ? account.tokenHint : t('common.none'), mono: true },
          { label: t('token.validated'), value: account.validated ? t('token.validated') : t('token.notValidated') },
          { label: t('settings.persisted'), value: account.persisted ? t('settings.persisted') : t('settings.notPersisted') },
          { label: t('settings.tokenType'), value: account.isFineGrained ? t('token.permissionFine') : t('token.permissionClassic') },
          { label: t('settings.apiBase'), value: account.apiBase, mono: true },
          { label: t('settings.validatedAt'), value: account.validatedAt !== null ? formatRelativeTime(account.validatedAt) : t('common.none') },
        ]
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.account')),
          h('p', { className: 'dgp-field-hint' }, t('settings.accountHint')),
          h(KVGrid, { rows: accountRows }),
          h('div', { className: 'dgp-settings-row' },
            h(TextInput, {
              type: 'password',
              value: token,
              placeholder: t('token.placeholder'),
              autoComplete: 'off',
              onChange: function onChange(value) { setToken(value) },
            }),
            h(Btn, { variant: 'primary', icon: 'check', busy: tokenSaving, disabled: tokenSaving || detecting, onClick: saveToken },
              tokenSaving ? t('token.saving') : t('settings.saveToken')),
            h(Btn, { icon: 'search', busy: detecting, disabled: tokenSaving || detecting, onClick: function detect() { store.detectToken(false) } },
              detecting ? t('token.detecting') : t('settings.detectToken'))),
          h('div', { className: 'dgp-settings-row' },
            h(Btn, {
              variant: 'danger',
              icon: 'trash',
              disabled: tokenSaving || !account.connected,
              onClick: function clearToken() { store.clearToken() },
            }, t('settings.clearToken')),
            h(HelpLinks, {
              items: [
                { href: links.githubTokenClassic, label: t('token.generateClassic') },
                { href: links.githubTokenFine, label: t('token.generateFine') },
                { href: links.githubTokens, label: t('token.manageGithub') },
              ],
            })),
          h('div', { className: 'dgp-token-perm' },
            h('span', { className: 'dgp-token-perm-title' }, t('token.permissionsTitle')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionClassic')),
            h('p', { className: 'dgp-token-perm-line' }, t('token.permissionFine'))))
      } else if (tab === 'enterprise') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.enterprise')),
          h('p', { className: 'dgp-field-hint' }, t('settings.enterpriseHint')),
          h(Field, { label: t('settings.apiBase') },
            h(TextInput, {
              value: draft.apiBase,
              mono: true,
              disabled: saving,
              onChange: function onChange(value) { patchDefault('apiBase', value) },
            })),
          h(Field, { label: t('settings.gitBase') },
            h(TextInput, {
              value: draft.gitBase,
              mono: true,
              disabled: saving,
              onChange: function onChange(value) { patchDefault('gitBase', value) },
            })),
          h('h3', { className: 'dgp-block-title' }, t('help.endpoints')),
          h(KVGrid, {
            rows: [
              { label: t('settings.apiBase'), value: draftLinks.apiBase, mono: true },
              { label: t('settings.gitBase'), value: draftLinks.gitBase, mono: true },
            ],
          }),
          h('p', { className: 'dgp-field-hint' }, t('help.endpointsHint')),
          h(HelpLinks, {
            items: [
              { href: draftLinks.githubTokenClassic, label: t('help.githubClassic') },
              { href: draftLinks.githubTokens, label: t('help.githubManage') },
            ],
          }))
      } else if (tab === 'scan') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.scanRoots')),
          h('p', { className: 'dgp-field-hint' }, t('settings.scanRootsHint')),
          h('ul', { className: 'dgp-roots' },
            scanRoots.length === 0
              ? h('li', { className: 'dgp-roots-empty' }, t('common.empty'))
              : scanRoots.map(function renderRoot(root, index) {
                  return h('li', { key: root + '-' + index, className: 'dgp-root' },
                    h('span', { className: 'dgp-root-path dgp-mono' }, root),
                    h(IconBtn, {
                      icon: 'trash',
                      title: t('common.remove'),
                      disabled: saving,
                      onClick: function removeRoot() {
                        setScanRoots(scanRoots.slice(0, index).concat(scanRoots.slice(index + 1)))
                      },
                    }))
                })),
          h('div', { className: 'dgp-settings-row' },
            h(TextInput, {
              value: rootInput,
              mono: true,
              placeholder: t('settings.scanRootPlaceholder'),
              disabled: saving,
              onChange: function onChange(value) { setRootInput(value) },
            }),
            h(Btn, { icon: 'plus', disabled: saving, onClick: addRoot }, t('settings.scanRootAdd'))),
          h(Toggle, {
            checked: autoDetect,
            label: t('settings.autoDetectToken'),
            disabled: saving,
            onChange: function onChange() { setAutoDetect(!autoDetect) },
          }))
      } else if (tab === 'defaults') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.defaults')),
          h('p', { className: 'dgp-field-hint' }, t('settings.defaultsHint')),
          h('div', { className: 'dgp-form-grid' },
            h(Field, { label: t('field.visibility') },
              h(Segmented, {
                value: draft.visibility,
                disabled: saving,
                options: [
                  { value: 'public', label: t('field.public') },
                  { value: 'private', label: t('field.private') },
                ],
                onChange: function onChange(value) { patchDefault('visibility', value) },
              })),
            h(Field, { label: t('field.license') },
              h(Select, {
                value: draft.license,
                disabled: saving,
                options: LICENSE_IDS.map(function licenseOption(id) {
                  return { value: id, label: id === 'none' ? t('field.licenseNone') : id }
                }),
                onChange: function onChange(value) { patchDefault('license', value) },
              })),
            h(Field, { label: t('field.branch') },
              h(TextInput, {
                value: draft.branch,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('branch', value) },
              })),
            h(Field, { label: t('field.tagPrefix') },
              h(TextInput, {
                value: draft.tagPrefix,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('tagPrefix', value) },
              })),
            h(Field, { label: t('field.commitMessage'), className: 'dgp-span-2' },
              h(TextInput, {
                value: draft.commitMessage,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('commitMessage', value) },
              })),
            h(Field, { label: t('field.authorName'), optional: true },
              h(TextInput, {
                value: draft.authorName,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('authorName', value) },
              })),
            h(Field, { label: t('field.authorEmail'), optional: true },
              h(TextInput, {
                type: 'email',
                value: draft.authorEmail,
                disabled: saving,
                onChange: function onChange(value) { patchDefault('authorEmail', value) },
              })),
            h(Field, { label: t('settings.topicPreset'), className: 'dgp-span-2' },
              h(ChipInput, {
                value: draft.topicPreset,
                placeholder: t('field.topicPlaceholder'),
                disabled: saving,
                onChange: function onChange(topics) { patchDefault('topicPreset', topics) },
              }))))
      } else if (tab === 'danger') {
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('settings.danger')),
          confirmClear
            ? h('div', { className: 'dgp-danger-confirm' },
                h('p', { className: 'dgp-danger-text' }, t('settings.clearHistoryConfirm')),
                h('div', { className: 'dgp-settings-row' },
                  h(Btn, { variant: 'danger', icon: 'trash', busy: clearing, disabled: clearing, onClick: function doClear() { store.clearHistory(); setConfirmClear(false) } },
                    t('settings.clearHistoryYes')),
                  h(Btn, { onClick: function cancelClear() { setConfirmClear(false) } }, t('settings.clearHistoryNo'))))
            : h('div', { className: 'dgp-settings-row' },
                h(Btn, { variant: 'danger', icon: 'trash', disabled: clearing, onClick: function askClear() { setConfirmClear(true) } },
                  t('settings.clearHistory'))))
      } else {
        const npmEntry = (Array.isArray(snapshot.platforms) ? snapshot.platforms : []).filter(function pickNpm(entry) {
          return entry && entry.id === 'npm'
        })[0] || null
        content = h('div', { className: 'dgp-settings-section' },
          h('h3', { className: 'dgp-block-title' }, t('help.title')),
          h('p', { className: 'dgp-field-hint' }, t('help.subtitle')),
          h('h3', { className: 'dgp-block-title' }, t('help.credentials')),
          h(HelpLinks, { items: credentialLinkItems(links) }),
          h('h3', { className: 'dgp-block-title' }, t('help.endpoints')),
          h(KVGrid, {
            rows: [
              { label: t('settings.apiBase'), value: links.apiBase, mono: true },
              { label: t('settings.gitBase'), value: links.gitBase, mono: true },
              { label: t('platforms.npmRegistry'), value: links.npmRegistry, mono: true },
            ],
          }),
          h('p', { className: 'dgp-field-hint' }, t('help.endpointsHint')),
          h('p', { className: 'dgp-field-hint' }, t('help.npmRegistryHint', { registry: links.npmRegistry })),
          h(NpmCustomRegistryHelp, { links: links, store: store, probe: snapshot.npmrcProbe, detecting: snapshot.detectingNpmToken === true }),
          h('h3', { className: 'dgp-block-title' }, t('help.diagnostics')),
          h('p', { className: 'dgp-field-hint' }, t('help.diagnosticsHint')),
          h('div', { className: 'dgp-settings-row' },
            h(Btn, {
              icon: 'copy',
              onClick: function copyDiagnostics() {
                const diag = {
                  plugin: NS,
                  clientVersion: CLIENT_VERSION,
                  gitBase: links.gitBase,
                  apiBase: links.apiBase,
                  github: account.connected
                    ? (account.login !== '' ? '@' + account.login : t('common.yes'))
                    : t('settings.noAccount'),
                  githubTokenSource: tokenSourceLabel(account.tokenSource),
                  npmRegistry: links.npmRegistry,
                  npmToken: npmEntry && npmEntry.tokenConfigured === true ? t('token.validated') : t('platform.tokenMissing'),
                  scanRoots: scanRoots.length,
                }
                copyText(JSON.stringify(diag, null, 2)).then(function onCopied(ok) {
                  store.showToast(ok ? t('help.diagCopied') : t('common.copyFailed'), ok ? 'success' : 'warn')
                })
              },
            }, t('help.copyDiagnostics'))))
      }
      return h(Modal, {
        title: t('settings.title'),
        onClose: function closeSettings() { store.closeSettings() },
        footer: h('div', { className: 'dgp-modal-actions' },
          tab === 'danger'
            ? null
            : tab === 'help'
              ? h('div', { className: 'dgp-modal-actions' },
                  h(Btn, { onClick: function closeSettings() { store.closeSettings() } }, t('common.close')))
              : h('div', { className: 'dgp-modal-actions' },
                  h(Btn, { variant: 'primary', icon: 'check', busy: saving, disabled: saving, onClick: saveSettings },
                    saving ? t('settings.saving') : t('settings.save')),
                  h(Btn, { onClick: function closeSettings() { store.closeSettings() } }, t('common.close')))),
      },
        snapshot.error
          ? h('p', { className: 'dgp-settings-error', role: 'alert' },
              t('settings.inlineError') + '：' + toText(snapshot.error.message))
          : null,
        h('div', { className: 'dgp-settings-tabs', role: 'tablist' }, tabs.map(function renderTab(item) {
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'dgp-settings-tab',
            role: 'tab',
            'aria-selected': tab === item.id,
            'data-on': tab === item.id ? '1' : '0',
            onClick: function selectTab() { switchTab(item.id) },
          }, item.label)
        })),
        content)
    }

    /**
     * The Platforms page: one card per platform with its credential fields,
     * enable switch and verify button. Secrets are typed here and sent once;
     * the responses only ever carry a hint.
     */
    function PlatformConfigPage(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const platforms = Array.isArray(snapshot.platforms) ? snapshot.platforms : []
      const saving = snapshot.savingPlatforms === true
      const verifying = snapshot.verifyingPlatform
      const savingNpm = snapshot.savingNpmToken === true
      const npmStored = []
      const tokenState = useState({ registry: '', token: '', access: 'public', distTag: 'latest', provenance: false, publishName: '' })
      const tokenDraft = tokenState[0]
      const setTokenDraft = tokenState[1]
      const npmEntry = platforms.find(function findNpm(entry) { return entry.id === 'npm' }) || null
      const pageLinks = helpLinks(snapshot.settings, platforms)
      useEffect(function adoptServerState() {
        if (!npmEntry) return
        setTokenDraft(function keepDraft(current) {
          return {
            registry: current.registry !== '' ? current.registry : (npmEntry.registry || 'https://registry.npmjs.org'),
            token: current.token,
            access: current.access !== 'public' ? current.access : npmEntry.access,
            distTag: current.distTag !== 'latest' ? current.distTag : npmEntry.distTag,
            provenance: npmEntry.provenance,
            publishName: current.publishName !== '' ? current.publishName : (npmEntry.publishName || ''),
          }
        })
      }, [npmEntry ? npmEntry.registry : null, npmEntry ? npmEntry.distTag : null, npmEntry ? npmEntry.access : null, npmEntry ? npmEntry.publishName : null])
      void npmStored
      function patchDraft(patch) {
        setTokenDraft(function merge(current) { return Object.assign({}, current, patch) })
      }
      function saveNpm() {
        const registry = toText(tokenDraft.registry).trim()
        if (registry !== '' && !isAllowedBaseUrl(registry)) {
          store.showToast(baseUrlProblem(registry, t('platforms.npmRegistry')), 'warn')
          return
        }
        const publishName = toText(tokenDraft.publishName).trim()
        if (publishName !== '' && !isValidNpmName(publishName)) {
          store.showToast(t('platforms.publishNameInvalid'), 'warn')
          return
        }
        const patch = {
          npm: {
            enabled: npmEntry ? npmEntry.enabled === true : false,
            registry: registry || undefined,
            access: tokenDraft.access,
            distTag: tokenDraft.distTag || 'latest',
            provenance: tokenDraft.provenance === true,
            publishName: publishName,
          },
        }
        if (toText(tokenDraft.token).trim() !== '') patch.npm.token = toText(tokenDraft.token).trim()
        store.savePlatforms(patch).then(function onDone(ok) {
          if (ok) patchDraft({ token: '' })
        })
      }
      function toggleNpmEnabled() {
        if (!npmEntry) return
        store.savePlatforms({ npm: { enabled: !(npmEntry.enabled === true) } })
      }
      function verifyNpm() {
        store.verifyPlatform('npm')
      }
      function verifyGithub() {
        store.verifyPlatform('github')
      }
      const githubAccount = snapshot.account || normalizeAccount(null)
      const githubCard = h(SectionCard, {
        title: t('platforms.sectionGithub'),
        subtitle: t('platforms.githubTokenHint'),
        actions: h('div', { className: 'dgp-card-actions' },
          githubAccount.connected ? h(Badge, { tone: 'success' }, '@' + githubAccount.login) : h(Badge, { tone: 'danger' }, t('platform.notConfigured')),
          h(Btn, {
            icon: 'check',
            busy: verifying === 'github',
            disabled: verifying !== null,
            onClick: verifyGithub,
          }, verifying === 'github' ? t('platforms.verifying') : t('platforms.verify')),
          h(LinkOut, { href: pageLinks.githubTokenClassic, className: 'dgp-link', title: t('token.newTabHint') },
            h(Icon, { name: 'external', size: 11 }), t('token.generateClassic')),
          h(LinkOut, { href: pageLinks.githubTokens, className: 'dgp-link', title: t('token.newTabHint') },
            h(Icon, { name: 'external', size: 11 }), t('token.manageGithub')),
          h(Btn, { icon: 'settings', onClick: function openGithubSettings() { store.openSettings() } }, t('header.settings'))),
      },
        h('div', { className: 'dgp-toggle-grid' },
          h(Toggle, {
            checked: true,
            label: t('platforms.enabledToggle'),
            hint: 'GitHub 是内置平台，始终可用。',
            disabled: true,
            onChange: function noop() {},
          })))

      const npmCard = npmEntry
        ? h(SectionCard, {
            title: t('platforms.sectionNpm'),
            storageKey: 'npm',
            collapsible: true,
            defaultOpen: false,
            // Collapsed, the header still says what is configured; expanded, the
            // fields themselves are the label.
            summary: [
              npmEntry.registry || t('platforms.npmRegistryUnset'),
              npmEntry.account && npmEntry.account.login ? '@' + npmEntry.account.login : t('platform.npmNoAccount'),
              npmEntry.publishName ? t('platforms.summaryPublishName', { name: npmEntry.publishName }) : t('platforms.summaryManifestName'),
            ].join(' · '),
            subtitle: npmEntry.description,
            actions: h('div', { className: 'dgp-card-actions' },
              npmEntry.tokenConfigured
                ? h(Badge, { tone: 'success' }, t('platform.tokenConfigured', { hint: npmEntry.tokenHint || '***' }))
                : h(Badge, { tone: 'warn' }, t('platform.tokenMissing')),
              h(Btn, {
                icon: 'check',
                busy: verifying === 'npm',
                disabled: verifying !== null || savingNpm,
                onClick: verifyNpm,
              }, verifying === 'npm' ? t('platforms.verifying') : t('platforms.verify'))),
          },
            h('div', { className: 'dgp-toggle-grid' },
              h(Toggle, {
                checked: npmEntry.enabled === true,
                label: t('platforms.enabledToggle'),
                hint: npmEntry.description,
                disabled: saving,
                onChange: toggleNpmEnabled,
              })),
            h(RegistryStatusRow, { registry: snapshot.registry, busy: snapshot.registryBusy === true, store: store }),
            h('div', { className: 'dgp-form-grid' },
              h(Field, {
                label: t('platforms.npmRegistry'),
                hint: t('platforms.registryInvalid'),
                className: 'dgp-span-2',
              }, h(TextInput, {
                value: tokenDraft.registry !== '' ? tokenDraft.registry : (npmEntry.registry || ''),
                placeholder: 'https://registry.npmjs.org',
                disabled: saving,
                onChange: function onChange(value) { patchDraft({ registry: value }) },
              })),
              h(Field, { label: t('platforms.npmToken'), hint: t('platforms.npmTokenHint'), className: 'dgp-span-2' },
                h('div', { className: 'dgp-inline-row' },
                  h(TextInput, {
                    type: 'password',
                    value: tokenDraft.token,
                    placeholder: t('platforms.npmTokenPlaceholder'),
                    disabled: saving || savingNpm,
                    onChange: function onChange(value) { patchDraft({ token: value }) },
                  }),
                  h(Btn, {
                    icon: 'check',
                    busy: savingNpm,
                    disabled: saving || savingNpm,
                    onClick: function saveTokenNow() {
                      const value = toText(tokenDraft.token).trim()
                      if (value === '') {
                        store.showToast(t('platforms.needToken'), 'warn')
                        return
                      }
                      store.saveNpmToken(value).then(function onSaved(ok) {
                        if (ok) patchDraft({ token: '' })
                      })
                    },
                  }, savingNpm ? t('platforms.saving') : t('settings.saveToken')),
                  npmEntry.tokenConfigured
                    ? h(Btn, {
                        variant: 'ghost',
                        icon: 'close',
                        disabled: saving || savingNpm,
                        onClick: function clearToken() { store.saveNpmToken('') },
                      }, t('settings.clearToken'))
                    : null,
                  h(LinkOut, {
                    href: pageLinks.npmCustomRegistry ? pageLinks.npmConsole : pageLinks.npmToken,
                    className: 'dgp-link',
                    title: t('token.newTabHint'),
                  },
                    h(Icon, { name: 'external', size: 11 }),
                    pageLinks.npmCustomRegistry ? t('help.npmConsole') : t('token.generateNpm')),
                  pageLinks.npmCustomRegistry
                    ? null
                    : h(LinkOut, { href: pageLinks.npmTokens, className: 'dgp-link', title: t('token.newTabHint') },
                        h(Icon, { name: 'external', size: 11 }), t('token.manageNpm'))),
                npmEntry.account && npmEntry.account.login
                  ? h('p', { className: 'dgp-field-hint' }, t('platforms.npmAccount') + '：@' + npmEntry.account.login)
                  : null),
              h(NpmCustomRegistryHelp, { links: pageLinks, store: store, probe: snapshot.npmrcProbe, detecting: snapshot.detectingNpmToken === true }),
              h(Field, {
                label: t('platforms.npmPublishName'),
                hint: t('platforms.npmPublishNameHint'),
                optional: true,
                className: 'dgp-span-2',
              }, h(TextInput, {
                value: tokenDraft.publishName !== '' ? tokenDraft.publishName : (npmEntry.publishName || ''),
                placeholder: '@your-scope/' + (snapshot.selectedPath ? basename(snapshot.selectedPath) : 'my-plugin'),
                mono: true,
                disabled: saving,
                onChange: function onChange(value) { patchDraft({ publishName: value }) },
              })),
              h(Field, { label: t('platforms.npmAccess'), hint: t('platforms.npmAccessHint') },
                h(Select, {
                  value: tokenDraft.access,
                  disabled: saving,
                  options: [
                    { value: 'public', label: 'public' },
                    { value: 'restricted', label: 'restricted' },
                  ],
                  onChange: function onChange(value) { patchDraft({ access: value }) },
                })),
              h(Field, { label: t('platforms.npmDistTag'), hint: t('platforms.npmDistTagHint') },
                h(TextInput, {
                  value: tokenDraft.distTag,
                  placeholder: 'latest',
                  disabled: saving,
                  onChange: function onChange(value) { patchDraft({ distTag: value }) },
                })),
              h(Field, { label: t('platforms.npmProvenance'), hint: t('platforms.npmProvenanceHint'), className: 'dgp-span-2' },
                h(Toggle, {
                  checked: tokenDraft.provenance === true,
                  label: t('platforms.npmProvenance'),
                  disabled: saving,
                  onChange: function onChange(next) { patchDraft({ provenance: next }) },
                }))),
            h('div', { className: 'dgp-inline-row dgp-platforms-actions' },
              h(Btn, { variant: 'primary', icon: 'check', busy: saving, disabled: saving, onClick: saveNpm },
                saving ? t('platforms.saving') : t('platforms.save'))))
        : h(SectionCard, { title: t('platforms.sectionNpm') },
            h('p', { className: 'dgp-muted' }, t('platform.empty')))

      return h('div', { className: 'dgp-page' },
        h('div', { className: 'dgp-page-head' },
          h('h2', { className: 'dgp-page-title' }, t('platforms.title')),
          h('p', { className: 'dgp-page-sub' }, t('platforms.subtitle'))),
        h('div', { className: 'dgp-page-body' }, githubCard, npmCard))
    }

    /**
     * The Version sync page: local version per plugin against every platform's
     * remote version, with a bump button and a "publish only the ones behind".
     */
    function SyncPage(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const plan = snapshot.syncPlan || null
      const plugin = findPlugin(snapshot.plugins, snapshot.selectedPath)
      const busy = snapshot.syncBusy === true
      const bumping = snapshot.syncBumping === true
      if (!plugin) {
        return h('div', { className: 'dgp-page' },
          h('div', { className: 'dgp-page-head' },
            h('h2', { className: 'dgp-page-title' }, t('sync.title')),
            h('p', { className: 'dgp-page-sub' }, t('sync.subtitle'))),
          h('div', { className: 'dgp-page-body' },
            h(EmptyState, {
              icon: 'branch',
              title: t('empty.title'),
              body: t('sync.pickPlugin'),
              hint: t('empty.hint'),
              action: h(Btn, {
                variant: 'primary',
                icon: 'play',
                onClick: function goPublish() { store.setTab('publish') },
              }, t('tab.publish')),
            })))
      }
      const rows = plan ? plan.platforms : []
      const behindCount = plan ? plan.behind.length : 0
      const summary = plan
        ? (behindCount > 0 ? t('sync.behindN', { n: behindCount }) : t('sync.allInSync'))
        : ''
      const actions = h('div', { className: 'dgp-card-actions' },
        h(Btn, {
          icon: 'refresh',
          busy: busy,
          disabled: busy || bumping,
          onClick: function check() { store.checkSync() },
        }, busy ? t('sync.checking') : t('sync.check')),
        h(Btn, {
          icon: 'branch',
          busy: bumping,
          disabled: busy || bumping,
          onClick: function bump() {
            const suggested = plan && plan.bumpSuggestion
            store.bumpVersion('patch', suggested)
          },
        }, t('sync.bumpOnly')),
        plan && behindCount > 0
          ? h(Btn, {
              variant: 'primary',
              icon: 'play',
              disabled: busy || bumping || snapshot.publishing === true,
              onClick: function sync() { store.syncBehindPlatforms() },
            }, t('sync.startSync'))
          : null)
      const head = h('div', { className: 'dgp-page-head' },
        h('div', {},
          h('h2', { className: 'dgp-page-title' }, t('sync.title')),
          h('p', { className: 'dgp-page-sub' }, plugin.name + (plan ? ` · ${plan.version}` : ` · ${plugin.version || ''}`))),
        h('span', { className: 'dgp-spacer' }),
        actions)
      const table = plan
        ? h('table', { className: 'dgp-sync-table' },
            h('thead', {},
              h('tr', {},
                h('th', {}, t('sync.platform')),
                h('th', {}, t('sync.local')),
                h('th', {}, t('sync.remote')),
                h('th', {}, t('sync.state')),
                h('th', {}, t('common.details')))),
            h('tbody', {}, rows.map(function renderRow(row) {
              return h('tr', { key: row.platform, 'data-state': row.state },
                h('td', {},
                  h('span', { className: 'dgp-sync-platform' },
                    h(PlatformGlyph, { id: row.platform, size: 13 }),
                    h('span', {}, row.label))),
                h('td', { className: 'dgp-mono' }, row.local || '—'),
                h('td', { className: 'dgp-mono' },
                  row.url
                    ? h(LinkOut, { href: row.url, className: 'dgp-kv-link' }, row.remote || '—')
                    : (row.remote || '—')),
                h('td', {}, h(Badge, {
                  tone: row.state === 'in-sync' ? 'success' : row.state === 'behind' ? 'warn' : row.state === 'unknown' ? 'muted' : 'danger',
                }, t(syncStateKey(row.state)))),
                h('td', { className: 'dgp-sync-detail' }, row.detail || '—'))
            })))
        : null
      const notes = []
      if (plan && plan.occupied.length > 0) {
        notes.push({ key: 'occupied', tone: 'danger', text: t('sync.occupiedN', { n: plan.occupied.length }) })
      }
      if (plan && plan.belowLatest.length > 0) {
        notes.push({ key: 'belowLatest', tone: 'warn', text: t('sync.belowLatest', { n: plan.belowLatest.length }) })
      }
      if (plan && plan.needsBump) {
        // Name the version the bump will write: a blind patch bump cannot clear a
        // collision whose remote latest sits far above the local version.
        notes.push({
          key: 'bump',
          tone: 'warn',
          text: plan.bumpSuggestion ? t('sync.bumpTo', { version: plan.bumpSuggestion }) : t('sync.needsBump'),
        })
      }
      if (plan && plan.behind.length > 0) notes.push({ key: 'behind', tone: 'warn', text: summary })
      if (plan && plan.behind.length === 0) notes.push({ key: 'sync', tone: 'pass', text: summary })
      return h('div', { className: 'dgp-page' },
        head,
        h('div', { className: 'dgp-page-body' },
          h(SectionCard, {
            title: t('sync.title'),
            subtitle: t('sync.subtitle'),
            actions: h(Btn, {
              variant: 'primary',
              icon: 'check',
              busy: bumping,
              disabled: busy || bumping,
              onClick: function bumpAndCheck() {
                const suggested = plan && plan.bumpSuggestion
                store.bumpVersion('patch', suggested).then(function afterBump(result) {
                  if (result) store.checkSync()
                })
              },
            }, t('sync.bumpAndSync')),
          },
            plan
              ? table
              : h(EmptyState, {
                  icon: 'refresh',
                  title: t('sync.emptyTitle'),
                  body: t('sync.emptyHint'),
                  action: h(Btn, {
                    variant: 'primary',
                    icon: 'refresh',
                    busy: busy,
                    disabled: busy,
                    onClick: function checkNow() { store.checkSync() },
                  }, busy ? t('sync.checking') : t('sync.check')),
                }),
            notes.length > 0
              ? h('div', { className: 'dgp-sync-notes' }, notes.map(function renderNote(note) {
                  return h('p', { key: note.key, className: 'dgp-sync-note', 'data-tone': note.tone }, note.text)
                }))
              : null,
            h('p', { className: 'dgp-field-hint' }, t('sync.bumpHint')))))
    }

    function RightPane(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const plugin = findPlugin(snapshot.plugins, snapshot.selectedPath)
      const account = snapshot.account || normalizeAccount(null)
      const publishing = snapshot.publishing === true
      const job = snapshot.job || null
      const showProgress = Boolean(job) || publishing
      const showResult = Boolean(job && isTerminalStatus(job.status))
      if (!plugin) {
        return h('div', { className: 'dgp-right' },
          h('div', { className: 'dgp-right-inner' },
            h(QuickStartCard, { snapshot: snapshot, store: store }),
            account.connected !== true ? h(TokenBanner, { snapshot: snapshot, store: store }) : null,
            h(EmptyState, {
              icon: 'code',
              title: t('empty.title'),
              body: t('empty.body'),
              hint: t('empty.hint'),
              action: h(Btn, {
                variant: 'primary',
                icon: 'refresh',
                busy: snapshot.scanBusy === true,
                disabled: snapshot.scanBusy === true,
                onClick: function scan() { store.rescan() },
              }, t('empty.scan')),
            })))
      }
      return h('div', { className: 'dgp-right' },
        h('div', { className: 'dgp-right-inner' },
          h(QuickStartCard, { snapshot: snapshot, store: store }),
          account.connected !== true ? h(TokenBanner, { snapshot: snapshot, store: store }) : null,
          // The comparison badge only appears once preflight actually ran: a
          // claim like "matches your account" must come from the same rules the
          // publish path uses, not from a second copy of them in the browser.
          h(PluginHead, {
            plugin: plugin,
            store: store,
            publishing: publishing,
            ownership: snapshot.preflight && snapshot.preflight.ownership ? snapshot.preflight.ownership : null,
          }),
          h(PlatformPicker, { snapshot: snapshot, store: store, disabled: publishing }),
          showProgress ? h(ProgressSection, { snapshot: snapshot, store: store }) : null,
          showResult ? h(ResultSection, { snapshot: snapshot, store: store }) : null,
          h(FormSection, { snapshot: snapshot, store: store, disabled: publishing }),
          h(OptionsSection, { snapshot: snapshot, store: store, disabled: publishing }),
          h(ReadmePreview, { snapshot: snapshot, store: store }),
          h(PreflightSection, { snapshot: snapshot, store: store })))
    }

    function LoadingScreen() {
      return h('div', { className: 'dgp-loading' },
        h(Spinner, null),
        h('p', { className: 'dgp-loading-text' }, t('common.loading')))
    }

    function ErrorScreen(props) {
      const p = props || {}
      const error = p.error || null
      const store = p.store
      return h('div', { className: 'dgp-loading' },
        h(EmptyState, {
          icon: 'warn',
          title: t('error.loadState'),
          body: error && error.message ? error.message : t('error.network'),
          hint: error && error.code ? error.code : null,
          action: h(Btn, {
            variant: 'primary',
            icon: 'refresh',
            onClick: function retry() { store.loadState() },
          }, t('error.retry')),
        }))
    }

    function useStoreSnapshot(store) {
      const state = useState(function initialSnapshot() { return store.getState() })
      const snapshot = state[0]
      const setSnapshot = state[1]
      useEffect(function subscribeStore() {
        setSnapshot(store.getState())
        return store.subscribe(function onStoreChange() {
          setSnapshot(store.getState())
        })
      }, [store])
      return snapshot
    }

    function PublishCenter(ownerProps) {
      const props = ownerProps || {}
      const providedStore = props.store || null
      const storeRef = useRef(null)
      if (storeRef.current === null) storeRef.current = providedStore || createStore()
      const store = storeRef.current
      useLocaleTick()
      const snapshot = useStoreSnapshot(store)
      useEffect(function bootstrap() {
        if (providedStore !== null) return undefined
        store.loadState()
        return function cleanup() {
          store.dispose()
        }
      }, [store, providedStore])
      const phase = snapshot.phase || 'loading'
      const activeTab = snapshot.activeTab || 'publish'
      let body = null
      if (phase === 'error') {
        body = h(ErrorScreen, { error: snapshot.error, store: store })
      } else if (phase === 'loading' && snapshot.plugins.length === 0) {
        body = h(LoadingScreen, null)
      } else if (activeTab === 'platforms') {
        body = h(PlatformConfigPage, { snapshot: snapshot, store: store })
      } else if (activeTab === 'sync') {
        body = h(SyncPage, { snapshot: snapshot, store: store })
      } else {
        body = h('div', { className: 'dgp-body' },
          h(LeftPane, { snapshot: snapshot, store: store }),
          h(RightPane, { snapshot: snapshot, store: store }))
      }
      const suspended = activeTab !== 'publish'
      void suspended
      return h('div', { className: 'dgp-root' },
        h('style', null, CSS),
        h(Header, { snapshot: snapshot, store: store }),
        h(PageTabs, { snapshot: snapshot, store: store }),
        h(ErrorBar, {
          error: snapshot.error,
          onDismiss: function dismiss() { store.dismissError() },
          onOpenSettings: function openSettings() { store.openSettings() },
        }),
        body,
        snapshot.settingsOpen === true ? h(SettingsModal, { snapshot: snapshot, store: store }) : null,
        h(Toast, { toast: snapshot.toast, onDismiss: function dismissToast() { store.clearToast() } }))
    }

    /** The page-level tab strip: publish / platforms / version sync. */
    function PageTabs(props) {
      const p = props || {}
      const snapshot = p.snapshot || {}
      const store = p.store
      const active = snapshot.activeTab || 'publish'
      const tabs = [
        { id: 'publish', label: t('tab.publish'), icon: 'play' },
        { id: 'platforms', label: t('tab.platforms'), icon: 'settings' },
        { id: 'sync', label: t('tab.sync'), icon: 'branch' },
      ]
      return h('div', { className: 'dgp-page-tabs', role: 'tablist' },
        tabs.map(function renderTab(item) {
          const on = active === item.id
          return h('button', {
            key: item.id,
            type: 'button',
            className: 'dgp-page-tab',
            role: 'tab',
            'aria-selected': on === true,
            'data-on': on ? '1' : '0',
            onClick: function select() { store.setTab(item.id) },
          },
            h(Icon, { name: item.icon, size: 12 }),
            h('span', { className: 'dgp-page-tab-label' }, item.label))
        }))
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch() {
        /* the crash card below is the user-facing report */
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'dgp-root dgp-crash' },
            h('style', null, CSS),
            h('div', { className: 'dgp-crash-card' },
              h('h2', { className: 'dgp-crash-title' }, t('error.crashed')),
              h('p', { className: 'dgp-crash-hint' }, t('error.crashedHint')),
              h('pre', { className: 'dgp-crash-detail' }, String((this.state.error && this.state.error.message) || this.state.error)),
              h(Btn, {
                variant: 'primary',
                icon: 'refresh',
                onClick: function reload() {
                  try {
                    if (typeof window !== 'undefined' && window && window.location && typeof window.location.reload === 'function') window.location.reload()
                  } catch (error) {
                    /* reload is best effort */
                  }
                },
              }, t('error.reload'))))
        }
        return this.props.children
      }
    }

    function Page() {
      return h(ErrorBoundary, null, h(PublishCenter, null))
    }

    /** The left-sidebar row glyph: the shell owns the button, we draw the mark. */
    function SidebarIcon(ownerProps) {
      const props = ownerProps || {}
      const size = typeof props.size === 'number' && isFinite(props.size) && props.size > 0 ? props.size : 16
      const active = props.active === true
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.7 : 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        h('path', { key: 'trunk', d: 'M5 12.2V4.4' }),
        h('path', { key: 'branch', d: 'M5 8.4c0-1.9 1.5-3.4 3.4-3.4h1.2' }),
        h('path', { key: 'arrow', d: 'M11.9 12V4.9' }),
        h('path', { key: 'arrowHead', d: 'M9.6 7.1 11.9 4.8l2.3 2.3' }),
        h('circle', { key: 'top', cx: '5', cy: '3.6', r: '1.2', fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'bottom', cx: '5', cy: '13', r: '1.2', fill: 'currentColor', stroke: 'none' }),
        active
          ? h('circle', { key: 'accent', cx: '9.7', cy: '5', r: '1.15', fill: 'var(--dsw-alias-brand-primary)', stroke: 'none' })
          : h('circle', { key: 'accent', cx: '9.7', cy: '5', r: '1.15', fill: 'currentColor', stroke: 'none' }),
      ])
    }
    // ══════════════════════════════════════════════════════════════════════
    // Styles — theme tokens only (--dsw-alias-*), scoped under .dgp-root.
    // ══════════════════════════════════════════════════════════════════════
    const CSS = [
      '.dgp-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;container-type:inline-size;overflow:hidden;}',
      '.dgp-root *{box-sizing:border-box;}',
      '.dgp-root button{font-family:inherit;}',
      '.dgp-header{display:flex;align-items:center;gap:8px;flex:none;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-brand{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);}',
      '.dgp-head-text{min-width:0;}',
      '.dgp-title{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-sub{margin:1px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-spacer{flex:1 1 auto;min-width:0;}',
      '.dgp-account{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer;white-space:nowrap;max-width:230px;overflow:hidden;}',
      '.dgp-account:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-account-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary);}',
      '.dgp-account-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary);}',
      '.dgp-account-dot[data-on="1"]{background:var(--dsw-alias-state-success-primary);}',
      '.dgp-account-label{overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-account-warn{font-size:10px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,opacity .12s ease;}',
      '.dgp-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
            '/* Blanket focus ring: every focusable control gets one unless a rule below overrides it. */',
      '.dgp-root :focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;}',
      '/* Inputs already draw a border on focus; the ring sits just outside it. */',
      '.dgp-input:focus-visible,.dgp-search-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px;}',
      '/* The chip input lives inside a bordered box that shows the ring instead. */',
      '.dgp-chip-input:focus-visible{outline:none;}',
      '.dgp-chips:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px;}',
      '/* Icon buttons are square and small; inset the ring so it stays inside the 32px box. */',
      '.dgp-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px;}',
      '.dgp-seg-btn:focus-visible,.dgp-settings-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px;}',
      '/* The switch is a label; ring the label so the whole control reads as focused. */',
      '.dgp-toggle:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:6px;}',
'.dgp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.dgp-btn:disabled{opacity:.45;cursor:default;}',
      '.dgp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);}',
      '.dgp-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.06);}',
      '.dgp-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;}',
      '.dgp-btn-danger:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.dgp-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-btn-link{height:auto;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);}',
      '.dgp-btn-label{display:inline-block;}',
      '.dgp-header-btn{flex:none;}',
      '.dgp-icon-btn{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:4px;margin:-4px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dgp-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-icon-btn:disabled{opacity:.4;cursor:default;}',
      '.dgp-link{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none;cursor:pointer;background:transparent;border:0;font-family:inherit;padding:0;}',
      '.dgp-link:hover{text-decoration:underline;}',
      '.dgp-mono{font-family:' + MONO_FONT + ';font-size:11.5px;tab-size:2;}',
      '.dgp-body{display:flex;flex:1 1 auto;min-height:0;overflow:hidden;}',
      '.dgp-left{display:flex;flex-direction:column;flex:0 0 320px;min-width:260px;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-search{display:flex;align-items:center;gap:7px;flex:none;margin:10px 12px 6px;padding:0 9px;height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);}',
      '.dgp-search:focus-within{border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-search-input{flex:1 1 auto;min-width:0;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:none;}',
      '.dgp-search-input::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.dgp-left-meta{display:flex;align-items:center;gap:8px;flex:none;padding:2px 14px 6px;}',
      '.dgp-left-count{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-left-empty{padding:16px 14px;}',
      '.dgp-left-nomatch{margin:20px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dgp-plugin-list{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow:auto;padding:2px 10px 10px;}',
      '.dgp-plugin-row{display:flex;align-items:flex-start;gap:9px;width:100%;padding:8px 9px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;}',
      '.dgp-plugin-row:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-plugin-row-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-plugin-row:disabled{opacity:.6;cursor:default;}',
      '.dgp-plugin-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-brand-primary);}',
      '.dgp-plugin-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;}',
      '.dgp-plugin-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-plugin-meta{display:flex;gap:6px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-author{display:flex;align-items:center;gap:4px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dgp-plugin-author svg{flex:none;opacity:.75;}',
      '.dgp-plugin-author-none{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-plugin-ver{flex:none;}',
      '.dgp-plugin-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;}',
      '.dgp-plugin-badges{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:none;}',
      '.dgp-badge{display:inline-flex;align-items:center;padding:0 6px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:600;white-space:nowrap;}',
      '.dgp-badge[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-badge[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-badge[data-tone="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-scan-warn{padding:0 14px 6px;}',
      '.dgp-scan-warn-line{margin:2px 0;font-size:10.5px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere;}',
      '.dgp-history{display:flex;flex-direction:column;gap:4px;flex:none;padding:9px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);max-height:200px;overflow:auto;}',
      '.dgp-history-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-title{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}',
      '.dgp-history-empty{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;color:var(--dsw-alias-label-primary);text-decoration:none;font-size:11.5px;border:1px solid transparent;}',
      '.dgp-history-row:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}',
      '.dgp-history-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary);}',
      '.dgp-history-dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary);}',
      '.dgp-history-dot[data-status="cancelled"]{background:var(--dsw-alias-state-warn-primary);}',
      '.dgp-history-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dgp-history-ver{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-history-dry{flex:none;font-size:9.5px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-history-time{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-right{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:16px 20px 28px;background:var(--dsw-alias-bg-base);}',
      '.dgp-right-inner{display:flex;flex-direction:column;gap:12px;max-width:980px;margin:0 auto;}',
      '.dgp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-card-head{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-card[data-open="0"] .dgp-card-head{border-bottom:0;}',
      '.dgp-card-toggle{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:inherit;cursor:pointer;text-align:left;min-height:24px;}',
      '.dgp-card-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-sm);}',
      '.dgp-card-toggle svg{transition:transform .15s ease;flex:none;}',
      '.dgp-card[data-open="1"] .dgp-card-toggle svg{transform:rotate(90deg);}',
      '.dgp-card-sum{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-card-toggle-btn{flex:none;min-height:32px;padding:4px 8px;font-size:11px;}',
      '.dgp-card-heading{flex:1 1 auto;min-width:0;}',
      '.dgp-card-title{margin:0;font-size:13px;font-weight:700;letter-spacing:-.01em;}',
      '.dgp-card-sub{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-card-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;}',
      '.dgp-ai-error{margin:0 0 12px;padding:7px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-card-body{display:flex;flex-direction:column;gap:10px;padding:12px 14px;}',
      '.dgp-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dgp-token-banner{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-head{display:flex;align-items:flex-start;gap:9px;padding:12px 14px 0;}',
      '.dgp-token-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-heading{min-width:0;}',
      '.dgp-token-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px 0;}',
      '.dgp-token-form .dgp-input{flex:1 1 260px;min-width:0;}',
      '.dgp-token-hint{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px 0;}',
      '.dgp-token-perm{display:flex;flex-direction:column;gap:2px;}',
      '.dgp-token-perm-title{font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.03em;text-transform:uppercase;}',
      '.dgp-token-perm-line{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-token-generate{flex:none;align-self:center;}',
      '.dgp-token-links{display:flex;flex-direction:column;gap:5px;flex:none;align-items:flex-start;}',
      '.dgp-help-links{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;min-width:0;}',
      '.dgp-help-link{display:flex;align-items:center;gap:2px;min-width:0;}',
      '.dgp-help-link .dgp-link{font-size:12px;align-items:flex-start;}',
      '.dgp-help-link .dgp-link svg{flex:none;margin-top:2px;}',
      '.dgp-help-link-label{overflow-wrap:anywhere;line-height:1.45;}',
      '.dgp-npm-help{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0;}',
      '.dgp-registry{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);min-width:0;}',
      '.dgp-registry[data-state="online"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.dgp-registry[data-state="down"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-registry[data-state="unreachable"]{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-registry-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none;}',
      '.dgp-registry-detail{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;min-width:0;flex:1 1 220px;}',
      '.dgp-registry-action{flex:none;}',
      '.dgp-npm-help-title{margin:0;font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dgp-npm-help-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;min-width:0;}',
      '.dgp-npm-help-steps>li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0;}',
      '.dgp-npmrc-probe{font-size:11.5px;color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere;min-width:0;}',
      '.dgp-npm-help code{margin:0;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.dgp-guide{border-color:var(--dsw-alias-border-l2);}',
      '.dgp-guide[data-done="1"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.dgp-guide-head{display:flex;align-items:flex-start;gap:10px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-guide[data-open="0"] .dgp-guide-head{border-bottom:0;}',
      '.dgp-guide-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-brand-primary);}',
      '.dgp-guide-heading{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:2px;}',
      '.dgp-guide-title{margin:0;font-size:13.5px;font-weight:700;line-height:1.4;}',
      '.dgp-guide-sub{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-guide-steps{list-style:none;margin:0;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.dgp-guide-step{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);}',
      '.dgp-guide-step[data-done="1"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.dgp-guide-mark{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;flex:none;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;line-height:1;}',
      '.dgp-guide-step[data-done="1"] .dgp-guide-mark{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-guide-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.dgp-guide-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.dgp-guide-label{font-size:12.5px;font-weight:600;line-height:1.4;}',
      '.dgp-guide-tag{padding:0 5px;height:15px;display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:9.5px;line-height:1;}',
      '.dgp-guide-flag{font-size:10.5px;font-weight:600;color:var(--dsw-alias-state-success-primary);}',
      '.dgp-guide-detail{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-guide-actions{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:3px;}',
      '.dgp-guide-actions .dgp-btn{flex:none;}',
      '.dgp-token-error{margin:0 14px;font-size:11.5px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-token-warnings{margin:0 14px;padding-left:16px;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-token-current{margin:8px 14px 12px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-head{display:flex;align-items:flex-start;gap:10px;padding:2px 2px 0;}',
      '.dgp-plugin-head-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);}',
      '.dgp-plugin-head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-plugin-head-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-plugin-head-name{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere;}',
      '.dgp-plugin-head-ver{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-author-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;border:1px solid color-mix(in srgb, var(--dsw-alias-button-primary-fill) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-button-primary-fill) 12%, transparent);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;}',
      '.dgp-author-chip svg{flex:none;color:var(--dsw-alias-button-primary-fill);}',
      '.dgp-author-chip-label{font-weight:500;font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-author-chip-name{overflow-wrap:anywhere;}',
      '.dgp-author-chip-none{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);}',
      '.dgp-author-chip-none svg{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-plugin-head-link{font-size:11px;}',
      '.dgp-plugin-head-meta{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap;}',
      '.dgp-plugin-head-path{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-copy-path{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-plugin-head-published{font-size:10.5px;color:var(--dsw-alias-state-success-primary);flex:none;align-self:center;}',
      '.dgp-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.dgp-field-head{display:flex;align-items:baseline;gap:6px;}',
      '.dgp-field-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dgp-field-optional{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-field-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-field-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-input{width:100%;min-width:0;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:none;transition:border-color .12s ease;}',
      '.dgp-input:focus{border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-input:disabled{opacity:.6;cursor:default;}',
      '.dgp-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dgp-input-invalid{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-textarea{height:auto;min-height:52px;padding:6px 9px;line-height:1.55;resize:vertical;}',
      '.dgp-select{cursor:pointer;}',
      '.dgp-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
      '.dgp-span-2{grid-column:span 2;}',
      '.dgp-option-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
      '.dgp-option-row{display:flex;flex-wrap:wrap;gap:14px;}',
      '.dgp-toggle-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}',
      '.dgp-toggle{display:flex;align-items:flex-start;gap:9px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer;text-align:left;}',
      '.dgp-toggle:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dgp-toggle:disabled{opacity:.55;cursor:default;}',
      '.dgp-toggle-track{position:relative;display:inline-flex;align-items:center;width:26px;height:15px;flex:none;margin-top:1px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transition:background .12s ease,border-color .12s ease;}',
      '.dgp-toggle-on .dgp-toggle-track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.dgp-toggle-knob{position:absolute;left:1px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:left .12s ease,background .12s ease;}',
      '.dgp-toggle-on .dgp-toggle-knob{left:12px;background:var(--dsw-alias-bg-base);}',
      '.dgp-toggle-text{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.dgp-toggle-label{font-size:12px;color:var(--dsw-alias-label-primary);}',
      '.dgp-toggle-hint{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-seg-btn{height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap;}',
      '.dgp-seg-btn:hover{color:var(--dsw-alias-label-primary);}',
      '.dgp-seg-btn[data-on="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dgp-seg-btn:disabled{opacity:.55;cursor:default;}',
      '.dgp-chips{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:30px;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);}',
      '.dgp-chips-invalid{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-chips-empty{font-size:10.5px;color:var(--dsw-alias-label-tertiary);padding:0 2px;}',
      '.dgp-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 3px 1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-primary);}',
      '.dgp-chip-text{font-family:' + MONO_FONT + ';font-size:10.5px;}',
      '.dgp-chip-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;}',
      '.dgp-chip-x:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dgp-chip-input{flex:1 1 120px;min-width:100px;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;outline:none;}',
      '.dgp-chip-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dgp-advanced{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);}',
      '.dgp-readme{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.dgp-readme-meta{display:flex;align-items:center;gap:10px;justify-content:space-between;color:var(--dsw-alias-label-secondary);}',
      '.dgp-readme-chars{font-size:10.5px;}',
      '.dgp-readme-pre{max-height:260px;overflow:auto;}',
      '.dgp-pre{margin:0;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:' + MONO_FONT + ';font-size:11px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;}',
      '.dgp-preflight-empty{display:flex;flex-direction:column;gap:4px;}',
      '.dgp-preflight{display:flex;flex-direction:column;gap:10px;}',
      '.dgp-preflight-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;}',
      '.dgp-preflight-summary[data-tone="pass"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-preflight-summary[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-preflight-summary[data-tone="fail"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-preflight-summary-text{font-weight:600;}',
      '.dgp-preflight-counts{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-weight:400;}',
      '.dgp-preflight-stale{margin:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-preflight-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}',
      '.dgp-check{display:flex;align-items:flex-start;gap:8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-check[data-status="warn"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-check[data-status="fail"]{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-base));}',
      '.dgp-check[data-status="warn"]{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-base));}',
      '.dgp-check-fix-primary{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:600;}',
      '.dgp-check-fix-primary:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);}',
      '.dgp-check-icon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-success-primary);}',
      '.dgp-check[data-status="warn"] .dgp-check-icon{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-check[data-status="fail"] .dgp-check-icon{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-check-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
      '.dgp-check-head{display:flex;align-items:baseline;gap:8px;}',
      '.dgp-check-title{font-size:12px;font-weight:600;}',
      '.dgp-check-status{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-check-detail{margin:0;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-check-fix{flex:none;height:24px;padding:0 8px;font-size:11px;}',
      '.dgp-preflight-block{display:flex;flex-direction:column;gap:5px;}',
      '.dgp-block-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.dgp-block-title{margin:0;font-size:11.5px;font-weight:700;letter-spacing:.02em;}',
      '.dgp-block-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:0;}',
      '.dgp-kv-row{display:contents;}',
      '.dgp-kv-row[data-tone="warn"] .dgp-kv-value{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-ownership .dgp-block-title{display:flex;align-items:center;gap:5px;}',
      '.dgp-owner-confirm{display:flex;align-items:flex-start;gap:9px;margin-top:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;}',
      '.dgp-owner-confirm:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dgp-owner-confirm-box{flex:none;width:16px;height:16px;min-width:16px;margin:1px 0 0;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer;}',
      '.dgp-owner-confirm-box:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;}',
      '.dgp-owner-confirm-text{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.dgp-owner-confirm-title{font-size:11.5px;font-weight:600;overflow-wrap:anywhere;}',
      '.dgp-owner-confirm-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-owner-confirmed-note{display:flex;align-items:center;gap:5px;margin:8px 0 0;font-size:10.5px;color:var(--dsw-alias-state-success-primary);}',
      '.dgp-owner-confirmed-remembered{color:var(--dsw-alias-label-secondary);}',
      '.dgp-owner-forget{flex:none;margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-owner-forget:hover{color:var(--dsw-alias-label-primary);}',
      '.dgp-owner-forget:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;}',
      '.dgp-kv-label{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-kv-value{margin:0;font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-kv-link{word-break:break-all;}',
      '.dgp-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-file{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden;}',
      '.dgp-file-details{display:block;}',
      '.dgp-file-summary{display:flex;align-items:center;gap:8px;padding:5px 9px;cursor:pointer;list-style:none;}',
      '.dgp-file-summary::-webkit-details-marker{display:none;}',
      '.dgp-file-name{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
      '.dgp-file-meta{display:flex;align-items:center;gap:6px;flex:none;}',
      '.dgp-file-bytes{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-file-pre{margin:0;border:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0;max-height:220px;overflow:auto;}',
      '.dgp-warnings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-warning{font-size:11px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere;}',
      '.dgp-publish-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-publish-info{flex:1 1 auto;min-width:0;}',
      '.dgp-publish-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-publish-hint[data-tone="pass"]{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-publish-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-publish-hint[data-tone="fail"]{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-publish-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.dgp-page-tabs{display:flex;align-items:center;gap:4px;flex:none;padding:8px 20px 0;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
      '.dgp-page-tab{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;cursor:pointer;}',
      '.dgp-page-tab:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dgp-page-tab[data-on="1"]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary);}',
      '.dgp-page-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.dgp-page-tab-label{white-space:nowrap;}',
      '.dgp-page{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;}',
      '.dgp-page-head{display:flex;align-items:flex-start;gap:10px;flex:none;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-page-title{margin:0;font-size:14px;font-weight:700;}',
      '.dgp-page-sub{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:760px;}',
      '.dgp-page-body{display:flex;flex-direction:column;gap:12px;padding:12px 20px 24px;}',
      '.dgp-platforms{display:flex;flex-direction:column;gap:8px;}',
      '.dgp-platform-group{display:flex;flex-direction:column;gap:6px;margin:2px 0 10px;}',
      '.dgp-platform-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.dgp-platform-group-title{font-size:11px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-primary);}',
      '.dgp-platform-group-note{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-platform-row{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:9px 11px;}',
      '.dgp-platform-row-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-platform-row-off{opacity:.72;}',
      '.dgp-platform-head{display:flex;align-items:flex-start;gap:9px;}',
      '.dgp-platform-check{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
      '.dgp-platform-main{flex:1 1 auto;min-width:0;}',
      '.dgp-platform-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-platform-label{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.dgp-platform-glyph{display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary);}',
      '.dgp-platform-name{white-space:nowrap;}',
      '.dgp-platform-badges{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;}',
      '.dgp-platform-desc{margin:3px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-platform-overrides{margin-top:9px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l1);}',
      '.dgp-platforms-hint{margin:6px 0 0;}',
      '.dgp-inline-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-inline-row > .dgp-input{flex:1 1 auto;min-width:160px;}',
      '.dgp-platforms-actions{margin-top:10px;}',
      '.dgp-sync-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.dgp-sync-table th{text-align:left;font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-sync-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle;}',
      '.dgp-sync-table tr[data-state="behind"] td{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);}',
      '.dgp-sync-table tr[data-state="in-sync"] td{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 6%,transparent);}',
      '.dgp-sync-platform{display:inline-flex;align-items:center;gap:6px;font-weight:600;}',
      '.dgp-sync-detail{font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-sync-notes{display:flex;flex-direction:column;gap:4px;margin-top:9px;}',
      '.dgp-sync-note{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-sync-note[data-tone="pass"]{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-sync-note[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}',
      '.dgp-step{display:flex;gap:10px;position:relative;padding:4px 0;}',
      '.dgp-step-rail{position:relative;display:flex;justify-content:center;flex:none;width:18px;}',
      '.dgp-step-rail::before{content:"";position:absolute;top:18px;bottom:-6px;width:2px;background:var(--dsw-alias-border-l1);}',
      '.dgp-step:last-child .dgp-step-rail::before{display:none;}',
      '.dgp-step-dot{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);}',
      '.dgp-step[data-status="done"] .dgp-step-dot{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base);}',
      '.dgp-step[data-status="running"] .dgp-step-dot{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dgp-step[data-status="failed"] .dgp-step-dot{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);}',
      '.dgp-step[data-status="skipped"] .dgp-step-dot{opacity:.55;}',
      '.dgp-step-skip{width:6px;height:2px;background:var(--dsw-alias-label-tertiary);}',
      '.dgp-step-body{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0;padding-top:1px;}',
      '.dgp-step-name{font-size:12px;font-weight:600;}',
      '.dgp-step[data-status="pending"] .dgp-step-name{color:var(--dsw-alias-label-secondary);font-weight:400;}',
      '.dgp-step-status{font-size:10px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-step[data-status="done"] .dgp-step-status{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-step[data-status="running"] .dgp-step-status{color:var(--dsw-alias-brand-primary);}',
      '.dgp-step[data-status="failed"] .dgp-step-status{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-step-detail{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}',
      '.dgp-step-error{font-size:10.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}',
      '.dgp-log-console{max-height:190px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);font-family:' + MONO_FONT + ';font-size:11px;line-height:1.6;}',
      '.dgp-log-empty{margin:0;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-log-line{display:flex;gap:8px;align-items:flex-start;}',
      '.dgp-log-time{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-log-step{flex:none;color:var(--dsw-alias-brand-primary);}',
      '.dgp-log-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '.dgp-log-line[data-level="success"] .dgp-log-text{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-log-line[data-level="warn"] .dgp-log-text{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-log-line[data-level="error"] .dgp-log-text{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-progress-foot{display:flex;align-items:center;gap:8px;}',
      '.dgp-progress-elapsed{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-result-card{border-color:var(--dsw-alias-border-l2);}',
      '.dgp-result{display:flex;flex-direction:column;gap:8px;}',
      '.dgp-result-head{display:flex;align-items:flex-start;gap:9px;}',
      '.dgp-result-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);}',
      '.dgp-result[data-tone="success"] .dgp-result-icon{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
      '.dgp-result[data-tone="warn"] .dgp-result-icon{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-result[data-tone="fail"] .dgp-result-icon{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dgp-result-heading{min-width:0;}',
      '.dgp-result-title{margin:0;font-size:13.5px;font-weight:700;}',
      '.dgp-result-error{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}',
      '.dgp-result-hosts{display:flex;flex-direction:column;gap:6px;margin:10px 0 2px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-result-hosts-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.dgp-result-hosts-title{font-size:11px;font-weight:700;color:var(--dsw-alias-label-primary);}',
      '.dgp-result-hosts-count{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-result-hosts-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.dgp-result-host{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11px;}',
      '.dgp-result-host[data-tone="success"]{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);}',
      '.dgp-result-host[data-tone="fail"]{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);}',
      '.dgp-result-host[data-tone="warn"]{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);}',
      '.dgp-result-host-icon{display:inline-flex;flex:none;}',
      '.dgp-result-host[data-tone="success"] .dgp-result-host-icon{color:var(--dsw-alias-state-success-primary);}',
      '.dgp-result-host[data-tone="fail"] .dgp-result-host-icon{color:var(--dsw-alias-state-error-primary);}',
      '.dgp-result-host[data-tone="warn"] .dgp-result-host-icon{color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-result-host-label{font-weight:600;flex:none;}',
      '.dgp-result-host-status{font-size:10.5px;color:var(--dsw-alias-label-secondary);flex:none;}',
      '.dgp-result-host-link{font-size:10.5px;color:var(--dsw-alias-button-primary-fill);overflow-wrap:anywhere;}',
      '.dgp-result-host-error{flex:1 1 100%;font-size:10.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}',
      '.dgp-result-body{display:flex;flex-direction:column;gap:8px;}',
      '.dgp-result-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;}',
      '.dgp-result-file{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-result-file-action{font-size:10px;}',
      '.dgp-result-file-size{font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-result-note{margin:0;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-result-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;}',
      '.dgp-errorbar{display:flex;align-items:flex-start;gap:8px;flex:none;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-errorbar-icon{display:inline-flex;flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-errorbar-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
      '.dgp-errorbar-msg{font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.dgp-errorbar-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-errorbar-code{font-size:10px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-errorbar-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-empty{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:22px 18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);}',
      '.dgp-empty-title{margin:0;font-size:14px;font-weight:700;}',
      '.dgp-empty-body{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:560px;}',
      '.dgp-empty-hint{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.dgp-empty-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}',
      '.dgp-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1 1 auto;min-height:0;padding:40px 20px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-loading-text{margin:0;font-size:12px;}',
      '.dgp-spinner{display:inline-block;width:11px;height:11px;flex:none;border-radius:50%;border:1.6px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dgp-spin .8s linear infinite;}',
      '.dgp-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:8px;padding:7px 10px 7px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 6px 20px var(--dsw-alias-border-l1);max-width:80vw;}',
      '.dgp-toast[data-tone="success"]{border-color:var(--dsw-alias-state-success-primary);}',
      '.dgp-toast[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.dgp-toast[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary);}',
      '.dgp-toast-text{overflow-wrap:anywhere;}',
      '.dgp-modal-layer{position:fixed;inset:0;z-index:85;display:flex;align-items:center;justify-content:center;padding:24px;}',
      '.dgp-modal-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-overlay);opacity:.72;}',
      '.dgp-modal{position:relative;z-index:1;display:flex;flex-direction:column;width:min(700px,100%);max-height:84vh;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 40px var(--dsw-alias-border-l2);}',
      '.dgp-modal-head{display:flex;align-items:center;gap:8px;flex:none;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-modal-title{margin:0;font-size:14px;font-weight:700;}',
      '.dgp-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 14px 14px;}',
      '.dgp-modal-foot{flex:none;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dgp-modal-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;}',
      '.dgp-settings-tabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;position:sticky;top:0;z-index:1;padding:8px 0;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:12px;}',
      '.dgp-settings-tab{height:26px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;white-space:nowrap;}',
      '.dgp-settings-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dgp-settings-tab[data-on="1"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dgp-settings-section{display:flex;flex-direction:column;gap:9px;}',
      '.dgp-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dgp-settings-row .dgp-input{flex:1 1 260px;min-width:0;}',
      '.dgp-roots{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',
      '.dgp-roots-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-root{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);}',
      '.dgp-root-path{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
      '.dgp-danger-confirm{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;}',
      '.dgp-danger-text{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary);}',
      '.dgp-settings-error{margin:0 0 8px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow-wrap:anywhere;}',
      '.dgp-crash{align-items:center;justify-content:center;padding:24px;}',
      '.dgp-crash-card{display:flex;flex-direction:column;gap:10px;max-width:540px;padding:18px 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
      '.dgp-crash-title{margin:0;font-size:15px;}',
      '.dgp-crash-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.dgp-crash-detail{margin:0;max-height:160px;overflow:auto;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-error-primary);font-family:' + MONO_FONT + ';font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;}',
      '@keyframes dgp-spin{to{transform:rotate(360deg);}}',
      '@container (max-width: 960px){.dgp-body{flex-direction:column;overflow:auto;}.dgp-left{flex:0 0 auto;min-width:0;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);max-height:44vh;}.dgp-history{max-height:132px;}.dgp-right{overflow:visible;}}.dgp-right{overflow:auto;}',
      '@container (max-width: 700px){.dgp-form-grid,.dgp-option-grid,.dgp-toggle-grid{grid-template-columns:minmax(0,1fr);}.dgp-span-2{grid-column:auto;}.dgp-sub{display:none;}.dgp-header{flex-wrap:wrap;}.dgp-account{max-width:none;}.dgp-guide-head{flex-wrap:wrap;}.dgp-guide-actions{flex-direction:column;align-items:stretch;}.dgp-guide-actions .dgp-guide-end{align-self:flex-end;}}',
      '@media (max-width: 720px){.dgp-head-text{display:none;}.dgp-modal-layer{padding:12px;}}',
      '@media (prefers-reduced-motion: reduce){.dgp-root *{animation:none !important;transition:none !important;}}',
    ].join('')

    // ══════════════════════════════════════════════════════════════════════
    // Registration — sidebar row + keyed main page (CONTRACT §5.1)
    // ══════════════════════════════════════════════════════════════════════
    function apply(ctx) {
      ctx.effect(function registerLocale() {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-github-publisher: locale')

      let bound = null
      try {
        bound = ctx.locale.bind(NS)
      } catch (error) {
        bound = null
      }
      wireLocale(ctx.locale, bound)

      // The left-sidebar row. The shell owns the button, label, tooltip and the
      // panel switch; this component draws only the glyph.
      ctx.effect(function registerSidebarRow() {
        return ctx.slots.inject('sidebar.panellist', function mountSidebarRow() {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function panelLabel() {
              return t('panel.label')
            },
            locale: NS,
          }, SidebarIcon)
        })
      }, 'dsh-github-publisher: sidebar row')

      // The page that row selects. The layout mounts it only while this panel
      // is selected, so the conversation keeps the center column otherwise.
      ctx.effect(function registerMainPage() {
        return ctx.slots.inject('main', function mountMainPage() {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, Page)
        })
      }, 'dsh-github-publisher: page')
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
      // Internal handles for the Node tests. The Web loader only consumes
      // `name`, `inject` and `apply`; extra fields are inert at runtime.
      __test: {
        NS: NS,
        PANEL_ID: PANEL_ID,
        PANEL_ORDER: PANEL_ORDER,
        CLIENT_VERSION: CLIENT_VERSION,
        API: API,
        zh: zh,
        en: en,
        DEFAULT_FORM: BASE_FORM,
        DEFAULT_DEFAULTS: BASE_DEFAULTS,
        STEP_IDS: STEP_IDS,
        Page: Page,
        PublishCenter: PublishCenter,
        ErrorBoundary: ErrorBoundary,
        SidebarIcon: SidebarIcon,
        Header: Header,
        LeftPane: LeftPane,
        RightPane: RightPane,
        FormSection: FormSection,
        OptionsSection: OptionsSection,
        ReadmePreview: ReadmePreview,
        PreflightSection: PreflightSection,
        ProgressSection: ProgressSection,
        ResultSection: ResultSection,
        PlatformPicker: PlatformPicker,
        PlatformConfigPage: PlatformConfigPage,
        SyncPage: SyncPage,
        PageTabs: PageTabs,
        normalizePlatforms: normalizePlatforms,
        normalizeSyncPlan: normalizeSyncPlan,
        normalizeResult: normalizeResult,
        syncStateKey: syncStateKey,
        sanitizePlatformSelection: sanitizePlatformSelection,
        TokenBanner: TokenBanner,
        HelpLinks: HelpLinks,
        QuickStartCard: QuickStartCard,
        NpmCustomRegistryHelp: NpmCustomRegistryHelp,
        helpLinks: helpLinks,
        credentialLinkItems: credentialLinkItems,
        SETTINGS_TABS: SETTINGS_TABS,
        SettingsModal: SettingsModal,
        ErrorBar: ErrorBar,
        Toast: Toast,
        createStore: createStore,
        initialState: initialState,
        buildForm: buildForm,
        normalizeForm: normalizeForm,
        validateForm: validateForm,
        normalizePreflight: normalizePreflight,
        normalizeJob: normalizeJob,
        normalizeAccount: normalizeAccount,
        normalizeSettings: normalizeSettings,
        jobSteps: jobSteps,
        stepLabel: stepLabel,
        stepStatusKey: stepStatusKey,
        actionLabelKey: actionLabelKey,
        readmeFromPreflight: readmeFromPreflight,
        isTerminalStatus: isTerminalStatus,
        isTokenError: isTokenError,
        findPlugin: findPlugin,
        filterPlugins: filterPlugins,
        formatBytes: formatBytes,
        formatDuration: formatDuration,
        formatRelativeTime: formatRelativeTime,
        formatClock: formatClock,
        t: t,
        useStoreSnapshot: useStoreSnapshot,
        resetHttp: resetHttp,
        currentHttpToken: currentHttpToken,
        copyText: copyText,
      },
    }
  },
})
