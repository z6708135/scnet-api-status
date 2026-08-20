import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const statusChecks = sqliteTable(
  "status_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
    endpointOk: integer("endpoint_ok", { mode: "boolean" }).notNull(),
    inferenceOk: integer("inference_ok", { mode: "boolean" }),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    outputTokens: integer("output_tokens"),
    outputTpsMilli: integer("output_tps_milli"),
    truncated: integer("truncated", { mode: "boolean" }),
    model: text("model").notNull(),
    errorCode: text("error_code"),
    source: text("source").notNull().default("scheduled-probe"),
  },
  (table) => [index("idx_status_checks_checked_at").on(table.checkedAt)],
);

export const quickProbeUses = sqliteTable(
  "quick_probe_uses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    visitorHash: text("visitor_hash").notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_quick_probe_uses_visitor_time").on(table.visitorHash, table.usedAt)],
);
