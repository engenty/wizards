CREATE TABLE `share_job` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`target` text NOT NULL,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`status` text NOT NULL,
	`request` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_job_run` ON `share_job` (`run_id`,`created_at`);