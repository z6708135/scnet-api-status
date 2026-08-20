import { env } from "cloudflare:workers";
import { streamCompletion } from "../../../lib/scnet-stream";
import { consumeQuickProbe } from "../../../lib/status-store";

export const dynamic = "force-dynamic";
const GITHUB_PAGES_ORIGIN = "https://z6708135.github.io";

function responseHeaders(request?: Request) {
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (request?.headers.get("origin") === GITHUB_PAGES_ORIGIN) headers["Access-Control-Allow-Origin"] = GITHUB_PAGES_ORIGIN;
  return headers;
}

function json(data: unknown, status = 200, request?: Request) {
  return Response.json(data, { status, headers: responseHeaders(request) });
}

export async function OPTIONS(request: Request) {
  if (request.headers.get("origin") !== GITHUB_PAGES_ORIGIN) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { ...responseHeaders(request), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}

async function visitorHash(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const salt = env.STATUS_RATE_LIMIT_SALT;
  if (!salt) throw new Error("快速测试暂未启用");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "请求格式错误" }, 415, request);
  let message = "";
  try { message = String(((await request.json()) as { message?: unknown }).message ?? "").trim(); }
  catch { return json({ error: "请求格式错误" }, 400, request); }
  if (!message || message.length > 280) return json({ error: "请输入 1–280 个字符" }, 400, request);

  const apiKey = env.SCNET_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-tp-")) return json({ error: "公开快速测试暂未启用：需要配置允许服务端调用的普通 API Key。" }, 503, request);
  let hash: string;
  try { hash = await visitorHash(request); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "快速测试暂未启用" }, 503, request); }
  const limit = await consumeQuickProbe(hash);
  if (!limit.ok) return json({ error: limit.reason }, 429, request);

  try { return json(await streamCompletion(apiKey, message), 200, request); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "模型请求失败" }, 502, request); }
}
