-- A client space stands beside the team spaces (docs/plans/org-spaces.md): a client space of
-- before, under a team space, moves under the organization's own space, its root (the oldest space
-- made here with no parent), with its clients still in it. It wears the organization's brand and
-- Info, as it did.
UPDATE `space` SET
  `access` = 'all',
  `brand_from` = 'root',
  `parent_id` = coalesce((
    SELECT r.`id` FROM `space` AS r
    WHERE r.`tenant_id` = `space`.`tenant_id` AND r.`parent_id` IS NULL AND r.`kind` = 'space' AND r.`origin` IS NULL
    ORDER BY r.`created_at` LIMIT 1
  ), `parent_id`),
  `brand` = coalesce((
    SELECT r.`brand` FROM `space` AS r
    WHERE r.`tenant_id` = `space`.`tenant_id` AND r.`parent_id` IS NULL AND r.`kind` = 'space' AND r.`origin` IS NULL
    ORDER BY r.`created_at` LIMIT 1
  ), `brand`),
  `facts` = coalesce((
    SELECT r.`facts` FROM `space` AS r
    WHERE r.`tenant_id` = `space`.`tenant_id` AND r.`parent_id` IS NULL AND r.`kind` = 'space' AND r.`origin` IS NULL
    ORDER BY r.`created_at` LIMIT 1
  ), `facts`),
  `themes` = coalesce((
    SELECT r.`themes` FROM `space` AS r
    WHERE r.`tenant_id` = `space`.`tenant_id` AND r.`parent_id` IS NULL AND r.`kind` = 'space' AND r.`origin` IS NULL
    ORDER BY r.`created_at` LIMIT 1
  ), `themes`)
WHERE `kind` = 'client';
