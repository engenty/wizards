CREATE TABLE `space_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`plugin` text,
	`name` text NOT NULL,
	`label` text,
	`sign_in` text NOT NULL,
	`audience` text NOT NULL,
	`rules` text NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`secret` text,
	`set_up_by` text,
	`set_up_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_connection_space` ON `space_connection` (`space_id`);--> statement-breakpoint
CREATE TABLE `space_connection_sign_in` (
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`secret` text NOT NULL,
	`signed_in_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`connection_id`, `user_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `space_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `space_connection` (`id`, `space_id`, `connector_id`, `plugin`, `name`, `label`, `sign_in`, `audience`, `rules`, `actions`, `secret`, `set_up_by`, `set_up_at`, `updated_at`, `last_used_at`)
SELECT `id`, `space_id`, `connector`, `plugin`, `label`, `label`, 'space', 'all', '{"read":"allow","write":"ask","destructive":"deny","send":"ask"}', `actions`, `data`, `created_by`, `created_at`, `updated_at`, NULL
FROM `plugin_connection`;--> statement-breakpoint
DROP TABLE `plugin_connection`;
