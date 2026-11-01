CREATE TABLE `space_source` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`plugin` text NOT NULL,
	`address` text NOT NULL,
	`label` text NOT NULL,
	`state` text NOT NULL,
	`rules` text NOT NULL,
	`categories` text NOT NULL,
	`every_hours` integer,
	`token` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`last_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_source_space` ON `space_source` (`space_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_source_token` ON `space_source` (`token`);--> statement-breakpoint
CREATE TABLE `space_source_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`address` text NOT NULL,
	`title` text,
	`path` text NOT NULL,
	`included` integer NOT NULL,
	`reason` text,
	`decided_by` text,
	`status` text NOT NULL,
	`item_key` text,
	`result` text,
	`note` text,
	`fingerprint` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `space_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_source_entry_address` ON `space_source_entry` (`source_id`,`address`);--> statement-breakpoint
CREATE TABLE `space_source_run` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`written` integer NOT NULL,
	`unchanged` integer NOT NULL,
	`failed` integer NOT NULL,
	`left_out` integer NOT NULL,
	`log` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `space_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_source_run_source` ON `space_source_run` (`source_id`,`started_at`);