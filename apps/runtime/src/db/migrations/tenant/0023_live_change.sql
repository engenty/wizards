CREATE TABLE `live_change` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`op` text NOT NULL,
	`item` text NOT NULL,
	`parent` text,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `live_change_at` ON `live_change` (`at`);--> statement-breakpoint
CREATE TRIGGER `live_project_ai` AFTER INSERT ON `project` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.id, 'space', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_au` AFTER UPDATE ON `project` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.id, 'space', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_ad` AFTER DELETE ON `project` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.id, 'space', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_ai` AFTER INSERT ON `wizard` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_au` AFTER UPDATE ON `wizard` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_ad` AFTER DELETE ON `wizard` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'wizard', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_ai` AFTER INSERT ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_au` AFTER UPDATE ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_ad` AFTER DELETE ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_ai` AFTER INSERT ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'translation', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.wizard_id || ':' || new.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_au` AFTER UPDATE ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'translation', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.wizard_id || ':' || new.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_ad` AFTER DELETE ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id), 'translation', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.wizard_id || ':' || old.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_ai` AFTER INSERT ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'message', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_au` AFTER UPDATE ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = new.wizard_id), 'message', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_ad` AFTER DELETE ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM wizard WHERE id = old.wizard_id), 'message', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_ai` AFTER INSERT ON `space_page` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'page', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_au` AFTER UPDATE ON `space_page` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'page', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_ad` AFTER DELETE ON `space_page` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'page', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_ai` AFTER INSERT ON `space_table` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'table', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_au` AFTER UPDATE ON `space_table` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'table', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_ad` AFTER DELETE ON `space_table` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'table', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_ai` AFTER INSERT ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_table WHERE id = new.table_id), 'row', 'put', i, new.table_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_au` AFTER UPDATE ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_table WHERE id = new.table_id), 'row', 'put', i, new.table_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_ad` AFTER DELETE ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_table WHERE id = old.table_id), 'row', 'del', i, old.table_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_ai` AFTER INSERT ON `space_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_au` AFTER UPDATE ON `space_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_ad` AFTER DELETE ON `space_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'category', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_ai` AFTER INSERT ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_category WHERE id = new.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_au` AFTER UPDATE ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_category WHERE id = new.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_ad` AFTER DELETE ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM space_category WHERE id = old.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_ai` AFTER INSERT ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN new.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = new.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_au` AFTER UPDATE ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN new.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = new.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_ad` AFTER DELETE ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, CASE WHEN old.page_id IS NOT NULL THEN 'page' WHEN old.row_id IS NOT NULL THEN 'row' WHEN old.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN old.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = old.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(old.page_id, old.row_id, old.table_id, old.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_file_ai` AFTER INSERT ON `project_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'file', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_file_au` AFTER UPDATE ON `project_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'file', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_file_ad` AFTER DELETE ON `project_file` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'file', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_connector_ai` AFTER INSERT ON `project_connector` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'connector', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.project_id || ':' || new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_connector_au` AFTER UPDATE ON `project_connector` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'connector', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.project_id || ':' || new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_project_connector_ad` AFTER DELETE ON `project_connector` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'connector', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.project_id || ':' || old.id AS i) WHERE i IS NOT NULL;
END;
