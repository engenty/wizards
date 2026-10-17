CREATE TABLE `plugin_claim` (
	`plugin` text NOT NULL,
	`key` text NOT NULL,
	`tenant_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`plugin`, `key`)
);
--> statement-breakpoint
CREATE INDEX `plugin_claim_tenant` ON `plugin_claim` (`tenant_id`,`plugin`);