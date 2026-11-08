ALTER TABLE `approval` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `approval` ADD `step_id` text;--> statement-breakpoint
CREATE INDEX `approval_run` ON `approval` (`run_id`,`step_id`);--> statement-breakpoint
ALTER TABLE `wizard` ADD `answerers` text DEFAULT '[]' NOT NULL;