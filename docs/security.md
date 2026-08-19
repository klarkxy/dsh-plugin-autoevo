# 安全模型

## 1. 信任边界

可信输入是插件自身固定策略、DSH services、用户在当前任务中的明确批准，以及插件自己写入并重新读取的 receipt。

GitHub 仓库里的 README、源码、注释、manifest、Issue 或 PR 按数据分类。系统提示只含本插件固定策略。审查输出是来源路径、派生风险代码、短事实说明、blob/content hash、fit 和兼容性结论。

`find_dsh_plugin` 是可选的第三方发现后端，不是信任根。AutoEvo 只在它对当前 Agent registry scope 可见时经 DSH nested tool pipeline 调用；返回的 note、描述和安装命令都视为不可信数据。只有严格 GitHub 仓库 URL 会被归一化为候选标识，摘要长度受限，并且仓库名、名称、描述、topics 或 package name 必须覆盖需求的领域锚点。市场未安装时，不降级到裸 `gh` 搜索，也不把市场仓库送进能力审查。AutoEvo 只对固定包名 `dsh-find-plugin` 申请一次性批准并用 `dsh plugin add --save-exact` 安装。市场已装后的空、畸形或明显无关结果视为没有可复用候选；执行失败则发现未完成，不能发放创建权限。保留下来的候选都不能跳过下述审查与批准门槛。

## 2. 安装门槛

同时满足以下条件才进入安装：

1. 候选来自同一当前 Policy V5 resolution 的持久 review receipt；旧 policy review 可读但不得授权；
2. Host hard boundaries：完整/非截断、可物化 snapshot，可识别的安全 package identity，不可变且安全的 installSpec/manifest bundle，可安装来源，没有 path/symlink/special-file/patch/sandbox/resource 逃逸，兼容性不是 explicitly incompatible；
3. 当 `needsSemanticReviewer` 为真时，必须有绑定当前 ReviewerRequest/review/requirementHash/snapshotDigest/candidateDigest/session/version 的 `approved` 裁决；缺失、过期、伪造、rejected、uncertain 一律 fail closed。MechanicalFacts、recommendation、keyword fit、star count、静态 high risk 只用于展示/召回/路由，不能单独取消 `use_this` 或让 installer 拒绝本可安装的候选；
4. 新鲜认证用户 `use_this` 决定后，Host 铸造并保留 ActionCommitment（必要时 ExecutionLease）；reviewer/verifier 不能铸造授权；
5. GitHub 安装 spec 钉在 exact commit；本地来源绑定 lineage root commit、status 与除 `.git`/`node_modules` 外的完整文件集合；HEAD 必须是该 root 或其后代；
6. 安装前重新审查，材料一致；live Host `selectionReceipt` 与 `actionCommitment` 必须存在且结构哈希匹配；
7. live DSH approval 返回一次性的 `allowed-once`，只批准副作用，不代替用户决定。

symlink、特殊文件或截断的本地快照停在审查阶段。材料变化记为 `review_expired`。非 bundle 或 Host 判定不可物化仍不可直接安装。可修的 high 或 peer 不兼容仍可走 `modify_this`。

本地改进批准后复制到插件 owned snapshot，完整文件 hash 与 review 对齐；`npm pack --ignore-scripts` 生成 tgz 后再复核 snapshot，最终安装该 tgz。Windows 上 DSH rc.6 会经 shell 转发 pnpm 参数，owned artifact path 和卸载用 package name 都经过 shell 安全校验；移除前再校验一次 receipt 中的 package name。

批准理由包含 fit、风险、兼容性、生命周期脚本名称和最多八项派生 finding。

安全 finding 由静态 detector 产生。对 Agent 展示时按 `code + severity + detail` 合并同类 source/build 观察，同时保留全部来源和 evidence hash；持久 review 仍保存原始 finding，风险策略不降级。`process_execution` 只证明快照中存在进程 API 导入与调用模式，不证明命令目标、用途、必要性、实际运行或回调服务。Agent 必须把这些未建立语义明确说成未知，不能自行补理由。

## 2.1 父会话边界与托管源创建

AutoEvo 父会话在 `tools/pre-execute` 与 monotonic guard 上拒绝 filesystem write/edit、shell、Cordis mutation/definition、agent/subagent/workflow 委托，以及直接的 DSH plugin install/remove。真正的能力进化模式仍由 `agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 的精确标记界定。

`create_new` / `modify_this` 只在 Host 拉起、cwd 绑定托管 git 源、sandbox 模式为 `workspace-write` 的子会话中继续。父会话不得 `cordis_define(kind:new)`。子会话再拒绝 AutoEvo 决策工具、Cordis mutation、嵌套委托、直接装卸与 git push/tag/release / gh pr。Windows 上为完整性导向的部分隔离，不宣称机密性或网络隔离。

父回合取消后，Host 通过 owned `AgentHandle.dispose()` 停止并 drain 子 Agent，不依赖创建阶段 signal。清理 Git 使用独立的 bounded timeout，不继承已取消 signal；有界编辑先 checkpoint，再以 `recovery_required` 收口并释放 workflow lock。取消、超时与真实 executable 缺失分别报告。

搜完或审完后不得用 `ask_user` 直接弹窗；必须先在对话里说明候选或审查结果。只读选择由 LLM 映射为快照 `navigation`；最终安装、修改、新建或停止由 LLM 解释新鲜用户回合并提交结构化 `decision`。简单 UI 主操作为 `use_this` / `search_more`；`modify_this` / `create_new` / `stop` 属于 advanced/recovery。Host 不再对用户措辞做关键词复核，但仍要求 action 属于当前 interrupt；`use_this` / `modify_this` 的 `candidate_id` 必须属于该 action 的当前候选集合，并精确绑定工作流中的 review。审查与安装仍要求当前 Policy V5 review 回执、匹配的不可变 install specification、Host commitment、真实新用户回合、防重放与 `allowed-once`。安装结果只有 `pending | verified | failed_absent | recovery_required`。未完成的旧 policy workflow 不得 resume 执行旧 interrupt/decision/receipt/verdict/commitment/lease。

这意味着语义正确性明确依赖当前 LLM：弱模型可能把真实用户意图解释成另一个同样合法的 action 或候选。Host 保证授权完整性和作用域约束，不保证模型的语言理解正确；因此能力进化模式不得搭配低智力、上下文保持差或结构化工具调用不可靠的模型。

## 3. 进程与凭据

- 进程请求以 argv 数组发出。传给 Windows 上 DSH rc.6 pnpm 边界的安装 spec 只含通过元字符校验的值。
- `gh` 继承 `GH_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GH_HOST`；DSH 验证子进程默认只获得 `DSH_HOME`。
- 管理员可显式配置额外凭据环境变量名；receipt 与模型可见输出只保留变量名。
- Git 命令固定 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`。
- stdout、stderr、命令时间、候选数、文件数和读取总字节均有上限。失败时持久化/返回 stderr 的诊断 hash。
- 本地打包用 Node 直接运行 npm 的 JavaScript CLI。cache 与 temp 固定在 owned artifact root，成功后删除。

## 4. 验证证据

可信 observer 记录：

```json
{ "kind": "tool/call", "callId": "...", "name": "calculator" }
{ "kind": "tool/result", "callId": "...", "name": "calculator", "isError": false }
{ "kind": "task/result", "resultSha256": "...", "matchedExpectation": true }
```

Host mechanical 核对 callId/name 匹配、结果成功、预期工具全部覆盖，并只接受 DSH `assistant/message` 后紧跟 `turn/end: completed` 的最终回答。没有 expected tools 的插件走 load 验证：子进程 `exit 0` 且观察到 completed-turn 最终回答即可。`matchedExpectation` / `taskResultMatchedExpectation` 只保存为诊断布尔值，不得作为最终 `verified` 门槛。最终回答只保存 SHA-256。独立 semantic verifier 在 mechanical 成功之后运行，绑定 evidence digest / session / version；timeout、cancel、late submit 与缺失 submit 均为 `uncertain`，不能覆盖 mechanical 失败。

## 5. 删除

临时目录由 `installationId` 唯一拥有。删除前对 trial root 与候选路径做 `realpath`，确认候选是 trials root 的严格子目录。删除使用 Node `rm`，对象是已经验证的精确路径。

外部安装前先持久化 `installState: unknown`、`installOutcome: pending` 的 provisional receipt。安装命令异常时，persistent Profile 只有在 dependency 与可见 package target 都不存在时才记 `failed_absent`；存在、未知或不可核实时记 `recovery_required`。安装命令成功后，还必须证明 Profile dependency 等于精确审查 spec 且 bundle 已启用，才执行 Loader/runtime 验证。最终 receipt 写入失败时，temporary trial 立即补偿删除；persistent Profile 保留 fail-closed recovery anchor。

## 6. Prompt Injection

审查器把 prompt-injection-like 文本记成 `prompt_injection:block` 派生事实，并把风险升为 `high`。Agent 看到的是分类结果和 hash。

## 7. 运行假设

- 隔离的 DSH home/profile 只隔离配置与依赖；获准安装的包仍以当前用户权限运行。
- 启发式扫描覆盖常见 lifecycle、registry 之外的依赖、进程/网络/文件系统/环境访问、动态求值与 prompt injection 信号，供安装决策使用。
- MechanicalFacts 的 static high risk / keyword 命中只作展示与是否启动 semantic reviewer 的路由；直接安装由 Host hard boundaries、绑定的 reviewer 裁决和新鲜用户 `use_this` 决定。可修 high 仍可走 `modify_this`。
- `contributionAdvice.eligible` 表示可以建议贡献。提交前由人工或 Agent 检查实际 diff，清理用户路径、账号、私有地址、密钥和专有逻辑，并再次取得用户明确批准。
- 内部托管源 commit 由 Host 在禁用 hooks/签名后本地完成；任何 fork、push、tag、release 或上游 PR 都属于后续发布动作，仍需另行明确批准。
