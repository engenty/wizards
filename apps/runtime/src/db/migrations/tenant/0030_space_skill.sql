CREATE TABLE IF NOT EXISTS `space_skill` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`blob_files` text DEFAULT '[]' NOT NULL,
	`mode` text DEFAULT 'demand' NOT NULL,
	`run_scripts` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'own' NOT NULL,
	`origin` text,
	`origin_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `space_skill_name` ON `space_skill` (`project_id`,`name`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sync_space_skill_ai` AFTER INSERT ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'skill' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sync_space_skill_au` AFTER UPDATE ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'skill' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sync_space_skill_ad` AFTER DELETE ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'skill' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `live_space_skill_ai` AFTER INSERT ON `space_skill` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'skill', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `live_space_skill_au` AFTER UPDATE ON `space_skill` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'skill', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `live_space_skill_ad` AFTER DELETE ON `space_skill` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'skill', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;
