CREATE TABLE `run_row` (
	`run_id` text NOT NULL,
	`n` integer NOT NULL,
	`step` text NOT NULL,
	`kind` text NOT NULL,
	`state` text,
	`data` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `n`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_score` (
	`run_id` text NOT NULL,
	`eval` text NOT NULL,
	`row` integer NOT NULL,
	`score` real,
	`data` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `eval`, `row`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
