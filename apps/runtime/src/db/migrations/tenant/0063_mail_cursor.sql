CREATE TABLE `mail_cursor` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`since` integer NOT NULL,
	`next_at` integer,
	`read_at` integer,
	`error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `space_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `space_connection` ADD `autonomous_mode` text DEFAULT 'off' NOT NULL;