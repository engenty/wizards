CREATE TABLE `store_database` (
	`id` text PRIMARY KEY NOT NULL,
	`wizard_id` text NOT NULL,
	`holder` text NOT NULL,
	`migrations` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`used_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`wizard_id`) REFERENCES `wizard`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_database_holder` ON `store_database` (`wizard_id`,`holder`);--> statement-breakpoint
-- The broker decides a wizard's own data too (docs/plans/wizard-data.md). A space that has its
-- rules already gets the seed for it, once; a space without rules is seeded whole on its first
-- decision (broker/rwx.ts `seedRwx`). A space that has rules for clients gets theirs.
INSERT OR IGNORE INTO `rwx_rule` (`id`, `tenant_id`, `space_id`, `subject_kind`, `subject_id`, `resource_kind`, `resource_id`, `r`, `w`, `x`, `created_by`)
SELECT lower(hex(randomblob(6))), s.`tenant_id`, s.`space_id`, v.subject_kind, v.subject_id, 'data', '*', v.r, v.w, v.x, 'seed'
FROM (SELECT `space_id`, min(`tenant_id`) AS `tenant_id` FROM `rwx_rule` GROUP BY `space_id`) AS s
CROSS JOIN (
  SELECT 'role' AS subject_kind, 'admin' AS subject_id, 'allow' AS r, 'allow' AS w, 'allow' AS x
  UNION ALL SELECT 'role', 'owner', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'member', 'allow', 'allow', NULL
  UNION ALL SELECT 'role', 'client', 'allow', 'allow', NULL
  UNION ALL SELECT 'guest', NULL, 'allow', 'allow', NULL
) AS v
WHERE NOT EXISTS (
  SELECT 1 FROM `rwx_rule` AS e WHERE e.`space_id` = s.`space_id` AND e.`resource_kind` = 'data'
)
AND (v.subject_id IS NOT 'client' OR EXISTS (
  SELECT 1 FROM `rwx_rule` AS c WHERE c.`space_id` = s.`space_id` AND c.`subject_kind` = 'role' AND c.`subject_id` = 'client'
));
