CREATE TABLE `notice` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`wizard_id` text NOT NULL,
	`run_id` text,
	`start_id` text,
	`detail` text,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notice_tenant_at` ON `notice` (`tenant_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `run` ADD `started_by` text;--> statement-breakpoint
ALTER TABLE `wizard` ADD `starts` text DEFAULT '[]' NOT NULL;