const STATUS_URL = "./status.json";
const QUICK_TEST_URL = "https://scnet-api-status.vittoriowa-zhang.chatgpt.site/api/quick-test";

const $ = (id) => document.getElementById(id);
const fmt = (value, suffix = "", digits = 0) => value == null ? "—" : `${Number(value).toFixed(digits)}${suffix}`;
const formatTime = (value) => new Intl.DateTimeFormat("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false, timeZone:"Asia/Shanghai" }).format(new Date(value)) + " CST";
const tone = (check) => check.inferenceOk === true ? "up" : check.inferenceOk === false || !check.endpointOk ? "down" : "partial";
const label = (check) => check.inferenceOk === true ? "可用" : check.inferenceOk === false ? "异常" : check.endpointOk ? "仅端点" : "不可达";

function render(data) {
  const checks = data.checks || [];
  if (!checks.length) return;
  const latest = checks[0], summary = data.summary;
  const currentTone = tone(latest);
  $("status-panel").className = `status-panel ${currentTone}`;
  $("hero-pulse").className = `pulse ${currentTone}`;
  $("status-label").textContent = label(latest);
  $("status-note").textContent = latest.inferenceOk === true ? `${latest.model} 已返回有效流式响应。` : latest.inferenceOk === false ? `${latest.model} 对话请求失败${latest.errorCode ? `：${latest.errorCode}` : "。"}` : "鉴权与模型目录正常；真实对话探针等待合规监测凭证接入。";
  $("last-check").textContent = formatTime(latest.checkedAt);
  $("uptime").textContent = fmt(summary?.uptimePct, "%", 2);
  $("sample-count").textContent = summary?.samples ? `${summary.samples} 次真实对话` : "数据积累中";
  $("ttft").textContent = fmt(latest.ttftMs, " ms");
  $("output-tps").textContent = fmt(latest.outputTps, " tok/s", 1);
  $("truncations").textContent = summary?.truncations ?? "—";

  const recent = checks.slice(0, 36).reverse();
  $("bars").innerHTML = recent.map((check) => `<div class="bar ${tone(check)}" title="${formatTime(check.checkedAt)} · ${label(check)} · ${check.latencyMs ?? "—"} ms"></div>`).join("") + Array.from({length: Math.max(0, 36-recent.length)}, () => '<div class="bar empty"></div>').join("");
  $("history-body").innerHTML = checks.slice(0, 10).map((check) => `<tr><td>${formatTime(check.checkedAt)}</td><td><span class="row-state ${tone(check)}">${label(check)}</span></td><td>${check.httpStatus ?? "—"}</td><td>${fmt(check.latencyMs," ms")}</td><td>${fmt(check.ttftMs," ms")}</td><td>${fmt(check.outputTps," tok/s",1)}</td><td>${check.truncated == null ? "—" : check.truncated ? "是" : "否"}</td></tr>`).join("");
}

async function refresh() {
  try { const response = await fetch(`${STATUS_URL}?t=${Date.now()}`, { cache:"no-store" }); if (response.ok) render(await response.json()); }
  catch { $("data-mode").textContent = "状态数据暂不可用"; }
}

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("send-button"), error = $("chat-error"), result = $("chat-result");
  button.disabled = true; button.textContent = "测试中…"; error.hidden = true; result.hidden = true;
  try {
    const response = await fetch(QUICK_TEST_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({message:$("quick-message").value}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "测试请求失败");
    $("chat-reply").textContent = data.reply;
    $("chat-metrics").innerHTML = `<span>TTFT <strong>${data.metrics.ttftMs} ms</strong></span><span>总耗时 <strong>${data.metrics.totalMs} ms</strong></span><span>输出 <strong>${data.metrics.outputTokens ?? "—"} tokens</strong></span><span>速度 <strong>${fmt(data.metrics.outputTps," tok/s",1)}</strong></span><span>截断 <strong>${data.metrics.truncated ? "是" : "否"}</strong></span>`;
    result.hidden = false;
  } catch (problem) { error.textContent = problem.message || "测试请求失败"; error.hidden = false; }
  finally { button.disabled = false; button.textContent = "发送测试"; }
});

refresh();
setInterval(refresh, 60_000);
