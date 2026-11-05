CREATE TABLE `draft_change` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wizard_id` text NOT NULL,
	`change` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_change_wizard` ON `draft_change` (`wizard_id`,`id`);--> statement-breakpoint
CREATE INDEX `draft_change_at` ON `draft_change` (`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_app_check` (
	`app` text NOT NULL,
	`person` text NOT NULL,
	`kind` text NOT NULL,
	`allowed` integer DEFAULT 0 NOT NULL,
	`refused` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`app`, `person`)
);
--> statement-breakpoint
CREATE TABLE `mcp_app_seen` (
	`app` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`tool_at` integer,
	`widget_at` integer
);
