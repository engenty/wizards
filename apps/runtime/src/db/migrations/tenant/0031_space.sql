-- project becomes space: the tables, their project_id columns, their indexes, the search index
-- and the triggers of the sync and the live feed take the new names; the data stays.
DROP TRIGGER `project_chunk_ai`;--> statement-breakpoint
DROP TRIGGER `project_chunk_ad`;--> statement-breakpoint
DROP TRIGGER `project_chunk_tri_ai`;--> statement-breakpoint
DROP TRIGGER `project_chunk_tri_ad`;--> statement-breakpoint
DROP TRIGGER `sync_project_ai`;--> statement-breakpoint
DROP TRIGGER `sync_project_au`;--> statement-breakpoint
DROP TRIGGER `sync_project_ad`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_ai`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_au`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_ad`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_file_ai`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_file_au`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_file_ad`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_translation_ai`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_translation_au`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_translation_ad`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_message_ai`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_message_au`;--> statement-breakpoint
DROP TRIGGER `sync_wizard_message_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_page_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_page_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_page_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_row_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_row_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_table_row_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_value_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_value_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_category_value_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_item_category_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_item_category_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_item_category_ad`;--> statement-breakpoint
DROP TRIGGER `sync_project_file_ai`;--> statement-breakpoint
DROP TRIGGER `sync_project_file_au`;--> statement-breakpoint
DROP TRIGGER `sync_project_file_ad`;--> statement-breakpoint
DROP TRIGGER `sync_project_connector_ai`;--> statement-breakpoint
DROP TRIGGER `sync_project_connector_au`;--> statement-breakpoint
DROP TRIGGER `sync_project_connector_ad`;--> statement-breakpoint
DROP TRIGGER `live_project_ai`;--> statement-breakpoint
DROP TRIGGER `live_project_au`;--> statement-breakpoint
DROP TRIGGER `live_project_ad`;--> statement-breakpoint
DROP TRIGGER `live_wizard_ai`;--> statement-breakpoint
DROP TRIGGER `live_wizard_au`;--> statement-breakpoint
DROP TRIGGER `live_wizard_ad`;--> statement-breakpoint
DROP TRIGGER `live_wizard_file_ai`;--> statement-breakpoint
DROP TRIGGER `live_wizard_file_au`;--> statement-breakpoint
DROP TRIGGER `live_wizard_file_ad`;--> statement-breakpoint
DROP TRIGGER `live_wizard_translation_ai`;--> statement-breakpoint
DROP TRIGGER `live_wizard_translation_au`;--> statement-breakpoint
DROP TRIGGER `live_wizard_translation_ad`;--> statement-breakpoint
DROP TRIGGER `live_wizard_message_ai`;--> statement-breakpoint
DROP TRIGGER `live_wizard_message_au`;--> statement-breakpoint
DROP TRIGGER `live_wizard_message_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_page_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_page_au`;--> statement-breakpoint
DROP TRIGGER `live_space_page_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_table_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_table_au`;--> statement-breakpoint
DROP TRIGGER `live_space_table_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_table_row_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_table_row_au`;--> statement-breakpoint
DROP TRIGGER `live_space_table_row_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_category_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_category_au`;--> statement-breakpoint
DROP TRIGGER `live_space_category_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_category_value_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_category_value_au`;--> statement-breakpoint
DROP TRIGGER `live_space_category_value_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_item_category_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_item_category_au`;--> statement-breakpoint
DROP TRIGGER `live_space_item_category_ad`;--> statement-breakpoint
DROP TRIGGER `live_project_file_ai`;--> statement-breakpoint
DROP TRIGGER `live_project_file_au`;--> statement-breakpoint
DROP TRIGGER `live_project_file_ad`;--> statement-breakpoint
DROP TRIGGER `live_project_connector_ai`;--> statement-breakpoint
DROP TRIGGER `live_project_connector_au`;--> statement-breakpoint
DROP TRIGGER `live_project_connector_ad`;--> statement-breakpoint
DROP TRIGGER `live_presence_ai`;--> statement-breakpoint
DROP TRIGGER `live_presence_au`;--> statement-breakpoint
DROP TRIGGER `live_presence_ad`;--> statement-breakpoint
DROP TRIGGER `live_chat_ai`;--> statement-breakpoint
DROP TRIGGER `live_chat_au`;--> statement-breakpoint
DROP TRIGGER `live_chat_ad`;--> statement-breakpoint
DROP TRIGGER `live_chat_member_ai`;--> statement-breakpoint
DROP TRIGGER `live_chat_member_au`;--> statement-breakpoint
DROP TRIGGER `live_chat_member_ad`;--> statement-breakpoint
DROP TRIGGER `live_chat_approval_ai`;--> statement-breakpoint
DROP TRIGGER `live_chat_approval_au`;--> statement-breakpoint
DROP TRIGGER `live_chat_approval_ad`;--> statement-breakpoint
DROP TRIGGER `live_chat_section_ai`;--> statement-breakpoint
DROP TRIGGER `live_chat_section_au`;--> statement-breakpoint
DROP TRIGGER `live_chat_section_ad`;--> statement-breakpoint
DROP TRIGGER `sync_space_skill_ai`;--> statement-breakpoint
DROP TRIGGER `sync_space_skill_au`;--> statement-breakpoint
DROP TRIGGER `sync_space_skill_ad`;--> statement-breakpoint
DROP TRIGGER `live_space_skill_ai`;--> statement-breakpoint
DROP TRIGGER `live_space_skill_au`;--> statement-breakpoint
DROP TRIGGER `live_space_skill_ad`;--> statement-breakpoint
DROP TABLE `project_chunk_fts`;--> statement-breakpoint
DROP TABLE `project_chunk_tri`;--> statement-breakpoint
DROP INDEX `project_tenant`;--> statement-breakpoint
DROP INDEX `wizard_project`;--> statement-breakpoint
DROP INDEX `project_file_project`;--> statement-breakpoint
DROP INDEX `project_chunk_project`;--> statement-breakpoint
DROP INDEX `project_chunk_file`;--> statement-breakpoint
DROP INDEX `project_chunk_ref`;--> statement-breakpoint
DROP INDEX `space_page_project`;--> statement-breakpoint
DROP INDEX `space_table_project`;--> statement-breakpoint
DROP INDEX `project_chunk_page`;--> statement-breakpoint
DROP INDEX `project_chunk_row`;--> statement-breakpoint
DROP INDEX `project_chunk_table`;--> statement-breakpoint
DROP INDEX `project_chunk_value`;--> statement-breakpoint
DROP INDEX `project_file_origin`;--> statement-breakpoint
DROP INDEX `sync_base_project`;--> statement-breakpoint
DROP INDEX `sync_change_project`;--> statement-breakpoint
DROP INDEX `chat_project`;--> statement-breakpoint
DROP INDEX `chat_section_project`;--> statement-breakpoint
ALTER TABLE `project` RENAME TO `space`;--> statement-breakpoint
ALTER TABLE `project_connector` RENAME TO `space_connector`;--> statement-breakpoint
ALTER TABLE `project_file` RENAME TO `space_file`;--> statement-breakpoint
ALTER TABLE `project_chunk` RENAME TO `space_chunk`;--> statement-breakpoint
ALTER TABLE `space_connector` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `wizard` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_file` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_chunk` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_page` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_table` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_category` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_item_category` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `plugin_connection` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `sync_base` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `sync_change` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `sync_conflict` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `sync_merge` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `live_change` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `chat` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `chat_section` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
ALTER TABLE `space_skill` RENAME COLUMN `project_id` TO `space_id`;--> statement-breakpoint
CREATE INDEX `space_tenant` ON `space` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `wizard_space` ON `wizard` (`space_id`);--> statement-breakpoint
CREATE INDEX `space_file_space` ON `space_file` (`space_id`,`kind`,`position`);--> statement-breakpoint
CREATE INDEX `space_chunk_space` ON `space_chunk` (`space_id`,`model`);--> statement-breakpoint
CREATE INDEX `space_chunk_file` ON `space_chunk` (`file_id`);--> statement-breakpoint
CREATE INDEX `space_chunk_ref` ON `space_chunk` (`space_id`,`plugin`,`ref`);--> statement-breakpoint
CREATE INDEX `space_page_space` ON `space_page` (`space_id`,`wizard_id`);--> statement-breakpoint
CREATE INDEX `space_table_space` ON `space_table` (`space_id`,`wizard_id`);--> statement-breakpoint
CREATE INDEX `space_chunk_page` ON `space_chunk` (`page_id`);--> statement-breakpoint
CREATE INDEX `space_chunk_row` ON `space_chunk` (`row_id`);--> statement-breakpoint
CREATE INDEX `space_chunk_table` ON `space_chunk` (`table_id`);--> statement-breakpoint
CREATE INDEX `space_chunk_value` ON `space_chunk` (`value_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_file_origin` ON `space_file` (`space_id`,`origin`,`origin_key`);--> statement-breakpoint
CREATE INDEX `sync_base_space` ON `sync_base` (`space_id`);--> statement-breakpoint
CREATE INDEX `sync_change_space` ON `sync_change` (`space_id`,`seq`);--> statement-breakpoint
CREATE INDEX `chat_space` ON `chat` (`space_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chat_section_space` ON `chat_section` (`space_id`,`position`);--> statement-breakpoint
CREATE VIRTUAL TABLE `space_chunk_fts` USING fts5(`text`, content='space_chunk', content_rowid='id', tokenize='unicode61 remove_diacritics 2');--> statement-breakpoint
INSERT INTO `space_chunk_fts`(`space_chunk_fts`) VALUES ('rebuild');--> statement-breakpoint
CREATE VIRTUAL TABLE `space_chunk_tri` USING fts5(`text`, content='space_chunk', content_rowid='id', tokenize='trigram remove_diacritics 1');--> statement-breakpoint
INSERT INTO `space_chunk_tri`(`space_chunk_tri`) VALUES ('rebuild');--> statement-breakpoint
CREATE TRIGGER `space_chunk_ai` AFTER INSERT ON `space_chunk` BEGIN
	INSERT INTO `space_chunk_fts`(rowid, `text`) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER `space_chunk_ad` AFTER DELETE ON `space_chunk` BEGIN
	INSERT INTO `space_chunk_fts`(`space_chunk_fts`, rowid, `text`) VALUES ('delete', old.id, old.text);
END;--> statement-breakpoint
CREATE TRIGGER `space_chunk_tri_ai` AFTER INSERT ON `space_chunk` BEGIN
	INSERT INTO `space_chunk_tri`(rowid, `text`) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER `space_chunk_tri_ad` AFTER DELETE ON `space_chunk` BEGIN
	INSERT INTO `space_chunk_tri`(`space_chunk_tri`, rowid, `text`) VALUES ('delete', old.id, old.text);
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_ai` AFTER INSERT ON `space` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.id AS p, 'space' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_au` AFTER UPDATE ON `space` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.id AS p, 'space' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_ad` AFTER DELETE ON `space` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.id AS p, 'space' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_ai` AFTER INSERT ON `wizard` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'wizard' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_au` AFTER UPDATE ON `wizard` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'wizard' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_ad` AFTER DELETE ON `wizard` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'wizard' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_ai` AFTER INSERT ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'wizard' AS k, new.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_au` AFTER UPDATE ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'wizard' AS k, new.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_file_ad` AFTER DELETE ON `wizard_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id) AS p, 'wizard' AS k, old.wizard_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_ai` AFTER INSERT ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'translation' AS k, new.wizard_id || ':' || new.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_au` AFTER UPDATE ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'translation' AS k, new.wizard_id || ':' || new.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_translation_ad` AFTER DELETE ON `wizard_translation` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id) AS p, 'translation' AS k, old.wizard_id || ':' || old.lang AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_ai` AFTER INSERT ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'message' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_au` AFTER UPDATE ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id) AS p, 'message' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_wizard_message_ad` AFTER DELETE ON `wizard_message` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id) AS p, 'message' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_ai` AFTER INSERT ON `space_page` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'page' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_au` AFTER UPDATE ON `space_page` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'page' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_page_ad` AFTER DELETE ON `space_page` WHEN old.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'page' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_ai` AFTER INSERT ON `space_table` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'table' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_au` AFTER UPDATE ON `space_table` WHEN new.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'table' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_ad` AFTER DELETE ON `space_table` WHEN old.wizard_id IS NULL BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'table' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_ai` AFTER INSERT ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_table WHERE id = new.table_id AND wizard_id IS NULL) AS p, 'row' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_au` AFTER UPDATE ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_table WHERE id = new.table_id AND wizard_id IS NULL) AS p, 'row' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_table_row_ad` AFTER DELETE ON `space_table_row` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_table WHERE id = old.table_id AND wizard_id IS NULL) AS p, 'row' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_ai` AFTER INSERT ON `space_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'category' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_au` AFTER UPDATE ON `space_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'category' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_ad` AFTER DELETE ON `space_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'category' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_ai` AFTER INSERT ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_category WHERE id = new.category_id) AS p, 'category' AS k, new.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_au` AFTER UPDATE ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_category WHERE id = new.category_id) AS p, 'category' AS k, new.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_category_value_ad` AFTER DELETE ON `space_category_value` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT (SELECT space_id FROM space_category WHERE id = old.category_id) AS p, 'category' AS k, old.category_id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_ai` AFTER INSERT ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_au` AFTER UPDATE ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_item_category_ad` AFTER DELETE ON `space_item_category` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, CASE WHEN old.page_id IS NOT NULL THEN 'page' WHEN old.row_id IS NOT NULL THEN 'row' WHEN old.table_id IS NOT NULL THEN 'table' ELSE 'file' END AS k, COALESCE(old.page_id, old.row_id, old.table_id, old.file_id) AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_file_ai` AFTER INSERT ON `space_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'file' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_file_au` AFTER UPDATE ON `space_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'file' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_file_ad` AFTER DELETE ON `space_file` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'file' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_connector_ai` AFTER INSERT ON `space_connector` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'connector' AS k, new.space_id || ':' || new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_connector_au` AFTER UPDATE ON `space_connector` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'connector' AS k, new.space_id || ':' || new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_connector_ad` AFTER DELETE ON `space_connector` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'connector' AS k, old.space_id || ':' || old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_skill_ai` AFTER INSERT ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'skill' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_skill_au` AFTER UPDATE ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT new.space_id AS p, 'skill' AS k, new.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `sync_space_skill_ad` AFTER DELETE ON `space_skill` BEGIN
	INSERT INTO `sync_change` (`space_id`, `kind`, `item`, `at`)
	SELECT p, k, i, unixepoch() * 1000 FROM (SELECT old.space_id AS p, 'skill' AS k, old.id AS i)
	WHERE p IS NOT NULL AND i IS NOT NULL AND (SELECT `applying` FROM `sync_guard` WHERE `id` = 1) = 0;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_ai` AFTER INSERT ON `space` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.id, 'space', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_au` AFTER UPDATE ON `space` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.id, 'space', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_ad` AFTER DELETE ON `space` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.id, 'space', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_ai` AFTER INSERT ON `wizard` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_au` AFTER UPDATE ON `wizard` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_ad` AFTER DELETE ON `wizard` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'wizard', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_ai` AFTER INSERT ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_au` AFTER UPDATE ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_file_ad` AFTER DELETE ON `wizard_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id), 'wizard', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.wizard_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_ai` AFTER INSERT ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'translation', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.wizard_id || ':' || new.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_au` AFTER UPDATE ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'translation', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.wizard_id || ':' || new.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_translation_ad` AFTER DELETE ON `wizard_translation` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id), 'translation', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.wizard_id || ':' || old.lang AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_ai` AFTER INSERT ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'message', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_au` AFTER UPDATE ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = new.wizard_id), 'message', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_wizard_message_ad` AFTER DELETE ON `wizard_message` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM wizard WHERE id = old.wizard_id), 'message', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_ai` AFTER INSERT ON `space_page` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'page', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_au` AFTER UPDATE ON `space_page` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'page', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_page_ad` AFTER DELETE ON `space_page` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'page', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_ai` AFTER INSERT ON `space_table` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'table', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_au` AFTER UPDATE ON `space_table` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'table', 'put', i, new.wizard_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_ad` AFTER DELETE ON `space_table` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'table', 'del', i, old.wizard_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_ai` AFTER INSERT ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_table WHERE id = new.table_id), 'row', 'put', i, new.table_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_au` AFTER UPDATE ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_table WHERE id = new.table_id), 'row', 'put', i, new.table_id, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_table_row_ad` AFTER DELETE ON `space_table_row` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_table WHERE id = old.table_id), 'row', 'del', i, old.table_id, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_ai` AFTER INSERT ON `space_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_au` AFTER UPDATE ON `space_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_ad` AFTER DELETE ON `space_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'category', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_ai` AFTER INSERT ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_category WHERE id = new.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_au` AFTER UPDATE ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_category WHERE id = new.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_category_value_ad` AFTER DELETE ON `space_category_value` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM space_category WHERE id = old.category_id), 'category', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.category_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_ai` AFTER INSERT ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN new.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = new.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_au` AFTER UPDATE ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, CASE WHEN new.page_id IS NOT NULL THEN 'page' WHEN new.row_id IS NOT NULL THEN 'row' WHEN new.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN new.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = new.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(new.page_id, new.row_id, new.table_id, new.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_item_category_ad` AFTER DELETE ON `space_item_category` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, CASE WHEN old.page_id IS NOT NULL THEN 'page' WHEN old.row_id IS NOT NULL THEN 'row' WHEN old.table_id IS NOT NULL THEN 'table' ELSE 'file' END, 'put', i, CASE WHEN old.row_id IS NOT NULL THEN (SELECT table_id FROM space_table_row WHERE id = old.row_id) END, unixepoch() * 1000 FROM (SELECT COALESCE(old.page_id, old.row_id, old.table_id, old.file_id) AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_file_ai` AFTER INSERT ON `space_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'file', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_file_au` AFTER UPDATE ON `space_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'file', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_file_ad` AFTER DELETE ON `space_file` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'file', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_connector_ai` AFTER INSERT ON `space_connector` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'connector', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.space_id || ':' || new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_connector_au` AFTER UPDATE ON `space_connector` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'connector', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.space_id || ':' || new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_connector_ad` AFTER DELETE ON `space_connector` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'connector', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.space_id || ':' || old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_skill_ai` AFTER INSERT ON `space_skill` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'skill', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_skill_au` AFTER UPDATE ON `space_skill` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'skill', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_space_skill_ad` AFTER DELETE ON `space_skill` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'skill', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_presence_ai` AFTER INSERT ON `live_presence` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, new.kind, unixepoch() * 1000 FROM (SELECT new.kind || ':' || new.item AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_presence_au` AFTER UPDATE ON `live_presence` WHEN old.state IS NOT new.state OR old.place IS NOT new.place OR old.name IS NOT new.name BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, new.kind, unixepoch() * 1000 FROM (SELECT new.kind || ':' || new.item AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_presence_ad` AFTER DELETE ON `live_presence` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, old.kind, unixepoch() * 1000 FROM (SELECT old.kind || ':' || old.item AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_ai` AFTER INSERT ON `chat` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_au` AFTER UPDATE ON `chat` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_ad` AFTER DELETE ON `chat` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'chat', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_ai` AFTER INSERT ON `chat_member` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_au` AFTER UPDATE ON `chat_member` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_ad` AFTER DELETE ON `chat_member` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = old.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_ai` AFTER INSERT ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_au` AFTER UPDATE ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_ad` AFTER DELETE ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = old.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_ai` AFTER INSERT ON `chat_section` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'chat', 'put', i, 'section', unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_au` AFTER UPDATE ON `chat_section` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.space_id, 'chat', 'put', i, 'section', unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_ad` AFTER DELETE ON `chat_section` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.space_id, 'chat', 'del', i, 'section', unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
UPDATE `sync_base` SET `record` = json_remove(json_set(`record`, '$.spaceId', json_extract(`record`, '$.projectId')), '$.projectId') WHERE json_valid(`record`) AND json_type(`record`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_conflict` SET `base` = json_remove(json_set(`base`, '$.spaceId', json_extract(`base`, '$.projectId')), '$.projectId') WHERE json_valid(`base`) AND json_type(`base`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_conflict` SET `local` = json_remove(json_set(`local`, '$.spaceId', json_extract(`local`, '$.projectId')), '$.projectId') WHERE json_valid(`local`) AND json_type(`local`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_conflict` SET `remote` = json_remove(json_set(`remote`, '$.spaceId', json_extract(`remote`, '$.projectId')), '$.projectId') WHERE json_valid(`remote`) AND json_type(`remote`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_merge` SET `local` = json_remove(json_set(`local`, '$.spaceId', json_extract(`local`, '$.projectId')), '$.projectId') WHERE json_valid(`local`) AND json_type(`local`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_merge` SET `remote` = json_remove(json_set(`remote`, '$.spaceId', json_extract(`remote`, '$.projectId')), '$.projectId') WHERE json_valid(`remote`) AND json_type(`remote`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `sync_merge` SET `before` = json_remove(json_set(`before`, '$.spaceId', json_extract(`before`, '$.projectId')), '$.projectId') WHERE json_valid(`before`) AND json_type(`before`, '$.projectId') IS NOT NULL;--> statement-breakpoint
UPDATE `asset` SET `kind` = 'space' WHERE `kind` = 'project';
