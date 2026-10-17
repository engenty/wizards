CREATE TABLE `runner` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text,
	`seen` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `run_index` ADD `owner` text;--> statement-breakpoint
ALTER TABLE `run_index` ADD `seen` integer;