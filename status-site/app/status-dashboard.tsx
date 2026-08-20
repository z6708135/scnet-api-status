"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Check = {
  id: number | string;
  checkedAt: string;
  endpointOk: boolean;
  inferenceOk: boolean | null;
  httpStatus: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  outputTps: number | null;
  truncated: boolean | null;
  model: string;
  errorCode: string | null;
};

type ApiPayload = {
  checks: Check[];
  summary: {
    samples: number;
    successes: number;
    uptimePct: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    avgTtftMs: number | null;
    avgOutputTps: number | null;
    truncations: number;
  } | null;
};

type ChatResult = {
  reply: string;
  metrics: { ttftMs: number; totalMs: number; outputTokens: number | null; outputTps: number | null; truncated: boolean };
};

const seededCheck: Check = {
  id: "seed",
  checkedAt: "2026-08-20T17:29:23+08:00",
  endpointOk: true,
  inferenceOk: null,
  httpStatus: 200,
  latencyMs: 139,
  ttftMs: null,
  outputTps: null,
  truncated: null,
  model: "DeepSeek-V4-Flash-0731",
  errorCode: null,
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function checkLabel(check: Check) {
  if (check.inferenceOk === true) return "可用";
  if (check.inferenceOk === false) return "异常";
  if (check.endpointOk) return "仅端点";
  return "不可达";
}

function metric(value: number | null | undefined, suffix: string, digits = 0) {
  return value == null ? "—" : `${value.toFixed(digits)}${suffix}`;
}

export function StatusDashboard() {
  const [payload, setPayload] = useState<ApiPayload>({ checks: [seededCheck], summary: null });
  const [live, setLive] = useState(false);
  const [message, setMessage] = useState("Hello world");
  const [testing, setTesting] = useState(false);
  const [chatResult, setChatResult] = useState<ChatResult | null>(null);
  const [chatError, setChatError] = useState("");

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as ApiPayload;
        if (active && next.checks.length) { setPayload(next); setLive(true); }
      } catch { /* Keep the labelled seed observation. */ }
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const latest = payload.checks[0] ?? seededCheck;
  const statusTone = latest.inferenceOk === false || !latest.endpointOk ? "down" : latest.inferenceOk ? "up" : "partial";
  const bars = useMemo(() => payload.checks.slice(0, 36).reverse(), [payload.checks]);

  async function runQuickTest(event: FormEvent) {
    event.preventDefault();
    setTesting(true); setChatError(""); setChatResult(null);
    try {
      const response = await fetch("/api/quick-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await response.json() as ChatResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "测试请求失败");
      setChatResult(data);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "测试请求失败");
    } finally { setTesting(false); }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="SCNet API 状态首页"><span className="brand-mark">S</span><span>SCNet API Status</span></a>
        <nav aria-label="页面导航"><a href="#quick-test">快速测试</a><a href="#history">历史记录</a><a href="#method">监测说明</a></nav>
        <span className="community-label">社区监测 · 非官方</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className={`pulse ${statusTone}`} /> 独立可用性监测</div>
        <h1>国家超算互联网<br />模型 API 状态</h1>
        <p className="hero-copy">持续记录 SCNet OpenAI 兼容端点的真实对话成功率、首 Token 时间、输出速度与截断情况。</p>
      </section>

      <section className={`status-panel ${statusTone}`} aria-labelledby="current-status">
        <div>
          <p className="section-kicker">当前状态</p>
          <h2 id="current-status"><span className="status-dot" /> {checkLabel(latest)}</h2>
          <p className="status-note">
            {latest.inferenceOk === true ? `${latest.model} 已返回有效流式响应。`
              : latest.inferenceOk === false ? `${latest.model} 对话请求失败${latest.errorCode ? `：${latest.errorCode}` : "。"}`
                : "鉴权与模型目录正常；真实对话探针等待合规监测凭证接入。"}
          </p>
        </div>
        <div className="last-check"><span>最后检查</span><strong>{formatTime(latest.checkedAt)} CST</strong><small>{live ? "实时数据" : "初始观测"}</small></div>
      </section>

      <section className="metrics" aria-label="关键指标">
        <article><span>30 天可用率</span><strong>{metric(payload.summary?.uptimePct, "%", 2)}</strong><small>{payload.summary?.samples ? `${payload.summary.samples} 次真实对话` : "数据积累中"}</small></article>
        <article><span>首 Token 时间</span><strong>{metric(latest.ttftMs, " ms")}</strong><small>最近成功响应</small></article>
        <article><span>输出速度</span><strong>{metric(latest.outputTps, " tok/s", 1)}</strong><small>服务端 usage 计数</small></article>
        <article><span>截断次数</span><strong>{payload.summary?.truncations ?? "—"}</strong><small>最近 30 天 · finish_reason=length</small></article>
      </section>

      <section className="quick-test" id="quick-test" aria-labelledby="quick-test-title">
        <div className="test-intro">
          <p className="section-kicker">一次性测试</p>
          <h2 id="quick-test-title">现在发起一轮真实对话</h2>
          <p>输入一句话，服务端将向同一模型发送流式请求，并返回回复、TTFT、总耗时和输出速度。每个访客有严格频率限制。</p>
        </div>
        <form className="chat-card" onSubmit={runQuickTest}>
          <label htmlFor="quick-message">你的消息</label>
          <div className="chat-input-row">
            <input id="quick-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={280} required aria-describedby="quick-hint" />
            <button type="submit" disabled={testing || !message.trim()}>{testing ? "测试中…" : "发送测试"}</button>
          </div>
          <small id="quick-hint">最多 280 字符；默认使用 “Hello world”。</small>
          {chatError && <p className="chat-error" role="alert">{chatError}</p>}
          {chatResult && (
            <div className="chat-result" aria-live="polite">
              <div className="reply"><span>模型回复</span><p>{chatResult.reply}</p></div>
              <div className="test-metrics">
                <span>TTFT <strong>{chatResult.metrics.ttftMs} ms</strong></span>
                <span>总耗时 <strong>{chatResult.metrics.totalMs} ms</strong></span>
                <span>输出 <strong>{chatResult.metrics.outputTokens ?? "—"} tokens</strong></span>
                <span>速度 <strong>{metric(chatResult.metrics.outputTps, " tok/s", 1)}</strong></span>
                <span>截断 <strong>{chatResult.metrics.truncated ? "是" : "否"}</strong></span>
              </div>
            </div>
          )}
        </form>
      </section>

      <section className="timeline" aria-labelledby="timeline-title">
        <div className="section-heading"><div><p className="section-kicker">近况</p><h2 id="timeline-title">最近 36 次探测</h2></div><div className="legend"><span className="key up" />正常 <span className="key down" />异常 <span className="key partial" />仅端点</div></div>
        <div className="bars" aria-label="最近探测结果图">
          {bars.map((check) => <div className={`bar ${check.inferenceOk === true ? "up" : check.inferenceOk === false || !check.endpointOk ? "down" : "partial"}`} key={check.id} title={`${formatTime(check.checkedAt)} · ${checkLabel(check)} · ${check.latencyMs ?? "—"} ms`} />)}
          {Array.from({ length: Math.max(0, 36 - bars.length) }).map((_, index) => <div className="bar empty" key={`empty-${index}`} />)}
        </div>
      </section>

      <section className="history" id="history" aria-labelledby="history-title">
        <div className="section-heading"><div><p className="section-kicker">明细</p><h2 id="history-title">最近记录</h2></div><span className="model-chip">DeepSeek-V4-Flash-0731</span></div>
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>状态</th><th>HTTP</th><th>总延迟</th><th>TTFT</th><th>输出速度</th><th>截断</th></tr></thead>
          <tbody>{payload.checks.slice(0, 10).map((check) => <tr key={check.id}>
            <td>{formatTime(check.checkedAt)} CST</td><td><span className={`row-state ${check.inferenceOk === false || !check.endpointOk ? "down" : check.inferenceOk ? "up" : "partial"}`}>{checkLabel(check)}</span></td>
            <td>{check.httpStatus ?? "—"}</td><td>{metric(check.latencyMs, " ms")}</td><td>{metric(check.ttftMs, " ms")}</td><td>{metric(check.outputTps, " tok/s", 1)}</td><td>{check.truncated == null ? "—" : check.truncated ? "是" : "否"}</td>
          </tr>)}</tbody></table></div>
      </section>

      <section className="method" id="method"><div><p className="section-kicker">监测方法</p><h2>真实对话，透明结论</h2></div><div className="method-copy">
        <p>定时探针发送固定的 “Hello world” 并接收完整流式回复，记录 HTTP 状态、TTFT、总耗时、usage 输出 Token 与 finish reason；不保存回复正文。</p>
        <p>只有真实推理请求计入可用率。`finish_reason=length` 计为一次截断；模型目录可达但未完成推理时仅标记“仅端点”。</p>
      </div></section>

      <footer><p>独立社区项目，不代表 SCNet 官方服务承诺。</p><p>页面每分钟刷新 · 所有时间为中国标准时间</p></footer>
    </main>
  );
}
