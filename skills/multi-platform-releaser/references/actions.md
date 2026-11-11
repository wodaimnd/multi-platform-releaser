# action 参考（10 个）

工具名：`multi_platform_releaser`（`index.js:38`）
schema：`index.js:648-682`　`execute`：`index.js:683-745`　返回摘要渲染：`index.js:679`

## 通用

- `action` 是唯一必填字段（`index.js:675`）。
- `additionalProperties: false`（`index.js:659`）—— 顶层多传字段会被 schema 拒。
- `timeoutMs: 330_000`（`index.js:681`），大于 `waitMs` 上限（300000），所以 publish 等待不会被工具超时先掐断。
- `isConcurrencySafe: () => false`（`index.js:682`）。
- 输出给模型的是 `render()` 生成的纯文本摘要（`index.js:679`）；结构化数据在返回对象里，摘要按 action 分类生成（`index.js:585-646`）。

## `state`

无参数。返回：`version`、`account{connected, login, tokenSource}`、`plugins[]`、`history[]`。
实现：`index.js:687-689` → `buildStateWithCapabilities()`（`index.js:257`）。
摘要（`index.js:588-597`）：账号连接状态 + 本地插件数 + 历史条数 + 前 12 个插件名。

## `scan`

参数：`roots?: string[]` —— 额外扫描的绝对目录。空数组等于不传（`index.js:694`）。
返回 `plugins[]`，每项含 `name` / `version` / `path`。
摘要：`共发现 N 个本地 DSH 插件` + 逐行 `- name version (path)`（`index.js:598-599`）。

## `preflight`

参数：`path`（插件目录绝对路径）、`form?`。
返回：`plugin`、`plan{owner, repo}`、`canPublish`、`blocking[]`（`status === 'fail'` 的 check id 列表，`publisher.mjs:1934`）、`checks[]`、`preview.writes[]`。
`checks[].fix` 的取值告诉你去改哪里：`form` → 改表单，`settings` → 改设置。
**发布前必跑这一步**，且 `blocking` 为空才继续。

## `publish`

参数：`path`、`form?`、`waitMs?`。
流程：`publisher.publish({path, form})` 拿到 `jobId`（`index.js:700`），随后 `waitForJob(publisher, jobId, waitMs)`（`index.js:701-702`，`waitForJob` 在 `index.js:785`）。
`waitMs` 归一化：`Math.min(Math.max(Number(waitMs) || 120000, 1000), 300000)`（`index.js:701`）。
**它只是等待时长，不是成败判据**；超时返回的任务继续在后台跑，用 `job` 再读。

返回摘要（`index.js:609-619`）：`发布任务 <jobId>：<status>` + 每步一行 + 结果块（仓库 / commit / tag / Release URL）+ 失败原因（含 code）+ 最后 12 条日志。

## `job`

参数：`jobId?`（缺省取最近一个任务，`publisher.mjs getJob(null)`）。
找不到任务 → `PublisherError('job-not-found', '没有找到发布任务', {status: 404})`（`index.js:707`）。
返回 `{ job }`，`job.steps[]` 每项 `{id, status, detail}`。

## `cancel`

参数：`jobId?`。返回 `{ cancelled: boolean }`（`index.js:712`）。
摘要：`已请求取消发布任务` / `没有正在运行的任务`（`index.js:620-621`）。
取消后 job 的 pending 步变 `skipped`、running 步变 `skipped`，`job.error.code = 'cancelled'`（`publisher.mjs:3090-3099`）。

## `settings`

参数：`settings: { defaults?, scanRoots?, autoDetectToken? }`（`index.js:673`）。
也接受把这三个字段直接放在顶层（`index.js:715` 的 `args.settings ?? args` 兜底）。
返回只回显这三项（`index.js:716`）。

## `token`

两种用法：
- `{ action: 'token', token: '<PAT>' }` —— 保存并校验（`index.js:668` 的 schema 描述）。
- `{ action: 'token', detect: true }` —— 不传 token，从环境 / `gh` CLI / git credential helper 自动探测（`index.js:669`）。

探测优先级实现：`detectTokenCandidates()`（`publisher.mjs:223-244`），顺序为 `env.GITHUB_TOKEN` → `env.GH_TOKEN` → `gh auth token`（超时 4000ms）→ `git credential fill`（超时 5000ms，`GIT_TERMINAL_PROMPT=0`）。
摘要：`GitHub 账号已连接：@login（tokenSource，已保存/仅本次会话）` 或 `GitHub 账号已断开`（`index.js:624-627`）。

## `history`

无参数。返回 `history[]`，最多 50 条（`store.mjs:19` `HISTORY_MAX = 50`）。
每条含 `at` / `owner` / `repo` / `status` / `repoUrl`。空时摘要为 `还没有发布记录`（`index.js:639`）。

## `suggest`

参数：`path`、`form?`。用配置的 DeepSeek 模型起草。
返回 `{ provider, model, suggestion{ description, descriptionZh, topics[], releaseNotes } }`。
模型不可用时抛 `HttpError(503, 'llm-unavailable', AI_UNAVAILABLE_MESSAGE)`（`index.js:311`）。
摘要：`AI 补全（provider/model）：` + 四个字段（`index.js:628-635`）。

## 步骤 id（publish 的 `job.steps[]` 用它）

按选择动态生成：`buildStepIds()`（`platforms.mjs:499-515`）。
- 没有选任何 hosting 平台时，**auth/repo/topics/commit/push/release 一步都不会出现**（`platforms.mjs:508-511`）—— npm-only 发布是合法选择。
- 选了 hosting 时：`auth` → `inspect` → `prepare` → `repo` → `topics` → `commit` → `push` → `release`。
- 选了 npm 时追加：`npm-auth` → `npm-guard` → `npm-publish` → `npm-verify`（`platforms.mjs:27`）。
- 最后恒有 `finish`（`platforms.mjs:21`）。

中文步骤名在 `publisher.mjs:3359-3373`。
