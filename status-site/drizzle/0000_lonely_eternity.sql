CREATE TABLE `quick_probe_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`visitor_hash` text NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quick_probe_uses_visitor_time` ON `quick_probe_uses` (`visitor_hash`,`used_at`);--> statement-breakpoint
CREATE TABLE `status_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checked_at` integer NOT NULL,
	`endpoint_ok` integer NOT NULL,
	`inference_ok` integer,
	`http_status` integer,
	`latency_ms` integer,
	`ttft_ms` integer,
	`output_tokens` integer,
	`output_tps_milli` integer,
	`truncated` integer,
	`model` text NOT NULL,
	`error_code` text,
	`source` text DEFAULT 'scheduled-probe' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_status_checks_checked_at` ON `status_checks` (`checked_at`);