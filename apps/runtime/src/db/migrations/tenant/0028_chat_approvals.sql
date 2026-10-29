CREATE TABLE `chat_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input` text,
	`asked_by` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_approval_chat` ON `chat_approval` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_approval_state` ON `chat_approval` (`tenant_id`,`state`);