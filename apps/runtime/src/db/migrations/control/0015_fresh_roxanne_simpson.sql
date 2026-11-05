ALTER TABLE `run_index` ADD `wake_at` integer;--> statement-breakpoint
CREATE INDEX `run_index_wake` ON `run_index` (`wake_at`);