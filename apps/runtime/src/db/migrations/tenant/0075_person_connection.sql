CREATE TABLE `connection_choice` (
	`wizard_id` text NOT NULL,
	`need` text NOT NULL,
	`holder` text NOT NULL,
	`person_connection_id` text,
	`space_connection_id` text,
	`chosen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`wizard_id`, `need`, `holder`),
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_connection_id`) REFERENCES `person_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_connection_id`) REFERENCES `space_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connection_choice_person` ON `connection_choice` (`person_connection_id`);--> statement-breakpoint
CREATE TABLE `person_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`connector_id` text NOT NULL,
	`label` text NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_connection_account` ON `person_connection` (`holder`,`connector_id`,`label`);