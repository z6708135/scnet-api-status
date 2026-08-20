import { env } from "cloudflare:workers";
import { insertCheck, readStatus } from "../../../lib/status-store";

export const dynamic = "force-dynamic";
const MODEL = "DeepSeek-V4-Flash-0731";
const GITHUB_PAGES_ORIGIN = "https://z6708135.github.io";

function responseHeaders(request?: Request) {
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (request?.headers.get("origin") === GITHUB_PAGES_ORIGIN) headers["Access-Control-Allow-Origin"] = GITHUB_PAGES_ORIGIN;
  return headers;
}

function json(data: unknown, status = 200, request?: Request) {
  return Response.json(data, { status, headers: responseHeaders(request) });
}

function nullableNumber(value: unknown, max = 600_000) {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

export async function GET(request: Request) {
  try { return json(await readStatus(), 200, request); }
  catch { return json({ checks: [], summary: null }, 200, request); }
}

export async function OPTIONS(request: Request) {
  if (request.headers.get("origin") !== GITHUB_PAGES_ORIGIN) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { ...responseHeaders(request), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" } });
}

export async function POST(request: Request) {
  const expected = env.STATUS_INGEST_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) return json({ error: "unauthorized" }, 401, request);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "content-type must be application/json" }, 415, request);
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { return json({ error: "invalid JSON" }, 400, request); }

  const checkedAt = typeof input.checkedAt === "string" ? input.checkedAt : "";
  const latencyMs = nullableNumber(input.latencyMs); const ttftMs = nullableNumber(input.ttftMs);
  const outputTokens = nullableNumber(input.outputTokens, 1_000_000); const outputTps = nullableNumber(input.outputTps, 100_000);
  if (!Number.isFinite(Date.parse(checkedAt)) || [latencyMs, ttftMs, outputTokens, outputTps].includes(undefined)) return json({ error: "invalid metrics" }, 400, request);
  if (input.endpointOk !== true && input.endpointOk !== false) return json({ error: "invalid endpointOk" }, 400, request);
  if (input.inferenceOk !== true && input.inferenceOk !== false && input.inferenceOk !== null) return json({ error: "invalid inferenceOk" }, 400, request);
  if (input.truncated !== true && input.truncated !== false && input.truncated !== null) return json({ error: "invalid truncated" }, 400, request);
  if (input.model !== MODEL) return json({ error: "unexpected model" }, 400, request);
  const httpStatus = nullableNumber(input.httpStatus, 599);
  if (httpStatus === undefined) return json({ error: "invalid httpStatus" }, 400, request);

  await insertCheck({
    checkedAt, endpointOk: input.endpointOk, inferenceOk: input.inferenceOk, httpStatus,
    latencyMs, ttftMs, outputTokens, outputTps, truncated: input.truncated, model: MODEL,
    errorCode: input.errorCode == null ? null : String(input.errorCode).slice(0, 160), source: "scheduled-probe",
  });
  return json({ accepted: true }, 202, request);
}
