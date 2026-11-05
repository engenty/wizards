CREATE TABLE `run_effect` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`tool` text NOT NULL,
	`state` text NOT NULL,
	`output` text,
	`at` integer NOT NULL
);
