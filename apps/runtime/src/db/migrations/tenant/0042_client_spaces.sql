CREATE TABLE `space_member` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_member_key` ON `space_member` (`space_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `space_member_user` ON `space_member` (`user_id`);--> statement-breakpoint
ALTER TABLE `space` ADD `kind` text DEFAULT 'space' NOT NULL;--> statement-breakpoint
ALTER TABLE `space` ADD `parent_id` text REFERENCES space(id);--> statement-breakpoint
CREATE INDEX `space_parent` ON `space` (`parent_id`);