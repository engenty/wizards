ALTER TABLE `space_skill` ADD `blob_files` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `space_skill` ADD `run_scripts` integer DEFAULT false NOT NULL;