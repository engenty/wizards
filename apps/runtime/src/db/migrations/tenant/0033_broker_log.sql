CREATE TABLE `broker_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`who_kind` text NOT NULL,
	`who_id` text,
	`run_id` text,
	`chat_id` text,
	`wizard_id` text,
	`space_id` text,
	`connection_id` text NOT NULL,
	`action_id` text NOT NULL,
	`kind` text NOT NULL,
	`input_summary` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`result` text,
	`result_size` integer,
	`critical` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broker_log_connection` ON `broker_log` (`connection_id`,`at`);--> statement-breakpoint
CREATE INDEX `broker_log_space` ON `broker_log` (`space_id`,`at`);