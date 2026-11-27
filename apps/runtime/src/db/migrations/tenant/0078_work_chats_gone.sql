-- Work's chats are the chats of the team's Bot Server now: the studio's own chats, their
-- sections and the calls held in them go. The live triggers go first, so nothing is told of rows
-- that are deleted with their tables.
DROP TRIGGER IF EXISTS `live_chat_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_member_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_member_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_member_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_section_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_section_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_chat_section_ad`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_approval_ai`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_approval_au`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `live_approval_ad`;--> statement-breakpoint
DELETE FROM `approval` WHERE `chat_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `live_change` WHERE `kind` = 'chat';--> statement-breakpoint
DROP TABLE `chat_state`;--> statement-breakpoint
DROP TABLE `chat_member`;--> statement-breakpoint
DROP TABLE `chat`;--> statement-breakpoint
DROP TABLE `chat_section`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
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
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_approval`("id", "tenant_id", "run_id", "step_id", "tool_name", "input", "asked_by", "held_for", "state", "output", "decided_by", "decided_at", "created_at") SELECT "id", "tenant_id", "run_id", "step_id", "tool_name", "input", "asked_by", "held_for", "state", "output", "decided_by", "decided_at", "created_at" FROM `approval`;--> statement-breakpoint
DROP TABLE `approval`;--> statement-breakpoint
ALTER TABLE `__new_approval` RENAME TO `approval`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approval_state` ON `approval` (`tenant_id`,`state`);--> statement-breakpoint
CREATE INDEX `approval_run` ON `approval` (`run_id`,`step_id`);