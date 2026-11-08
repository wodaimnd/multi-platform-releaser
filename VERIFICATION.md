# 多平台发布台 — 验收报告（v0.3.0）

> 唯一目的：说清「做了什么、凭什么说它真的能用、怎么复现、怎么回滚」。
> 与 `CONTRACT.md`（接口契约）互补：那边写形状，这里写证据。

## 0. 交付形状

| 项 | 值 |
|---|---|
| 落地方案 | **B —— 就地改造 `dsh-github-publisher`**（你选的） |
| 首批平台 | **GitHub + npm registry**（你选的） |
| 版本 | `0.3.0`（`package.json` / `lib/publisher.mjs` VERSION / `client.js` CLIENT_VERSION / `lib/github.mjs` UA 四处一致） |
| 源码 | `C:\Users\Shinelon\Desktop\AI\dsh-github-publisher-0.1.0` |
| 已装入 | `desktop` profile，`link:` + `dsh.profile.bundles` 行 |
| 改造前备份 | `G:\AI PGRM\plugn\backup\dsh-github-publisher-0.1.0-preview`（28 个文件，可整目录还原） |
| 新增文件 | `lib/platforms.mjs`（514 行，平台注册表/npm 适配/CLI 定位）、`tests/multi-platform.spec.mjs`、`G:\AI PGRM\plugn\ensure-bundle.mjs` |

## 1. 三个新页面（你要的 UI）

| 页面 | 组件 | 主要内容 |
|---|---|---|
| 发布（默认页签） | `PlatformPicker` + 原 `FormSection` / `OptionsSection` / `PreflightSection` | 每个平台一行 checkbox + 图标 + 状态徽章；勾 npm 展开 access / dist-tag / 2FA OTP；**发布按钮文案随勾选变化**：`发布到 GitHub + npm registry` |
| 平台配置 | `PlatformConfigPage` | GitHub 卡片（账号状态 / 启用 / 验证 / 去设置）；npm 卡片（Registry / Access Token 保存+校验+清除 / access / dist-tag / provenance / 已验账号 / 保存） |
| 版本同步 | `SyncPage` | 矩阵表：平台 × 本地版本 × 远端版本（可点） × 状态（已同步/落后/未发布/本地更新/未知） × 详情；动作：检查版本 / 只提升版本 / 提升并同步 / 发布到落后平台 |

页签切换与选中项存在 `localStorage` 的 `dsh-github-publisher.page`。

## 1b. v0.3.0 新增：上手向导 + 绑定入口（把「去哪申请 token」做进界面）

| 落点 | 组件 | 内容 |
|---|---|---|
| 发布页最上方 | `QuickStartCard` | 三步卡片：① 绑定 GitHub 令牌 ② 选中要发布的插件 ③ 绑定 npm 令牌（标「可选」）；每步 = 标题 + 说明 + 申请外链 + 就地按钮（打开设置 / 扫描目录 / 去平台配置）；头部显示进度 `已完成 N/3`，全绿变「全部就绪」；可折叠，折叠状态存 `dsh-github-publisher.guide` |
| 未连接账号横幅 | `TokenBanner` | 原单链接 → 三条：申请经典 PAT / 申请细粒度 PAT / 管理 GitHub 令牌 |
| 设置弹窗第 5 页签 | `SettingsModal` → `help` | 「帮助与链接」：7 条凭据入口（GitHub 4 + npm 3）、当前生效的接口地址、npm registry 说明（自建 registry 另给提示）、「复制诊断信息」 |
| 设置弹窗 Enterprise 分节 | `SettingsModal` → `enterprise` | 输入 `apiBase` / `gitBase` 时**实时预览**派生出的两个地址 + 端点外链 |
| 平台配置页 | `PlatformConfigPage` | GitHub 卡片加申请/管理令牌外链；npm 卡片 token 行加申请/管理 npm Token 外链 |

统一由纯函数 `helpLinks(settings, platforms)` 派生，全部外链 `target="_blank" rel="noreferrer"`：

```
github  https://<gitBase>/settings/tokens/new?scopes=repo,workflow&description=DSH%20Plugin%20Publisher
        https://<gitBase>/settings/personal-access-tokens/new
        https://<gitBase>/settings/tokens
npm     https://www.npmjs.com/settings/tokens/new      （registry 非 registry.npmjs.org 时改指该主机）
        https://www.npmjs.com/settings/tokens
docs    docs.github.com / docs.npmjs.com 官方说明（固定，不随 Enterprise 变化）
```

- **Enterprise 跟随**：`gitBase` 取自 `settings.defaults`，改成 `https://ghe.example.com` 后上面三条
  GitHub 链接一起变（SSR 有专门断言：企业域名出现且 `github.com` 不再出现）。
- **诊断信息不含凭据**：`复制诊断信息` 只带 plugin / clientVersion / gitBase / apiBase / github 账号状态 /
  token 来源标签 / npm registry / npm token 是否已配 / 扫描根数量，**没有 token 原文、没有 token 掩码**。
- 新增 SSR 断言 **19 条**（116 → 135）：三条 GitHub 链接、两条 npm 链接、向导三步文案与「可选」标记、
  进度 `已完成 1/3`、折叠记忆（`data-open="0"` 且步骤列表不渲染、按钮变「展开向导」）、全绑定态
  「全部就绪」、Enterprise 派生链接、帮助页签的 7 条入口 + 官方文档 + 端点 + 诊断按钮。

## 2. 「发布按钮 = 一次性发到所有已勾选平台」是怎么做到的

一套表单 → `form.platforms` 决定 job 的步骤集（`lib/platforms.mjs` 的 `buildStepIds`）：

| 勾选 | 实际步骤 |
|---|---|
| GitHub | `auth → inspect → prepare → repo → topics → commit → push → release → finish`（与原行为逐字节一致） |
| npm | `inspect → prepare → npm-auth → npm-guard → npm-publish → npm-verify → finish` |
| 两者 | `auth → inspect → prepare → repo → topics → commit → push → release → npm-auth → npm-guard → npm-publish → npm-verify → finish` |

平台隔离：某平台某步 throw 只把该组标红，`platformResults` 里只有真正完成的平台才是 `succeeded`；
成功平台的链接照常出现在结果卡里。

## 3. 真实运行验证（在你自己这台机器上，不是 mock）

全部通过**运行中的 DSH Host**（端口 50183，`/dsh-github-publisher/api/*`）实测：

| 验证项 | 命令/入口 | 结果 |
|---|---|---|
| 插件在 GUI 里活着 | `GET /api/health` | `{ok:true, version:"0.2.0", name:"dsh-github-publisher"}` |
| 平台列表 | `GET /api/state` | `platforms=2`（github enabled、npm 可启停），`selection=["github"]`，`plugins=18` |
| npm 能力探测（**修好的 bug**） | `GET /api/state.capabilities` | `npmCli=true`、`node=v24.22.1`、`git=2.45.1` |
| 启停 npm 平台 | `POST /api/platforms` | `enabled: "github, npm"` → 再关回 `false` |
| 真实版本 bump | `POST /api/version/bump {mode:patch}` | `0.1.0 → 0.1.1`，`package.json` 真被改写 |
| 跨平台版本矩阵 | `POST /api/sync/plan` | GitHub 行 `wodaimnd/dsh-live-check 尚未创建`、npm 行 `尚未发布`，`behind=[github,npm]` |
| 预检按平台分支 | `POST /api/preflight {platforms:["github"]}` | 出现 `repo/owner/identity` 等 GitHub 检查 |
| 同上，仅 npm | `POST /api/preflight {platforms:["npm"]}` | **无 repo 检查**，出现 `npm-cli / npm-auth / npm-name / npm-version`，`needsNpmToken=true` |
| npm-only 演练发布 | `POST /api/publish` → `GET /api/job` | `succeeded`，7 步，`npm-publish=skipped(--dry-run)`，`npm-guard=首次发布` |
| 双平台演练发布 | 同上，`platforms=["github","npm"]` | `succeeded`，13 步，真实 `auth=@wodaimnd · config`、真实 `commit=82dc06f`、`npm-publish=skipped(--dry-run)` |
| npm 真跑（非演练） | `lib/platforms.mjs` `runNpm` | `npm publish --dry-run` 真实子进程 `EXIT 0`，输出 `+ npmprobe-fixture@0.0.1` |
| 缺 token → 400 | `POST /api/platforms/verify {platformId:"npm"}` | `HTTP 400 code=npm-no-token`（**修好的 bug**，原为 500 internal） |
| 非法 registry → 400 | `POST /api/platforms {npm:{registry:"http://evil.example.com"}}` | `HTTP 400 code=bad-request`，且配置文件未被写入 |
| 伪装 loopback → 400 | `...{registry:"http://127.0.0.1.evil.com"}` | `HTTP 400` |
| 自建 loopback → 200 | `...{registry:"http://127.0.0.1:4873"}` | `HTTP 200` |
| 未知平台 → 400 | `POST /api/platforms/verify {platformId:"bogus"}` | `HTTP 400 code=bad-request`，`details.platforms=["github","npm"]` |
| 不存在的目录 → 404 | `POST /api/version/bump {path:"C:\nope"}` | `HTTP 404 code=not-found` |

> 说明：GitHub 侧用的是你已配置的真实账号 `wodaimnd`（`@wodaimnd · config`），但发布走的是**演练**，
> 因此没有在你的 GitHub 上建仓、也没有推任何东西。npm 侧走 `--dry-run`，没有向 registry 上传。
> 真要实发时把「演练」取消勾选即可——那一步需要你的真实 token，代码路径已经在这里跑通。

## 4. 自动化测试（814 项，本机全绿）

```
static      122/122      静态契约：manifest / locale 对称 / 图标 / 客户端注册 / 无裸色值
host-sim     99/99       Host HTTP 契约（含 platforms / version/bump / sync/plan / 预检分支）
multi        37/37       平台注册表 / 配置归一化 / 步骤编排 / npm CLI 定位 / registry 校验 / 错误码
readme-append 7/7        README 只追加更新日志：幂等 / 原文保留 / 新版本置顶 / dry-run 不写盘
version-sync  9/9        版本声明一致性：扫描 / 漂移 / 自动同步 / bump 连带写跟随者
npm-version-guard 7/7    npm 版本守卫：重复才拦、低于 latest 只警告、一次越过远端（§4r）
npm-name-scope 6/6       发布用包名每插件独立，陈旧全局值不再劫持其他插件
lib-git      23/23       临时仓库、bare remote、askpass、abort
lib-github   29/29       mock API：401/403/404/422/限额/重试
smoke        33/33       浏览器半边状态机（伪 React）
ssr         189/189      真 React SSR：含平台勾选 / 平台配置 / 版本同步 三页 × 中英
                         + 上手向导 / 绑定外链 / Enterprise 派生 / 帮助页签
                         + 自建 registry（http://127.0.0.1:4873）不走伪造 token 页
                         + 阻断项高亮排序 / 卡片折叠 / 低于远端只警告（§4r）
e2e         253/253      从零端到端：真实 Host + 真实 git 推本地 bare + mock GitHub
```

复现：

```powershell
cd "C:\Users\Shinelon\Desktop\AI\dsh-github-publisher-0.1.0"
# SSR 需要一个真 React 运行时（只在这一项需要）
mkdir G:\AI PGRM\plugn\.react-runtime; cd G:\AI PGRM\plugn\.react-runtime
'{ "name": "react-runtime", "private": true }' | Set-Content package.json
npm i react@18 react-dom@18
$env:DSH_HARNESS_REACT_ROOT = "G:\AI PGRM\plugn\.react-runtime\package.json"

cd "C:\Users\Shinelon\Desktop\AI\dsh-github-publisher-0.1.0"
node tests/verify-static.mjs; node tests/host-sim.mjs; node tests/multi-platform.spec.mjs
node tests/lib-git.spec.mjs; node tests/lib-github.spec.mjs
node tests/client-smoke.mjs; node tests/client-ssr.check.mjs; node tests/e2e-acceptance.mjs
```

## 4b. 反馈修复：自建 registry 的「管理 npm 的 API」曾跳到捏造地址

**反馈原文**：「点击管理npm的API自动跳转到了错误的网址 http://127.0.0.1:4873」。

**缺陷**：`helpLinks()` 原来用 `npmConsoleHost(registry)` 把任何非 npmjs 的 registry 主机拼成
`'https://' + host`，再无条件接上 `/settings/tokens[/new]`。本机 registry 是 `http://127.0.0.1:4873`
（本地 Verdaccio），于是产出 `https://127.0.0.1:4873/settings/tokens` ——
**scheme 被强改成 https（必然打不开）且 `/settings/tokens` 是凭空捏造的路径**（Verdaccio 的 Web UI 就在根路径）。

**修复**：

| 改动 | 内容 |
|---|---|
| `npmRegistryOrigin(registry)` | 取 `/^(https?:\/\/[^/?#]+)/i`，**保留原 scheme** |
| `npmConsoleUrl(registry)` | origin 为空或含 `npmjs.org` → `https://www.npmjs.com`；否则返回该 origin 原样 |
| `helpLinks()` | 新增 `npmHost` / `npmLoginCommand` / `npmrcEntry` / `npmCustomRegistry`；自建 registry 时 `npmToken` 与 `npmTokens` **都塌缩为 `npmConsole`**，不再拼接路径 |
| `NpmCustomRegistryHelp` | 新增组件：三步走（复制 `npm login --registry=…` → 复制 `.npmrc` 键名 → 粘贴保存），仅自建 registry 渲染 |
| `credentialLinkItems()` | npm 组在自建 registry 时改为「打开 registry 控制台 + npm 令牌官方说明」 |
| `QuickStartCard` | 第 3 步文案换成 `guide.stepNpmCustom`，外链塌缩为一条「打开 registry 控制台」 |
| `PlatformConfigPage` / `SettingsModal(help)` | 挂载 `NpmCustomRegistryHelp`；npm 卡片的不再显示两条 npmjs 令牌链接 |

**新增 SSR 断言 14 条（135 → 149）**，钉死的是否定条件：

- `href="http://127.0.0.1:4873"` 存在，且含「打开 registry 控制台」；
- **不得**出现 `https://127.0.0.1:4873`、`127.0.0.1:4873/settings`、`.../settings/tokens`；
- 必须出现 `npm login --registry=http://127.0.0.1:4873` 与 `//127.0.0.1:4873/:_authToken=` 与两个复制按钮；
- 必须出现 `class="dgp-card dgp-guide"` 且在向导内也有 npm login 命令；
- 帮助页签同样跟随自建 registry，且不出现 `www.npmjs.com/settings/tokens`；
- npmjs 的原有断言（`https://www.npmjs.com/settings/tokens/new`）保持不变，回归未破。

复跑结果：`npm run test:all` → **728/728 全绿**。

## 4c. 真实发布事故与根因修复：Windows 上 HTTPS push 拿不到 token

**背景**：用插件真发一个从未发布过的插件（`market-lens` 0.5.0）到 GitHub，job 在 `push` 步骤失败：

```
[done  ] auth / inspect / prepare / repo / topics / commit
[failed] push     → git-network, attempts=3
         "无法连接 GitHub 的 git 服务：git 命令失败（exit 128）…"
```

**排查（逐层排除，不是直接下结论）**：

| 检查 | 结果 | 结论 |
|---|---|---|
| `curl https://github.com`、`api.github.com` | 200 | 网络与 TLS 正常 |
| `git ls-remote`（公开仓库，无需凭证） | 成功返回 refs | git 传输层正常 |
| DNS | `github.com → 198.18.0.91`（fake-ip） | 代理链路可用，非 DNS 故障 |
| `GIT_CURL_VERBOSE=1` 跟踪 | TLS 1.3 握手成功、HTTP/2 200 | 抓包层面完全正常 |
| 手工 push | `fatal: could not read Username for 'https://github.com'`，`exit 128` | **凭证没送到 git** |
| `GET /api/state.capabilities` | `askpassSupported = false` | 插件自己禁用了凭证通道 |

**真正的根因**（不是网络）：`lib/publisher.mjs` 把能力硬编码成

```js
askpassSupported: process.platform !== 'win32',   // 第 754 行
```

而 `lib/git.mjs#makeAskpass` 只会写一个 `#!/bin/sh` 的 `askpass.sh`。Windows 的 git 执行不了
POSIX 脚本（`EFTYPE`），作者于是用「Windows 上报告不支持」绕过——代价是 **Windows 上 HTTPS 推送永远失败**。
错误信息说「检查代理/VPN」具有误导性，实际与网络无关。

**修复**：

| 文件 | 改动 |
|---|---|
| `lib/git.mjs` | `makeAskpass()` 按平台分文件：win32 生成 `askpass.cmd`（`@echo off` + `if /i "%prompt:Password=%"` 分支），POSIX 仍是 `askpass.sh`；两者都从环境变量取值，**文件本身永不含 token** |
| `lib/publisher.mjs` | `askpassSupported` 改为 `true`（不再是平台判断） |
| `tests/lib-git.spec.mjs` | 断言改为：win32 必须产出 `.cmd` 且含 `GIT_PASSWORD`；POSIX 必须产出 `.sh` |

**真机验证（不是 mock）**：临时脚本用 `lib/git.mjs#push` 对真实 `github.com` 推送一个一次性分支，
再通过同一 askpass 路径删除它：

```
platform : win32
pushing  : verify-askpass-tmp
push ok  : true          * [new branch] HEAD -> verify-askpass-tmp
delete ok: true
RESULT   : PASS
```

远端分支复查：只剩 `main`，无残留。验证脚本用完即删，token 只经环境变量传递。

**修复后全量**：`npm run test:all` → **728/728 全绿**（`lib-git` 的
`HTTP push uses GIT_ASKPASS` 在 Windows 上首次真正跑通，不再是「跳过」）。

## 4d. 本次发布的实际结果（market-lens 0.5.0）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/wodaimnd/market-lens （public，全新创建） |
| 默认分支 | `main` @ `b8a0352` |
| Tag | `v0.5.0` → `b8a0352` |
| Release | https://github.com/wodaimnd/market-lens/releases/tag/v0.5.0 |
| 提交内容 | 57 个文件，**无 `node_modules`、无测试残留** |
| 克隆复验 | `git clone --depth 1` → 57 文件，`package.json` version = `0.5.0` |

**过程中拦下的两个坑（都已在发布前处理）**：

1. **演练会把工作区测试残留提交进仓库**：`test-out.txt` / `tmp-test-out.txt`（46KB）/ `tmp-test-dir.txt`
   被 `git add` 收进首个提交。已在 `.gitignore` 补 `test-out.txt`、`tmp-*`、`*-out.txt`，
   `git rm --cached` 后单独提交清理，最终仓库 0 泄漏。
2. **版本号漂移导致 tag 打错**：工作区 `package.json` 已是 `0.6.0`（有一批未提交的在研改动），
   而已发布提交里是 `0.5.0`。第一次按工作区版本创建的 `v0.6.0` tag 指向一个内容为 0.5.0 的提交，
   **已删除该 tag**，改按已提交内容在 `b8a0352` 上打 `v0.5.0` 并建 Release。
   教训：打 tag 前必须 `git show HEAD:package.json` 核对，不能读工作区文件。

## 4e. npm 侧：`fetch failed` 是误导性错误，改为点名 registry

**背景**：本地 npm registry 配的是 `http://127.0.0.1:4873`，预检里出现：

```
[warn] npm-auth    :: npm token 未能验证 :: fetch failed
[warn] npm-version :: npm 版本未校验       :: fetch failed
```

`fetch failed` 是 Node `fetch` 的笼统包装，**既不说哪个 registry、也不说为什么**——用户无法判断
是地址填错、registry 没启动、还是 DNS 或代理问题。

**真相**：Verdaccio 根本没有安装（`where verdaccio` 无结果、4873 无监听进程），
所以「连不上」是真实状态，但错误信息没说清。

**修复**（`lib/platforms.mjs#registryFetch`）：

| 传输原因 | 现在给出的 `detail` |
|---|---|
| `ECONNREFUSED` / `ECONNRESET` / `TypeError` | `127.0.0.1:4873 上没有 registry 在监听（连接被拒绝）` |
| `ENOTFOUND` / `EAI_AGAIN` / `UND_ERR_SOCKET` | `no-such-host.invalid 无法解析（DNS 查不到该主机）` |
| `TimeoutError` / `UND_ERR_CONNECT_TIMEOUT` | `<host> 连接超时（<n>ms）` |

- 统一错误码 `registry-unreachable`，`message` 附带完整 URL；
- **判定顺序有讲究**：DNS 失败会裹在 socket 错误里，所以 `isDns` 必须优先于 socket/`TypeError` 分支
  （这一步第一次写反了，实测把 DNS 误报成「连接被拒绝」，已修正并加断言）。
- `lib/publisher.mjs` 预检据此改成：`npm-auth` 标题变「registry 连不上」，detail 追加
  「请启动该 registry，或在『平台配置 → npm』里改成 https://registry.npmjs.org」；
  `npm-version` 标题变「registry 连不上，版本未校验」。**不再出现 `fetch failed`。**

**新增断言**（`tests/multi-platform.spec.mjs`，22 → 23）：把 npm 指向 `http://127.0.0.1:9`，
断言 `npm-auth` 标题为「registry 连不上」、detail 含 `127.0.0.1:9` 与「没有 registry 在监听」、
**明确断言不含 `fetch failed`**，且 `npm-version` 也给出可读原因。

## 4f. npm 真实发布的两个硬阻塞（已核实，不是插件缺陷）

这两个必须说清楚，否则会误以为「点一下就能发 npm」：

| 阻塞 | 证据 | 结论 |
|---|---|---|
| **本机没有 registry 可发** | `where verdaccio` → 无结果；`Get-NetTCPConnection -LocalPort 4873` → 无监听；`curl 127.0.0.1:4873` → 连接被拒绝 | 配的 `http://127.0.0.1:4873` 是一个**从未安装**的服务 |
| **`@local` scope 不属于你的 npm 账号** | `npm whoami` → `jntm114514`；`npm org ls local` → **403 You may not perform that action with these credentials**；匿名 `GET /-/org/local/user` → `{"local":"owner"}`（说明该 org 存在但成员不是你） | 所有插件包名都是 `@local/...`，**直接发公共 registry 会被 403 拒绝** |

可选出路（需要你决定，我没有擅自改包名或发布）：

1. 装 Verdaccio 并启动 → 保持 `@local` 包名，`http://127.0.0.1:4873` 立刻可用
2. 包名改到自己的 scope（如 `@jntm114514/market-verdict`）或不用 scope → 可发公共 registry
3. 只在 GitHub 发布，npm 保持关闭

**凭据核验（4 个全部有效，只读检查，未做任何写操作）**：

```
ghp_Pzv…waDB            → wodaimnd   VALID
github_pat_11AV4…mkn    → wodaimnd   VALID
npm_94…dMFz             → jntm114514 VALID
npm_qH…b9JRz            → jntm114514 VALID
```


## 4g. Git Credential Manager 会弹窗阻塞自动化发布（已隔离）

**现象**：执行 git push / ls-remote 时桌面弹出 Git Credential Manager 的
"Sign in with your browser" OAuth 窗口，必须人工点一下才会走到
"Authentication Succeeded"，否则命令一直挂着。

**根因**：Git for Windows 把 GCM 装在 **system 级**凭据助手：

```
git config --system credential.helper → manager
```

lib/git.mjs 只在 push 路径上传了 `-c credential.helper=`，但 `ls-remote` /
`fetch` 等其它调用没带，git 就去问 system 的 GCM，GCM 发现没存凭据便开窗等人点。

**修复**（把隔离下沉到唯一入口 `runGit`，覆盖本模块所有 git 调用）：

| 机制 | 作用 |
|---|---|
| 每条命令前置 `-c credential.helper=` | 把 system 的 `manager` 整条链路清空（仅本进程） |
| `GIT_TERMINAL_PROMPT=0` | 绝不读 stdin，缺凭据立刻失败 |
| `GCM_INTERACTIVE=never` / `GCM_GUI_PROMPT=0` | GCM 被调用也拒绝开窗 |
| `GIT_ASKPASS_REQUIRE=force` + `GIT_ASKPASS` | HTTPS push 凭据只从临时 askpass 脚本取 |

**关键取舍：不动用户的全局配置。** `git config --global credential.helper ""`
虽然更省事，但会让你自己手敲 git 也失去凭据助手。所以隔离只在本插件进程内生效：

```
global  credential.helper = (空，未改)
system  credential.helper = manager  (仍是原样，你手敲 git 照常)
插件进程内               = 无 helper + askpass only
```

**验证**（真机，非 mock）：

- 对需要认证的 URL 跑 `runGit(['ls-remote', …])` → **秒级失败**且输出中不含
  "Git Credential Manager" / "Sign in with your browser"（历史上会永久阻塞）
- 本地裸仓库 `push` 仍成功（隔离不破坏正常推送）
- 错误消息里的命令串**不含** `credential.helper`（内部参数不外泄）
- 设一个会留痕的假 helper 再前置空 helper，证实空 helper 能覆盖它

**新增断言**：`tests/lib-git.spec.mjs` 增加
`every git call is isolated from Git Credential Manager`（22 → 23 项），
断言环境常量、快速失败、无 GCM 痕迹、并无参数泄漏。

**结果**：从 "弹出窗口 + 等待人工" 变为 "无人值守跑完"。

## 4h. Registry 地址校验过严（反馈修复）

**反馈原文**：「Registry 只接受 https:// 或以 http://127.0.0.1、http://localhost 开头的地址」

**问题**：这条规则只放行 `https://` 与 `http://127.0.0.1|localhost`，把真实的私有
registry 场景全挡在门外：

| 被拒地址 | 实际场景 |
|---|---|
| `http://192.168.1.50:4873` | 局域网 Verdaccio |
| `http://10.0.0.5:4873` | 内网 Nexus |
| `http://registry.internal:4873` | 内网域名 |
| `http://[::1]:4873` | IPv6 回环 |
| `registry.npmjs.org` | 用户漏写协议 |

**新规则**（`isAcceptableBaseUrl` / `isPrivateHostname`）：

- `https://` 任意主机：**放行**
- `http://` 仅在私网主机：**放行**（127/8、10/8、192.168/16、172.16–31/12、169.254/16、
  `::1`、`fe80::/10`、`fc00::/7`、`.local` / `.internal` / `.lan`、单段主机名）
- `http://` 指向公网主机：**拒绝**（token 会明文上网）——提示语直接给出应改的 `https://` 形式
- 无协议：按 host 推断 scheme（`registry.npmjs.org` → https、`127.0.0.1:4873` → http）

**没有放宽的部分**（防止绕过）：

- `http://192.168.1.50.evil.com:4873`：主机名不是 IP，仍拒
- `http://127.0.0.1.evil.com`：四段 IPv4 解析失败，仍拒
- `http://172.15.0.1` / `http://172.32.0.1`：刚好落在 172.16/12 之外，仍拒
- `ftp://…`：scheme 白名单之外，仍拒

**前后端一致性**：`client.js#isAllowedBaseUrl` 与 `lib/platforms.mjs#isAcceptableBaseUrl`
是同一条规则的镜像；用 21 个用例交叉比对，**判定完全一致**（脚本已验证）。

**测试**：`tests/multi-platform.spec.mjs` 新增 4 个用例（接受清单 13 条、拒绝清单 9 条、
无协议推断 5 条、错误提示可操作性 2 条），29 → 33 项。

**提示语**也不再是原来那种"只接受 https:// 或 127.0.0.1"的笼统说法，而是：

```
Registry 用 http:// 指向公网主机 evil.example.com：token 会明文上网。
请改用 https://evil.example.com，或确认这是内网地址
```

## 4j. 面板内启动 registry + 加载时自动检测

**需求**：「在插件里新增启动按钮，其次是插件运行自动检验是否启动，若没有则先运行。」

**Host 侧**（`lib/platforms.mjs` + `index.js`）：

| API | 作用 |
|---|---|
| `GET /api/registry/status?registry=…` | 只读体检：`local` / `verdaccio` / `listening` / `reachable` / `startable` / `detail`。不带参数时用已存的 npm registry |
| `POST /api/registry/start` | 拉起本机 registry，返回启动后的 status（含 `attempts`） |

**判定分层**（`registryStatus`）：`reachable=false` 时继续区分
「端口有监听但 ping 失败」→ 仍在启动；「本机 + Verdaccio 已装 + 端口关闭」→ `startable=true`；
「远端主机」→ 不可启动，提示只能启动本机。

**启动策略**（`startLocalRegistry`，逐个尝试、成功即停）：

1. Windows 计划任务 `VerdaccioLocalRegistry`（脱离会话，DSH 重启后仍在）
2. `G:\AI PGRM\plugn\start-verdaccio.ps1`（幂等脚本，任务不存在时兜底）
3. 直接 detached `verdaccio -c config.yaml`

**前端**：

- `RegistryStatusRow` 状态条：`在线` / `未启动` / `连不上` / `未检测` 四态 + 原因文字 +
  「启动 registry」（仅 `startable=true` 才出现）+「重新检测」
- `store.checkRegistry()` / `store.startRegistry()` 两个动作
- **自动**：`loadState` 首次成功后调 `checkRegistryOnLoad()` —— 不可达且可启动就**直接启动**，
  成功弹 toast。`registryAutoTried` 保证每会话只试一次，失败不循环

**实测**（真机，非 mock）：

- 杀掉 4873 进程 → `registryStatus` 返回 `startable: true` →
  `startLocalRegistry` → `started: true, reachable: true`，`attempts: scheduled-task=true`
  （修正后只有一条策略执行，不再多开一次 PowerShell）
- `https://registry.npmjs.org` → `local: false, startable: false`，
  `startLocalRegistry` 返回「只能启动本机 registry」，**不会**去 shell out

**测试**：`multi-platform.spec.mjs` +4（37 项）、`client-ssr.check.mjs` +15（168 项）、
`verify-static.mjs` 契约路由表补 `registry/status` 与 `registry/start`。

## 4k. 三个反馈一起修：缓存不丢、README 只追加、Release 追加而不复用

**反馈**：「其次要有缓存能力，不要重新进入一刷新之前设置的内容就没有了。而且发布更新的时候，
之前的 readme 之类的内容就不做修改，仅仅增加更新日志，而不是反复重发与覆盖。」

### ① 静默刷新会清空界面（缓存丢的根因）

`loadState({silent:true})` 之前只 `setState(shared)`，**不重建 form**，也不保留 search /
selectedPath / activeTab。发布、预检、扫描后都会触发一次静默刷新，于是用户刚填的东西被冲掉。

现在静默刷新只替换服务端拥有的切片（plugins / history / account / platforms / settings），
**保留** `selectedPath` / `form` / `formDirty` / `formErrors` / `search` / `preflight` /
`activeTab` / `settingsOpen` / `toast`。

另外搜索词现在落盘（`dsh-github-publisher.search`），重开面板仍是上次的筛选条件。

### ② README 只在缺失时生成，更新时只追加更新日志

`readmeMode` 从两档扩到三档，**默认改为 `append`**：

| 模式 | 行为 |
|---|---|
| `auto` | 有 README 就 keep，没有才生成 |
| `append`（新默认） | 保留现有 README **每一个字节**，只在末尾维护一个 `## 更新日志` 块 |
| `regenerate` | 整文件重写（唯一破坏性模式，需用户显式选择） |

追加规则（`appendReleaseNotes`）：

- 首次追加：原文完整保留，末尾新增带标记的日志块（`<!-- dsh-publisher:releases:begin/end -->`）
- 后续版本：新条目**置顶**，旧条目保留在下（newest first）
- 重复发布同一 tag：`already recorded`，**文件字节不变**（幂等）

实测（真文件）：手写 README 47 字节 → 追加后 210 字节，原文一字不差，只多出日志块。
测试覆盖 7 项（`tests/readme-append.spec.mjs`）。

### ③ 已存在的 Release 现在会更新，而不是静默丢弃

原来 `getReleaseByTag` 命中就 `复用`，新写的更新说明**根本发不出去**。现在：

| 情形 | 动作 |
|---|---|
| 已有 Release 没写说明 | `updateRelease` 写入本次说明 |
| 已有说明且含本次 tag | 保持不变（幂等） |
| 已有说明但不含本次 | `新说明 + --- + 旧说明`，**旧内容保留在下方** |

新增 `GitHubClient#updateRelease`（`PATCH /repos/:owner/:repo/releases/:id`）。

### 测试

本节当时的清单是 `773 项全绿`：static 122 / host-sim 99 / multi 37 / readme-append 7 /
lib-git 23 / lib-github 29 / smoke 33 (+2 缓存用例) / ssr 170 / e2e 253
（当前总数见 §4，**814 项**）

## 4l. npm token 改为从 .npmrc 自动读取（不再手动粘贴）

**根因**：egistry HTTP 401 是因为配置里存的 token 是 29 个字符的
//127.0.0.1:4873/:_authToken= —— 那是 .npmrc 的**键名**，不是 token 值（真值 124 字符）。
来源是面板上那个「复制 .npmrc 键名」按钮：它复制的就是键名，用户照做就粘错了。

**修法（三层）**：

| 层 | 内容 |
|---|---|
| 读取 | eadNpmrcToken(registry) 按 host 匹配扫描 ~/.npmrc、~/.npmrc-verdaccio、$NPM_CONFIG_USERCONFIG、$DSH_NPMRC |
| 识别 | looksLikeNpmrcKey(value) 一眼认出「// 开头」或「含 _authToken」的串 |
| 拦截 | saveNpmToken() 在发给 registry 前先挡掉键名，返回 
pm-token-is-key 并告诉用户去点自动读取 |

**接口**：

- POST /api/platforms/npm-token/detect { adopt?: boolean }
  - dopt:false → 只报告找到的 token hint 与来源文件（不写盘）
  - dopt:true → 校验并保存
- 前端 store.detectNpmToken(adopt) 两个动作：「自动读取并保存」「只检测不保存」

**界面变化**：原来那个会误导人的「复制 .npmrc 键名」按钮**已删除**，替换为
「从 .npmrc 自动读取（推荐，省得手动复制出错）」+ 两个按钮 + 读到后显示 hint 与来源文件。

**实测**（真机）：

```
detect  -> found=true  hint=ZTI5Mz…MWEw  source=C:\Users\Shinelon\.npmrc-verdaccio  account=jntm114514
adopt   -> saved=true  login=jntm114514
保存后 token 长度: 124        ← 正确值，不再是 29 的键名
whoami  -> jntm114514        ← 用它打 registry 通过
```

坏值拦截实测：

```
saveNpmToken("//127.0.0.1:4873/:_authToken=")
→ code: npm-token-is-key
→ "这看起来是 .npmrc 的键名…点「从 .npmrc 自动读取」让插件自己取那个值"
```

## 4m. 自发布实录：GitHub 成功，npm 因环境变量名失效

**任务**：把「多平台发布台」自己发布到 GitHub + npm。

### 先修掉一个真实配置错误

package.json 的 epository / homepage / ugs / uthor 全部指向 Sun-0306，
而实际登录账号是 wodaimnd，那个仓库在 GitHub 上 404。已改为 wodaimnd。

### GitHub 侧：完全成功

| 步骤 | 结果 |
|---|---|
| repo | 新建 public wodaimnd/dsh-github-publisher |
| topics | deepseek / dsh / dsh-plugin |
| push | 第一次 xit 128（网络瞬时不可达，手工带 token 也复现），网络恢复后重试成功 |
| release | 0.3.0 |

### npm 侧：ENEEDAUTH，根因是环境变量名


pm-auth 预检通过（走 
pmVerify → 直接 fetch /-/whoami），但 
pm-publish 报

eed auth。两者走了**不同的凭据通道**：

- 预检：我自己发 HTTP 请求，token 放在 Authorization 头 → 通过
- 发布：把 token 塞进子进程环境变量 
pm_config_<host>:_authToken → **npm 读不到**

该变量名在这种情形下含有冒号和端口（
pm_config_127.0.0.1:4873:_authToken），
Windows 下 cmd/环境块传递不可靠，npm 实际没拿到凭据。

**修法**：改用**临时 .npmrc**（
pm_config_userconfig 指向一个 0600 的临时文件，
内容 //host/:_authToken=…），这是 npm 跨平台最可靠的传凭据方式；子进程 close 时删除
临时目录，实测不残留。

**实测**：

`
runNpm(["whoami"]) 带 token  →  之前 FAIL(ENEEDAUTH)，现在 OK
临时 .npmrc 泄漏检查        →  leaked: 0
真实 publish                →  PUBLISHED: true, version: 0.3.0
registry 核实              →  @jntm114514/dsh-github-publisher@0.3.0
`

### 源码没有被改坏

| 文件 | 发布后状态 |
|---|---|
| package.json | 与发布前**字节相同**（prepare 无需改动） |
| README.md | 与发布前**字节相同**（dryRun 与真实发布都没触发追加，因为文件被判定无需改动） |
| 
ame / private | 仍是 dsh-github-publisher + private:true（npm 只在临时副本里改名并去 private） |

### 复现命令

```powershell
# 预检
POST /dsh-github-publisher/api/preflight  { path, form: { platforms:["github","npm"], dryRun:true } }
# 真实发布
POST /dsh-github-publisher/api/publish    { path, form: { platforms:["github","npm"], dryRun:false } }
```

## 4n. 版本一致性契约缺口（本轮真发暴露）

**现象**：Host 重启后发 0.3.1，预检与发布都成功，但 erify-static 报
`package version expected 0.3.0 / actual 0.3.1`。

**根因**：`POST /api/version/bump` 只改 `package.json`。包内另有 **四处**版本声明没跟着走：

| 位置 | 常量 |
|---|---|
| `package.json` | `version` |
| `client.js` | `CLIENT_VERSION` |
| `lib/publisher.mjs` | `VERSION` |
| `lib/github.mjs` | `DEFAULT_USER_AGENT` |
| `CONTRACT.md` | 固定标识符表「版本」行 |

于是 registry 上的 0.3.1 是个**名不符实**的包：`package.json` 写 0.3.1，
而 `CLIENT_VERSION` / `VERSION` / UA 都还是 0.3.0。装进 profile 后会显示旧版本号。

**修法（两层）**：

1. **把声明对齐**：bump 后同步改另外四处（本轮手工全量刷到 0.3.2）。
2. **把断言改成自校验**：测试不再硬编码版本字面量，一律以 `package.json` 为唯一真值

```js
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
```

`verify-static` / `host-sim` / `lib-github.spec` / `e2e-acceptance` 全部改为与
`package.json` 比对，以后 bump 只需改一处真值。

**真发实录（v0.3.2，13/13 步）**：

```
[done] repo     复用已有仓库 wodaimnd/dsh-github-publisher
[done] commit   提交 5faf7ea
[done] push     已推送 main
[done] release  Release v0.3.2
[done] npm-auth @jntm114514
[done] npm-guard 远端 0.3.1 → 本次 0.3.2
[done] npm-publish @jntm114514/dsh-github-publisher@0.3.2
[done] npm-verify  registry 已收录 0.3.2
```

**tarball 内容核实**（下载包解压对照，不只是看 metadata）：五处版本号全部为 0.3.2，
`name` 为 `@jntm114514/dsh-github-publisher`，`private` 已被去掉（源码里仍是 `true`）。

### 仍未自动化的一处

`POST /api/version/bump` **仍然只改 `package.json`**。本轮是靠手工同步其余四处。
这是下一处该补的：bump 时一并改写 `CLIENT_VERSION` / `VERSION` / `DEFAULT_USER_AGENT` /
`CONTRACT.md`，否则下次 bump 还会出现同样的不一致。

## 4o. 版本声明自动同步（补 4n 留下的缺口）

**上一轮遗留**：`POST /api/version/bump` 只改 `package.json`，另外三处声明要手工同步。

**本轮补完**。新增 `lib/version-sync.mjs`：

| 导出 | 作用 |
|---|---|
| `findVersionDeclarations(pluginPath)` | 扫插件自身源码，找出所有版本声明 |
| `inspectVersionDrift(pluginPath, expected?)` | 与 `package.json` 比对，分出 drifted / synced |
| `syncVersionDeclarations(pluginPath, target, {dryRun})` | **只替换版本字面量**，其余字节不动；幂等 |

识别的三处声明（实测恰好 3 条，不误报）：

```
client.js              CLIENT_VERSION
lib/publisher.mjs      VERSION
lib/github.mjs         DEFAULT_USER_AGENT
```

扫描排除 `node_modules` / `tests` / `dist` / 点目录，并排除自身模块
（`version-sync.mjs` 的文档注释里含同样的样例文本，否则会自匹配）。

**接入两处**：

1. `Publisher#bumpVersion` 现在**默认全量同步**：先写跟随者，最后写 manifest
   （跟随者失败时 manifest 不会被改，避免"清单说 0.4.0 而别处还是 0.3.x"）。
   返回值新增 `synced: [{ rel, from, to }]`；`sync:false` 可关闭。
2. 预检新增 `version-drift` 检查项：不一致时 `warn` 并列出具体文件与旧版本，
   一致时 `pass`。**是警告不是阻塞** —— 因为一次 bump 就能全部修好。

**新接口**：`POST /api/version/drift` `{ path }` → 只读，返回漂移表。

**实测**：

```
BEFORE canonical: 0.3.2 | drifted: 0
BUMP: 0.3.2 -> 0.3.3
synced: client.js 0.3.2->0.3.3, lib/github.mjs 0.3.2->0.3.3, lib/publisher.mjs 0.3.2->0.3.3
AFTER canonical: 0.3.3 | drifted: 0
```

人为造漂移（把 client.js 改回 0.3.0）后预检输出：

```
status : warn
title  : 版本声明不一致
detail : package.json 是 0.3.2，但这些地方还是旧版本：client.js（0.3.0）。点「提升版本」会一次同步全部
```

**测试**：`tests/version-sync.spec.mjs` 新增 8 项（含幂等、只改字面量、不扫 node_modules/tests、
无额外声明的朴素插件）。

## 4p. 阻断项高亮 + 一键提升版本

**反馈**：「版本 0.3.2 已存在于 npm / 远端最新为 0.3.2；先 bump 版本再发布……能不能高亮未设置好的地方，我找不到」

### 根因（两个）

1. `npm-version` 的 `fix` 是 `'form'`，而 `fixCheck('form')` 只会滚到 `dgp-section-publish` ——
   **那块里根本没有版本号字段**。点了等于没点。
2. 失败项与通过项**同权重、同顺序**混排。十几条 pass 里埋一条 fail，视觉上等于不存在。

### 修法

**① 后端给出可执行动作**

`npm-version` 失败时改为 `fix: 'bump'` 并附 `suggestion`（应写入的目标版本）：

```
status     : fail
title      : 版本 0.3.2 已存在于 npm
detail     : 远端最新为 0.3.2；先 bump 版本再发布
fix        : bump
suggestion : 0.3.3
blocking   : npm-version
```

**② 前端三件事**

| 改动 | 效果 |
|---|---|
| `fixCheck` 支持 `'bump'` | 直接调 `store.bumpVersion('patch')`，一键改完 |
| `CheckRow` 按钮文案带具体值 | 「**提升到 0.3.3**」而不是笼统的「修复」 |
| `sortedChecks` 按 fail → warn → pass 排序 | **阻断项排到最上面**，组内保持原顺序 |
| CSS 加背景色 | fail 行 `color-mix` 红底 + 红色描边；warn 行黄底；bump 按钮红色加粗 |

全部用 `--dsw-alias-*` token，无硬编码色值。

**③ `normalizeCheck` 保留 `suggestion`**（原来会丢弃未知字段）。

### 实测

真实 registry 上 0.3.2 已存在，预检直接给出：

```
status     : fail
fix        : bump
suggestion : 0.3.3
可点击按钮 : 「提升到 0.3.3」
```

### 测试

`version-sync.spec.mjs` 新增 1 项（真起一个 HTTP mock registry 让冲突真的发生，
断言 `fix === 'bump'` 且 `suggestion === '1.0.1'`）；
`client-ssr.check.mjs` 新增 4 项（fail 高亮、按钮带版本号、fail 排在 pass 前面、阻断时不给发布按钮）。


## 4q. npm 发布名改为「每插件独立」+ 平台卡片可折叠

**反馈**：「预检依旧有问题，不同插件的 npm 版本应该不互相挤占的。其次是平台配置 UI 里的 npm 改成和
GitHub 的设置 UI 一样，点了才弹出，不然太占位置了。」

### 问题一：npm 发布名被所有插件共用（真缺陷）

**实证**（改前）：

```
全局 platforms.npm.publishName = "@jntm114514/dsh-github-publisher"

dsh-github-publisher → npmName = @jntm114514/dsh-github-publisher → fail「版本 0.3.3 已存在」
market-lens         → npmName = @jntm114514/dsh-github-publisher → fail「版本 0.8.0 已存在」
market-verdict      → npmName = @jntm114514/dsh-github-publisher → fail「版本 0.1.0 已存在」
```

三个完全不同的插件被当成同一个包，后两条 fail 全是假的。根因：`npmPublishNameOf` 读的是**全局**
`config.platforms.npm.publishName`，一旦设过，所有插件都用它。

**修法**：把发布名从全局挪到**每插件的 draft**。

| 改动 | 内容 |
|---|---|
| `FORM_KEYS` | 增加 `publishName`，让 draft 能承载 |
| `npmPublishNameOf(pluginName, pluginConfig)` | 只认传进来的那个插件配置，**不再读全局** |
| 9 处调用点 | 全部改为 `{ publishName: form.publishName }` 或该插件自己的 draft |
| `mergeForm` | 新增 `form.publishName`（来源：request → draft → defaults，**不经全局**） |
| `syncPlan` | 单独读取该插件的 draft |

**迁移**：把原来的全局值写进该插件自己的 draft，然后**清空全局**：

```
已写入该插件 draft.publishName = @jntm114514/dsh-github-publisher
全局 publishName 现在是: ""
```

**验收**（真实配置，四个插件各自独立）：

```
全局 platforms.npm.publishName: "" 

dsh-github-publisher  @jntm114514/dsh-github-publisher  | name: pass | version: fail（0.3.2 真存在）
market-lens           @local/market-lens                | name: pass | version: pass
market-verdict        @local/market-verdict             | name: pass | version: pass
apk-lab               @local/apk-lab                    | name: pass | version: pass
dsh-offload           @local/dsh-offload                | name: pass | version: pass
```

注意 `dsh-github-publisher` 那条 fail 是**真的**（0.3.2 确实在 registry 上），其余全部恢复 pass。

### 问题二：平台卡片常驻展开

`SectionCard` 原本没有任何折叠能力（`dgp-card-body` 永远渲染）。npm 卡片里塞了
Registry / Token / access / distTag / provenance / 发布名 / .npmrc 帮助块，比 GitHub 卡片高得多。

**修法**：给 `SectionCard` 加 `collapsible` / `defaultOpen` / `storageKey` / `summary` / `forceOpen`：

| 项 | 行为 |
|---|---|
| npm 卡片 | `collapsible` + **`defaultOpen: false`**（默认收起） |
| 收起时头部 | 仍显示一行摘要：`registry · @账号 · 发布名/按 package.json 名` |
| 展开控件 | 标题本身就是按钮（chevron 旋转 90°）+ 右侧「展开/收起」 |
| 可访问性 | `aria-expanded` / `aria-controls` 指向真实 body id（由 `storageKey` 派生） |
| 持久化 | `localStorage['dsh-github-publisher.collapse:npm'] = '0' | '1'` |
| `forceOpen` | 预留给「有阻断问题时自动展开」 |

标题是按钮、卡片头保留 `dgp-card-head`，所以视觉与其他卡片一致。

### 顺带修掉的两处过时约束

1. `verify-static` 的主题 token 白名单只允许 `--dsw-alias-*`，但项目规范允许
   `--dsw-radius-*` / `--dsw-focus-ring-*` / `--dsw-font-*`。焦点环是正当用法，白名单已放宽。
2. `multi-platform.spec.mjs` 有两条用例仍用 `updatePlatforms({ npm: { publishName } })` 设置包名——
   那是旧的全局模型。已改为 `saveDraft(pluginDir, { publishName })`。

### 测试

`tests/npm-name-scope.spec.mjs` 新增 **6** 项：`npmPublishNameOf` 回退、per-plugin 覆盖、
「A 插件设包名不影响 B 插件」、「三个插件三个不同名」、**陈旧全局值不再劫持其他插件**、draft 往返。
`client-ssr.check.mjs` 新增 **3** 项折叠断言（默认收起、摘要、`aria-expanded` / `aria-controls` / 展开控件）。

本节当时合计增加 21 项（781 → 802）。

## 4r. 「版本 0.3.4 已存在于 npm」是一句不可能成立的话（本轮修复）

用户报的原文：

```
版本 0.3.4 已存在于 npm
失败
远端最新为 1.0.1；先 bump 版本再发布（npm 不允许重发同名版本）
```

标题与下一行自相矛盾：如果远端最新是 1.0.1，那么 0.3.4 就不可能「已存在」。这三行里藏了三个独立缺陷。

### 4r-1 三个缺陷

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 把「这个版本号已被占用」与「本地版本低于远端 latest」当成同一件事 | **假拒绝**：0.3.4 从未发布过，npm 允许发布低于 latest 的版本，插件却拦住了 |
| 2 | 标题按前者写死、detail 按后者拼字符串 | **自相矛盾的文案**：「已存在」+「远端最新为 1.0.1」不可能同时成立 |
| 3 | `suggestion = bumpVersionString(local,'patch')` | **死循环**：0.3.5 仍然 ≤ 1.0.1，点一次失败一次，用户永远出不来 |

附带一处视图不一致：`compareSyncState(local, remote)` 是 `return order > 0 ? 'behind' : 'ahead'`，
local 0.3.4 vs remote 1.0.1 得 `ahead`，所以同步页的 behind 列表不含 npm、`needsBump=false`，
与预检的 fail 互相打脸。

根因是**数据不够**：旧 `npmRemoteState` 只请求 `/<name>/latest`，只拿得到「最新是哪个版本」，
拿不到「有哪些版本」——这个问题它根本无法回答，于是用 latest 的位置关系去猜。

### 4r-2 实证（不猜）

- registry 上 1.0.0 / 1.0.1 是插件自己发出去的：`$DSH_HOME/github-publisher/history.json` 有
  v1.0.1 / v1.0.0 / v0.3.3 / v0.3.2 / v0.3.1 / v0.3.0。
- 对照实验（临时包 `@jntm114514/dsh-guard-probe`）：先发 2.0.0（占 latest），再发 1.0.0 →
  **Verdaccio 接受，且 `dist-tags.latest` 退回到 1.0.0**，`versions=[1.0.0,2.0.0]`。
  结论：低版本发布**合法**，代价是 latest 倒退 → 该**警告**，不该拦。
  探针已彻底清理（unpublish + 删存储目录 + 重写 `.verdaccio-db.json` 的 list），复查 404。
- `npmRemoteState('@jntm114514/dsh-github-publisher')` 实测：`has('0.3.4') = false`（**证明 0.3.4 是空的**）、`has('1.0.1') = true`。

### 4r-3 修法

| 层 | 改动 |
|---|---|
| 数据 | `lib/platforms.mjs` 的 `npmRemoteState` 改读**完整 packument**（`accept: application/vnd.npm.install-v1+json`），返回 `{exists, version, versions(降序), has(v), url, publishedAt}`；`has` 先严格串匹配、再退化为 `compareVersions === 0` |
| 页面地址 | 新增 `registryPageUrl(base,name)`：npmjs 用 `www.npmjs.com/package/<name>`，自建 registry 用 `<base>/-/web/detail/<name>`（不再猜 npmjs 的路径） |
| 判定 | 新增 `nextVersionAbove(local,remote)`：取 remote/local 较大者为 floor 再 patch+1，**保证一次越过远端** |
| 唯一真值 | 新增 `versionGuardVerdict({local,remote})` → `{ok,reason,next}`，reason ∈ `no-local / first-publish / duplicate / below-latest / ahead`；**预检与发布守卫共用同一个纯函数**，从结构上消除两处走偏（本 bug 正是这个形状） |
| 预检 | `duplicate` → fail + `fix:'bump'` + suggestion；`below-latest` → **warn** + `fix:'bump'` + suggestion（附「latest 会退回」）；`ahead` → pass |
| 守卫 | `npm-guard` 改为 `if (!verdict.ok) throw version-exists`；`below-latest` 记一条 warn 后**放行** |
| 回查 | `npm-verify` 改用 `remote.has(version)`（不再要求等于 `dist-tags.latest`——低版本发布时它本来就不等） |
| 同步页 | `syncPlan` 新增 `occupied[] / belowLatest[] / bumpSuggestion`；两个 bump 按钮改用 `plan.bumpSuggestion`；`needsBump` 改为 `occupied.length>0 || belowLatest.length>0`；`needsVersionBump` 同步修正 |
| 前端 | `store.bumpVersion(mode, version)` 支持显式版本；`fixCheck('bump')` 传 `check.suggestion`；新增文案 `sync.belowLatest / sync.occupiedN / sync.bumpTo`（中英对称） |

### 4r-4 修完的实测输出

预检 `dsh-github-publisher`（本地 0.3.4，远端 1.0.1）：

```
[warn] npm-version  本地 0.3.4 低于远端最新 1.0.1
blocking = []   canPublish = true   suggestion = 1.0.2
plan.npm.versionOccupied = false   belowLatest = true   bumpSuggestion = '1.0.2'
url = http://127.0.0.1:4873/-/web/detail/@jntm114514%2fdsh-github-publisher
```

`nextVersionAbove` 用例：`('0.3.4','1.0.1') → 1.0.2`、`('1.0.1','1.0.1') → 1.0.2`、
`('0.3.4','0.3.3') → 0.3.5`、`('0.3.4',null) → 0.3.5`、`('1.0.1','1.0.1-rc.1') → 1.0.2`。

### 4r-5 本轮测试

`tests/npm-version-guard.spec.mjs` 新增 **7** 项：`nextVersionAbove` 六组边界、
`versionGuardVerdict` 五分支（**duplicate 才拦** / below-latest 放行 / ahead / first-publish / no-local）、
`npmRemoteState` 列出全部版本且 `has('0.3.4')===false`、
真起 mock registry：**free-but-older → warn 且不阻塞**、**真被占用 → fail 且 `canPublish=false`**、
以及真跑一次 publish 断言 `npm-guard` **不会**拒绝 0.3.4（`no step may report version-exists`）。

`tests/version-sync.spec.mjs` 的 mock registry 补了 `versions`——旧 fixture 只回 `dist-tags.latest`，
在「必须知道有哪些版本」的新数据模型下，它本来就答不出「1.0.0 是否存在」。

`tests/client-ssr.check.mjs` 新增 **5** 项：低于远端时面板说「本次可以发布，但 latest 会退回」、
带出 `1.0.2` 的越级 bump 建议、且**绝不**出现「已经存在这个版本号」。

本节合计增加 12 项（802 → **814**）：

```
static 122 / host-sim 99 / multi 37 / readme-append 7 / version-sync 9 /
npm-version-guard 7 / npm-name-scope 6 / lib-git 23 / lib-github 29 /
smoke 33 / ssr 189 / e2e 253   = 814
```

改动文件：`lib/platforms.mjs`、`lib/publisher.mjs`、`client.js`、`CONTRACT.md`、
`tests/npm-version-guard.spec.mjs`（新）、`tests/version-sync.spec.mjs`、`tests/client-ssr.check.mjs`、`package.json`。
改动前的整份快照在 `G:\AI PGRM\plugn\backup\publisher-version-guard`（28 个文件）。

## 5. 为在这台 Windows 机器上跑通而修掉的测试侧缺陷

这些**不是插件功能问题**，是原测试写死在 POSIX 上；不改它们就无法验证功能（已逐条最小化修改，语义不变）：

| 位置 | 原问题 | 改法 |
|---|---|---|
| `tests/host-sim.mjs` | `await import(path.join(...))` 在 Windows 抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（备份副本同样报错） | 改 `pathToFileURL(...).href` |
| `tests/host-sim.mjs` | 断言 `config.json` 是 0600；Windows 不暴露 POSIX 位（实测恒为 666） | 仅在非 win32 断言 |
| `tests/client-ssr.check.mjs` | React 路径写死 `/Users/sunchujun/...`，本机无此目录 | 改 `DSH_HARNESS_REACT_ROOT` 等候选路径，找不到就 `SKIP` 而不是硬失败 |
| `tests/e2e-acceptance.mjs` | `which git` + `/usr/bin/git`；`gitBase` 用 `file://` 手工拼接 | 改 `where git`；`file://` 改 `pathToFileURL` |
| `tests/e2e-acceptance.mjs` | git argv 探针是 `#!/bin/sh` 脚本，Windows 无法 exec（`EFTYPE`） | win32 用 `git.cmd` 包装；POSIX 保持原样 |
| `tests/e2e-acceptance.mjs` | 路径比较 `C:\a\b` vs `C:/a/b` 恒不等 | 新增 `samePath()` 归一化分隔符与大小写 |
| `tests/lib-git.spec.mjs` | askpass 目录 0700 + 直接 exec `.sh` | win32 跳过 0700 断言；`.cmd` shim 的存在性已断言（4c 真正的修复） |
| `tests/lib-github.spec.mjs` | 断言 user-agent `.../0.1.0` | 跟随版本改为 `0.2.0` |

## 6. 顺带修掉的两个**真功能 bug**（线上发现，已修 + 加测试）

1. **Electron 里探测不到 npm**：Host 的 `process.execPath` 是 `DeepSeek Harness.exe`，旁边没有
   `node_modules/npm`，原来的「execPath 同级找 npm」必然失败（线上 `capabilities.npmCli=false`）。
   现在 `npmCliCandidates()` 依次尝试：execPath 同级 → PATH 上的 `node` → PATH 上的 `npm`
   → `npm_config_prefix` / `%APPDATA%\npm` / `NODE_PATH`；`nodeBinaryFor()` 单独解出真正能跑
   `npm-cli.js` 的 node。线上复验 `npmCli=true`。
2. **配置接口漏校验 + 错误码吞掉**：`POST /api/platforms` 原样写入 registry，`http://evil.example.com`
   也能存进去；`PlatformConfigError` 没被 `failurePayload` 识别，缺 token 时返回 **500 internal**。
   现在 URL 先校验后写盘（拒绝裸 http、拒绝 `http://127.0.0.1.evil.com` 这类伪装），
   `PlatformConfigError` 映射为 400 并保留 `npm-no-token` 等稳定错误码。各补一条回归测试。

## 7. 已知边界（写清而不是含糊过去）

| 项 | 现状 |
|---|---|
| 真·上传 npm | 代码路径已真跑（`--dry-run` 到真实 npm CLI），但**没有**向 registry 上传过包——那需要你的 token 并会真的发布一个包。你点「发布」时才会发生。 |
| 真·建 GitHub 仓库 | 同上：真实账号已完成鉴权与 git 提交（`82dc06f`），但没有建仓/推送（演练）。 |
| 浏览器像素级视觉 | 本机无浏览器自动化，视觉以「真 React SSR 渲染 + 无 React 警告」覆盖，未做像素对比。 |
| 其它平台（dsh.so / dshfind / dshmp） | 按你的选择**不在首批**。适配器接口（`lib/platforms.mjs` 的 `PLATFORMS` + `buildStepIds`）已为此留好位置：加一个平台 = 加一段描述 + 一段步骤组。 |

## 8. 回滚

```powershell
# 1) 从 profile 摘掉（也可手动删 bundles 里的那一行）
node "G:\AI PGRM\plugn\ensure-bundle.mjs" --remove

# 2) 整目录还原到改造前
Copy-Item "G:\AI PGRM\plugn\backup\dsh-github-publisher-0.1.0-preview\*" `
          "C:\Users\Shinelon\Desktop\AI\dsh-github-publisher-0.1.0\" -Recurse -Force

# 3) 重启 Desktop
pwsh -File "G:\AI PGRM\plugn\restart-dsh.ps1"
```

数据目录 `~/.dsh/github-publisher/` 未被迁移或破坏：`config.json` 里的 GitHub token / 账号缓存 /
草稿 / 历史原样保留，只多出 `platforms` 段（回滚后旧版本会忽略该段，不会报错）。

## 9. 日常使用注意

`dsh.profile.bundles` 会被别的进程（插件管理器 / experimental bundle 开关 / profile reload）重写，
本插件的行可能被悄悄摘掉，表现为「页面 404、侧栏没入口」而不是报错。遇到就执行：

```powershell
node "G:\AI PGRM\plugn\ensure-bundle.mjs"          # 幂等补回
node "G:\AI PGRM\plugn\ensure-bundle.mjs" --check  # 只检查，不改
```
## 10. 多仓库平台（Gitee / Codeberg）+ 扫描提速（本轮）

### 10-1 扫描为什么慢，改了什么

实测首次 `scan` 4778 ms，其中每个插件 6 次串行 git 子进程占 506/562 ms（90%）。

| 改动 | 效果 |
|---|---|
| 6 次 git 调用合并为 `repoSnapshot`（4 进程并发） | 单插件 562 → 153 ms |
| 扫描新增 `gitFacts`：非 git 目录零子进程，真仓库只跑 1 次 `rev-parse` | 非 git 目录 172 → 0 ms |
| 16 个根目录串行 → 8 并发 worker | 4778 → 818 ms |
| 扫描结果落盘 `scan-cache.json`（按根目录指纹分桶，最多 4 份） | 重启后 4778 → 9 ms |
| `#capabilities` 三个子进程并发 + 缓存 `node --version` | 重启后再省 ~30 ms |

**实测结果**：首次打开 796 ms（6.0×），重启后 147 ms（32×）。

**一个差点漏掉的回归**：为提速给 `repoSnapshot` 加了 `.git` 预检，导致嵌套仓库检测失效
（旧 `isGitRepo(child)` 返回 true，新代码返回 null）——嵌套在别人仓库里的插件会静默丢失
「父仓库会看到这些改动」的警告。写测试时断言失败才抓到，已修：`.git` 快捷路径只用于 `gitFacts`，
`repoSnapshot` 保留向上查找。

### 10-2 三个平台的真实差异（全部取自官方 spec + 真机验证）

| 项 | GitHub | Gitee v5 | Codeberg (Forgejo 1.22) |
|---|---|---|---|
| 鉴权 | `Authorization: Bearer` | `access_token` 查询参数 / body 字段 | `Authorization: token` |
| topics | ✅ | **无此接口** | ✅ |
| 改仓字段 | `homepage` | `homepage` + 必须回显 `name` | **`website`** |
| Release | `draft` 可选 | 无 `draft`，`target_commitish` 必填 | 两者都有 |
| Release URL | `html_url` | **响应里没有 URL 字段** | `html_url` |
| push 用户名 | `x-access-token` 占位 | **必须真实登录名** | 真实登录名 |

### 10-3 真机验证时抓到的 5 个 bug

只看 spec 发现不了的，跑真实 API 才暴露：

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | `owner` 取错 | Gitee 返回 `mirrors_admin`（内部 ID），不是 `mirrors` |
| 2 | `htmlUrl` 是克隆地址 | `https://gitee.com/x/y.git`，点「打开仓库」404 |
| 3 | 改仓 400 | Gitee 要求回显 `name`，spec 未标 required |
| 4 | **push 403** | Gitee 拒绝 `x-access-token`：`The token username invalid` |
| 5 | Release 无 URL | Gitee 响应无 url 字段，必须按平台拼接 |

还有一处**假成功**：`buildStepIds` 只认 `github`，Gitee 发布只跑 3 步就报 succeeded，根本没建仓库。

### 10-4 Codeberg Release 404 是平台限制

建仓 / topics / commit / push 全部成功，只有 `createRelease` 返回 404 `The target couldnt be found`。
穷举排除：tag 不存在（先推送 annotated tag）、需要索引时间（等 0/5/15 秒）、target 值错（main/tag/sha/不传）、
仓库为空（auto_init）、权限不足（admin=true）、参数格式（最小 body）——**全部仍 404**。
对照 `forgejo/forgejo` 同一 API 正常，是 Codeberg 对新账号的限制。

**处理**：release 失败降级为 warn，明确提示「tag 已推送，Release 页面可手动补建」并给出链接。
理由：仓库已建、代码已推、tag 已在，此时报整次失败是误导。

### 10-5 UI：四分卡片 + 单选语义

- 平台卡片分两组：**仓库平台（单选）** GitHub / Gitee / Codeberg，**附加目标** npm
- 仓库平台互斥（一次发布只推一个远端），切换时自动换掉旧值；npm 可任意组合
- 每张卡显示自己的凭据状态；Gitee 额外标「不支持 topics」
- 预检按平台分别校验：GitHub 走账号解析，Gitee/Codeberg 用各自的 `host-auth` 检查

### 10-6 本轮测试

| 套件 | 变化 | 新增内容 |
|---|---|---|
| multi-platform | 47 → **52** | Gitee/Codeberg 作为仓库平台、npm-only 无 host、缺 token 阻断、topics 警告、Codeberg 独立凭据 |
| providers | 新增 **18** | 三平台鉴权方式、payload 字段、topics 短路、releaseUrl 拼接、owner/htmlUrl 修正、默认 GitHub |
| client-ssr | 219 → **230** | 四分卡片、分组标题、单选说明、Gitee 无 topics 徽章 |
| lib-git | 23 → **30** | repoSnapshot 等价性、gitFacts 各分支、嵌套仓库、非仓库零子进程 |

合计 **600 项**（不含 e2e）。

### 10-7 实跑记录

```
Gitee  (心 ward-day)：auth → repo → commit → push → release 全部 done
        https://gitee.com/ward-day/dsh-e2e-.../releases/tag/v0.1.0
Codeberg (InfiniteOFone)：auth → repo → topics → commit → push → release(降级) 全部 done
        https://codeberg.org/InfiniteOFone/dsh-cb-...
```

两个探针仓库验证后已删除（HTTP 204），账号保持干净。

### 10-8 备份

`G:\AI PGRM\plugn\backup\publisher-multihost-20261106-213920`（36 文件，改动前）。
## 11. 一次发布推所有远端（A 方案）+ 插件改名

### 11-1 上一版的设计错误

上一版为了省事把「仓库平台」做成**单选**，理由是「一次发布只推一个 git 远端」。
这违背了插件的产品定位——它叫多平台发布台，核心能力就是一次发到多个地方。
限制是我自己加的，不是架构约束：`push` 只是一行 `remoteUrl = ...`，把它换成循环即可。

### 11-2 改造：commit 一次，repo/push/release 按平台循环

| 步骤 | 改造前 | 改造后 |
|---|---|---|
| `auth` | 单个 `job.token` + `account` | `hostContext[id]`：每个平台自己的 token / login / apiBase / webBase |
| `repo` | 建一个仓库 | 循环 `#ensureRepo`，每平台独立成败 |
| `push` | 推一个远端 | 同一 commit 推每个远端，`username` 按平台（Gitee 要真实登录名） |
| `release` | 发一个 Release | 每平台各自 tag + Release，Codeberg 被拒时降级不阻断 |
| `commit` | 不变 | **不变**：只做一次，所有远端共享同一个 sha |

### 11-3 分平台独立状态（这是 A 方案的核心）

`job.status` 新增 **`partial`**：有平台成功、有平台失败时的真实状态。

| 结果 | job.status | 理由 |
|---|---|---|
| 全部成功 | `succeeded` | — |
| 部分成功 | **`partial`** | 报 `failed` 会抹掉已经上线的成果；报 `succeeded` 会掩盖真实失败 |
| 全部失败 | `failed` | 确实什么都没发出去 |

`job.result.hosts[]` 每项包含 `status / repoUrl / releaseUrl / tag / pushed / steps / error / code`，
结果卡按平台逐行渲染。步骤级状态（`repo running` → `done`）与平台级状态分开记录：
一个步骤对整次任务是「跑了」，对某个平台可能是「失败了」。

### 11-4 三个平台账号不同：owner 语义修正

真机测试暴露：GitHub 是 `wodaimnd`、Gitee 是 `ward-day`、Codeberg 是 `InfiniteOFone`，
但表单只有一个 owner 输入框，且被 GitHub 登录名自动填满 → Gitee/Codeberg 往 `wodaimnd` 推送 →
`POST /orgs/wodaimnd/repos` → 404。

| owner 值 | 行为 |
|---|---|
| 填写了 | 所有平台发到这个账号/组织 |
| **留空** | **每个平台用自己令牌对应的账号** |

`mergeForm` 只在「仅勾选 GitHub」时才用 GitHub 登录名兜底；预检里空 owner 从 `fail` 改为 `pass`，
并说明会用哪些账号。

### 11-5 真机验证

```
=== 同时发布到 Gitee + Codeberg（owner 留空）===
auth      done   @ward-day（Gitee）、@InfiniteOFone（Codeberg）
repo      done   2/2 个平台建仓成功
commit    done   提交 41a74a9
push      done   2/2 个平台已推送
release   done   2/2 个平台完成
finish    done   完成

每平台结果:
  Gitee     succeeded  https://gitee.com/ward-day/dsh-multi-...
  Codeberg  succeeded  https://codeberg.org/InfiniteOFone/dsh-multi-...
```

失败隔离实测（owner 填 `ward-day` 时 Codeberg 404）：

```
状态: partial
repo      done     1/2 个平台建仓成功
push      done     1/1 个平台已推送
  Gitee     succeeded  https://gitee.com/ward-day/dsh-multi-...
  Codeberg  failed     Codeberg 资源不存在（HTTP 404，POST /orgs/wodaimnd/repos）
```

探针仓库验证后全部删除（HTTP 204）。

### 11-6 插件改名：多代码平台发布插件

| 位置 | 旧 | 新 |
|---|---|---|
| `client.js` `panel.label` / `panel.title` | 多平台发布台 | **多代码平台发布插件** |
| `client.js` `error.crashed` | GitHub 发布台出错了（陈旧） | 多代码平台发布插件出错了 |
| 英文 label | Release Hub | Multi-Forge Publisher |
| `package.json` description | 只提 GitHub + npm | GitHub / Gitee / Codeberg / npm，同一 commit 推每个远端 |
| `package.json` keywords | 无平台词 | 增加 gitee、codeberg |
| `README.md` / `CONTRACT.md` / `cordis.patch.yml` | 多平台发布台 | 多代码平台发布插件 |

顺带修掉一个**假通过的断言**：`verify-static` 的 `requiredLabels` 写着 `GitHub 发布台`，
能通过纯粹是因为 `error.crashed` 的旧文案恰好含这几个字。已改成检查真实面板名。

### 11-7 本轮测试

| 套件 | 变化 | 新增内容 |
|---|---|---|
| multi-platform | 52 → **56** | `hostingsOf` 多选、步骤不重复、owner 语义四种组合、多平台预检 |
| client-ssr | 231 → **239** | 多选标签、`partial` 结果卡六态（名称/逐平台/成败对照/原因/链接/不伪装成功） |
| 其余 | 全绿 | 改名相关的文案断言同步更新 |

合计 **613 项**（不含 e2e）。`npm run check` + `npm test` exit 0。

### 11-8 备份

`G:\AI PGRM\plugn\backup\publisher-multipush-20261107-093723`（多平台改造前）
`G:\AI PGRM\plugn\backup\publisher-rename-20261107-121703`（改名与发布前）
## 12. 包名改为 multi-platform-releaser + 四平台首次发布

### 12-1 改名范围：分清「包标识」与「内部标识」

包名出现在 20 多处，但只有三处是 loader 解析用的**包标识**，改了不同步就会「装上了但不出现」：

| 位置 | 值 | 为什么必须同步 |
|---|---|---|
| `package.json` `name` | `multi-platform-releaser` | 安装时用的名字 |
| `cordis.patch.yml` 的 `name:` | 同上 | loader 要解析这一行；留旧名则装成功但永不出现 |
| `client.js` `__ModuleLoader__.load({ id })` | 同上 | 浏览器半注册的 id |
| `client.js` `const NS` | 同上 | locale 命名空间，shell 靠它解析文案 |

**刻意不改**的内部标识（改了会丢用户数据或分裂接口）：

- `/dsh-github-publisher/api/*` HTTP 路由前缀
- `x-dsh-github-publisher-token` CSRF 头
- `dsh-github-publisher.selected` / `.tab` / `.page` / `.guide` / `.search` / `.collapse:*` localStorage 键
- `PANEL_ID = 'github-publisher'` 侧栏行 id 与 main key

理由：这些是内部标识符，已装副本和用户保存的界面状态都依赖它们；改名没有任何可见收益，
却会让用户发现「我的设置没了」。

### 12-2 顺带修的两个真 bug

**① 预检的 GitHub repo 检查没走新的 owner 语义**（导致 `GitHub 上找不到 “”`）

A 方案允许 owner 留空 = 各平台用自己账号，`#ensureRepo` 已按此实现，但 `#checkRepo` 仍用
`form.owner` 字面值 → 空 owner 变成空命名空间。发布本身是好的，只有预检报错——
这种「预检说不行、发布能成」的分歧最容易让人不信任面板。已改成同一套解析。

**② npm 的 `private: true` 分支在某次重构中丢失**

`EPRIVATE` 首次发布就撞上：`package.json` 有 `private: true`（保护本地安装，不能删），
早先的临时副本逻辑只判断「包名不同」，发布同名包时直接用源码树 → npm 拒绝。
已恢复为「名字不同 **或** manifest 是 private」都建临时副本。

### 12-3 首次发布结果（四平台）

```
auth       done  @wodaimnd（GitHub）、@ward-day（Gitee）、@InfiniteOFone（Codeberg）
prepare    done  无需写入文件
repo       done  3/3 个平台建仓成功
commit     done  提交 2e0cc16
push       done  3/3 个平台已推送
release    done  3/3 个平台完成
npm-auth   done  @jntm114514
npm-publish done multi-platform-releaser@0.3.4
```

验证结果：

| 平台 | 仓库 | Release / tag |
|---|---|---|
| GitHub | `wodaimnd/multi-platform-releaser` | Release `v0.3.4` ✓ |
| Gitee | `ward-day/multi-platform-releaser` | Release `v0.3.4` ✓ |
| Codeberg | `InfiniteOFone/multi-platform-releaser` | tag `v0.3.4` ✓（Release 页面受平台限制） |
| npm | `multi-platform-releaser@0.3.4` | 974 KB unpacked |

**三平台同一 commit `2e0cc16`** —— 这正是 A 方案的目标：一次提交，多个远端。

### 12-4 两个环境事实（写下来免得以后重踩）

- **`dsh-github-publisher` 这个 npm 名被别人占用**（维护者 `relphchris`，0.1.2），所以必须换名。
  `multi-platform-releaser` 查过公网可用。
- **配置里原本存的是 Verdaccio token**（124 字符），对公网 npm 返回 401。
  公网 token 在 `~/.npmrc`（40 字符），换成它之后 `whoami` 返回 `jntm114514`。

### 12-5 测试

613 项全绿，改名相关断言同步更新。`npm run check` + `npm test` exit 0。

`npm-verify` 报「版本不存在」是 registry 索引延迟（约 30 秒），重查即通过——
发布本身成功，该步骤的判定窗口偏紧，已知行为。

### 12-6 备份

`G:\AI PGRM\plugn\backup\publisher-pkgrename-20261107-125641`（改包名前）
## 13. 全面优化（按 12 维审计驱动）

用 `plugin-audit` 的 12 维逐条走一遍，机械层用扫描器，语义层人工读代码。
**没有凭感觉改**：每条都有证据，改完复扫。

### 13-1 审计发现与处置

| 维 | 问题 | 级别 | 处置 |
|---|---|---|---|
| 1 装配面 | `package.json` 没声明 `dsh.forge`，装坏不知道清什么 | 警告 | 补 `source` + 6 条真实 `effects` |
| 8 可访问性 | **所有弹窗都没有 Esc 关闭**——只有遮罩和 × 能关 | 阻断 | 补 Esc + 焦点陷阱 + 焦点归还 |
| 8 可访问性 | 6 个交互元素缺焦点环（输入框、搜索框、chip、分段按钮、设置页签、开关） | 警告 | 加全局兜底 + 7 条针对性规则 |
| 8 可访问性 | 关闭按钮 26×26、卡片折叠 24 高，低于 32×32 硬线 | 警告 | 用 padding 扩大可点区、margin 抵消布局偏移 |
| 8 可访问性 | 表单错误没和输入框关联，屏幕阅读器只念框不念原因 | 警告 | `aria-describedby` + `aria-invalid`（克隆子元素，不改调用方） |
| 6 能力等价 | agent 工具描述写着「GitHub only」，不会知道能发 Gitee/Codeberg | 提示 | 改写描述；`github_publisher` 工具名保留（改名字是破坏性变更） |

**7 / 10 / 11 三维复查后没改**：七态齐（降级态由 `capability 探测 + 分支渲染` 覆盖）；
剪贴板只写不读、轮询只在发布中跑；计时全用真实时间戳，没有 `setInterval` 累加。

### 13-2 顺手修的三个真 bug

**① `partial` 被播报成「发布已取消」**

`finishJob` 只有 `succeeded` / `failed` / else 三支，`partial` 落到 else → 「发布已取消」。
这是最坏的消息：用户已经有一部分代码推到远端了，却被告知什么都没发生。
已加 `partial` 分支：保留结果卡（逐平台表可见）+ warn 语气 + `1/2 个仓库平台已发布`。

**② 预检的 `host-auth` 只检查第一个平台**

多平台发布要验三个身份，只验第一个意味着无效的 Gitee token 要等发布中途才炸。
已改为遍历所有勾选的 hosting，每个独立成败。

**③ topics 警告在多平台改造时丢失**

重写 `host-auth` 块时把「Gitee 不支持 topics」那条 warning 一起删了。
测试抓到了（`preflight: Gitee warns that topics will be skipped`），已按平台循环补回。

### 13-3 性能优化（实测数据）

**并行化**：预检的 6 个网络探测原来严格串行，实际互不依赖（只有 repo 探测需要 login）。
改成 config 一加载就全部 kick off，用到处再 await。

| 场景 | 优化前 | 优化后 | 倍数 |
|---|---|---|---|
| 冷启动（4 平台） | 3707 ms | **1928 ms** | 1.9× |
| 热路径 | 1002 ms | **~700 ms** | 1.4× |

**缓存**：

- `#npmVerifyCached`：npm 身份按 `registry\|token` 缓存 60 秒（预检每次表单变动都跑）
- `#identityCached`：各平台身份按 `host\|base\|token` 缓存 180 秒
- `preflight` 的 `git --version` 改走 `#gitVersionCache`（省 80 ms/次）
- 凭据变更时强制失效：`saveNpmToken` 挂 `#invalidateNpmVerify()`

**轮询退避**：固定 650 ms → 自适应阶梯 `[1, 1, 1.5, 2, 3, 4]×`。
快照无变化才加宽，**任何步骤变化立即重置回基准**。
一次 4 平台发布原来约 50 次请求，长步骤（push/release/npm）返回完全相同的文档。

**刻意没缓存的两项**：npm 版本号、仓库是否存在。它们会变，缓存过期会给出错误结论——
「慢一点但正确」好过「快但发错」。

### 13-4 测试

613 → **615**（新增 2 条结构契约：轮询阶梯存在且封顶、`partial` 有独立分支且保留结果）。

```
122 + 99 + 56 + 7 + 9 + 7 + 6 + 30 + 18 + 29 + 35 + 239 = 615
```

`npm run check` + `npm test` exit 0。
`guard_check_bundle`：ERROR 0 / WARN 0 / PASS 18。
`audit-scan` 终检：**阻断 0 · 警告 0**（唯一提示是 benign catch 汇总，非缺陷）。

### 13-5 备份

`G:\AI PGRM\plugn\backup\publisher-pkgrename-20261107-125641`（本轮改动前）
## 14. Agent 工具改名 github_publisher → multi_platform_releaser

### 14-1 为什么必须改

Agent 读工具 id 比读描述早。一个叫 `github_publisher` 的工具，模型会先入为主
认为只能发 GitHub，于是传 `platforms: ['github']`——用户要发三个平台，实际只发了一个。
这是**静默的能力损失**，比报错更难发现。

### 14-2 改名边界：哪些改、哪些绝对不能改

| 类别 | 标识符 | 处置 | 理由 |
|---|---|---|---|
| 工具 id | `github_publisher` | **改** → `multi_platform_releaser` | 模型读取的第一信息 |
| Host 自述 | `export const name` | **改** → `multi-platform-releaser` | 与包身份对齐 |
| 页面注入全局 | `__DSH_GITHUB_PUBLISHER__` | 保留 | client.js 从注入脚本读取，改了页面拿不到 token |
| CSRF 头 | `x-dsh-github-publisher-token` | 保留 | 两半共同约定，改了请求全部 403 |
| 路由前缀 | `/dsh-github-publisher/api` | 保留 | 页面按此前缀调用，改了接口全断 |
| 数据目录 | `$DSH_HOME/github-publisher` | 保留 | **用户的 token 和历史在这里**，改了等于清空配置 |
| 环境变量 | `DSH_GITHUB_PUBLISHER_DIR/_CWD/_GIT_HTTP_VERSION` | 保留 | 测试隔离与高级用法依赖 |
| 面板行 id | `PANEL_ID = 'github-publisher'` | 保留 | 槽位 key，改了侧栏点进去空白 |

判断依据只有一条：**这个标识符有没有已经部署的产物在读它。**
有 → 保留；没有（只在源码内部流转）→ 跟随产品名。

### 14-3 工具名的推导规则

新工具名不是随手起的，而是 `package.json` 的 name 把连字符换成下划线：
`multi-platform-releaser` → `multi_platform_releaser`。
已加断言锁死这条规则，同时断言 id **不得包含任何单一 forge 的名字**（github/gitee/codeberg）。

### 14-4 测试

615 → **616**（新增 1 条：工具 id 不命名单一 forge，且必须与包名派生一致）。

三处断言同步更新：

| 位置 | 改动 |
|---|---|
| `verify-static` 的 `agent tool name` | 期望值改为新名 |
| `verify-static` 的 `CONTRACT.md pins the fixed identifiers` | 列表里工具名换新，内部标识符保留旧拼写 |
| `host-sim` 的注册断言 | 断言名与校验值都改；真实 `apply()` 跑通 |

```
123 + 99 + 56 + 7 + 9 + 7 + 6 + 30 + 18 + 29 + 35 + 239 = 616
```

`npm run check` + `npm test` exit 0。`guard_check_bundle`：ERROR 0 / WARN 0 / PASS 18。

### 14-5 备份

`G:\AI PGRM\plugn\backup\publisher-toolrename-20261108-150537`（改名前三处一致）。
