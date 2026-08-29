# 安全模型

[使用指南](user-guide.md) · [开发者指南](developer-guide.md) · [架构说明](architecture.md) · [返回 README](../README.md)

## 1. 信任边界

可信输入只有四类：插件自身固定策略、DSH services、用户在当前任务中的明确批准，以及插件自己写入并重新读取的 receipt。AutoEvo 产出工作流证据与风险警告；它不拥有也不替代 DSH Core 的权限、sandbox 或 approval 强制执行。

GitHub 仓库里的 README、源码、注释、manifest、Issue 或 PR 一律按不可信数据处理。系统提示只含本插件固定策略。审查输出是来源路径、派生风险代码、短事实说明、blob/content hash、fit 和兼容性结论。

远端发现是 Host 自己的 scoped GitHub 搜索，不是第三方市场插件：

- 通过 argv-only `gh api` 查询 `topic:dsh-plugin`；不安装 `dsh-find-plugin`，也不降级到无 topic 的全站搜索。
- 只有严格 `owner/repository` 标识且客观可用的非 archived、非 fork、非 disabled 仓库会被归一化为候选，摘要长度受限并去重；语义相关性由 Agent 判断，不是 Host 淘汰条件。
- Host 只为 Agent 密封的 1–5 个候选读取有界的根 package、README 与 DSH manifest 预览；外部文本始终作为不可信数据展示。
- 空、畸形或明显无关结果视为没有可复用候选；`gh` 执行失败则发现未完成，不能发放创建权限。
- 模型不得直接调用 `find_dsh_plugin` 或裸 `gh`。

保留下来的候选都不能跳过下述审查与批准门槛。

## 2. 安装门槛

下列是 AutoEvo 的工作流和证据条件，不是独立安全边界。DSH Core 决定一个操作是否可执行；若 DSH Core 允许，用户可以明确接受警告，AutoEvo 会把该警告和选择保留在 receipt 中。

同时满足以下条件才进入安装流程：

1. 候选来自同一当前 Policy resolution 的持久 review receipt；任何 Policy 不匹配的 review 都不得授权；
2. Host 只阻断无法正确安装目标的机械问题：来源或包身份不明确、snapshot 不完整或不可物化、installSpec 与审查来源不一致、bundle manifest 无效或明显路径越界；
3. `needsSemanticReviewer` 只表示值得请求第二意见。reviewer 缺失、超时、`rejected` 或 `uncertain` 会作为警告展示，不会自行取消安装入口，也不能授予执行权。生命周期脚本、进程/网络/文件访问、兼容性未知、fit 与 recommendation 同样是给人类和 LLM 的事实与建议；
4. 新鲜认证用户 `use_this` 决定后，Host 铸造并保留 ActionCommitment（必要时 ExecutionLease）；reviewer/verifier 不能铸造授权，也不能把安装完成态升级为 `verified`；
5. GitHub 安装 spec 钉在 exact commit；本地来源绑定 lineage root commit、status 与除 `.git`/`node_modules` 外的完整文件集合；HEAD 必须是该 root 或其后代；
6. 安装前重新审查，材料一致；live Host `selectionReceipt` 与 `actionCommitment` 必须存在且结构哈希匹配；
7. live DSH approval 返回一次性的 `allowed-once`，只批准副作用，不代替用户决定。

symlink、特殊文件或截断的本地快照停在审查阶段；材料变化记为 `review_expired`；非 bundle 或 Host 判定不可物化仍不可直接安装。风险高、脚本存在、兼容性未知或明确不兼容、reviewer 无法判断时，用户仍可在看到摘要后选择使用、修改或跳过。

本地改进批准后复制到插件 owned snapshot，完整文件 hash 与 review 对齐；冻结 tgz 后再复核 snapshot，最终安装该 tgz。生命周期与构建脚本按 DSH 和包管理器的正常规则执行，AutoEvo 只在事前展示并在失败时返回结构化阶段、摘要、可重试性与修复建议，不静默修改 profile 的构建白名单。

批准理由包含 fit、风险、兼容性、生命周期脚本名称和最多八项派生 finding。

安全 finding 由静态 detector 产生。对 Agent 展示时按 `code + severity + detail` 合并同类 source/build 观察，同时保留全部来源和 evidence hash；持久 review 仍保存原始 finding，风险策略不降级。`process_execution` 只证明快照中存在进程 API 导入与调用模式，不证明命令目标、用途、必要性、实际运行或回调服务。Agent 必须把这些未建立语义明确说成未知，不能自行补理由。

## 2.1 父会话边界与托管施工

- 父会话边界：能力进化模式由 `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 的精确标记界定。AutoEvo 将 `create_new` / `modify_this` 与 workflow、user turn、boot identity 和托管根绑定；父会话只负责决定、展示与 Host 工具调用，不在托管根内直接写文件或运行施工 shell。
- 发现预算：能力发现用用户原话进入 `capability_workflow`；模型在 Host 限定的两轮补查、五个补充查询和二十候选预算内自主收敛，只能用 `capability_workflow_present` 密封发现池中的 1–5 个候选，空池不能生成候选。
- 两道确认门不可由 DSH approval 替代：Gate 1 只接受密封候选的新鲜用户选择，Gate 2 才接受安装、修改、新建或停止决定；`allowed-once` 只批准副作用，不代替用户决定。澄清回答只影响只读搜寻，不是 Gate 2。审查与安装仍要求当前 Policy review 回执、匹配的不可变 install specification、Host commitment、真实新用户回合与防重放。
- 施工边界：相同无效参数在同一回合重复时断路，且不消费 interrupt 或 commitment。诊断输出屏蔽凭据、完整路径与原始 stderr。创建或修改获批后，Host 创建独立子会话，其不可变 `session.header.cwd` 与 DSH `workspace-write` 根都精确指向单个 managed source；首个模型步骤前还要验证父子归属、系统级 Creator preset、工具目录和真实文件/shell 越界探针。子会话只能在该根内编辑并运行有界构建/测试，不能更换目标、安装插件、修改 profile、发布、提交 Git 或嵌套委派；Host 随后无 hook 提交、重审与冻结。

取消、超时与真实 executable 缺失分别报告。普通构建或安装失败保持可诊断、可修复；只有安装对象无法唯一对账时才进入 `recovery_required`。completed 安装的清理重开与 sealed failure 恢复是两条互不混同的路径。模型展示只包含版本化语义状态、定长事实、候选作用域动作和可用工具；仓库描述与内容始终标记为不可信数据，选择阶段误提交的 `use_this` 会安全归一化为只读审查。完整流程见[架构说明](architecture.md) §2 与 §4。

语义正确性明确依赖当前 LLM：弱模型可能把真实用户意图解释成另一个同样合法的 action 或候选。Host 保证授权完整性和作用域约束，不保证模型的语言理解正确；因此能力进化模式不得搭配低智力、上下文保持差或结构化工具调用不可靠的模型。

## 3. 进程与凭据

- 进程请求以 argv 数组发出。传给 Windows 上 DSH pnpm 边界的安装 spec 只含通过元字符校验的值。
- `gh` 继承 `GH_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GH_HOST`；DSH 验证子进程默认只获得 `DSH_HOME`。
- 管理员可显式配置额外凭据环境变量名；receipt 与模型可见输出只保留变量名。
- Git 命令固定 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`。
- stdout、stderr、命令时间、候选数、文件数和读取总字节均有上限。失败时持久化/返回 stderr 的诊断 hash。
- 本地打包只允许真实 `node`/`node.exe` 解释 npm 的 JavaScript CLI；Desktop/Electron 宿主可执行文件不能代替 Node。npm cache 与 temp 固定在 owned artifact root，成功后删除。
- GitHub 精确 commit 的 Git 对象缓存位于工作区 `.autoevo/cache/git`，按仓库加锁并校验 bare/origin/commit；它只是可重建传输层。安装仍只接受 stateDir owned root 中已审查并复算 SHA-256 的 tgz。

## 4. 验证证据

可信 observer 只记录 Host 侧的工具往返与完成轮 hash，不记录模型正文：

```json
{ "kind": "tool/call", "callId": "...", "name": "calculator" }
{ "kind": "tool/result", "callId": "...", "name": "calculator", "isError": false }
{ "kind": "task/result", "resultSha256": "...", "matchedExpectation": true }
```

不变量：机械验证完全由 Host 驱动；独立 semantic verifier 不能覆盖 Host 失败，也不能把 `activated` 或 `awaiting_user_test` 升级为 `verified`；`matchedExpectation` / `taskResultMatchedExpectation` 只保存为诊断布尔值，不得作为最终 `verified` 门槛。三层的执行条件与状态语义见[架构说明 §4](architecture.md#4-数据与状态) 与 [§5](architecture.md#5-状态语义)。

## 5. 删除

临时目录由 `installationId` 唯一拥有。删除前对 trial root 与候选路径做 `realpath`，确认候选是 trials root 的严格子目录。删除使用 Node `rm`，对象是已经验证的精确路径。

外部安装前先持久化 `installState: unknown`、`installOutcome: pending` 的 provisional receipt。安装命令异常时，persistent Profile 只有在 dependency 与可见 package target 都不存在时才记 `failed_absent`；存在、未知或不可核实时记 `recovery_required`。安装命令成功后，还必须证明 Profile dependency 等于精确审查 spec 且 bundle 已启用，才执行 Loader/runtime 验证。最终 receipt 写入失败时，persistent Profile 保留恢复锚点，并向 LLM 提供可理解的恢复诊断。

## 6. Prompt Injection 与静态 detector

审查器把 prompt-injection-like 文本记成派生事实并提高风险。Agent 看到的是分类结果和 hash；这是警告，不是 DSH 权限结论。

文本类规则（`hidden_instructions`、`prompt_injection`、`data_exfiltration`）覆盖全部 UTF-8 文件，包括 README、SKILL.md 与其它 markdown——文本文件是隐藏指令的经典载体；代码类规则只扫可执行源。finding detail 保持短语级，review receipt 不含源码文本。

检测项包括 `child_process`、`process_execution`、`dynamic_evaluation`、`environment_access`、`filesystem_access`、`network_access`、`prompt_injection`、`lifecycle_script`、`non_registry_dependency`、隐藏指令、数据外发、凭据访问、混淆代码、下载执行、关闭 TLS 校验、破坏性操作、持久化机制与云元数据访问。部分高歧义信号会请求 semantic reviewer 给出第二意见；它们不会把 reviewer 变成门禁。新增检测的思路部分受 NVIDIA SkillSpector（Apache 2.0）启发；规则与正则均为 AutoEvo 独立重实现。

## 7. 运行假设

- 隔离的 DSH home/profile 只隔离配置与依赖；获准安装的包仍以当前用户权限运行。
- 启发式扫描的检测项见 §6；结果供安装决策使用，不构成权限结论。
- MechanicalFacts 的 static high risk / keyword 命中只作展示与是否启动 semantic reviewer 的路由；它们是警告和决策证据，不会自行控制 DSH Core 权限。可修 high 仍可走 `modify_this`，且 DSH Core 允许时用户可明确接受警告。安装完成后的功能是否已验证只看 Host 三层结果，不看 reviewer/verifier。
- `contributionAdvice.eligible` 表示可以建议贡献。提交前由人工或 Agent 检查实际 diff，清理用户路径、账号、私有地址、密钥和专有逻辑，并再次取得用户明确批准。
- 内部托管源 commit 由 Host 在禁用 hooks/签名后本地完成；任何 fork、push、tag、release 或上游 PR 都属于后续发布动作，仍需另行明确批准。
