# 灵石计费与 Relay 设计

## 对象

- `ModelChannel`：平台维护的上游渠道与模型映射。
- `PricingRule`：按 capability、model、tier 和 unit 定价。
- `CreditAccount` / ledger：团队灵石余额和不可变流水。
- `LlmCallLog`：一次 AI 调用的状态、用量、预留、实扣和错误。

## 计费单位

系统支持 token、图片张数和视频秒数等单位。`PER_SECOND` 按 `pricePerUnit × ceil(seconds)` 计算，秒数至少为 1；价格保留平台定义的小数精度。

## 调用状态机

1. 认证用户和当前团队。
2. 解析 `fast` / `premium` 档位并选择可用渠道。
3. 查价格并创建 pending call log。
4. 预留余额；不足返回 402 `insufficient_balance`。
5. 调用上游。
6. 按实际用量 reconcile，多退少补。
7. 完成 call log；转发失败走幂等 refund。

同一购买或退款通过幂等键和唯一索引防止重复入账。客户端不得传价格、供应商密钥或任意上游模型名。

管理端在“价目表”维护渠道和定价；用户端只看到平台档位、预计消耗和最终扣费。
