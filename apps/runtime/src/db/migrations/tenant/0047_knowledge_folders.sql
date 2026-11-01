ALTER TABLE `space_file` ADD `parent_id` text REFERENCES space_page(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `space_table` ADD `parent_id` text REFERENCES space_page(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `space_table` ADD `position` integer DEFAULT 0 NOT NULL;