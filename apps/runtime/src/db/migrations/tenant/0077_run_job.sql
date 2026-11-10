CREATE TABLE `run_job` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`owner` text,
	`seen` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_job_run` ON `run_job` (`run_id`,`step_id`);