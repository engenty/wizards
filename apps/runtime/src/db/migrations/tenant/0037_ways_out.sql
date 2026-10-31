ALTER TABLE `broker_log` ADD `step_id` text;--> statement-breakpoint
CREATE INDEX `broker_log_run` ON `broker_log` (`run_id`);--> statement-breakpoint
CREATE INDEX `broker_log_wizard` ON `broker_log` (`wizard_id`,`kind`,`at`);--> statement-breakpoint
ALTER TABLE `space` ADD `mail_domains` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `wizard` ADD `daily_mail_limit` integer DEFAULT 50 NOT NULL;