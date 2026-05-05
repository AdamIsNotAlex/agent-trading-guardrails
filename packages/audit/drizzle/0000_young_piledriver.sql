CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`correlation_id` text NOT NULL,
	`environment` text NOT NULL,
	`intent_id` text,
	`principal` text,
	`prompt_id` text,
	`session_id` text,
	`input_ref` text,
	`data` text NOT NULL,
	`previous_hash` text NOT NULL,
	`event_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_event_id_unique` ON `audit_events` (`event_id`);