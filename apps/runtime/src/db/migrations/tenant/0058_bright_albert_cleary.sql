CREATE TABLE `run_signal` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`data` text,
	`source` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_signal_match` ON `run_signal` (`space_id`,`name`,`key`,`at`);--> statement-breakpoint
CREATE TABLE `run_wait` (
	`run_id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`since` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_wait_match` ON `run_wait` (`space_id`,`name`,`key`);