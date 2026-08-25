# 安全模型

[使用指南](user-guide.md) · [开发者指南](developer-guide.md) · [架构说明](architecture.md) · [返回 README](../README.md)

## 1. 信任边界

可信输入是插件自身固定策略、DSH services、用户在当前任务中的明确批准，以及插件自己写入并重新读取的 receipt。

GitHub 仓库里的 README、源码、注释、manifest、Issue 或 PR 按数据分类。系统提示只含本插件固定策略。审查输出是来源路径、派生风险代码、短事实说明、blob/content hash、fit 和兼容性结论。

远端发现是 Host 自己的 scoped GitHub 搜索，不是第三方市场插件。AutoEvo 通过 argv-only `gh api` 查询 `topic:dsh-plugin`，描述和其它仓库文本都视为不可信数据。只有严格 `owner/repository` 标识会被归一化为候选，摘要长度受限，并且仓库名、名称、描述、topics 或 package name 必须覆盖需求的领域锚点。不安装 `dsh-find-plugin`，也不降级到无 topic 的全站搜索。空、畸形或明显无关结果视为没有可复用候选；`gh` 执行失败则发现未完成，不能发放创建权限。模型不得直接调用 `find_dsh_plugin` 或裸 `gh`。保留下来的候选都不能跳过下述审查与批准门槛。

## 2. 安装门槛

同时满足以下条件才进入安装：

1. 候选来自同一当前 Policy V9 resolution 的持久 review receipt；任何 policy 不匹配的 review 都不得授权；
2. Host hard boundaries：完整/非截断、可物化 snapshot，可识别的安全 package identity，不可变且安全的 installSpec/manifest bundle，可安装来源，没有 path/symlink/special-file/patch/sandbox/resource 逃逸，兼容性不是 explicitly incompatible；
3. 当 `needsSemanticReviewer` 为真时（`dynamic_evaluation` / `prompt_injection` / `hidden_instructions` / `data_exfiltration` / `credential_access`），必须有绑定当前 ReviewerRequest/review/requirementHash/snapshotDigest/candidateDigest/session/version 的 `approved` 裁决；缺失、过期、伪造、rejected、uncertain 一律 fail closed。`process_execution`、`fetch`/`fs`/`process.env`、普通 lifecycle、`fit !== full`、兼容 `unknown` 不启动 reviewer，也不单独取消 `use_this`。MechanicalFacts、recommendation、keyword fit、star count 只用于展示/召回/路由；
4. 新鲜认证用户 `use_this` 决定后，Host 铸造并保留 ActionCommitment（必要时 ExecutionLease）；reviewer/verifier 不能铸造授权，也不能把安装完成态升级为 `verified`；
5. GitHub 安装 spec 钉在 exact commit；本地来源绑定 lineage root commit、status 与除 `.git`/`node_modules` 外的完整文件集合；HEAD 必须是该 root 或其后代；
6. 安装前重新审查，材料一致；live Host `selectionReceipt` 与 `actionCommitment` 必须存在且结构哈希匹配；
7. live DSH approval 返回一次性的 `allowed-once`，只批准副作用，不代替用户决定。

symlink、特殊文件或截断的本地快照停在审查阶段。材料变化记为 `review_expired`。非 bundle 或 Host 判定不可物化仍不可直接安装。可修的 high 或 peer 不兼容仍可走 `modify_this`。

本地改进批准后复制到插件 owned snapshot，完整文件 hash 与 review 对齐；`npm pack --ignore-scripts` 生成 tgz 后再复核 snapshot，最终安装该 tgz。Windows 上 DSH rc.6 会经 shell 转发 pnpm 参数，owned artifact path 和卸载用 package name 都经过 shell 安全校验；移除前再校验一次 receipt 中的 package name。

批准理由包含 fit、风险、兼容性、生命周期脚本名称和最多八项派生 finding。

安全 finding 由静态 detector 产生。对 Agent 展示时按 `code + severity + detail` 合并同类 source/build 观察，同时保留全部来源和 evidence hash；持久 review 仍保存原始 finding，风险策略不降级。`process_execution` 只证明快照中存在进程 API 导入与调用模式，不证明命令目标、用途、必要性、实际运行或回调服务。Agent 必须把这些未建立语义明确说成未知，不能自行补理由。

## 2.1 父会话边界与托管源创建

- 父会话边界：真正的能力进化模式由 `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 的精确标记界定。父会话保留官方创造模式的活进程插件实验、runtime inspect、preset 创作与委托工具，只在 `tools/pre-execute` 上拒绝直接的 DSH plugin install/remove；Host 不再创建子 Agent，绝不回退 `code`。`create_new` / `modify_this` / 定向纠错在当前会话进行，cwd 绑定托管 git 源，源码副作用前预检父会话施工目录；施工阶段只允许托管源内文件读写、shell 测试、todo、官方创造技能和三个 `cordis_inspect_*`，并拒绝 Cordis mutation、嵌套委托、装卸、Git 写入、依赖变更与发布部署。Windows 上为完整性导向的部分隔离，不宣称机密性或网络隔离。
- 发现预算：能力发现用用户原话进入 `capability_workflow`；模型在 Host 限定的两轮补查、五个补充查询和二十候选预算内自主收敛，只能用 `capability_workflow_present` 密封发现池中的 1–5 个候选，空池不能生成候选。
- Gate 1/2 不可由 DSH approval 替代：Gate 1 只接受密封候选的新鲜用户选择，Gate 2 才接受安装、修改、新建或停止决定；`allowed-once` 只批准副作用，不代替用户决定。审查与安装仍要求当前 Policy V9 review 回执、匹配的不可变 install specification、Host commitment、真实新用户回合与防重放。
- 调用与修改上限：相同无效参数在同一回合重复时断路，且不消费 interrupt、commitment 或 lease。诊断工具仅在关联失败或搜索不完整后可用，每个失败事件最多两次调用、八个探针；不启动子进程、不重试、不清理，并屏蔽凭据、完整路径、URL、原始 stderr 和施工会话正文。同一 review / source / layer / fixture 不得重复安装或验证；modify 最多两次。

父回合取消后没有子 Agent 需要 dispose。清理 Git 使用独立的 bounded timeout，不继承已取消 signal；有界编辑先 checkpoint，再以 `recovery_required` 收口并释放 workflow lock；取消、超时与真实 executable 缺失分别报告。completed 安装的清理重开与 sealed `recovery_required` 是两条互不混同的路径。模型展示只包含版本化语义状态、定长事实、预算、硬约束、候选作用域动作和可用工具；市场描述与仓库内容始终标记为不可信数据，选择阶段误提交的 `use_this` 会安全归一化为只读审查。完整流程见[架构说明](architecture.md) §2 与 §4。

这意味着语义正确性明确依赖当前 LLM：弱模型可能把真实用户意图解释成另一个同样合法的 action 或候选。Host 保证授权完整性和作用域约束，不保证模型的语言理解正确；因此能力进化模式不得搭配低智力、上下文保持差或结构化工具调用不可靠的模型。

## 3. 进程与凭据

- 进程请求以 argv 数组发出。传给 Windows 上 DSH rc.6 pnpm 边界的安装 spec 只含通过元字符校验的值。
- `gh` 继承 `GH_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GH_HOST`；DSH 验证子进程默认只获得 `DSH_HOME`。
- 管理员可显式配置额外凭据环境变量名；receipt 与模型可见输出只保留变量名。
- Git 命令固定 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`。
- stdout、stderr、命令时间、候选数、文件数和读取总字节均有上限。失败时持久化/返回 stderr 的诊断 hash。
- 本地打包用 Node 直接运行 npm 的 JavaScript CLI。cache 与 temp 固定在 owned artifact root，成功后删除。

## 4. 验证证据

可信 observer 只记录 Host 侧的工具往返与完成轮 hash，不记录模型正文：

```json
{ "kind": "tool/call", "callId": "...", "name": "calculator" }
{ "kind": "tool/result", "callId": "...", "name": "calculator", "isError": false }
{ "kind": "task/result", "resultSha256": "...", "matchedExpectation": true }
```

不变量：机械验证完全由 Host 驱动；独立 semantic verifier 不能覆盖 Host 失败，也不能把 `activated` 或 `awaiting_user_test` 升级为 `verified`；`matchedExpectation` / `taskResultMatchedExpectation` 只保存为诊断布尔值，不得作为最终 `verified` 门槛。三层的执行条件与状态语义见[架构说明](architecture.md#4-数据与状态) §4 与 [§5](architecture.md#5-状态语义)。

## 5. 删除

临时目录由 `installationId` 唯一拥有。删除前对 trial root 与候选路径做 `realpath`，确认候选是 trials root 的严格子目录。删除使用 Node `rm`，对象是已经验证的精确路径。

外部安装前先持久化 `installState: unknown`、`installOutcome: pending` 的 provisional receipt。安装命令异常时，persistent Profile 只有在 dependency 与可见 package target 都不存在时才记 `failed_absent`；存在、未知或不可核实时记 `recovery_required`。安装命令成功后，还必须证明 Profile dependency 等于精确审查 spec 且 bundle 已启用，才执行 Loader/runtime 验证。最终 receipt 写入失败时，temporary trial 立即补偿删除；persistent Profile 保留 fail-closed recovery anchor。

## 6. Prompt Injection 与静态 detector

审查器把 prompt-injection-like 文本记成 `prompt_injection:block` 派生事实，并把风险升为 `high`。Agent 看到的是分类结果和 hash。

文本类规则（`hidden_instructions`、`prompt_injection`、`data_exfiltration`）覆盖全部 UTF-8 文件，包括 README、SKILL.md 与其它 markdown——文本文件是隐藏指令的经典载体；代码类规则只扫可执行源。finding detail 保持短语级，review receipt 不含源码文本。

既有代码：`child_process`、`process_execution`、`dynamic_evaluation`、`environment_access`、`filesystem_access`、`network_access`、`prompt_injection`、`lifecycle_script`、`non_registry_dependency`。Policy V9 新增：`hidden_instructions`（零宽/bidi/Unicode Tag 字符、注释藏指令、文本中的 data: URI 与超长 base64、NUL）、`data_exfiltration`（已知 webhook/隧道收集端点、外发对话或凭据的指令）、`credential_access`（凭据库路径、环境收割）、`obfuscated_code`（超长编码 blob 与同文件动态求值、混淆标识符）、`remote_code_execution`（下载即执行）、`tls_verification_disabled`、`destructive_operation`、`persistence_mechanism`、`cloud_metadata_access`。语义审查门禁代码为 `prompt_injection`、`hidden_instructions`、`data_exfiltration`、`credential_access` 与 `dynamic_evaluation`。新增检测的思路部分受 NVIDIA SkillSpector（Apache 2.0）启发；规则与正则均为 AutoEvo 独立重实现。

## 7. 运行假设

- 隔离的 DSH home/profile 只隔离配置与依赖；获准安装的包仍以当前用户权限运行。
- 启发式扫描覆盖常见 lifecycle、registry 之外的依赖、进程/网络/文件系统/环境访问、动态求值、prompt injection、隐藏指令、数据外发、凭据访问、混淆代码与云元数据信号，供安装决策使用。
- MechanicalFacts 的 static high risk / keyword 命中只作展示与是否启动 semantic reviewer 的路由；直接安装由 Host hard boundaries、绑定的 reviewer 裁决和新鲜用户 `use_this` 决定。可修 high 仍可走 `modify_this`。安装完成后的功能是否已验证只看 Host 三层结果，不看 reviewer/verifier。
- `contributionAdvice.eligible` 表示可以建议贡献。提交前由人工或 Agent 检查实际 diff，清理用户路径、账号、私有地址、密钥和专有逻辑，并再次取得用户明确批准。
- 内部托管源 commit 由 Host 在禁用 hooks/签名后本地完成；任何 fork、push、tag、release 或上游 PR 都属于后续发布动作，仍需另行明确批准。
