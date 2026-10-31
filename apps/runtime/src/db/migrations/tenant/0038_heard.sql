CREATE TABLE `person_seen` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL,
	`bell_seen_at` integer
);
--> statement-breakpoint
ALTER TABLE `broker_log` ADD `rule` text;--> statement-breakpoint
ALTER TABLE `broker_log` ADD `critical_kind` text;--> statement-breakpoint
CREATE INDEX `broker_log_critical` ON `broker_log` (`space_id`,`critical`,`at`);--> statement-breakpoint
ALTER TABLE `space` ADD `notify` text DEFAULT '{"bell":true,"mail":"hourly"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `space` ADD `critical_mailed_at` integer;