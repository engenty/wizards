PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_space_member` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text,
	`email` text,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_space_member`("id", "tenant_id", "space_id", "user_id", "email", "role", "added_by", "created_at") SELECT "id", "tenant_id", "space_id", "user_id", NULL, "role", "added_by", "created_at" FROM `space_member`;--> statement-breakpoint
DROP TABLE `space_member`;--> statement-breakpoint
ALTER TABLE `__new_space_member` RENAME TO `space_member`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `space_member_key` ON `space_member` (`space_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `space_member_user` ON `space_member` (`user_id`);