CREATE TABLE `sync_base` (
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`project_id` text NOT NULL,
	`seq` integer NOT NULL,
	`record` text,
	PRIMARY KEY(`kind`, `item`)
);
--> statement-breakpoint
CREATE INDEX `sync_base_project` ON `sync_base` (`project_id`);--> statement-breakpoint
CREATE TABLE `sync_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_change_item` ON `sync_change` (`kind`,`item`);--> statement-breakpoint
CREATE INDEX `sync_change_project` ON `sync_change` (`project_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_conflict` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`seq` integer NOT NULL,
	`base` text,
	`local` text,
	`remote` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_conflict_item` ON `sync_conflict` (`kind`,`item`);--> statement-breakpoint
CREATE TABLE `sync_guard` (
	`id` integer PRIMARY KEY NOT NULL,
	`applying` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_merge` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`local` text NOT NULL,
	`remote` text NOT NULL,
	`before` text NOT NULL,
	`seen` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_merge_item` ON `sync_merge` (`kind`,`item`,`created_at`);--> statement-breakpoint
INSERT INTO `sync_guard` (`id`, `applying`) VALUES (1, 0);--> statement-breakpoint
CREATE TRIGGER `sync_project_ai` AFTER INSERT ON `project` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.id AS p, 'space' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_au` AFTER UPDATE ON `project` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.id AS p, 'space' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_ad` AFTER DELETE ON `project` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.id AS p, 'space' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_ai` AFTER INSERT ON `wizard` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'wizard' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_au` AFTER UPDATE ON `wizard` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'wizard' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_ad` AFTER DELETE ON `wizard` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'wizard' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_ai` AFTER INSERT ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'wizard' AS k, new.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_au` AFTER UPDATE ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'wizard' AS k, new.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_ad` AFTER DELETE ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id) AS p, 'wizard' AS k, old.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_ai` AFTER INSERT ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'translation' AS k, new.wizard_id || ':' || new.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_au` AFTER UPDATE ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'translation' AS k, new.wizard_id || ':' || new.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_ad` AFTER DELETE ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id) AS p, 'translation' AS k, old.wizard_id || ':' || old.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_ai` AFTER INSERT ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'message' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_au` AFTER UPDATE ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id) AS p, 'message' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_ad` AFTER DELETE ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id) AS p, 'message' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_ai` AFTER INSERT ON `space_page` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'page' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_au` AFTER UPDATE ON `space_page` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'page' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_ad` AFTER DELETE ON `space_page` WHEN old.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'page' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_ai` AFTER INSERT ON `space_table` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'table' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_au` AFTER UPDATE ON `space_table` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'table' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_ad` AFTER DELETE ON `space_table` WHEN old.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'table' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_ai` AFTER INSERT ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_table WHERE id = new.table_id AND wizard_id IS NULL) AS p, 'row' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_au` AFTER UPDATE ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_table WHERE id = new.table_id AND wizard_id IS NULL) AS p, 'row' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_ad` AFTER DELETE ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_table WHERE id = old.table_id AND wizard_id IS NULL) AS p, 'row' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_ai` AFTER INSERT ON `space_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'category' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_au` AFTER UPDATE ON `space_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'category' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_ad` AFTER DELETE ON `space_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'category' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_ai` AFTER INSERT ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_category WHERE id = new.category_id) AS p, 'category' AS k, new.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_au` AFTER UPDATE ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_category WHERE id = new.category_id) AS p, 'category' AS k, new.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_ad` AFTER DELETE ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT project_id FROM space_category WHERE id = old.category_id) AS p, 'category' AS k, old.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_ai` AFTER INSERT ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_au` AFTER UPDATE ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_ad` AFTER DELETE ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, CASE WHEN old.page_id IS NOT NULL THEN 'page' WHEN old.row_id IS NOT NULL THEN 'row' WHEN old.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(old.page_id, old.row_id, old.table_id, old.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_file_ai` AFTER INSERT ON `project_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'file' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_file_au` AFTER UPDATE ON `project_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'file' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_file_ad` AFTER DELETE ON `project_file` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'file' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_connector_ai` AFTER INSERT ON `project_connector` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'connector' AS k, new.project_id || ':' || new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_connector_au` AFTER UPDATE ON `project_connector` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.project_id AS p, 'connector' AS k, new.project_id || ':' || new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_project_connector_ad` AFTER DELETE ON `project_connector` BEGIN
	INSERT INTO `sync_change` (`project_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.project_id AS p, 'connector' AS k, old.project_id || ':' || old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;