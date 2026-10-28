ALTER TABLE `chat` ADD `answering_since` integer;--> statement-breakpoint
CREATE TRIGGER `live_chat_ai` AFTER INSERT ON `chat` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_au` AFTER UPDATE ON `chat` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_ad` AFTER DELETE ON `chat` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'chat', 'del', i, NULL, unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_ai` AFTER INSERT ON `chat_member` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_au` AFTER UPDATE ON `chat_member` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_member_ad` AFTER DELETE ON `chat_member` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = old.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_ai` AFTER INSERT ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_au` AFTER UPDATE ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_approval_ad` AFTER DELETE ON `chat_approval` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT project_id FROM chat WHERE id = old.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_ai` AFTER INSERT ON `chat_section` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'chat', 'put', i, 'section', unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_au` AFTER UPDATE ON `chat_section` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT new.project_id, 'chat', 'put', i, 'section', unixepoch() * 1000 FROM (SELECT new.id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_chat_section_ad` AFTER DELETE ON `chat_section` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT old.project_id, 'chat', 'del', i, 'section', unixepoch() * 1000 FROM (SELECT old.id AS i) WHERE i IS NOT NULL;
END;