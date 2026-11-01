ALTER TABLE `space_mount_file` ADD `title` text;--> statement-breakpoint
-- Files read before get read once more, for their titles; their vectors stay (same bytes).
UPDATE `space_mount_file` SET `status` = 'pending' WHERE `status` = 'ready';