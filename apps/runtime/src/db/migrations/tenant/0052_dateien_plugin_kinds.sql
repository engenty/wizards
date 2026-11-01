ALTER TABLE `space_mount` ADD `plugin` text;--> statement-breakpoint
ALTER TABLE `space_mount` ADD `location` text;--> statement-breakpoint
ALTER TABLE `space_mount` ADD `cursor` text;--> statement-breakpoint
ALTER TABLE `space_mount_file` ADD `source_id` text;--> statement-breakpoint
CREATE INDEX `space_mount_file_source` ON `space_mount_file` (`mount_id`,`source_id`);