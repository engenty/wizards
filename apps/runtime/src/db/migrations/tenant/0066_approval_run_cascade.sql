PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`chat_id` text,
	`run_id` text,
	`step_id` text,
	`tool_name` text NOT NULL,
	`input` text,
	`asked_by` text NOT NULL,
	`held_for` text DEFAULT 'asker' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chat`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_approval`("id", "tenant_id", "chat_id", "run_id", "step_id", "tool_name", "input", "asked_by", "held_for", "state", "output", "decided_by", "decided_at", "created_at") SELECT "id", "tenant_id", "chat_id", "run_id", "step_id", "tool_name", "input", "asked_by", "held_for", "state", "output", "decided_by", "decided_at", "created_at" FROM `approval`;--> statement-breakpoint
DROP TABLE `approval`;--> statement-breakpoint
ALTER TABLE `__new_approval` RENAME TO `approval`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approval_chat` ON `approval` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `approval_state` ON `approval` (`tenant_id`,`state`);--> statement-breakpoint
CREATE INDEX `approval_run` ON `approval` (`run_id`,`step_id`);