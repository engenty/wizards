ALTER TABLE `space_file` ADD `hash` text;--> statement-breakpoint
CREATE INDEX `space_file_hash` ON `space_file` (`hash`);