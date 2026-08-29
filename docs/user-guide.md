# AutoEvo 使用指南

[English](user-guide.en.md) | 中文 · [返回 README](../README.md)

本指南面向在 DSH 中发现、安装、修改或创建能力的使用者。**能力进化** preset 使用 Search-first 工作流：临时实验与正式需求走同一流程。AutoEvo 负责流程、警告与证据回执；权限、sandbox 和 approval 的强制执行属于 DSH Core。

## 1. 使用前准备

- Node.js `^22.19.0 || ^24.0.0`。
- 一个可正常运行的 DSH profile；本文以 `web` 为例，命令中的 `--profile web` 要换成你实际使用的 profile。
- 查找或审查 GitHub 插件需要 GitHub CLI，先确认 `gh auth status` 正常。
- 使用指令遵循、上下文保持和结构化工具调用可靠的模型。

## 2. 安装、升级与首次加载

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.0.0
```

通过 npx 运行 DSH，无需全局安装；命令必须带 `@deepseek-ai/` 前缀（npm 上无 scoped 的 `dsh` 是无关项目）。安装或升级后重启该 profile，让新 bundle 生效。

安装成功后，用户 preset 列表中应出现 **能力进化**（id `evolution`）。AutoEvo 只升级自己管理且未被修改的 preset；同名外来目录或用户改过的内容会被保留并提示诊断。把配置项 `evolutionPreset` 设为 `false` 可以停止安装或升级 preset，但不会删除已有的 preset。

## 3. 第一次完整使用

### 3.1 发起需求

在新的 DSH 会话中选择 **能力进化**，直接描述目标：

> 我需要一个能同步项目记录的 DSH 插件。先查现成的。

需求足够明确时会直接搜寻；只有实质歧义会改变搜寻方向时，Agent 才会先澄清一次。澄清回答只影响只读搜寻，不代表选择、创建、修改或安装的授权。

### 3.2 第一道确认门：选候选去审查

Agent 会在有界预算内补充查询，然后密封 1–5 个候选。用一条新消息选择想审查的候选，例如：

- “先看第二个。”
- “按你推荐的那个审查。”
- “这几个都不合适，继续找。”

这一步是只读选择，不会安装、修改或新建。搜寻结果可以为空，此时只能继续搜寻、创建新能力或停止；选择“创建”仍需后续消息确认。

### 3.3 第二道确认门：审查后决定结果

Host 会审查候选的精确来源、manifest、必要源码、兼容性和安全事实。审查完成后，用一条新的聊天消息明确决定：原样复用、安装、修改、从零创建、继续搜索或停止。用自然语言表达即可；实际副作用仍由 DSH Core 的权限与一次性 approval 执行。

[![AutoEvo 主工作流](assets/flowcharts/autoevo-main-workflow.svg)](assets/flowcharts/autoevo-main-workflow.html)

（点击图片打开交互版流程图。）

## 4. 常见任务

### 4.1 原样使用本地能力

本地工具或技能已满足需求时可以直接复用。这是正常终态：不审查远端仓库，也不产生安装物。

### 4.2 安装已审查候选

只要审查能明确识别来源、目标包和有效安装描述，安装入口就交给用户决定。fit、兼容性、生命周期脚本、代码风险和 reviewer 意见会作为警告与建议展示，不会隐藏安装入口；只有无法物化的来源需要先修复。采用的能力一律持久安装到目标 profile，生命周期脚本与包管理器行为由 DSH 的正常权限、sandbox 和 approval 规则处理。

### 4.3 修改候选或已安装能力

候选只差一点、已安装插件需要升级、或历史失败来源需要修复时，选择“在这个来源上修改”。AutoEvo 会：

1. 验证精确上游或历史托管来源；
2. 在当前会话工作区的 `.autoevo/sources/` 中准备托管 Git 源；
3. 由 Host 启动 cwd 只绑定该托管源的短生命周期施工会话，完成编辑与有界检查；
4. 由 Host 提交、重新审查并冻结；
5. 等待你再次确认是否安装。

施工会话受 Host 管理，不能越出托管源、安装插件、修改 profile、提交或发布；完成后立即释放。历史失败或已移除的来源修复后按首次安装处理；只有 profile 中真实存在且来源精确匹配的插件才走替换路径。

### 4.4 从零创建

只有发现过程完整且没有合适候选，并且你在第二道门明确选择创建时，才会建立托管脚手架。创建同样交给 cwd 精确绑定的受管施工会话，完成检查和本地审查后还需再次确认安装。

### 4.5 停止

任何确认门都可以明确停止。停止不会被当成安装或创建授权，DSH approval 也不能覆盖这个决定。

### 4.6 版本、领养与上游更新

AutoEvo 为每个包保留安装回执链，配套四个工具：

| 工具 | 作用 |
| --- | --- |
| `capability_versions` | 按包名列出版本链，标出当前 live 版本与产物可用性；只读。 |
| `capability_rollback` | 回滚到历史版本（缺省为直接前任）。走标准审查来源重装路径，仍需一次性批准；没有关联审查的领养回执不能作为回滚目标。 |
| `capability_adopt` | 不带参数时扫描当前 profile 中未登记的已装插件；带 `package_name` 时登记为领养回执，之后可被版本与更新工具追踪。领养回执没有审查记录，`verified` 为 false。 |
| `capability_updates` | 对精确 GitHub pin 的安装只读对比上游默认分支头部 commit 与最新 release。升级本身仍走 §4.3 的修改流程。 |

## 5. 结果状态与下一步

[![AutoEvo 安装结果状态机](assets/flowcharts/autoevo-install-outcomes.svg)](assets/flowcharts/autoevo-install-outcomes.html)

（点击图片打开交互版状态机。）

| 字段 / 结果 | 准确含义 | 你应该做什么 |
| --- | --- | --- |
| `installed: true` | 目标 profile 与审查来源匹配，且结果属于非失败完成态 | 继续看 `verified`、`loaded` 和 outcome |
| `loaded: true` | bundle 已在目标进程加载 | 不要因此直接宣称功能已验证 |
| `verified` | Host 的 `tool_roundtrip`（自动真实工具往返）覆盖预期工具并成功返回 | 可以把功能称为已验证 |
| `activated` | `bundle_activation`（无工具时的 bundle 加载检查）通过 | 在目标 profile 中实际调用功能 |
| `awaiting_user_test` | persistent `manual_runtime` 完成，Host 没有自动功能夹具 | 到真实客户端或 profile 试用一次 |
| `restartRequired: true` | 已有非失败结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` | 安装命令失败，且 profile 与可见 package target 都不存在 | 先诊断原因，再决定是否重试 |
| `recovery_required` | 安装、替换或清理的真实状态不能安全确定 | 走恢复流程，不要盲目重装或手删 |

AutoEvo 在目标 profile 的真实安装结果上分别记录 installed、loaded、activated 与 verified，不会用私有预检结果代替真实证据。

如果成功安装的是发现到的 GitHub 项目，最终结果还会给出 Host 从已审查来源链确认的项目地址，并礼貌邀请你在确实受益时点一个 Star。这只是对上游作者的署名与支持提示；AutoEvo 不会替你打开页面、登录或执行 Star，也不会在安装失败时展示该提示。

遇到 `activated` 或 `awaiting_user_test` 时，在安装目标 profile 中发起一个最小、可核验、无副作用的真实请求，并记录实际工具调用和结果。模型说“看起来成功”不等于 Host 的 `verified` 回执。

## 6. 诊断与恢复

只想知道哪里失败时，直接说：

> 检查这次失败的原因，先不要重试、安装或清理。

诊断是只读、有预算且脱敏的：不会自动重试，也不会把完整 stderr、凭据、私密路径或会话正文交给模型。

故障恢复绑定当前 sealed interrupt。根据 Agent 提供的合法选项，用新消息确认对账、清理或重试；不要手工拼接旧 workflow、review 或 installation ID。

如果 pnpm 的 store 与目标 profile 已有依赖不一致，并且 Host 已确认目标插件根本没有装上，AutoEvo 会停在当前候选处，提供“先修复安装环境，再重试这个候选”的明确选项。确认后，Host 只在本次安装命令中复用该 profile 已记录的 store；不会把路径交给模型，也不会修改 profile 或全局 pnpm 配置。store 元数据变化、缺失或不可信时不会提供这条恢复路径。

已完成安装后想清理并重新开始是另一条流程，需要一条新的顶层消息：

> 清理这次已完成的安装，然后从头重新发现。

Host 会按该工作流拥有的 installation receipt 精确移除并重新开始，不会删除托管源码仓库。不要把已完成清理与故障恢复混用。

AutoEvo 对重复诊断、重复验证和修改次数设有限制。重复失败时会保留现有回执、比较新证据，由人决定下一步，不会原样循环同一安装或修复。

## 7. 卸载 AutoEvo

1. 在 DSH 的用户 preset 管理界面移除 **能力进化**。
2. 从安装它的同一个 profile 移除插件：

   ```powershell
   npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. 重启对应的 DSH profile。

注意这与 AutoEvo 的 `plugin_remove` 不同：后者按回执移除 AutoEvo 安装的第三方能力，不会卸载 AutoEvo 自身，也不会删除托管源码。

## 8. 安全与隐私提示

- GitHub README、源码、manifest 和仓库摘要都按不可信数据处理；审查结论以 Host 派生事实和内容 hash 为准。完整模型见[安全模型](security.md)。
- AutoEvo 的 finding 与建议是工作流证据，不是权限控制。DSH Core 决定是否允许操作；若允许，你可以明确接受带警告的候选，警告会保留在回执中。
- 安装的第三方插件最终以当前用户权限运行，隔离 profile 不是恶意代码沙箱。
- `forwardedCredentialEnv` 配置项只列出允许转发给被装能力的环境变量名，不包含取值。不要把密钥写进 prompt、文档、fixture 或仓库。
- 修改/创建的源码可能包含本机路径、账号或专有逻辑。贡献上游前应重新检查 diff，并单独取得 fork、push 或 PR 授权。

## 9. 常见问题

### 为什么同一条消息里不能选候选又直接安装？

候选选择和最终副作用决定是两道不同的确认门，中间的只读审查可能改变你对 fit、风险和兼容性的判断。

### 为什么 DSH 已经弹过 approval，还要我在聊天里确认？

聊天确认表达“做什么、对哪个候选做”；DSH approval 只批准一次具体副作用。二者不能互相替代。

### `activated` 算成功吗？

它是非失败完成态，表示 bundle 已加载，但还没有功能往返证据。你实际试用成功可以作为独立的运行时证据，但 Host 回执不会被改写成 `verified`。

### 工作区源码删了，已安装插件会坏吗？

不会。持久安装使用 AutoEvo 自己管理的不可变 artifact，不依赖工作区托管源码。

## 延伸阅读

- [开发者指南](developer-guide.md)
- [架构说明](architecture.md)
- [安全模型](security.md)
