DROP INDEX `space_table_list`;--> statement-breakpoint
CREATE UNIQUE INDEX `space_table_list` ON `space_table` (`space_id`,`wizard_id`,`list`);--> statement-breakpoint
ALTER TABLE `run` ADD `client_space_id` text REFERENCES space(id);--> statement-breakpoint
ALTER TABLE `run` ADD `client_shared_at` integer;--> statement-breakpoint
CREATE INDEX `run_client_space` ON `run` (`client_space_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `space` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `space_slug` ON `space` (`tenant_id`,`slug`);--> statement-breakpoint
UPDATE `space` SET `slug` = `id` WHERE `kind` = 'client';