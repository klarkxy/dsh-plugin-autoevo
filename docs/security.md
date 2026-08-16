# 安全模型

## 1. 信任边界

可信输入是插件自身固定策略、DSH services、用户在当前任务中的明确批准，以及插件自己写入并重新读取的 receipt。

GitHub 仓库里的 README、源码、注释、manifest、Issue 或 PR 按数据分类。系统提示只含本插件固定策略。审查输出是来源路径、派生风险代码、短事实说明、blob/content hash、fit 和兼容性结论。

`find_dsh_plugin` 是可选的第三方发现后端，不是信任根。AutoEvo 只在它对当前 Agent registry scope 可见时经 DSH nested tool pipeline 调用；返回的 note、描述和安装命令都视为不可信数据。只有严格 GitHub 仓库 URL 会被归一化为候选标识，摘要长度受限，并且仓库名、名称、描述、topics 或 package name 必须覆盖需求的领域锚点。市场未安装时，不降级到裸 `gh` 搜索，也不把市场仓库送进能力审查。AutoEvo 只对固定包名 `dsh-find-plugin` 申请一次性批准并用 `dsh plugin add --save-exact` 安装。市场已装后的空、畸形或明显无关结果视为没有可复用候选；执行失败则发现未完成，不能发放创建权限。保留下来的候选都不能跳过下述审查与批准门槛。

## 2. 安装门槛

同时满足以下条件才进入安装：

1. 候选来自同一 resolution 的持久 review receipt；
2. manifest 精确声明 `dsh.bundle.patch`，该安全相对路径存在于已审查快照且能按 Loader 方言解析，package name 通过 registry-name 校验；
3. fit 为 `full`，recommendation 为 `use`；
4. 风险为 `low` 或 `medium`，且与回执记录的实际 DSH runtime 兼容性为 `compatible`；
5. GitHub 安装 spec 钉在 exact commit；本地来源绑定 base commit、status 与除 `.git`/`node_modules` 外的完整文件集合；
6. 安装前重新审查，材料一致；
7. live DSH approval 返回一次性的 `allowed-once`。

symlink、特殊文件或截断的本地快照停在审查阶段。材料变化记为 `review_expired`。风险 `high`，或兼容性为 `incompatible` / `unknown` 的候选留在审查结果里，不授权安装。

本地改进批准后复制到插件 owned snapshot，完整文件 hash 与 review 对齐；`npm pack --ignore-scripts` 生成 tgz 后再复核 snapshot，最终安装该 tgz。Windows 上 DSH rc.6 会经 shell 转发 pnpm 参数，owned artifact path 和卸载用 package name 都经过 shell 安全校验；移除前再校验一次 receipt 中的 package name。

批准理由包含 fit、风险、兼容性、生命周期脚本名称和最多八项派生 finding。

## 2.1 新插件创建门禁

AutoEvo 在 DSH 的 `tools/pre-execute` 与 monotonic guard 两层检查带 Agent 身份的 `cordis_define(kind:new)`。

1. 真正的能力进化模式：`agentPresets.serviceFor(agent, "autoevoEvolutionMode")` 必须返回 owner 为 `dsh-plugin-autoevo` 且协议版本匹配的标记。preset id 或同名外来 preset 不能冒充。
2. 模式外：拒绝并提示切换到 **能力进化**；即使内存里残留 `scratch_ready` 也不放行。
3. 模式内：没有当前 Agent 的 `scratch_ready` 权限时，调用会以明确理由失败；`reuse_required`、`modify_required` 与 `review_required` 均不能创建。权限在调用进入前绑定 callId，避免并发消费；失败或取消后恢复，成功后消费。每次新的 `capability_resolve` 先撤销旧权限，并建立新的 generation；较晚返回的旧解析，以及不属于该 Agent 当前 resolution 的 review，都不能恢复或覆盖权限。

这不是通用代码意图分类器：普通编辑、命令、测试、Git 操作、AutoEvo 自身安装流程、无 Agent 的内部工具调用与 `cordis_define(kind:existing)` 不在门禁范围内。官方 Creator 技能不被全局禁用。权限仅驻留内存；持久 V1/V2 旧记录不会在重启后恢复创建能力。

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

验证器核对 callId/name 匹配、结果成功、预期工具全部覆盖，并只接受 DSH `assistant/message` 后紧跟 `turn/end: completed` 的最终回答。仅凭 stdout 日志不算任务完成。最终回答只保存 SHA-256；如果调用方给出预期文本，observer 只额外保存匹配布尔值。

## 5. 删除

临时目录由 `installationId` 唯一拥有。删除前对 trial root 与候选路径做 `realpath`，确认候选是 trials root 的严格子目录。删除使用 Node `rm`，对象是已经验证的精确路径。

外部安装前先持久化 `installState: unknown` 的 provisional receipt。安装命令异常时，persistent Profile 必须重读 dependency：存在记 `installed`，不存在记 `not_installed`，读取失败保持 `unknown`。最终 receipt 写入失败时，temporary trial 立即补偿删除；persistent Profile 保留 fail-closed recovery anchor。清理 persistent 失败记录时同样先查 Profile 依赖；依赖已经消失就只删 owned artifact。临时试用在批准和文件写入前就确定验证任务。

## 6. Prompt Injection

审查器把 prompt-injection-like 文本记成 `prompt_injection:block` 派生事实，并把风险升为 `high`。Agent 看到的是分类结果和 hash。

## 7. 运行假设

- 隔离的 DSH home/profile 只隔离配置与依赖；获准安装的包仍以当前用户权限运行。
- 启发式扫描覆盖常见 lifecycle、registry 之外的依赖、进程/网络/文件系统/环境访问、动态求值与 prompt injection 信号，供安装决策使用。
- `medium` 风险候选在理由清晰的批准后可以试用；`high` 风险停在审查阶段。
- `contributionAdvice.eligible` 表示可以建议贡献。提交前由人工或 Agent 检查实际 diff，清理用户路径、账号、私有地址、密钥和专有逻辑，并再次取得用户明确批准。
- fork、push、commit 与 PR 走现有 Git / `gh` 能力，每一次提交单独批准。
