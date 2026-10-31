CREATE TABLE `rwx_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`r` text,
	`w` text,
	`x` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rwx_rule_key` ON `rwx_rule` (`space_id`,`subject_kind`,`subject_id`,`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE INDEX `rwx_rule_space` ON `rwx_rule` (`space_id`);