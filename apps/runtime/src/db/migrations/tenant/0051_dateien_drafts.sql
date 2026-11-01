CREATE TABLE `space_mount_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`mount_id` text NOT NULL,
	`file_id` text NOT NULL,
	`base` text NOT NULL,
	`text` text,
	`base_text` text,
	`blob` text,
	`mime` text,
	`conflict` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mount_id`) REFERENCES `space_mount`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `space_mount_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_mount_draft_file` ON `space_mount_draft` (`file_id`);--> statement-breakpoint
CREATE INDEX `space_mount_draft_mount` ON `space_mount_draft` (`mount_id`);--> statement-breakpoint
ALTER TABLE `space_mount` ADD `writable` integer DEFAULT false NOT NULL;