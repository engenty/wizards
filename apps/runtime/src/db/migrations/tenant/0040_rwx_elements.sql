-- The broker decides wizards, skills and a space's setup too (docs/plans/modular.md, phase 1).
-- A space that has its rules already gets the seed for the new kinds, once; a space without
-- rules is seeded whole on its first decision (broker/rwx.ts `seedRwx`).
INSERT OR IGNORE INTO `rwx_rule` (`id`, `tenant_id`, `space_id`, `subject_kind`, `subject_id`, `resource_kind`, `resource_id`, `r`, `w`, `x`, `created_by`)
SELECT lower(hex(randomblob(6))), s.`tenant_id`, s.`space_id`, v.subject_kind, v.subject_id, v.resource_kind, '*', v.r, v.w, v.x, 'seed'
FROM (SELECT `space_id`, min(`tenant_id`) AS `tenant_id` FROM `rwx_rule` GROUP BY `space_id`) AS s
CROSS JOIN (
  SELECT 'role' AS subject_kind, 'admin' AS subject_id, 'wizard' AS resource_kind, 'allow' AS r, 'allow' AS w, 'allow' AS x
  UNION ALL SELECT 'role', 'owner', 'wizard', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'member', 'wizard', 'allow', NULL, 'allow'
  UNION ALL SELECT 'role', 'admin', 'skill', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'owner', 'skill', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'member', 'skill', 'allow', NULL, 'allow'
  UNION ALL SELECT 'guest', NULL, 'skill', 'allow', NULL, 'allow'
  UNION ALL SELECT 'role', 'admin', 'setup', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'owner', 'setup', 'allow', 'allow', 'allow'
  UNION ALL SELECT 'role', 'member', 'setup', 'allow', 'allow', NULL
) AS v
WHERE NOT EXISTS (
  SELECT 1 FROM `rwx_rule` AS e WHERE e.`space_id` = s.`space_id` AND e.`resource_kind` = v.resource_kind
);
