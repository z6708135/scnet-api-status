import { env } from "cloudflare:workers";

export type CheckInput = {
  checkedAt: string;
  endpointOk: boolean;
  inferenceOk: boolean | null;
  httpStatus: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  outputTps: number | null;
  truncated: boolean | null;
  model: string;
  errorCode: string | null;
  source?: string;
};

type CheckRow = {
  id: number; checked_at: number; endpoint_ok: number; inference_ok: number | null;
  http_status: number | null; latency_ms: number | null; ttft_ms: number | null;
  output_tokens: number | null; output_tps_milli: number | null; truncated: number | null;
  model: string; error_code: string | null;
};

function db() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

export async function ensureStatusSchema() {
  const database = db();
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS status_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at INTEGER NOT NULL,
      endpoint_ok INTEGER NOT NULL,
      inference_ok INTEGER,
      http_status INTEGER,
      latency_ms INTEGER,
      ttft_ms INTEGER,
      output_tokens INTEGER,
      output_tps_milli INTEGER,
      truncated INTEGER,
      model TEXT NOT NULL,
      error_code TEXT,
      source TEXT NOT NULL DEFAULT 'scheduled-probe'
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_status_checks_checked_at ON status_checks(checked_at)"),
    database.prepare(`CREATE TABLE IF NOT EXISTS quick_probe_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_hash TEXT NOT NULL,
      used_at INTEGER NOT NULL
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_quick_probe_uses_visitor_time ON quick_probe_uses(visitor_hash, used_at)"),
    database.prepare("PRAGMA optimize"),
  ]);
}

export async function insertCheck(input: CheckInput) {
  await ensureStatusSchema();
  return db().prepare(`INSERT INTO status_checks (
    checked_at, endpoint_ok, inference_ok, http_status, latency_ms, ttft_ms,
    output_tokens, output_tps_milli, truncated, model, error_code, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      new Date(input.checkedAt).getTime(), input.endpointOk ? 1 : 0,
      input.inferenceOk == null ? null : input.inferenceOk ? 1 : 0,
      input.httpStatus, input.latencyMs, input.ttftMs, input.outputTokens,
      input.outputTps == null ? null : Math.round(input.outputTps * 1000),
      input.truncated == null ? null : input.truncated ? 1 : 0,
      input.model, input.errorCode, input.source ?? "scheduled-probe",
    ).run();
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * ratio;
  const low = Math.floor(position); const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export async function readStatus() {
  await ensureStatusSchema();
  const result = await db().prepare(`SELECT
      id, checked_at, endpoint_ok, inference_ok, http_status, latency_ms, ttft_ms,
      output_tokens, output_tps_milli, truncated, model, error_code
    FROM status_checks
    WHERE checked_at >= ? AND source = 'scheduled-probe'
    ORDER BY checked_at DESC
    LIMIT 720`)
    .bind(Date.now() - 30 * 24 * 60 * 60 * 1000).all<CheckRow>();

  const rows = result.results ?? [];
  const inferenceRows = rows.filter((row) => row.inference_ok != null);
  const successes = inferenceRows.filter((row) => row.inference_ok === 1);
  const latencies = successes.flatMap((row) => row.latency_ms == null ? [] : [row.latency_ms]);
  const ttfts = successes.flatMap((row) => row.ttft_ms == null ? [] : [row.ttft_ms]);
  const speeds = successes.flatMap((row) => row.output_tps_milli == null ? [] : [row.output_tps_milli / 1000]);
  return {
    checks: rows.map((row) => ({
      id: row.id, checkedAt: new Date(row.checked_at).toISOString(), endpointOk: row.endpoint_ok === 1,
      inferenceOk: row.inference_ok == null ? null : row.inference_ok === 1, httpStatus: row.http_status,
      latencyMs: row.latency_ms, ttftMs: row.ttft_ms, outputTokens: row.output_tokens,
      outputTps: row.output_tps_milli == null ? null : row.output_tps_milli / 1000,
      truncated: row.truncated == null ? null : row.truncated === 1,
      model: row.model, errorCode: row.error_code,
    })),
    summary: inferenceRows.length ? {
      samples: inferenceRows.length, successes: successes.length,
      uptimePct: (successes.length / inferenceRows.length) * 100,
      p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95),
      avgTtftMs: average(ttfts), avgOutputTps: average(speeds),
      truncations: inferenceRows.filter((row) => row.truncated === 1).length,
    } : null,
  };
}

export async function consumeQuickProbe(visitorHash: string) {
  await ensureStatusSchema();
  const database = db(); const now = Date.now(); const dayAgo = now - 86_400_000; const tenMinutesAgo = now - 600_000;
  const [visitorRecent, visitorDay, globalHour] = await database.batch([
    database.prepare("SELECT COUNT(*) AS count FROM quick_probe_uses WHERE visitor_hash = ? AND used_at >= ?").bind(visitorHash, tenMinutesAgo),
    database.prepare("SELECT COUNT(*) AS count FROM quick_probe_uses WHERE visitor_hash = ? AND used_at >= ?").bind(visitorHash, dayAgo),
    database.prepare("SELECT COUNT(*) AS count FROM quick_probe_uses WHERE used_at >= ?").bind(now - 3_600_000),
  ]);
  const count = (result: D1Result) => Number((result.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  if (count(visitorRecent) >= 1) return { ok: false, reason: "每位访客 10 分钟只能测试一次。" };
  if (count(visitorDay) >= 5) return { ok: false, reason: "你今天的快速测试次数已用完。" };
  if (count(globalHour) >= 100) return { ok: false, reason: "当前测试请求较多，请稍后再试。" };
  await database.prepare("INSERT INTO quick_probe_uses (visitor_hash, used_at) VALUES (?, ?)").bind(visitorHash, now).run();
  await database.prepare("DELETE FROM quick_probe_uses WHERE used_at < ?").bind(dayAgo).run();
  return { ok: true as const };
}
