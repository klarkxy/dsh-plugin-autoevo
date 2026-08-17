# 社区质量 API（V1）

**已封存。** 没有公开、国内可达的质量服务，也不提供可配置的默认 endpoint。客户端开关默认关闭；在有可用写入口之前不要打开。下文只保留协议，便于以后解封。

该协议连接 AutoEvo 客户端与社区质量服务。客户端一次任务最多两次网络：读一份全站快照，写一批 observation。Good/Repairable/Broken/Junk 的跨样本判断由服务端完成。

读必须是**所有客户端相同的 GET URL**，才能走 CDN/R2，而不是每个用户打一次 Worker。参考实现见 [quality/](../quality/README.md)。

## 1. 读取质量快照

`GET <communityQualityEndpoint>/v1/quality/assessments`

每个客户端每个 UTC 日只 GET 一次，快照落在 `stateDir/community-quality/assessments.json`，当天重启也复用。客户端在本地按本次候选仓库名过滤；快照里没有的仓库视为 unknown 并保留。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-17T00:00:00.000Z",
  "assessments": [
    {
      "repository": "owner/plugin-a",
      "classification": "repairable",
      "repairability": 0.82,
      "evolutionValue": 0.91,
      "confidence": 0.78,
      "observationCount": 12,
      "reasonCodes": ["verification_failed", "repair_succeeded"],
      "updatedAt": "2026-08-17T00:00:00.000Z"
    }
  ]
}
```

允许分类：`good`、`repairable`、`broken`、`junk`、`unknown`。客户端忽略未请求仓库、非法分类、越界分数和无效字段。

## 2. 提交匿名 observation

`POST <communityQualityEndpoint>/v1/quality/observations`

审查只写本地 pending；安装结束或进程启动时打 **一次** POST，把待发记录打成一批。服务可返回 JSON，也可返回 `204 No Content`。每批最多 20 条；字段固定为：

```json
{
  "schemaVersion": 1,
  "observations": [
    {
      "schemaVersion": 1,
      "id": "quality_<32 hex>",
      "createdAt": "2026-08-17T00:00:00.000Z",
      "repository": "owner/plugin-a",
      "commit": "<exact upstream commit>",
      "localModification": false,
      "policyVersion": "v6-2026-08-17",
      "autoevoVersion": "0.5.0",
      "dshVersion": "0.1.0-rc.6",
      "stage": "review",
      "outcome": "repairable",
      "reasonCodes": ["fit_partial", "recommendation_modify"],
      "securityRisk": "low",
      "repairability": "repairable",
      "evolutionValue": "high"
    }
  ]
}
```

`stage` 为 `review`、`install` 或 `verification`。`id` 可作为幂等键。服务端按 repository + exact commit + 版本 + 阶段 + 日期去重加权，设置最小样本量和时间衰减；不得把单次失败直接判为 Junk。质量分类与安全风险必须分别存储和展示。

## 3. 隐私边界

V1 禁止接收或推断保存：需求全文、prompt、模型回答、验证任务/预期文本、源码、manifest、文件路径、用户名、主机名、IP 派生身份、环境变量、token 或其它凭据。生产后端应丢弃未知字段，并配置短期原始 observation 保留期与可审计的聚合规则。
