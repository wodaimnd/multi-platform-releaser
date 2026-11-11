# publish form 字段参考

`form` 会与 `defaults`、per-plugin 草稿、`suggested` 依次合并，优先级：**request → draft → defaults → suggested → 内置兜底**（`publisher.mjs:247-256`）。
所以只传你要改的字段，其余自动继承。

## 字段全集

白名单在 `store.mjs:323-361`（`FORM_KEYS`），只有这些 key 会被保留进草稿：

`owner` `name` `description` `descriptionZh` `homepage` `topics` `visibility` `license` `branch` `tagPrefix` `commitMessage` `authorName` `authorEmail` `confirmForeignAuthor` `confirmForeignAuthorFor` `repoExistsStrategy` `addReadme` `readmeMode` `addLicense` `addGitignore` `updatePackageJson` `createRelease` `releaseNotes` `dryRun` `forceWithLease` `platforms` `npmAccess` `npmDistTag` `npmOtp` `publishName`

## 默认值（`store.mjs:29-52` `DEFAULT_DEFAULTS`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `visibility` | `public` | 取值 `public` / `private`（`store.mjs:26`） |
| `license` | `MIT` | 取值 `MIT` / `Apache-2.0` / `BSD-3-Clause` / `GPL-3.0` / `none`（`store.mjs:23`） |
| `branch` | `main` | 校验正则 `^[A-Za-z0-9._/-]{1,200}$`（`publisher.mjs:100`） |
| `tagPrefix` | `v` | 最终 tag = 前缀 + 版本号 |
| `createRelease` | `true` | |
| `addReadme` | `true` | |
| `readmeMode` | `auto` | 见下；`store.mjs:38` 写的 `'append'` 是死默认值，到不了 |
| `addLicense` | `true` | |
| `addGitignore` | `true` | |
| `updatePackageJson` | `true` | |
| `commitMessage` | `chore: publish {name} v{version}` | 支持 `{name}` `{version}` 占位 |
| `authorName` / `authorEmail` | `''` | 邮箱必须匹配 `^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$`（`publisher.mjs:102`） |
| `apiBase` | `https://api.github.com` | Enterprise 改这个 |
| `gitBase` | `https://github.com` | |
| `repoExistsStrategy` | `reuse` | 见下 |
| `topicPreset` | `['deepseek','dsh','dsh-plugin']` | |
| `platforms` | `['github']` | 多选 |
| `npmAccess` | `public` | |
| `npmDistTag` | `latest` | |

## 三个需要特别小心的字段

### `readmeMode`

**发布链路上只有两档有效值。** 原因是 `mergeForm`（`publisher.mjs:247`）先于 `planPreparation` 跑，而它把一切非 `regenerate` 的值归一化成 `auto`：

- `auto`（不传即是）—— 已有 README → 动作 `keep`，**原文件一个字都不动**（`prepare.mjs:346-353`，理由写的是「可在发布选项中改为追加更新日志」）；README 缺失 → `create` 一份生成的（`prepare.mjs:354-360`）。
- `regenerate` —— 整文件重写（`update` / `create`），破坏性，必须显式指定。

⚠️ **`append` 到不了。** `store.mjs:38` 里确实写着 `readmeMode: 'append'`，但 `publisher.mjs:350` 是
`form.readmeMode = (request.readmeMode || draft.readmeMode || 'auto') === 'regenerate' ? 'regenerate' : 'auto'`
—— 它 fallback 直接写死 `'auto'`，**压根不读 `DEFAULTS`**，所以 `store.mjs:38` 那行是死默认值。`prepare.mjs:331` 认 `append`、`prepare.mjs:335-345` 也确有 `append-notes` 分支，但只要 `form` 是 `mergeForm` 产出的（`publish` 与 `preflight` 都是），`form.readmeMode` 就只可能是 `auto` 或 `regenerate`：
- 传 `append` → `mergeForm` 归一化成 `auto` → 已有 README 落到 `keep` 分支 → **静默保留，不追加，也不报错**。
- 想让追加生效，只能绕过发布层直调 `planPreparation({ plugin, form })` 并自己把 `form.readmeMode` 置为 `'append'` —— 仓库里只有 `tests/readme-append.spec.mjs` 这么做：`:66` 是唯一能触达 `append-notes` 的调用点，`:75` 传了同一个 `'append'` 但 `hasReadme: false`，落在 `create` 分支。
- `prepare.mjs:327` 的注释「the default for an existing README is `append`」是**过时注释**；同处的 `prepare.mjs:332` 里 `readmeMode !== 'keep'` 也永不为假（`mergeForm` 同样产不出 `'keep'`），别照抄。

追加逻辑：`appendReleaseNotes(existingText, entry, tag)`（`prepare.mjs:555-576`），返回 `{text, appended, reason}`；
- 同一条已记录 → `appended: false, reason: 'already recorded'`（`prepare.mjs:566`）—— 重复发布会**幂等跳过**，不会灌两遍。
- 已有区块 → 新条目**前插到区块内**（`prepare.mjs:570`），区块标记常量在 `prepare.mjs:510`。
- 没有区块 → 新建整个区块（`prepare.mjs:576`）。

### `repoExistsStrategy`

只有两个合法值（`publisher.mjs:348`）：`'error'` 保持原样，**其它任何值都归一化成 `'reuse'`**。
- `reuse` —— 复用已有仓库继续发布。
- `error` —— 仓库已存在就报错（预检里是 `checks.id === 'repo'`，`publisher.mjs:2042`）。

### `platforms`

选择归一化：`normalizeSelection()`（`platforms.mjs:528-534`），空数组回落到 `['github']`，顺序按 registry 顺序（github 10 → npm 20 → gitee 30 → codeberg 40，`platforms.mjs:199-276`）。
`gitee` 的 `topicsSupported: false`（`platforms.mjs:254`）—— 选 Gitee 时 topics 步骤自动跳过。

## npm 平台专属字段

- `npmAccess` —— `public` / `restricted`（`platforms.mjs:230`）。非 scoped 包只能用 `public`。
- `npmDistTag` —— 如 `latest` / `next` / `beta`（`platforms.mjs:231`）。实际命令是 `npm publish --access <access> --tag <distTag> --registry <registry>`（`publisher.mjs:2829`）。
- `npmOtp` —— 开了 2FA 时每次发布填一次，**不落盘**（`platforms.mjs:232`）。有值才追加 `--otp`（`publisher.mjs:2830`）。
- `provenance` —— **不是 form 字段**，是 npm 平台配置项（`platforms.mjs:233`），为 true 才追加 `--provenance`（`publisher.mjs:2831`）。需要 CI/OIDC，本机发布通常关闭。
- `publishName` —— 覆盖发布用的包名（`platforms.mjs:223-229`）。**per-plugin**，存在该插件的草稿里，不是全局设置（`store.mjs:358-360`）。
  解析优先级：per-plugin 覆盖 → `package.json` 的 `name`；**全局 `publishName` 故意不参与**（`platforms.mjs:429-433`），因为一个插件的发布名不该决定另一个插件的包名。
  名字改写规则：`scopePublishName(name, scope)`（`platforms.mjs:442-449`），`@local/market-lens` + `@jtnm114514` → `@jtnm114514/market-lens`。**源码 `package.json` 不动**，只改发布时的临时副本。

## 全局设置（不是 form）

`settings` 只有三项：`defaults`（上面那张默认值表）、`scanRoots: string[]`、`autoDetectToken: boolean`（`store.mjs:55-64`，`index.js:716`）。
`scanRoots` 落盘时统一 `path.resolve` 去重（`store.mjs:96-98`）。
