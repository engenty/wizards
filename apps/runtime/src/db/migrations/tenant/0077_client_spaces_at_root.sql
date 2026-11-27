-- A client is a client space (docs/plans/org-spaces.md): a space under the organization's root
-- with clients in it is one, its own kind again. Its clients work with its data, run its wizards
-- and skills, as in a client space before; what of the root they reach, the root opens item by
-- item.
UPDATE `space` SET `kind` = 'client', `access` = 'all'
WHERE `kind` = 'space' AND `parent_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `space_member` AS m WHERE m.`space_id` = `space`.`id` AND m.`role` = 'client'
);
--> statement-breakpoint
INSERT OR IGNORE INTO `rwx_rule` (`id`, `tenant_id`, `space_id`, `subject_kind`, `subject_id`, `resource_kind`, `resource_id`, `r`, `w`, `x`, `created_by`)
SELECT lower(hex(randomblob(6))), s.`tenant_id`, s.`id`, 'role', 'client', v.kind, '*', v.r, v.w, v.x, 'seed'
FROM `space` AS s
CROSS JOIN (
  SELECT 'document' AS kind, 'allow' AS r, 'allow' AS w, NULL AS x
  UNION ALL SELECT 'table', 'allow', 'allow', NULL
  UNION ALL SELECT 'page', 'allow', 'allow', NULL
  UNION ALL SELECT 'wizard', 'allow', NULL, 'allow'
) AS v
WHERE s.`kind` = 'client' AND EXISTS (
  SELECT 1 FROM `rwx_rule` AS e WHERE e.`space_id` = s.`id`
);
