# AutoEvo 使用指南

[English](user-guide.en.md) | 中文 · [返回 README](../README.md)

本指南面向在 DSH 中发现、安装、修改或创建能力的使用者。**能力进化** 使用 Search-first 工作流：临时实验与正式需求走同一流程。AutoEvo 负责流程、警告与证据回执；DSH Core 负责权限、sandbox 和 approval 的实际执行。它解释你需要做的选择、AutoEvo 能证明什么，以及失败后怎样恢复。

## 1. 使用前准备

- 目标稳定版 AutoEvo `v1.0.0`；tag 和 Release 由维护者在验收后另行发布。
- Node.js `^22.19.0 || ^24.0.0`。
- 一个可正常运行的 DSH profile；本文以 `web` 为例。
- 需要查找或审查 GitHub 插件时，建议安装 GitHub CLI，并确保 `gh auth status` 正常。
- 使用具备可靠指令遵循、上下文保持和结构化工具调用能力的模型。

先确认要把插件装进哪个 profile。安装命令中的 `--profile web` 必须与实际使用的 profile 一致；不要为了照抄示例把另一个 profile 误当成日常 profile。

## 2. 安装、升级与首次加载

安装 [§1](#1-使用前准备) 所列的发布版本（通过 npx 运行 DSH，无需全局安装；注意命令必须带 `@deepseek-ai/` 前缀，npm 上无 scoped 的 `dsh` 是无关项目）：

```powershell
npx @deepseek-ai/dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v1.0.0
```

安装或升级 AutoEvo 后，重启该 DSH profile，让新 bundle 生效。结果字段 `restartRequired` 的含义见[结果状态与下一步](#5-结果状态与下一步)。

安装成功后，在 DSH 的用户 preset 列表中查找 id 为 `evolution` 的 preset（显示名为 **能力进化**）。AutoEvo 只升级自己管理且未被修改的 preset；同名外来目录或用户改过的内容会被保留并提示诊断。

如果不想让 AutoEvo 安装或升级 preset，可将配置项 `evolutionPreset` 设为 `false`。这只会停止后续物化，不会删除已经存在的 preset。

## 3. 第一次完整使用

### 3.1 发起需求

在新的或空白 DSH 会话中选择 **能力进化**，然后直接描述目标：

> 我需要一个能同步项目记录的 DSH 插件。先查现成的。

Host 原样保存这条顶层消息。需求足够明确时直接搜寻；只有实质歧义会改变搜寻分类时，Agent 才能先澄清一次。澄清回答只影响只读搜寻，不授予选择、创建、修改或安装权限。

### 3.2 第一道确认门：选候选去审查

Agent 可以在有界预算内补充查询，然后密封 1–5 个候选。此时只需要选择想进一步审查的候选，例如：

- “先看第二个。”
- “按你推荐的那个审查。”
- “这几个都不合适，继续找。”

这一步是只读选择，不会安装、修改或新建。搜寻结果可以为空；此时只显示继续搜寻、创建新能力或停止，而“创建”仍需要新的顶层消息确认。

### 3.3 第二道确认门：审查后决定结果

Host 审查候选的精确来源、manifest、必要源码、兼容性和安全事实。审查完成后，再用一条新的聊天消息明确决定：

- 原样复用本地已有能力；
- 安装已审查候选；
- 在候选或已安装来源上修改；
- 没有合适候选时从零创建；
- 继续搜索；
- 停止。

自然语言即可，它表达你的工作流决定，不需要输入内部 action 名称。Host 将回复绑定到当前回合、候选与审查；实际副作用仍由 DSH Core 的权限与一次性 approval 执行，AutoEvo 不把流程回执当作权限授权。

```text
需求
  ↓
发现池与补查
  ↓
密封 1–5 个候选
  ↓  第一道门：选择要审查的候选
只读审查
  ↓  第二道门：使用 / 修改 / 创建 / 继续搜索 / 停止
安装或托管源码施工
  ↓
Host 验证与结果回执
```

## 4. 常见任务

### 4.1 原样使用本地能力

如果本地工具或技能已经满足需求，可以直接选择复用。这是正常终态：不会审查远端仓库，也不会产生安装物。

### 4.2 安装已审查候选

只要当前 Policy 的 review 能明确识别来源、目标包和有效安装描述，就可以把安装入口交给用户决定。fit、兼容性（包括明确不兼容）、生命周期脚本、代码风险和 reviewer 意见会作为 warning 与建议展示，不会自行隐藏安装入口；无法物化的来源才需要先修复。用户采用的能力一律持久安装到目标 profile。生命周期脚本与包管理器行为由 DSH 的正常权限、sandbox 和 approval 规则处理，AutoEvo 不另建私有预检 profile。

### 4.3 修改候选或已安装能力

当候选只差一点、已安装插件需要升级，或历史失败来源需要修复时，选择“在这个来源上修改”。AutoEvo 会：

1. 验证精确上游或历史托管来源；
2. 在当前会话工作区的 `.autoevo/sources/` 中准备 Host 托管 Git 源；
3. 让当前能力进化会话可见地编辑和运行检查；
4. 由 Host 提交、重新审查并冻结；
5. 等待你再次确认是否安装。

AutoEvo 不会为这一步启动隐藏子 Agent。历史失败或已移除来源在修复后按新的首次安装处理；只有 profile 中真实存在且来源精确匹配的插件才走 replacement。

### 4.4 从零创建

只有发现过程完整且没有合适候选，并且你在第二道门明确选择创建时，才会建立托管脚手架。创建同样发生在当前会话可见的托管源中，完成检查和本地审查后还要再次确认安装。

### 4.5 停止

任何确认门都可以明确停止。停止不会被当成安装或创建授权，DSH approval 也不能覆盖这个决定。聊天确认与 DSH approval 的分工见[常见问题](#9-常见问题)。

### 4.6 版本、领养与上游更新

AutoEvo 为每个包保留安装回执链。四个配套工具：

- `capability_versions`：按包名列出 Host 记录的版本链，标出当前 live 版本与产物可用性，只读。
- `capability_rollback`：回滚到该包的某个历史版本（缺省为直接前任）。走标准审查来源重装路径，仍需 DSH 一次性批准；没有关联审查的领养回执不能作为回滚目标。
- `capability_adopt`：不带参数时扫描当前 profile 中未登记的已装插件；带 `package_name` 时把其中一个登记为领养回执，之后可被版本与更新工具追踪。领养回执没有审查记录，`verified` 为 false。
- `capability_updates`：对精确 GitHub pin 的安装只读对比上游默认分支头部 commit 与最新 release，报告是否有更新。升级本身仍走 §4.3 的修改流程。

## 5. 结果状态与下一步

### 安装回执字段

| 字段 / 结果 | 准确含义 | 你应该做什么 |
| --- | --- | --- |
| `installed: true` | Host 证明目标 profile 与审查来源匹配，且结果属于非失败完成态 | 继续看 `verified`、`loaded` 和 outcome |
| `loaded: true` | Host 证明 bundle 已在目标进程加载 | 不要因此直接宣称功能已验证 |
| `verified` / `verified: true` | Host 的 `tool_roundtrip`（自动真实工具往返）覆盖预期工具并成功返回 | 可以把功能称为已验证 |
| `activated` | `bundle_activation`（无工具时的 bundle 加载检查）通过，只证明 Loader/Fiber 收口 | 在目标 profile 中实际调用功能 |
| `awaiting_user_test` | persistent `manual_runtime`（留给你人工运行验证）完成，Host 没有自动功能夹具 | 到真实客户端或 profile 试用一次 |
| `restartRequired: true` | 已有非失败结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` | 安装命令失败，且 profile 与可见 package target 都不存在 | 先诊断原因，再决定是否重试 |
| `recovery_required` | 安装、替换或清理的真实状态不能安全确定 | 走恢复流程，不要盲目重装或手删 |

AutoEvo 在目标 profile 的真实安装结果上分别记录 installed、loaded、activated 与 verified；不会用私有预检结果代替目标 profile 或真实工具往返证据。

### 人工功能验证

遇到 `activated` 或 `awaiting_user_test` 时，在安装目标 profile 中发起一个最小、可核验、无副作用的真实请求。记录实际工具调用和结果；不要把模型说“看起来成功”当作 Host 的 `verified` 回执。

## 6. 诊断与恢复

### 只想知道哪里失败

可以直接说：

> 检查这次失败的原因，先不要重试、安装或清理。

AutoEvo 的诊断是只读、有预算且脱敏的：不会自动重试，不会把完整 stderr、凭据、私密路径或会话正文交给模型。

### 故障中的 `recovery_required`

故障恢复绑定当前 sealed interrupt。根据 Agent 提供的合法选项，用新的消息确认对账、清理或重试；不要手工拼接旧 workflow、review 或 installation ID。

### 已完成安装后清理并重新开始

这是另一条流程。同样可以直接说，但要用一条新的顶层消息：

> 清理这次已完成的安装，然后从头重新发现。

Host 会按该工作流拥有的 installation receipt 精确移除并重新开始。它不会删除托管源码仓库。不要把 completed cleanup 与故障 interrupt 混用。

### 重复失败

AutoEvo 对重复诊断、重复验证和修改次数设有限制。重复失败时应保留现有回执，比较新证据，并让人决定下一步；不要原样循环同一安装或修复。

## 7. 卸载 AutoEvo

1. 在 DSH 的用户 preset 管理界面移除 **能力进化**。
2. 从安装它的同一个 profile 移除依赖：

   ```powershell
   npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. 重启对应的 DSH profile。

这与 AutoEvo 的 `plugin_remove` 不同：后者按 receipt 移除 AutoEvo 安装的第三方能力，不会卸载 AutoEvo 自身，也不会删除托管源码。

## 8. 安全与隐私提示

- 信任边界与审查证据的完整模型见[安全模型](security.md)：GitHub README、源码、manifest 和市场摘要都按不可信数据处理，审查结论以 Host 派生事实和内容 hash 为准。
- AutoEvo 的 finding 与建议是工作流证据，不是 sandbox 或权限控制。DSH Core 决定是否允许操作；若允许，用户可以明确接受带 warning 的候选，warning 会保留在回执中。
- 安装第三方插件最终会让其以当前用户权限运行。隔离 profile 不是恶意代码沙箱。
- `forwardedCredentialEnv` 是 AutoEvo 的配置项，只列出允许转发给被装能力的环境变量名，不包含取值。不要把密钥写进 prompt、文档、fixture 或仓库。
- 修改/创建源码可能包含本机路径、账号或专有逻辑。贡献上游前应重新检查 diff，并单独取得 fork、push 或 PR 授权。

## 9. 常见问题

### 为什么同一条消息里不能选候选又直接安装？

候选选择和最终副作用决定是两道不同确认门。中间的只读审查可能改变你对 fit、风险和兼容性的判断。

### 为什么 DSH 已经弹过 approval，还要我在聊天里确认？

聊天确认表达“做什么、对哪个候选做”；DSH approval 只允许一次具体副作用。二者不能互相替代。

### `activated` 算成功吗？

它是非失败完成态，表示 bundle 已加载；但还没有功能往返证据。实际试用成功可以作为独立运行时证据，Host 回执仍不会被模型擅自改写成 `verified`。

### 工作区源码删了，已安装插件会坏吗？

不会。持久安装使用 AutoEvo 自己管理的不可变 artifact，不依赖工作区托管源码。

## 延伸阅读

- [开发者指南](developer-guide.md)
- [架构说明](architecture.md)
- [安全模型](security.md)
