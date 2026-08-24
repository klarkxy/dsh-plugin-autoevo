# AutoEvo 使用指南

[English](user-guide.en.md) | 中文 · [返回 README](../README.md)

本指南面向在 DSH 中发现、安装、修改或创建能力的使用者。能力进化是官方创造模式的超集：活进程插件实验、runtime inspect、preset 创作和委托工具都还在；社区复用、审查、安装与升级由 AutoEvo 治理。它解释你需要做的选择、AutoEvo 能证明什么，以及失败后怎样安全恢复。内部 Policy、数据结构和代码入口分别见[架构说明](architecture.md)与[开发者指南](developer-guide.md)。

## 1. 使用前准备

- 可安装发布版 AutoEvo `v0.5.1`；仓库中的 `0.5.3` 尚未发布。
- Node.js `>=22.19.0 || >=24.0.0`。
- 一个可正常运行的 DSH profile；本文以 `web` 为例。
- 需要查找或审查 GitHub 插件时，建议安装 GitHub CLI，并确保 `gh auth status` 正常。
- 使用具备可靠指令遵循、上下文保持和结构化工具调用能力的模型。

先确认要把插件装进哪个 profile。安装命令中的 `--profile web` 必须与实际使用的 profile 一致；不要为了照抄示例把测试 profile 误当成日常 profile。

## 2. 安装、升级与首次加载

安装稳定版本：

```powershell
dsh plugin --profile web add --save-exact github:klarkxy/dsh-plugin-autoevo#v0.5.1
```

安装或升级 AutoEvo 后，重启该 DSH profile，让新 bundle 生效。`restartRequired: true` 是 AutoEvo 已经运行后安装其它能力时的结果字段，不是安装 AutoEvo 自身的免重启保证。

安装成功后，DSH 的用户 preset 列表中会出现 **能力进化**（id `evolution`，界面通常标记为自定义）。AutoEvo 只升级自己管理且未被修改的 preset；同名外来目录或用户改过的内容会被保留并提示诊断。

如果不想让 AutoEvo 安装或升级 preset，可将配置项 `evolutionPreset` 设为 `false`。这只会停止后续物化，不会删除已经存在的 preset。

## 3. 第一次完整使用

### 3.1 发起需求

在新的或空白 DSH 会话中选择 **能力进化**，然后直接描述目标：

> 我需要一个能做科学计数法计算的 DSH 插件。先查现成的。

AutoEvo 先检查当前 Agent 能看到的本地工具、技能和桥接能力；不足时再使用插件市场发现。若 `dsh-find-plugin` 尚未安装，AutoEvo 会单独请求一次 DSH approval 来安装它。这个 approval 只允许市场工具安装，不等于你选择了任何候选。

### 3.2 第一道确认门：选候选去审查

Agent 可以在有界预算内补充查询，然后密封 1–5 个候选。此时只需要选择想进一步审查的候选，例如：

- “先看第二个。”
- “按你推荐的那个审查。”
- “这几个都不合适，继续找。”

这一步是只读选择，不会安装、修改或新建。如果候选身份或差异会实质改变选择，Agent 可以先问一个精确问题。

### 3.3 第二道确认门：审查后决定结果

Host 审查候选的精确来源、manifest、必要源码、兼容性和安全事实。审查完成后，再用一条新的聊天消息明确决定：

- 原样复用本地已有能力；
- 安装已审查候选；
- 在候选或已安装来源上修改；
- 没有合适候选时从零创建；
- 继续搜索；
- 停止。

自然语言就是正式决定，不需要输入 `use_this`、`modify_this` 等内部 action。Host 会验证这条回复是否来自当前真实回合、是否绑定当前候选与审查；涉及副作用时还会再请求 DSH 一次性 approval。

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

### 4.2 安装完整候选

只有绑定当前 Policy、来源不可变、兼容性可接受、审查 fit 完整且安全门槛通过的候选，才会提供直接安装。持久安装会进入实际目标 profile；临时安装只适用于 Host 能自动验证的层。

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

任何确认门都可以明确停止。停止不会被当成安装或创建授权；DSH approval 也不能代替“停止/继续”的真实选择。

## 5. 结果状态与下一步

### 安装回执字段

| 字段 / 结果 | 准确含义 | 你应该做什么 |
| --- | --- | --- |
| `installed: true` | Host 证明目标 profile 与审查来源匹配，且结果属于非失败完成态 | 继续看 `verified`、`loaded` 和 outcome |
| `loaded: true` | Host 证明 bundle 已在目标进程加载 | 不要因此直接宣称功能已验证 |
| `verified` / `verified: true` | Host 的 `tool_roundtrip` 覆盖预期工具并成功返回 | 可以把功能称为已验证 |
| `activated` | `bundle_activation` 通过，只证明 Loader/Fiber 收口 | 在目标 profile 中实际调用功能 |
| `awaiting_user_test` | persistent `manual_runtime` 完成，Host 没有自动功能夹具 | 到真实客户端或 profile 试用一次 |
| `restartRequired: true` | 已有非失败结果，但当前进程没有完整热加载 | 重启对应 profile 后再试 |
| `failed_absent` | 安装命令失败，且 profile 与可见 package target 都不存在 | 先诊断原因，再决定是否重试 |
| `recovery_required` | 安装、替换或清理的真实状态不能安全确定 | 走恢复流程，不要盲目重装或手删 |

隔离 `headless` 预检只证明已审查字节能在隔离 Loader 中收口。它不等于目标 profile 已加载，也不等于真实客户端工具调用成功。

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

这是另一条流程。用新的顶层消息明确说：

> 清理这次已完成的安装，然后从头重新发现。

Host 会按该工作流拥有的 installation receipt 精确移除并重新开始。它不会删除托管源码仓库。不要把 completed cleanup 与故障 interrupt 混用。

### 重复失败

AutoEvo 对重复诊断、重复验证和修改次数设有限制。重复失败时应保留现有回执，比较新证据，并让人决定下一步；不要原样循环同一安装或修复。

## 7. 卸载 AutoEvo

1. 在 DSH 的用户 preset 管理界面移除 **能力进化**。
2. 从安装它的同一个 profile 移除依赖：

   ```powershell
   dsh plugin --profile web remove dsh-plugin-autoevo
   ```

3. 重启对应的 DSH profile。

这与 AutoEvo 的 `plugin_remove` 不同：后者按 receipt 移除 AutoEvo 安装的第三方能力，不会卸载 AutoEvo 自身，也不会删除托管源码。

## 8. 安全与隐私提示

- GitHub README、源码、manifest 和市场摘要都按不可信数据处理；审查结论来自 Host 派生事实和内容 hash。
- 安装第三方插件最终会让其以当前用户权限运行。隔离 profile 不是恶意代码沙箱。
- `forwardedCredentialEnv` 只配置允许转发的环境变量名；不要把密钥写进 prompt、文档、fixture 或仓库。
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

### 在哪里看可复现路径？

见[真实样例目录](real-world-samples.md)。请保留其中 `real-live-passed`、`implemented`、`planned` 的证据等级，不要把计划样例写成已经线上验证。

## 延伸阅读

- [开发者指南](developer-guide.md)
- [架构说明](architecture.md)
- [安全模型](security.md)
- [真实样例目录](real-world-samples.md)
