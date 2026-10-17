CREATE TABLE `wizard_translation` (
	`wizard_id` text NOT NULL,
	`lang` text NOT NULL,
	`texts` text NOT NULL,
	`version` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`wizard_id`, `lang`),
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `run` ADD `lang` text;--> statement-breakpoint
ALTER TABLE `wizard` ADD `translate` integer DEFAULT true NOT NULL;