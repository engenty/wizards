CREATE TABLE `notice` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`wizard_id` text NOT NULL,
	`run_id` text,
	`start_id` text,
	`detail` text,
	`user_id` text,
	`visitor` integer DEFAULT false NOT NULL,
	`wait_key` text,
	`shown` integer DEFAULT true NOT NULL,
	`due_at` integer,
	`claim_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`pushed_at` integer,
	`mailed_at` integer,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notice_tenant_at` ON `notice` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notice_due` ON `notice` (`due_at`);--> statement-breakpoint
CREATE INDEX `notice_run` ON `notice` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_effect` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`tool` text NOT NULL,
	`state` text NOT NULL,
	`output` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_effect_run` ON `run_effect` (`run_id`);--> statement-breakpoint
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
ALTER TABLE `run` ADD `started_by` text;--> statement-breakpoint
ALTER TABLE `run` ADD `occurrence` text;--> statement-breakpoint
ALTER TABLE `run` ADD `driving` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `run_occurrence` ON `run` (`wizard_id`,`occurrence`);--> statement-breakpoint
ALTER TABLE `wizard` ADD `signal_token` text;--> statement-breakpoint
ALTER TABLE `wizard` ADD `signal_secret` text;--> statement-breakpoint
ALTER TABLE `wizard` ADD `starts` text DEFAULT '[]' NOT NULL;