CREATE TABLE `space_bundle` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`description` text,
	`format` text NOT NULL,
	`origin` text NOT NULL,
	`hash` text NOT NULL,
	`left_out` text DEFAULT '[]' NOT NULL,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_bundle_space` ON `space_bundle` (`space_id`);--> statement-breakpoint
ALTER TABLE `space_connection` ADD `bundle_id` text;--> statement-breakpoint
ALTER TABLE `space_connector` ADD `bundle_id` text;--> statement-breakpoint
ALTER TABLE `space_skill` ADD `bundle_id` text;