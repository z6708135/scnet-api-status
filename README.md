# 国家超算互联网 API 可用性检查器

检查 `https://api.scnet.cn/api/llm/v1` 的 OpenAI 兼容接口，包括：

- API Key 鉴权与模型列表
- 文本生成成功率与延迟（min / mean / P50 / P95 / max）
- 可选流式响应首 Token 时间（TTFT）
- 可选小规模并发测试
- 网络错误、HTTP 429 与 5xx 指数退避重试（默认 2 次，并在报告中标记）
- 脱敏 JSON 报告（不会保存 API Key 或回复正文）

仅依赖 Python 3 标准库。

> **Token Plan 限制：**SCNet 官方规则明确规定，`sk-tp-` Key 仅限在支持的
> AI 工具中交互使用，禁止自动化脚本、自定义应用后端、Postman 或 cURL。
> 因此本检查器识别到 `sk-tp-` Key 时只验证密钥格式并退出，不会发送网络请求。
> 完整基准测试仅适用于平台允许脚本调用的普通按量 API Key。详见
> [Token Plan 官方说明](https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html)。

本项目附带 [Codex 配置模板](codex-scnet-config.example.toml)，其中模型已设为
免费套餐对应的精确 ID：`DeepSeek-V4-Flash-0731`。模板不包含 API Key。

## 公开状态页与定时探针

`docs/` 是 GitHub Pages 静态状态页，`status-site/` 是负责限频聊天的安全后端，提供：

- 30 天真实对话成功率
- 流式首 Token 时间（TTFT）
- 总响应时间与输出 Token/s
- `finish_reason=length` 截断次数
- 最近 36 次探测时间线与明细
- 限频的一次性快速聊天测试

`monitor_and_publish.py` 每次发送一条真实的流式 `Hello world` 对话，并把脱敏
指标更新到 `docs/status.json`。`.github/workflows/status-monitor.yml` 默认每 10 分钟
运行一次并提交历史记录，Pages 随后自动更新。

定时任务只需要一个仓库 Secret：

- `SCNET_API_KEY`：允许服务端自动化调用的普通 `sk-` Key

快速聊天后端还需要配置 `SCNET_API_KEY` 和 `STATUS_RATE_LIMIT_SALT`。
浏览器不会接触这些值。公开聊天窗口按访客限制为每
10 分钟一次、每天最多五次，并设置每小时全局上限。

`monitor_and_publish.py` 与公开聊天接口都会拒绝 `sk-tp-` Token Plan Key；免费
额度不改变 SCNet 对 Token Plan 使用场景的限制。

## 使用

不要把 API Key 写入脚本或提交到 Git：

```bash
export SCNET_API_KEY='允许脚本调用的普通 sk-... 密钥'
cd /home/zhang/Desktop/scnet-api-check
python3 scnet_api_check.py
```

完整检查（3 次串行、2 次并发、1 次流式）：

```bash
python3 scnet_api_check.py --runs 3 --concurrency 2 --stream \
  --output scnet-report.json
```

只验证鉴权和模型列表，不产生文本生成费用：

```bash
python3 scnet_api_check.py --skip-chat
```

指定模型或端点：

```bash
python3 scnet_api_check.py --model auto
python3 scnet_api_check.py --base-url 'https://api.scnet.cn/api/llm/v1'
```

查看所有参数：

```bash
python3 scnet_api_check.py --help
```

## 退出码

- `0`：所有已执行的检查通过
- `1`：至少一项检查失败
- `2`：缺少密钥或参数错误
- `3`：检测到禁止脚本调用的 Token Plan Key，未发送网络请求

程序默认只要求模型回复 `OK`，并限制到 8 个输出 Token。增加 `--runs`、
`--concurrency` 或启用 `--stream` 会增加实际 API 调用次数和额度消耗。
