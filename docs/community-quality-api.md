# 社区质量 API（V1）

该协议连接 AutoEvo 客户端与可独立部署的社区质量后端。客户端只负责提交结构化 observation 和应用聚合结果；Good/Repairable/Broken/Junk 的跨样本判断由后端完成。

## 1. 查询候选质量

`POST <communityQualityEndpoint>/v1/quality/query`

```json
{
  "schemaVersion": 1,
  "repositories": ["owner/plugin-a", "owner/plugin-b"]
}
```

```json
{
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

允许分类：`good`、`repairable`、`broken`、`junk`、`unknown`。没有返回的仓库按 unknown 处理并保留。客户端忽略未请求仓库、非法分类、越界分数和无效字段。

## 2. 提交匿名 observation

`POST <communityQualityEndpoint>/v1/quality/observations`

服务可返回 JSON，也可返回 `204 No Content`。字段固定为：

```json
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
```

`stage` 为 `review`、`install` 或 `verification`。`id` 可作为幂等键。后端应按 repository + exact commit + 版本维度聚合，控制重复客户端与单一来源权重，设置最小样本量和时间衰减；不得把单次失败直接判为 Junk。质量分类与安全风险必须分别存储和展示。

## 3. 隐私边界

V1 禁止接收或推断保存：需求全文、prompt、模型回答、验证任务/预期文本、源码、manifest、文件路径、用户名、主机名、IP 派生身份、环境变量、token 或其它凭据。生产后端应丢弃未知字段，并配置短期原始 observation 保留期与可审计的聚合规则。
