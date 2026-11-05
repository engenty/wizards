ALTER TABLE `notice` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `notice` ADD `visitor` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notice` ADD `wait_key` text;--> statement-breakpoint
ALTER TABLE `notice` ADD `shown` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notice` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `notice` ADD `claim_until` integer;--> statement-breakpoint
ALTER TABLE `notice` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notice` ADD `pushed_at` integer;--> statement-breakpoint
ALTER TABLE `notice` ADD `mailed_at` integer;--> statement-breakpoint
CREATE INDEX `notice_due` ON `notice` (`due_at`);--> statement-breakpoint
CREATE INDEX `notice_run` ON `notice` (`run_id`);