---
name: multi-platform-releaser
description: 用 DSH 的「多代码平台发布插件」把本地插件一次发布到 GitHub / Gitee / Codeberg 与 npm registry。当用户说「把这个插件发布出去」「发布插件」「推到仓库、打 tag、建 Release」「发到 npm」「多平台一起发」「再发一版」「仓库已存在怎么办」「npm 说版本已存在」「发布报了错 / 只完成了一部分」「帮我写仓库描述和 Release 说明」时使用；也用于查发布状态、发布历史、令牌来源与预检阻塞项。不用于普通 git 提交，也不用于编写或修改插件代码本身。
---

# 多代码平台发布插件（multi-platform-releaser）

一次提交推送到多个远端：GitHub / Gitee / Codeberg 各建自己的仓库、topics、tag、Release，并可同时 `npm publish`。

## 一、什么时候用

- 把某个**本地 DSH 插件目录**发布出去（「发布插件」「发到 GitHub」「推上去打个 tag」「再发一版」）。
- 问发布状态、发布历史、或为什么发不出去（预检阻塞、令牌、版本已存在、只完成了一部分）。
- 一次性发到多个平台，或要发到 npm。
- 要补全仓库元数据（描述 / topics / Release 说明）→ 用 `suggest`。
- **不要**用于：普通 git 提交、写或改插件代码、发布非 DSH 插件的任意仓库。

## 二、两个入口，先选对

| 入口 | 用法 | 何时选 |
|---|---|---|
| Agent 工具 `multi_platform_releaser` | 10 个 action，程序化调用 | AI 自主完成、无人盯着 |
| GUI 面板 | 左侧栏「多代码平台发布插件」（槽位 `sidebar.panellist`，id = `github-publisher`，order = 50） | 需要人工确认、看预检细节、填表单 |

两者走**同一套实现**（`lib/publisher.mjs`）和同一个 HTTP 前缀 `/dsh-github-publisher/api`，结果形状一致。面板只做呈现，不额外加工语义。

## 三、标准流程（五步骨架）

| 步 | 动作 | 这一步要拿到什么 |
|---|---|---|
| 1 | `state` | 账号连没连、有哪些本地插件、历史几条。工具描述原文就要求先跑它。没连先 `token`。 |
| 2 | `scan` | 明确要发的是哪个目录（拿绝对路径 `path`）。已知路径可跳过。 |
| 3 | `preflight`（必带 `path`） | **必做。** 读返回的 `blocking` 数组；非空就是发不出去，按 `checks[].fix` 修（`form` = 改表单，`settings` = 改设置）。 |
| 4 | `publish`（`path` + `form`） | 阻塞项清零后才发。 |
| 5 | `job` | 看 `job.steps[]` 与 `job.status`（∈ `succeeded` / `partial` / `failed` / `cancelled`）。 |

**先 preflight 再 publish。** 跳过 preflight 等于把能提前发现的问题留到发布中途炸；而 publish 一旦开始就可能已经把东西推到远端了。

## 四、10 个 action 速查

| action | 参数 | 做什么 |
|---|---|---|
| `state` | — | 账号 + 本地插件 + 历史 |
| `scan` | `roots?` | 扫本地 DSH 插件目录 |
| `preflight` | `path`, `form?` | 只读预检，给 `canPublish` / `blocking` / `checks` |
| `publish` | `path`, `form?`, `waitMs?` | 真发布，等待任务结束 |
| `job` | `jobId?`（缺省取最近一个） | 查任务步骤与日志 |
| `cancel` | `jobId?` | 取消正在跑的任务 |
| `settings` | `settings: { defaults?, scanRoots?, autoDetectToken? }` | 改全局设置 |
| `token` | `token?` / `detect: true` | 三态：传字符串 = 保存并校验；`detect: true` = 探测但不保存；传 `null` / `''` = 清除令牌 |
| `history` | — | 最近 50 条发布记录 |
| `suggest` | `path`, `form?` | 用配置的 DeepSeek 模型起草描述 / topics / Release 说明 |

工具**非并发安全**（`isConcurrencySafe: () => false`）：同一时刻只跑一个发布动作，别并行起两个 `publish`。
工具自身超时 330000ms，比 `waitMs` 上限多 30s —— 那是留给发布本身的余量。

### `waitMs` 与「超时」

`waitMs` 归一化成 `min(max(waitMs || 120000, 1000), 300000)`。它**只决定等多久，不决定发布成败**。
到点还没结束，`waitForJob` 返回 `{ job, timedOut: true }`，任务仍在后台跑。
**看到 `timedOut` 不要重发 publish** —— 用 `action: 'job'`（带 `jobId`）接着轮询，重发会把已经推上去的东西再来一遍。

## 五、会咬人的约束（重点）

### 1. 真会往外发东西的动作

`publish` 会：建或复用远端仓库、提交、push、打 tag、建 Release，且**可能执行 `npm publish`**。
空跑用 `form.dryRun: true`：只做本地提交，不创建远端仓库、不 publish npm。
**`npm publish` 成功不可撤**，同名版本号永远不能再发。

### 2. 令牌从哪来

GitHub 按优先级：会话内存 → `config.json` 里保存的 → `GITHUB_TOKEN` / `GH_TOKEN` 环境变量 → `gh auth token` → `git credential fill`（后两者是自动探测，`autoDetectToken: false` 可关）。
Gitee / Codeberg **只有显式配置的令牌**，没有探测兜底。
保存的令牌落在 `$DSH_HOME/github-publisher/config.json`，权限 0600。

### 3. 「部分失败」是一等状态

多平台选择下 `job.status = 'partial'` 的含义是：**至少一个平台全成功，且至少一个失败**。看到 `partial` 必须读 `job.result.hosts[]` 逐平台看谁成了谁没成 —— **不要重试整个发布**，那会把已经成功的平台再跑一遍。
单个平台内部同样分档：`succeeded` / `partial`（仓库建了或 push 了但没走完）/ `failed`。

### 4. npm 的死线

- 包名必须**全小写**、无空格、≤214 字符、可带 `@scope`；不合法 → `npm-name-invalid`。
- **版本号重复 = 硬失败**（`version-exists`，HTTP 409），错误信息里会给建议的下一个版本 `next`。npm 不允许重发同一个版本号。
- 发布低于远端 latest 是**合法**的，只是所选 dist-tag 会向后倒退，记 warn。
- `npmAccess: 'restricted'` 只对 scoped 包有意义；非 scoped 包只能用 `public`。
- `publishName` 可改写发布用的包名（`@旧/名` → `@新/名`），**只作用于临时副本**，源码 `package.json` 不动。

### 5. 别覆盖用户在仓库里写的东西

- `readmeMode` 实际只有 `auto`（默认，已有 README **原样保留**、只缺文件时才生成）与 `regenerate`（整文件重写，破坏性）两档；**传 `append` 会被静默归一化成 `auto`**，想让插件追加「更新日志」区块是走不通的 —— 成因见 `references/form.md`。
- `repoExistsStrategy` 只有两个取值：`reuse`（默认）与 `error`；填其它值会被归一化成 `reuse`。
- 仓库名只允许 `[A-Za-z0-9._-]` 且 1–100 字符；仓库描述 ≤350 字符；分支名 `[A-Za-z0-9._/-]`；提交邮箱必须是合法邮箱格式。
- 声明作者不是当前账号时，要显式给出 `confirmForeignAuthor` 才会放行（fork 的插件合法带别人的作者名）。

## 六、其它入口与落盘

- **HTTP 面**：前缀是 `/dsh-github-publisher/api/*`，**不是**包的 npm 名 —— 想直接调 HTTP 时别按包名猜。改动类动作一律 POST，只有读状态类用 GET；请求体上限 2MB。
- **落盘位置**：`$DSH_HOME/github-publisher/`（`DSH_HOME` 未设时为 `~/.dsh`；可用环境变量 `DSH_GITHUB_PUBLISHER_DIR` 整体覆盖）：
  - `config.json` —— 设置 + 平台配置 + 令牌（权限 0600，只在用户显式保存时才写令牌）
  - `history.json` —— 最近 50 条发布记录
  - `drafts.json` —— 每个插件一份半填表单草稿，最多 200 份

## 七、细节去哪找

- 每个 action 的完整参数与返回结构 → `references/actions.md`
- publish form 全字段、默认值、哪些落进 per-plugin 草稿 → `references/form.md`
- 失败码、预检 check id、日志通道、目录布局 → `references/pitfalls.md`
- 本文每条断言的源码出处（file:line）→ `references/evidence.md`
