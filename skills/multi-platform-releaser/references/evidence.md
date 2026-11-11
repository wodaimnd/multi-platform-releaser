# 断言 → 源码出处

本文每条断言都落到被审插件自己的 `file:line`。行号基于 **multi-platform-releaser 0.4.5**（`package.json:2-3`）。
路径前缀统一省略：`G:\AI PGRM\DSH\plugins\dsh-github-publisher\`。

## A. 装配与入口

| 断言 | 出处 |
|---|---|
| 包名 `multi-platform-releaser`、版本 `0.4.5` | `package.json:2`、`package.json:3` |
| Host 半入口 `./index.js`，`export const name = 'multi-platform-releaser'`，`inject = ['webServer']` | `package.json:10`；`index.js:30-31` |
| 浏览器半入口 `./client.js`，随包 locale 与 icon | `package.json:11-13` |
| 装配清单是包自带 patch | `package.json:34-36`（`dsh.bundle.patch = ./cordis.patch.yml`） |
| 客户端平台 web、立即加载、依赖三个 UI 包 | `package.json:37-45` |
| 随包副作用声明（写工作区、git/npm 子进程、https、读环境变量、写 `$DSH_HOME`） | `package.json:46-56` |
| **本包不含任何 skill**：无 `skills\` 目录、`dsh` 无 skills 键、patch 无 skill-filesystem 行 | 见本文件 §J 实证 |

## B. 槽位与面板

| 断言 | 出处 |
|---|---|
| 命名空间 `NS = 'multi-platform-releaser'` | `client.js:36` |
| 面板 id `PANEL_ID = 'github-publisher'` | `client.js:38` |
| 侧栏排序 `PANEL_ORDER = 50` | `client.js:40` |
| 客户端版本 `CLIENT_VERSION = '0.4.5'` | `client.js:42` |
| 侧栏行注册到 `sidebar.panellist`，用 `id: PANEL_ID` | `client.js:7906-7918` |
| 主页面注册到 `main`，用 `key: PANEL_ID`（与上条字面同值，故点得进去） | `client.js:7922-7930` |
| 客户端 `apply` 返回 `{ name: NS, inject: ['slots','locale'], apply }` | `client.js:7933-7936` |
| locale 注册与绑定 | `client.js:7893`、`client.js:7898` |
| 侧栏行文案「多代码平台发布插件」 | `client.js:6`（文件头注释） |
| 测试期暴露的内部句柄（含 PANEL_ID / STEP_IDS） | `client.js:7939-7952` |

## C. Agent 工具

| 断言 | 出处 |
|---|---|
| 工具名 `multi_platform_releaser` | `index.js:38`；`index.js:651` |
| 默认等待 120000ms、上限 300000ms | `index.js:39-40` |
| schema 定义体 | `index.js:648-682` |
| 10 个 action 的枚举 | `index.js:649`；`index.js:661` |
| `action` 是唯一必填 | `index.js:675` |
| 顶层禁止多余字段 | `index.js:659` |
| 工具超时 330000ms | `index.js:681` |
| 不可并发安全 | `index.js:682` |
| `execute` 分支 | `index.js:683-745` |
| 「先跑 state」写在工具描述里 | `index.js:655` |
| `waitMs` 归一化 `min(max(x||120000,1000),300000)` | `index.js:701` |
| 超时返回 `{ job, timedOut: true }`，不抛错 | `index.js:785-794`（判定在 `:790-791`） |
| `token` 三态：字符串保存 / `detect:true` 探测不保存 / `null`或`''` 清除 / 其它报错 | `index.js:719-724` |
| `job` 找不到 → 404 | `index.js:707` |
| `cancel` 返回 `{ cancelled }` | `index.js:712` |
| `settings` 只吃三个字段并只回显三个 | `index.js:673`；`index.js:715-716` |
| 摘要渲染按 action 分支 | `index.js:585-646` |
| `suggest` 的摘要在 `toolSummary` 里 | `index.js:628-635` |
| 工具注册失败只记日志，不拖垮 HTTP 面 | `index.js:578-580`；`index.js:774-777` |

## D. HTTP 面

| 断言 | 出处 |
|---|---|
| 前缀 `/dsh-github-publisher`，API 前缀加 `/api` | `index.js:33-34` |
| 请求体上限 2MB | `index.js:37` |
| 路由表（GET 取状态、POST 做改动） | `index.js:506-527` |
| loopback 才允许 token bootstrap | `index.js:208`、`index.js:214` |
| 挂到 webServer 的 prefix 路由 | `index.js:771` |

## E. 发布流程与步骤

| 断言 | 出处 |
|---|---|
| 固定步骤序列 | `publisher.mjs:90` |
| 步骤中文名 | `publisher.mjs:3359-3373` |
| 步骤分组常量：`['inspect','prepare']` / `['finish']` / `['auth','repo','topics','commit','push','release']` / `['npm-auth','npm-guard','npm-publish','npm-verify']` | `platforms.mjs:18`、`:21`、`:24`、`:27` |
| 按选择动态生成步骤；npm-only 不产生 hosting 步骤 | `platforms.mjs:499-515`（判定 `:508-511`） |
| 平台注册顺序 github 10 / npm 20 / gitee 30 / codeberg 40 | `platforms.mjs:199-276`（order 在 `:205`/`:217`/`:241`/`:260`） |
| Gitee 不支持 topics → `topicsSupported: false` | `platforms.mjs:254` |
| 选择归一化：空数组回落 `['github']` | `platforms.mjs:528-534` |
| hosting 集合只含 github/gitee/codeberg | `platforms.mjs:467` |

## F. form 与默认值

| 断言 | 出处 |
|---|---|
| 默认值全集 | `store.mjs:29-52` |
| `readmeMode` 的**有效**默认值是 `auto`，不是 `store.mjs:38` 写的 `'append'` | `publisher.mjs:350`（fallback 写死 `'auto'`，不读 DEFAULTS）→ 对照 `store.mjs:38` |
| `repoExistsStrategy` 默认 `reuse` | `store.mjs:47` |
| `license` 五取值 | `store.mjs:23` |
| `visibility` 两取值 | `store.mjs:26` |
| form 白名单（进草稿的 key） | `store.mjs:323-361` |
| 每插件可覆盖的字段 | `store.mjs:364` |
| 合并优先级 request → draft → defaults → suggested | `publisher.mjs:247-256` |
| topics 归一化：小写、替换非法字符、≤50 字符、最多 20 条 | `publisher.mjs:259-266` |
| 分支 `^[A-Za-z0-9._/-]{1,200}$` | `publisher.mjs:100` |
| 仓库名 `^[A-Za-z0-9._-]{1,100}$` | `publisher.mjs:101` |
| 邮箱 `^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$` | `publisher.mjs:102` |
| `repoExistsStrategy` 只认 `error`，其它一律 `reuse` | `publisher.mjs:348` |
| readmeMode 归一化只留 `auto` / `regenerate` 两档（`append`、`keep` 均被吞掉） | `publisher.mjs:350` |
| `auto` + 已有 README → 动作 `keep`；缺失 → `create` | `prepare.mjs:346-360` |
| `append-notes` 分支存在但发布链路不可达（仅直调 `planPreparation` 可达）；触达文件唯一 | `prepare.mjs:331-345`（`:341`）→ 对照 `publisher.mjs:350`；`tests/readme-append.spec.mjs` 为唯一触达文件，触达 `append-notes` 的调用点是 `:66`，`:75` 同模式但 `hasReadme:false` → `create` |
| `mergeForm` 先于 `planPreparation`（故归一化不可绕过） | `publisher.mjs:1368`（mergeForm）→ `:1875` / `:2410`（planPreparation） |
| 追加是幂等的（同条已记录则跳过） | `prepare.mjs:555-576`（`:566`） |
| 追加区块标记常量 | `prepare.mjs:510` |
| 只在临时副本上改发布名 | `platforms.mjs:412-420`（文档注释）；`publisher.mjs:2834` 起 实现 |

## G. npm

| 断言 | 出处 |
|---|---|
| 包名规则：非空、≤214 字符、必须全小写、正则 | `platforms.mjs:397`、`:401-406` |
| scoped 判定 | `platforms.mjs:398`、`:408-410` |
| 发布名优先级：per-plugin 覆盖 → 清单名；全局 publishName 不参与 | `platforms.mjs:429-433` |
| scope 改写规则 | `platforms.mjs:442-449` |
| 版本守卫裁决五档 | `publisher.mjs:3557-3571` |
| 守卫在发布时执行；重复版本抛 `version-exists`(409) | `publisher.mjs:2784-2824`（`:2800-2805`） |
| 远端查不到时不阻断，只 warn | `publisher.mjs:2819-2822` |
| 真实命令行 | `publisher.mjs:2826-2832` |

## H. 令牌

| 断言 | 出处 |
|---|---|
| 探测顺序 env.GITHUB_TOKEN → env.GH_TOKEN → `gh auth token` → `git credential fill` | `publisher.mjs:223-244`（`:231`/`:232`/`:233`/`:235-242`） |
| 运行时解析顺序：会话内存 → config → env → 探测 | `publisher.mjs:679-705` |
| 探测结果缓存 30s | `publisher.mjs:688`、`:696`、`:701` |
| GitHub 走完整链，Gitee/Codeberg 只认显式配置 | `publisher.mjs:715-720` |
| 保存的令牌写 `config.json`，权限 0600 | `store.mjs:6`、`store.mjs:189-194` |

## I. 落盘与任务

| 断言 | 出处 |
|---|---|
| 目录 `$DSH_HOME/github-publisher/`，未设时 `~/.dsh` | `store.mjs:70-77` |
| 可用 `DSH_GITHUB_PUBLISHER_DIR` 覆盖 | `store.mjs:71-72` |
| `history.json` 最多 50 条 | `store.mjs:7`、`store.mjs:19` |
| `drafts.json` 最多 200 份 | `store.mjs:8`、`store.mjs:20` |
| 三个文件名 getter | `store.mjs:216`、`:219-220`、`:223-224` |
| 任务日志与 `partial` 判定 | `publisher.mjs:3078-3088` |
| 单 hosting 的 `partial` | `publisher.mjs:2997` |
| `job.result.status` 由失败计数决定 | `publisher.mjs:3058` |
| 什么都没创建算真失败，不算 partial | `publisher.mjs:2483`（注释） |
| 关闭时取消所有 running 任务 | `index.js:750-756` |
| 发布记录字段 | `publisher.mjs:3046-3067` |

## J. 「插件原本是否自带 skill」的实证

| 项 | 命令 / 检查 | 结果 |
|---|---|---|
| 目录列表 | `Get-ChildItem -Force 'G:\AI PGRM\DSH\plugins\dsh-github-publisher'` | 无 `skills` 目录；顶层只有 `.git`、`lib`、`locale`、`tests`、`.gitignore`、`client.js`、`CONTRACT.md`、`cordis.patch.yml`、`icon.svg`、`index.js`、`LICENSE`、`package.json`、`README.md`、`VERIFICATION.md` |
| skills 目录 | `Test-Path '...\skills'` | `False` |
| SKILL.md | `Test-Path '...\SKILL.md'`；递归搜 `SKILL.md` / `skill.md` | 全部 `False` / 零命中 |
| package.json 声明 | 读 `dsh` 键 | 只有 `bundle` / `client` / `forge`；`dsh.skills` 与 `dsh.skill` 均不存在 |
| 包自带 patch | 读 `cordis.patch.yml` | 只有一个 insert 条目 `- id: multi-platform-releaser` / `name: multi-platform-releaser`，无第二行，无 `dsh-skill-filesystem` |
| profile 侧 | 在 `C:\Users\Shinelon\.dsh\profiles\next\cordis.patch.yml` 搜 `multi-platform\|github-publisher\|skill-filesystem` | 零命中（该 bundle 由 profile 的 `dsh.profile.bundles` 合成，不在 patch 里显式列出）；`profiles\next\cordis.yml` 内容为 `[]` |

**结论：0.4.5 完全不带 skill。** 本次新增的 `skills\multi-platform-releaser\SKILL.md` 是该插件的第一份随包手册。

## K. 本次新增的绑定（不是被审代码，列出来备查）

| 断言 | 出处 |
|---|---|
| `cordis.patch.yml` 追加 `dsh-skill-filesystem` 条目，`providerName: multi-platform-releaser`、`includeDefaultRoots: false`、`watch: false`、`bundledSkillDir: !!js <表达式>` | `cordis.patch.yml`（本文件的对应 patch 块） |
| `package.json` 的 `files` 增加 `"skills/**"`，否则发布包不带手册 | `package.json:15-27` |
| `dsh-skill-filesystem` 的 config 字段（含 `bundledSkillDir`） | 宿主侧 `@deepseek-ai/dsh-skill-filesystem` lib/index.js:31-42 |
| 装了 `bundledSkillDir` 的根以 `source: bundled` + `trustedHost: true` 入列 | 同上 lib/index.js:191-196 |
