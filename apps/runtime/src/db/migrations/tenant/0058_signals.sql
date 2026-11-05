CREATE TABLE `run_signal` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`delivery` text NOT NULL,
	`data` text,
	`source` text NOT NULL,
	`runs` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_signal_delivery` ON `run_signal` (`space_id`,`scope`,`name`,`key`,`delivery`);--> statement-breakpoint
CREATE INDEX `run_signal_match` ON `run_signal` (`space_id`,`name`,`key`,`at`);--> statement-breakpoint
CREATE INDEX `run_signal_at` ON `run_signal` (`at`);--> statement-breakpoint
CREATE TABLE `run_wait` (
	`run_id` text PRIMARY KEY NOT NULL,
	`wizard_id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`fields` text,
	`since` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_wait_match` ON `run_wait` (`space_id`,`name`,`key`);--> statement-breakpoint
ALTER TABLE `wizard` ADD `signal_token` text;--> statement-breakpoint
ALTER TABLE `wizard` ADD `signal_secret` text;