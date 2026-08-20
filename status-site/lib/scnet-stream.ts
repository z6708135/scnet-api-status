const BASE_URL = "https://api.scnet.cn/api/llm/v1";
export const MODEL = "DeepSeek-V4-Flash-0731";

type StreamEvent = {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { completion_tokens?: number };
  error?: { message?: string; code?: string };
};

export type ProbeResult = {
  reply: string;
  metrics: {
    ttftMs: number;
    totalMs: number;
    outputTokens: number | null;
    outputTps: number | null;
    truncated: boolean;
  };
};

export async function streamCompletion(apiKey: string, message: string): Promise<ProbeResult> {
  if (apiKey.startsWith("sk-tp-")) throw new Error("Token Plan Key 不可用于公开自动化探针，请配置普通 sk- API Key。");
  const started = performance.now();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "scnet-community-status/1.0",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "Reply naturally and concisely. Keep the answer under 80 words." },
        { role: "user", content: message },
      ],
      max_tokens: 160,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message || detail;
    } catch { /* Keep the status-only error. */ }
    throw new Error(detail.slice(0, 180));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; let reply = ""; let ttftMs: number | null = null;
  let outputTokens: number | null = null; let finishReason: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: StreamEvent;
      try { event = JSON.parse(data) as StreamEvent; } catch { continue; }
      if (event.error) throw new Error(event.error.message || event.error.code || "stream error");
      const choice = event.choices?.[0];
      const firstToken = choice?.delta?.content || choice?.delta?.reasoning_content;
      if (firstToken && ttftMs == null) ttftMs = performance.now() - started;
      if (choice?.delta?.content) reply += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (typeof event.usage?.completion_tokens === "number") outputTokens = event.usage.completion_tokens;
    }
  }

  const totalMs = performance.now() - started;
  if (ttftMs == null || !reply.trim()) throw new Error("HTTP 200，但流中没有有效回复内容");
  const generationSeconds = Math.max((totalMs - ttftMs) / 1000, 0.001);
  const outputTps = outputTokens == null ? null : outputTokens / generationSeconds;
  return {
    reply: reply.trim(),
    metrics: {
      ttftMs: Math.round(ttftMs), totalMs: Math.round(totalMs), outputTokens,
      outputTps: outputTps == null ? null : Math.round(outputTps * 10) / 10,
      truncated: finishReason === "length",
    },
  };
}
