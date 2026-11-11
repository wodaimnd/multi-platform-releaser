# 坑、失败码与预检

## 一、预检 check id（`preflight.checks[].id`）

`blocking` 就是所有 `status === 'fail'` 的 check id（收集处 `publisher.mjs:1934`）。

`checks[].fix` 一共四个取值，告诉你把注意力放哪：

| fix | 去哪修 |
|---|---|
| `form` | 发布表单里的字段 |
| `settings` | 全局设置 |
| `platforms` | 「平台配置」区（令牌、registry、发布用包名） |
| `bump` | 一键提升版本号（配套路由 `/api/version/bump`）—— 修的是 `package.json` 的 version |

常见 check id：

| id | 什么时候出现 | 去哪修 |
|---|---|---|
| 平台选择相关 | 一个都没选（`publisher.mjs:1460`） | `form` —— 至少勾一个平台 |
| `git` | PATH 里找不到 git（`publisher.mjs:1474`） | `settings` |
| GitHub 连通性 | 网络 / 超时（`publisher.mjs:1487`，网络类降为 `warn`） | — |
| `npm-cli` | 找不到 Node 自带的 npm（`publisher.mjs:1510`） | `settings` |
| `npm-name` | 发布用包名不合法（`publisher.mjs:1540-1547`，`platforms`）；或 `package.json` 缺 `name`（`publisher.mjs:1556`，`form`） | 见括号 |
| `npm-version` | 版本已存在于 npm（`publisher.mjs:1565-1576`，`fail` + `bump` + 带 `suggestion: next`）；低于远端 latest（`publisher.mjs:1577-1585`，**`warn` 不挡发布**）；首次发布 / 已领先则为 `pass` | `bump` |
| `npm-version-package` | `package.json` 没有 `version`（`publisher.mjs:1613`） | `form` |
| `host-auth` | Gitee / Codeberg 没配令牌（`publisher.mjs:1668-1674`，`dryRun` 时降为 `warn`）或令牌验不过（`publisher.mjs:1688-1694`） | `platforms` |
| `name` | 仓库名不合法（`publisher.mjs:1623`）：只允许 `[A-Za-z0-9._-]`、1–100 字符 | `form` |
| `description` | 仓库描述 > 350 字符（`publisher.mjs:1626`） | `form` |
| `repo` | 无法检查仓库（`publisher.mjs:2037`）或仓库已存在且策略为 `error`（`publisher.mjs:2042`） | `form`（改成「复用已有仓库」） |
| `identity` | 提交邮箱格式无效（`publisher.mjs:1782`） | `form` |

`checks[].status` 三档 `pass` / `warn` / `fail`。**只有 `fail` 进 `blocking`，`warn` 不挡发布。**

## 二、失败码

| code | 触发 | 备注 |
|---|---|---|
| `version-exists` | npm 上该版本已存在 | **HTTP 409**，消息里带建议的下一个版本 `next`（`publisher.mjs:2800-2805`） |
| `npm-name-missing` | 发布用包名为空（`publisher.mjs:2787`） | |
| `npm-name-invalid` | 包名不合法（`publisher.mjs:2788`） | 小写、无空格、≤214 字符、可带 `@scope` |
| `version-missing` | `package.json` 缺 `version`（`publisher.mjs:2789`） | |
| `invalid-token` | 某平台令牌缺失或校验失败（`publisher.mjs:2390`） | 多平台时会把每个平台的缺失原因拼在一起 |
| `job-not-found` | `job` 的 jobId 不存在 | 工具里是 404（`index.js:707`） |
| `cancelled` | 任务被取消（`publisher.mjs:3093-3095`） | 未跑的步骤标 `skipped` |
| `bad-request` | `action=token` 没给 token 也没给 `detect`（`index.js:723`）；未知 action（`index.js:740`） | |
| `llm-unavailable` | AI 补全时没有可用模型 | **HTTP 503**（`index.js:311`），提示先去「设置 → 模型」配置 |

## 三、npm 版本守卫到底怎么判

唯一裁决函数 `versionGuardVerdict`（`publisher.mjs:3557-3571`），**预检和发布时的守卫共用它**，所以面板不会承诺一个守卫随后拒绝的发布（这段注释本身就是为修「版本 0.3.4 已存在于 npm」的误报写的）。

| 裁决 | 含义 | 后果 |
|---|---|---|
| `no-local` | 本地清单没有版本号 | 另有检查单独报 |
| `first-publish` | 名字空闲 | 可以发 |
| `duplicate` | **这个版本已经存在** | **阻断**，npm 会拒 |
| `below-latest` | 可选，但低于远端 latest | 合法，**只 warn**：所选 dist-tag 会向后移动 |
| `ahead` | 可选且新于远端 latest | 可以发 |

发布时的实现：`publisher.mjs:2784-2824`。探测不到远端时**不阻断**，只 warn「版本未校验」，让 registry 自己拒（`publisher.mjs:2819-2822`）。

## 四、npm publish 的真实命令行

`publisher.mjs:2826-2832`：

```
npm publish --access <npmAccess> --tag <npmDistTag> --registry <registry> [--otp <npmOtp>] [--provenance] [--dry-run]
```

- `--provenance` 只在 npm 平台配置 `provenance: true` 时加，不是 form 字段。
- `--dry-run` 来自 `form.dryRun`。
- 发布名与清单名不同时，**改写的是临时副本**，源码 `package.json` 不动（`publisher.mjs:2834` 起）。

## 五、「部分失败」的完整语义

三层，别混：

1. **单个 hosting 的 status**（`publisher.mjs:2997`）：`repoOk || pushed` 但没走完 → `'partial'`。
2. **`job.result.status`**：任何一个 hosting 失败 → `'partial'`（`publisher.mjs:3058`）。
3. **`job.status`**（整任务，`publisher.mjs:3078-3088`）：至少一个 hosting 成功**且**至少一个失败 → `'partial'`；否则 `'succeeded'`。
   `'partial'` 的日志文案是「部分平台完成」，`'succeeded'` 是「发布成功」。
   注释写明了取舍理由：报 `succeeded` 会掩盖真实失败，报 `failed` 会丢掉远端上已经活着的东西。

**处置原则**：看到 `partial` 先读 `job.result.hosts[]` 定位是哪个平台，只针对失败的那个平台重试（例如只勾选它），**不要**整单重发 —— 成功的平台会被再推一遍（tag/Release 已存在会走复用逻辑，但 npm 那边直接撞 `version-exists`）。

`job.platformResults.npm` 单独带 `url` 与 `version`（`publisher.mjs:3056-3057`）。

**注意**：某个平台彻底没创建任何东西时是**真失败**，不会被算成 partial（`publisher.mjs:2483` 的注释：「Nothing was created anywhere: that is a real failure, not a partial.」）。

## 六、日志与任务记录

- 任务日志是 `job.logs[]`，每条 `{ level, text }`；`publish` 的摘要只带最后 12 条（`index.js:617`）。
- 日志 level 有 `warn` / `success` 等；守卫降级、低于 latest、远端版本查不到都记 `warn`。
- 发布记录落 `history.json`，最多 50 条（`store.mjs:19`），字段含 `at` / `owner` / `repo` / `status` / `repoUrl`；完成时还会记 `version` / `commitSha` / `tag` / `hosts[]` / `npmUrl` / `npmVersion` / `files[]` / `ownership`（`publisher.mjs:3046-3067`）。

## 七、插件关闭时的行为

注册了一个 shutdown effect（`index.js:750-756`）：取消当前任务，并把所有 `status === 'running'` 的任务一并取消。所以**发布中途关掉 DSH / 卸载插件会中断发布**，且中断点不可续跑，只能重来（已推上去的部分靠远端复用）。

## 八、已知的实现小瑕疵（不影响使用）

`index.js:726-733` 有一份重复的 `case 'suggest':` 渲染分支，缩进错位且**永远不会执行** —— JS 的 switch 在 `'suggest'` 上匹配的是前一处 `index.js:690`，那处正常 `break` 且结果经 `toolSummary()`（`index.js:628-635`）渲染。所以 `suggest` 的行为与本文描述一致，这段是死代码。
