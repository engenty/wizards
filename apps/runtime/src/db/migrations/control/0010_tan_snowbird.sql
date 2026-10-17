CREATE TABLE `ui_translation` (
	`lang` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`texts` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
