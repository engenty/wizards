CREATE TABLE `space_mount` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'scanning' NOT NULL,
	`error` text,
	`scanned_at` integer,
	`folder_category_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_category_id`) REFERENCES `space_category`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_mount_slug` ON `space_mount` (`space_id`,`slug`);--> statement-breakpoint
CREATE TABLE `space_mount_file` (
	`id` text PRIMARY KEY NOT NULL,
	`mount_id` text NOT NULL,
	`space_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`modified` integer NOT NULL,
	`hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`pages` integer,
	`thumb` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mount_id`) REFERENCES `space_mount`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_mount_file_path` ON `space_mount_file` (`mount_id`,`path`);--> statement-breakpoint
CREATE INDEX `space_mount_file_hash` ON `space_mount_file` (`mount_id`,`hash`);--> statement-breakpoint
CREATE INDEX `space_mount_file_status` ON `space_mount_file` (`mount_id`,`status`);--> statement-breakpoint
CREATE TABLE `space_mount_unit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`space_id` text NOT NULL,
	`mount_id` text NOT NULL,
	`file_id` text NOT NULL,
	`idx` integer NOT NULL,
	`heading` text,
	`sheet` integer,
	`start` integer,
	`end` integer,
	`embedding` blob,
	`model` text,
	`kind` text,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mount_id`) REFERENCES `space_mount`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `space_mount_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_mount_unit_file` ON `space_mount_unit` (`file_id`);--> statement-breakpoint
CREATE INDEX `space_mount_unit_space` ON `space_mount_unit` (`space_id`,`model`);--> statement-breakpoint
ALTER TABLE `space_item_category` ADD `mount_file_id` text REFERENCES space_mount_file(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `space_item_category_mount_file` ON `space_item_category` (`mount_file_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `space_mount_unit_fts` USING fts5(`text`, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE VIRTUAL TABLE `space_mount_unit_tri` USING fts5(`text`, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1');--> statement-breakpoint
CREATE TRIGGER `space_mount_unit_ad` AFTER DELETE ON `space_mount_unit` BEGIN
	DELETE FROM `space_mount_unit_fts` WHERE rowid = old.id;
	DELETE FROM `space_mount_unit_tri` WHERE rowid = old.id;
END;
