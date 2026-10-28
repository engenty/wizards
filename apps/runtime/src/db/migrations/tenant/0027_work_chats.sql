CREATE TABLE `chat` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`section_id` text,
	`parent_id` text,
	`private` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_author_id` text,
	`last_author_name` text,
	`last_text` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `chat_section`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_project` ON `chat` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chat_parent` ON `chat` (`parent_id`);--> statement-breakpoint
CREATE TABLE `chat_member` (
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`member_id` text NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`chat_id`, `kind`, `member_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_member_member` ON `chat_member` (`kind`,`member_id`);--> statement-breakpoint
CREATE TABLE `chat_section` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_section_project` ON `chat_section` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `chat_state` (
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`pinned_at` integer,
	`archived_at` integer,
	`read_at` integer,
	PRIMARY KEY(`chat_id`, `user_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
