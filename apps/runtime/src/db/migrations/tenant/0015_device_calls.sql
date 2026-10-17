CREATE TABLE `device_call` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`req_id` text NOT NULL,
	`request` text NOT NULL,
	`answer` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_call_req` ON `device_call` (`req_id`);--> statement-breakpoint
CREATE INDEX `device_call_run` ON `device_call` (`run_id`);--> statement-breakpoint
ALTER TABLE `run` ADD `device_offer` text;