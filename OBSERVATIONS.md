# 本次探测记录

时间：2026-08-20（Asia/Shanghai）

- `GET /models` 鉴权成功，HTTP 200；该 Key 可见 38 个模型。
- 模型列表请求观测延迟约 139–648 ms。
- 观测到一次 TLS `UNEXPECTED_EOF` 瞬时连接异常，随后请求可恢复。
- 对不属于该免费套餐的模型发起短请求时，平台正确返回 HTTP 403：
  `The current model does not support Token Plan`。
- 套餐的正确模型 ID 是 `DeepSeek-V4-Flash-0731`。发现官方对 `sk-tp-`
  Key 的使用限制后，没有继续通过脚本请求该模型。

结论：端点可达且密钥能通过鉴权，但 `DeepSeek-V4-Flash-0731` 的实际生成成功率、
TTFT 和并发稳定性尚未在官方允许的交互式 AI 工具内完成验证。

由于 API Key 曾以明文发到聊天中，建议先在 SCNet 控制台重置，再放入环境变量。
