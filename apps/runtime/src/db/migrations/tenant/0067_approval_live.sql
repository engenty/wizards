CREATE TRIGGER `live_approval_ai` AFTER INSERT ON `approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_approval_au` AFTER UPDATE ON `approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = new.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT new.chat_id AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_approval_ad` AFTER DELETE ON `approval` BEGIN
	INSERT INTO `live_change` (`space_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT (SELECT space_id FROM chat WHERE id = old.chat_id), 'chat', 'put', i, NULL, unixepoch() * 1000 FROM (SELECT old.chat_id AS i) WHERE i IS NOT NULL;
END;
