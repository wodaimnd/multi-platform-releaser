# 多代码平台发布插件 · dsh-github-publisher

把**本机上的 DSH 插件**一次发布到**多个代码平台**：左侧栏打开发布台，选插件 → 勾选平台（GitHub / Gitee / Codeberg，可多选，外加 npm）→ 补全一套发布要素 → 预检 → **一个按钮**把同一个 commit 推到每个远端，各自建仓、各自发 Release。某个平台失败不影响其他平台，结果卡按平台分别列出成败。全程进度按平台分组可见、可取消，设置、平台凭据与发布记录持久保存，还带一个「版本同步」矩阵用来给已发布的插件同步发新版本。

> DeepSeek Harness (DSH) Web 插件 · 左侧栏入口 `多代码平台发布插件` · 无构建步骤 · 依赖本机 `git`、Node 自带的 `npm` 与各平台 REST API。

## 为什么需要它

手工发布一个 DSH 插件，通常要重复十几步：新建仓库、补 README 徽章和安装说明、选许可证、写 `.gitignore`、把 `repository`/`homepage`/`keywords` 填进 package.json、`git init`、配置身份、commit、切分支、建 remote、push、打 tag、建 Release、再回来补 topics；要上 npm 还得另开一套流程：确认版本号没被占用、`npm publish`、回查 registry、再看 README 在 npm 页面是不是正常。发新版时更麻烦——版本号要 bump，GitHub 和 npm 两边都得重来一遍，很容易一边发了一边忘。

发布台把这些收进一个页面：发布要素只填一次（各平台之间本来就大差不大），平台专属的东西（npm 的 access/dist-tag/OTP、GitHub 的可见性/分支）折叠在各自那一行；点「发布到 GitHub + npm registry」就按顺序执行并实时显示进度。同一套操作也暴露成 Agent 工具 `multi_platform_releaser`，你可以直接让 DSH 里的 Agent 帮你发。

## 功能

- **左侧栏入口**：DSH 左侧栏新增「多代码平台发布插件」图标，中央页面有三个页签：发布 / 平台配置 / 版本同步；与宿主同主题（浅色/深色自动跟随）。
- **本地插件自动发现**：扫描 profile 的 `link:`/`file:` 依赖、已注册工作区、当前目录与自定义扫描目录，识别带 `dsh.bundle` / `dsh.client` 的包；显示版本、描述、README/LICENSE 状态、git 状态与已发布平台。
- **一套发布要素 + 平台勾选矩阵**：`name / version / description / descriptionZh / topics / license / README / releaseNotes` 统一填写；每个平台一行 checkbox，带状态徽章（未启用 / 未配凭据 / token 掩码）。勾选 npm 后展开它自己的 `access`、`dist-tag`、`2FA OTP`；未勾选 GitHub 时仓库字段只读且不参与校验（npm-only 发布不需要 GitHub 账号）。
- **平台配置页**：逐平台配凭据与默认值。GitHub：账号状态 + 启用开关 + 验证凭据（Enterprise 地址在设置弹窗里）；npm：`Registry`、`Access Token`（保存时向 registry 校验一次，带掩码显示与清除）、`access`、`dist-tag`、`provenance` 开关、已验账号。
- **一个按钮发所有平台**：按钮文案随勾选变化（`发布到 GitHub + npm registry`）。任务步骤按平台分组执行：GitHub = 校验账号 → 建仓/复用 → topics → commit → push → tag + Release；npm = 校验凭据 → 版本守卫 → `npm publish` → 回查 registry。**单个平台失败不会中断其他平台**，结果卡给每个平台独立的链接与失败原因。
- **npm 版本守卫**：发布前对比 registry 上的 latest，`版本相同或更低`直接判为阻塞项并提示先 bump（npm 不接受同名版本重发），不会等你跑到 publish 才吃 `EPUBLISHCONFLICT`。
- **版本同步矩阵**：插件 × 平台 × 本地版本 × 远端版本 × 状态（已同步 / 落后 / 未发布 / 本地更新 / 未知）。GitHub 读最新 Release 的 tag，npm 读 registry 的 latest。落后行可一键「发布到落后平台」（等价于只对 behind 平台 publish），也可先「只提升版本」做 patch/minor/major bump。
- **AI 一键补全发布信息**：发布信息卡片右上角「AI 补全信息」——用 **DSH 里已配置的 DeepSeek 模型**读取 package.json / README / 文件列表，生成英文描述、中文简介、topics 与 Release 说明，填入表单后可继续手改。这一步只花 DSH 的模型额度，不涉及任何平台、不会自动发布。
- **仓库文件自动完善（先预览后写入）**：
  - `README.md`：双语完整模板（徽章、功能、从 GitHub 克隆安装、目录结构、开发测试、License）；已有 README 默认保留，可切换为重新生成；
  - `LICENSE`：MIT / Apache-2.0 / BSD-3-Clause / GPL-3.0 标准全文，自动填年份与作者；
  - `.gitignore`：Node/DSH 插件通用模板；
  - `package.json`：只补缺失的 `repository` / `homepage` / `bugs` / `keywords` / `license` / `author` / `description`，不覆盖你手写的字段。
- **预检**：平台选择、git 是否可用、npm CLI 是否可用、GitHub token 是否有效、npm token 能否验证、包名是否存在、npm 远端版本是否已被占用、仓库是否已存在、仓库名与描述是否合规、提交身份、将写入的文件、工作区脏状态、remote 将被改写等；阻塞项会标红并定位到「设置」「平台配置」或「表单」。
- **演练模式**：勾选「演练」后只做本地准备与提交，不建仓、不推送、不创建 Release、不 `npm publish`（npm 用 `--dry-run`）——不需要任何凭据也能完整走一遍流程验证配置。
- **Release 自动生成**：默认开启，tag 为 `v<version>`，Release 说明由简介/版本/许可证/关键词自动生成，也可手填。
- **数据持久化**：设置、平台凭据、每个插件的表单草稿、最近 50 条发布记录保存在 `~/.dsh/github-publisher/`（沿用历史目录，旧 token/账号缓存继续可用）；token 只存本机 `config.json`（0600），响应与日志只回掩码。
- **不需要手动填 GitHub token 的路径**：若本机已有可用凭证（`GITHUB_TOKEN`/`GH_TOKEN`、`gh auth token`、`git credential` 里保存的 github.com 凭证），发布时自动检测并直接使用；npm 也支持用环境变量 `NPM_TOKEN` 兜底（不落盘）。
- **安全发布嵌套插件**：如果插件目录位于某个父 git 仓库内（很常见：monorepo/工作区），发布台会在插件目录里建立**独立** git 仓库，绝不会把父仓库的提交/远端牵连进来；预检会明确提示父仓库会看到这些文件改动。
- **Agent 工具 `multi_platform_releaser`**：`state / scan / preflight / publish / job / cancel / settings / token / history / suggest`，与 UI 共用同一个 `Publisher` 服务，行为一致；`form.platforms` 决定本次发到哪些平台。
- **对外 HTTP API**：`/dsh-github-publisher/api/*`（同源 + CSRF token 门禁），除原有的 state/scan/settings/token/preflight/publish/job/cancel/draft/history/ai 之外，新增 `platforms`、`platforms/verify`、`platforms/npm-token`、`version/bump`、`sync/plan`；完整接口见下文与 `CONTRACT.md`。

## 安装

插件位于 `C:\Users\Shinelon\Desktop\AI\dsh-github-publisher-0.1.0`，已经以本地 bundle 链接安装进当前 `desktop` profile。其他机器/部署安装方式：

```bash
# 在 DSH 中执行（Agent 或插件管理器同款入口）：
plugin_manager action=install_bundle target=/absolute/path/to/dsh-github-publisher
```

安装后刷新 DSH Web 页面（或重启 Desktop），左侧栏出现「多代码平台发布插件」图标。卸载：设置 → 插件 → GitHub Publisher → 移除，或 `plugin_manager action=remove_bundle`。

## 首次配置：连接各平台账号与 token

> **最快的路径**：打开发布台，最上面那张「上手向导」卡片已经把所有需要的链接和按钮排好了——
> ① 绑定 GitHub 令牌 ② 选中要发布的插件 ③ 绑定 npm 令牌（可选）。每步都带申请外链与就地按钮，
> 全部完成显示「全部就绪」。卡片可折叠，折叠状态会被记住。

1. 打开发布台 → 在「上手向导」第一步点「申请经典 PAT」或「申请细粒度 PAT」；也可以在右上角「设置 →
   帮助与链接」分节里一次性看到全部入口。
2. 授权页会自动带上 scope（经典 PAT 预填 `repo` + `workflow`），创建后复制 token。
   - **Classic token**：勾选 `repo`（要发私有仓库必须）；如需写入 workflow 文件再加 `workflow`。
   - **Fine-grained token**：仓库权限 `Contents: Read and write`、`Administration: Read and write`、`Metadata: Read-only`。
3. 粘贴到 token 输入框 →「保存并验证」。成功后显示 `@你的用户名`、token 掩码（如 `ghp_…a1b2`）与来源。
4. 也可点「自动检测」：依次尝试 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量、`gh auth token`、`git credential` 中已保存的 github.com 凭证；检测到的 token 默认只放内存，点「保存」才落盘。
5. 要发 npm：向导第三步点「申请 npm Token」→ 建议选 Automation 类型 → 回到「平台配置」页签 npm 卡片 →
   勾「启用这个平台」→ 填 `Registry`（默认 `https://registry.npmjs.org`）与 `Access Token` →「保存并验证」。
   向导那一步的「去平台配置」按钮会直接把你送到这张卡片。

### 绑定入口一览（全部在界面里点得到）

| 入口 | 出现在哪里 | 指向 |
|---|---|---|
| 申请经典 PAT | 上手向导第 1 步 / 未连接横幅 / 设置·GitHub 账号 / 设置·帮助与链接 / 平台配置 GitHub 卡片 | `<gitBase>/settings/tokens/new?scopes=repo,workflow&description=DSH%20Plugin%20Publisher` |
| 申请细粒度 PAT | 同上 | `<gitBase>/settings/personal-access-tokens/new` |
| 管理 GitHub 令牌 | 同上 | `<gitBase>/settings/tokens` |
| 申请 npm Token | 上手向导第 3 步 / 设置·帮助与链接 / 平台配置 npm 卡片 | `https://www.npmjs.com/settings/tokens/new`；**自建 registry 不给这条链接** |
| 管理 npm 令牌 | 同上 | `https://www.npmjs.com/settings/tokens`；**自建 registry 不给这条链接** |
| 打开 registry 控制台 | 上手向导第 3 步 / 设置·帮助与链接 / 平台配置 npm 卡片 | 自建 registry 时唯一目标 = registry 自身的 origin（如 `http://127.0.0.1:4873`，scheme 原样保留） |
| 复制 npm login 命令 | 设置·帮助与链接 / 平台配置 npm 卡片 | `npm login --registry=<registry>` |
| 复制 .npmrc 键名 | 同上 | `//<host>/:_authToken=` |
| 令牌官方说明 | 设置·帮助与链接 | GitHub Docs / npm Docs 对应页面 |
| 复制诊断信息 | 设置·帮助与链接 | 只含版本、接口地址、账号状态，不含 token 原文 |

所有外链都是 `target="_blank" rel="noreferrer"`；`<gitBase>` 取自「接口地址」配置，**换成 GitHub Enterprise
后这组链接会一起变成企业域名**（`helpLinks()` 统一派生，组件里不散写 URL）。

#### 用自建 registry（Verdaccio / 内网 Nexus）怎么办

自建 registry 根本没有 `/settings/tokens` 这个网页路由，token 是 `npm login` 写进 `~/.npmrc` 的。
所以插件在检测到非 npmjs registry 时会**换一套路线**，不再给你一个打不开的网址：

1. 「平台配置 → npm」卡片里直接展开三步：点「复制 npm login 命令」→ 终端粘贴执行（`npm login --registry=http://127.0.0.1:4873`）；
2. 点「复制 .npmrc 键名」拿到 `//127.0.0.1:4873/:_authToken=`，在 `~/.npmrc` 里找到这一行，复制等号后面的值；
3. 粘到上面的 `Access Token` 输入框 →「保存并验证」。

向导第 3 步的链接此时也只有一条「打开 registry 控制台」，指向 registry 自己的地址。

> 安全：两个 token 都不会出现在页面请求响应、发布日志、git 命令回显或 npm 子进程输出中；GitHub 推送使用临时 `GIT_ASKPASS`（0700，用完即删），不会写进 `.git/config`；npm token 只通过子进程环境变量 `npm_config_<registry>:_authToken` 传递，不进 `argv`、不写 `.npmrc`。

### DeepSeek token、GitHub token、npm token 与“不用 token”

| 问题 | 结论 |
|---|---|
| 能把 DeepSeek 的 token 当 GitHub / npm 凭证用吗？ | **不能**。DeepSeek token 只认证 DeepSeek 模型/账号；GitHub 建仓/推送/Release 只认 GitHub 凭证，npm publish 只认 npm token。三家鉴权各自独立，不可互换。 |
| DeepSeek token 在这插件里用在哪？ | 「AI 补全信息」按钮：用 DSH 已配置的 DeepSeek 模型生成英文描述/中文简介/topics/Release 说明（`POST /api/ai/suggest`）。只花模型额度，不涉及任何平台。 |
| 完全不想手动填 GitHub token？ | 三个选项：① 本机已有凭证时点「自动检测」（支持 `GITHUB_TOKEN`/`GH_TOKEN`、`gh auth token`、`git credential` 里保存的 github.com 凭证），有则直接用；② 先「演练」：识别插件→补全信息→写文件→本地 commit，无需 token 也不需要网络；③ 只填一次 PAT 并保存到本机 0600 文件，以后不再输入。 |
| npm token 也能自动检测吗？ | 支持环境变量 `NPM_TOKEN` 兜底（只在内存，不落盘）；否则在「平台配置 → npm」里填一次即可保存。 |
| 只想发 npm、不碰 GitHub 行不行？ | 行。取消勾选 GitHub 只留 npm，Owner/分支/topics 这些仓库字段既不校验也不使用，发布按钮变成「发布到 npm registry」。 |
| 不填任何凭证，能直接发布吗？ | 不能——各平台都要求自己的凭证。插件能做的是把发布前的一切准备好并预览（预检 + 演练）。 |

## 一键发布流程

1. 左侧插件列表选择要发布的插件（也可先「重新扫描」或到设置里添加扫描目录）。
2. 「发布平台」里勾选目标平台（GitHub / npm）；没配好的平台会标「未配凭据」并给「去配置」。
3. 右侧「发布信息」检查自动填好的仓库名/简介/topics/许可等；缺什么补什么。勾了 npm 的话，那一行会展开 `access` / `dist-tag` / `2FA OTP`。
4. 「发布选项」按需勾选：生成 README/LICENSE/.gitignore、完善 package.json、创建 Release、提交信息模板、作者身份；第一次可先勾「演练」跑一遍。
5. 点「预检」查看检查项（两个平台各自的目标与阻塞项）与将要写入的文件（README 可预览）。
6. 点「发布到 GitHub + npm registry」→ 观察按平台分组的步骤进度与日志；完成后结果卡给出仓库、Release、commit、npm 包链接，可一键复制。
7. 之后再发新版：切到「版本同步」页签 →「检查版本」看哪个平台落后 →「提升并同步」（bump `package.json` 的 version）→「发布到落后平台」只补发落后的那几个。

### 发布选项说明

| 选项 | 默认 | 说明 |
|---|---|---|
| 生成 README | 开 | 已有 README 时默认保留；下拉可改为「重新生成并覆盖」 |
| 生成 LICENSE | 开 | 已有 LICENSE 时保留；许可证选择 `none` 时跳过 |
| 生成 .gitignore | 开 | 已有则保留 |
| 完善 package.json | 开 | 只补缺失字段，不覆盖已有值 |
| 创建 Release | 开 | tag = 前缀 + version；已存在同名 Release 时复用 |
| 仓库已存在时 | 复用 | 可选「报错」避免误覆盖 |
| npm access | public | `restricted` 只对 scoped 包生效，非 scoped 包 npm 会强制 public |
| npm dist-tag | latest | 例如 `next` / `beta` |
| npm OTP | 空 | 开启 2FA 时每次发布填一次；只随命令传递，不写入配置文件 |
| 演练 | 关 | 只本地准备 + commit，不建仓/不推送/不 Release/不 publish（npm 用 `--dry-run`） |
| force-with-lease | 关 | 远端分支有冲突提交时的显式覆盖开关（高级） |

## 页面与入口

| 入口 | 位置 | 用途 |
|---|---|---|
| 多代码平台发布插件 | DSH 左侧栏（order 50） | 发布页（上手向导 + 插件列表 + 平台勾选 + 表单 + 预检 + 进度 + 历史）｜平台配置页｜版本同步页 |
| 设置 · 帮助与链接 | 发布台右上角「设置」→ 第 5 个页签 | 所有凭据申请入口、当前生效的接口地址、npm registry 说明、「复制诊断信息」 |
| `multi_platform_releaser` 工具 | Agent 工具面板 | 让 Agent 扫描/预检/发布/查询任务，例：`帮我用 multi_platform_releaser 把 dsh-xxx 发布到 GitHub 和 npm` |
| HTTP API | `/dsh-github-publisher/api/*` | 页面使用的同源接口，也可被本机脚本调用（需页面注入的 token） |

## HTTP API

统一前缀 `/dsh-github-publisher/api`。除 `GET /api/token`（仅 loopback）外，所有请求需带
`x-dsh-github-publisher-token` 请求头（值来自页面注入的 `window.__DSH_GITHUB_PUBLISHER__.token`）。
成功 `{ok:true,...}`，失败 `{ok:false,error:{code,message,details?}}`。

| Method | Path | 用途 |
|---|---|---|
| GET | `/token` | loopback bootstrap，返回页面 CSRF token |
| GET | `/health` | 健康检查（loopback） |
| GET | `/state` | 设置、账号、平台列表、插件列表、草稿、历史、当前任务、能力探测 |
| POST | `/scan` | `{roots?, checkRemote?}` 重新扫描本地插件 |
| POST | `/settings` | `{defaults?, scanRoots?, autoDetectToken?, platforms?}` 保存设置 |
| POST | `/token` | GitHub：`{token}` 保存并校验 PAT；`{token:null}` 清除；`{detect:true,persist?}` 自动检测 |
| GET/POST | `/platforms` | 读/写平台配置（npm registry+token+access+distTag、GitHub 地址、启用开关） |
| POST | `/platforms/verify` | `{platformId}` 用该平台端点验证凭据（GitHub `/user`，npm `/-/whoami`） |
| POST | `/platforms/npm-token` | `{token}` 保存并校验 npm token；`{token:null}` 清除 |
| POST | `/version/bump` | `{path, mode:`patch`|`minor`|`major`, version?}` 写回 package.json |
| POST | `/sync/plan` | `{path}` 跨平台版本矩阵（本地 vs 各平台远端，标落后/已同步/未发布） |
| POST | `/preflight` | `{path, form?}` 预检（按勾选平台给检查项）+ 文件计划 + README 预览 |
| POST | `/publish` | `{path, form?}` 启动发布任务（`form.platforms` 决定平台）→ `{jobId}` |
| GET | `/job?jobId=` | 任务快照（按平台分组步骤/日志/结果）；不传 jobId 返回最近任务，无任务时 `job:null`；未知 jobId → 404 |
| POST | `/cancel` | `{jobId?}` 取消运行中的任务 |
| POST | `/draft` | `{path, form}` 保存/覆盖表单草稿，`form:null` 删除 |
| POST | `/history/clear` | 清空发布记录 |
| POST | `/ai/suggest` | `{path, form?}` 用 DSH 已配置的 DeepSeek 模型起草描述/简介/topics/Release 说明（不发布） |

## 数据与隐私

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/github-publisher/config.json` | 设置、账号缓存（login 等）、**GitHub PAT 与 npm token（仅当你点保存）**、平台开关与 registry | 0600 |
| `~/.dsh/github-publisher/history.json` | 最近 50 条发布记录（含本次发到了哪些平台） | 默认 |
| `~/.dsh/github-publisher/drafts.json` | 每个插件的表单草稿 | 默认 |

- 数据目录沿用历史路径 `~/.dsh/github-publisher/`，升级后旧 token、账号缓存、草稿、历史继续可用。
- 测试或自定义 DSH home 可用环境变量 `DSH_GITHUB_PUBLISHER_DIR` 覆盖数据目录。
- 自动检测到的环境变量 token（`GITHUB_TOKEN` / `GH_TOKEN` / `NPM_TOKEN`）不落盘；页面只显示掩码。
- 插件不会读取或上传你的其它凭证；不会在后台自动推送任何东西——只有你点「发布到 …」才会执行。

## 企业版 GitHub

设置 → GitHub 企业版：填写 API 地址（如 `https://ghe.example.com/api/v3`）与站点地址（如 `https://ghe.example.com`），即可对 GitHub Enterprise 建仓/推送。API 地址允许 `http://127.0.0.1`/`localhost`（用于本地联调/自建实例），其余必须是 `https://`。私有 npm registry 同理：在「平台配置 → npm」的 Registry 里填自建地址即可。

## 故障排查

| 现象 | 处理 |
|---|---|
| 左侧栏没有入口 / 页面 404 | 刷新页面；确认插件在 设置 → 插件 中已启用；查看 Host 日志是否有 bundle 加载错误 |
| 「token 无效」 | 重新生成 PAT，确认 `repo` 权限（fine-grained 见上文三项）；企业版检查 API 地址 |
| 发布失败：`HTTP 404，POST /orgs/xxx/repos` | Owner 填错了：GitHub 个人账号的 Owner 必须填**登录名**（login，如 `wodaimnd`），不是昵称/显示名，也不是组织页面的显示名。预检会直接提示「GitHub 上找不到该账号/组织」并把 Owner 字段标为待修改。 |
| 之前失败过的插件 package.json 指向了错误仓库 | 新版发布时会把 `repository` / `homepage` / `bugs` 中指向其它 GitHub owner/repo 的过期地址自动更正为本次发布目标（预检的 package.json 变更里会显示），无需手改。 |
| 「预检未通过：仓库已存在」 | 把「仓库已存在时」改为「复用」，或修改仓库名 |
| 推送被拒绝（non-fast-forward） | 远端已有不同历史：换仓库名，或确认后勾选 force-with-lease |
| `Error in the HTTP2 framing layer` / 连接 GitHub 超时 | 本机到 GitHub 的 **HTTP/2** 链路不稳定（常见于代理/VPN 环境）。插件已默认用 **HTTP/1.1** 推送并自动重试，无需手动处理；极端情况下可设环境变量 `DSH_GITHUB_PUBLISHER_GIT_HTTP_VERSION=auto` 恢复 HTTP/2 优先，或在系统终端执行一次 `git config --global http.version HTTP/1.1`。远端仓库与本地 commit 都会保留，重新发布即可续传。 |
| 提交失败 `Please tell me who you are` | 填写作者名/邮箱，或在系统里 `git config --global user.name/user.email` |
| 文件写入了但没推送成功 | 本地文件与 commit 保留；修复原因后重新发布即可（幂等，不会重复建仓/重复 Release） |
| 插件目录在父 git 仓库里 | 这是允许的：会在插件目录内建独立仓库；预检会提示父仓库把文件改动视为未提交，请自行决定是否提交或加入父仓库 ignore |
| npm 报 `E403 you must be logged in` / `401` | 「平台配置 → npm」里的 token 没填或失效：点「验证凭据」重试；环境里的 `_authToken` 不会被继承，必须显式填 |
| npm 报 `EPUBLISHCONFLICT` / `version exists` | 版本守卫会在发布前拦住；确认后到「版本同步」点「只提升版本」，再「发布到落后平台」 |
| 「找不到 npm CLI」 | npm 随 Node 一起安装（`node_node_modules/npm/bin/npm-cli.js`）；重装 Node 或让 `node_modules/npm` 就位即可 |
| 「某平台失败但另一个成功了」 | 这是设计行为：平台之间互相隔离，失败平台的步骤标红并给出原因，成功平台的链接仍会写在结果卡里；修好后只勾那个平台重发即可 |
| 想清空发布记录 | 设置 → 清空历史 |

## 开发与测试

无构建、无第三方依赖：`index.js` + `lib/*.mjs`（Host，Node ESM）与 `client.js`（浏览器 classic JS，仅 require React）。

```bash
cd dsh-github-publisher
node --check index.js && node --check client.js
node tests/verify-static.mjs      # manifest / locale / 图标 / 客户端静态契约
node tests/host-sim.mjs           # Host HTTP 契约（含 platforms / bump / sync）+ 真实文件/真实 git 的 dry-run 发布
node tests/multi-platform.spec.mjs # 平台注册表、配置归一化、步骤编排、preflight 分支、版本 bump、sync 矩阵
node tests/lib-git.spec.mjs       # git 库（临时仓库、本地 bare remote、askpass、abort）
node tests/lib-github.spec.mjs    # GitHub 客户端（本地 mock API；401/403/404/422/限额/重试）
node tests/client-smoke.mjs       # 浏览器半边状态机（伪 React）
node tests/client-ssr.check.mjs   # 真 React SSR 渲染（含平台勾选 / 平台配置 / 版本同步三页）
node tests/e2e-acceptance.mjs     # 从零端到端：临时插件 + mock GitHub + 真实 git 发布
npm run test:all                  # 以上全部
```

`client-ssr.check.mjs` 需要一个真实 React 运行时：设 `DSH_HARNESS_REACT_ROOT` 指向任意含 `react` + `react-dom` 的 `package.json`（例如某个 profile 或临时 `npm i react@18 react-dom@18` 的目录）；没有可用运行时会报 `SKIP` 而不是硬失败。

本次验收：**690 项检查全部通过**（静态 122 + Host 99 + 多平台 18 + git 22 + GitHub 29 + 客户端状态机 31 + 真 React SSR 116 + 端到端 253）。端到端用的是真实 Host + 真实 git（推送到本地 bare 仓库）+ `127.0.0.1` 上的 mock GitHub，没有使用真实 GitHub / npm 账号；npm 的 publish 路径以 `--dry-run` 与 registry mock 覆盖，真实上传需要在你自己机器上用真实 token 发一次。

详细接口与内部契约见 [`CONTRACT.md`](CONTRACT.md)。

## License

MIT.
