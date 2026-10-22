CREATE TABLE `live_presence` (
	`kind` text NOT NULL,
	`item` text NOT NULL,
	`who` text NOT NULL,
	`tab` text DEFAULT '' NOT NULL,
	`who_kind` text NOT NULL,
	`name` text NOT NULL,
	`client` text,
	`place` text,
	`place_label` text,
	`state` text NOT NULL,
	`seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`kind`, `item`, `who`, `tab`)
);
--> statement-breakpoint
CREATE INDEX `live_presence_seen` ON `live_presence` (`seen_at`);--> statement-breakpoint
CREATE TRIGGER `live_presence_ai` AFTER INSERT ON `live_presence` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, new.kind, unixepoch() * 1000 FROM (SELECT new.kind || ':' || new.item AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_presence_au` AFTER UPDATE ON `live_presence` WHEN old.state IS NOT new.state OR old.place IS NOT new.place OR old.name IS NOT new.name BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, new.kind, unixepoch() * 1000 FROM (SELECT new.kind || ':' || new.item AS i) WHERE i IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `live_presence_ad` AFTER DELETE ON `live_presence` BEGIN
	INSERT INTO `live_change` (`project_id`, `kind`, `op`, `item`, `parent`, `at`)
	SELECT NULL, 'presence', 'put', i, old.kind, unixepoch() * 1000 FROM (SELECT old.kind || ':' || old.item AS i) WHERE i IS NOT NULL;
END;
