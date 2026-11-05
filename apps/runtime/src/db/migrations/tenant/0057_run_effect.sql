CREATE TABLE `run_effect` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`tool` text NOT NULL,
	`state` text NOT NULL,
	`output` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_effect_run` ON `run_effect` (`run_id`);