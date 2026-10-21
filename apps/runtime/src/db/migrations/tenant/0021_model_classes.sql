-- Definition version 2: the text classes standard, high and highest of version 1 are low,
-- standard and high now. Each step's model is renamed by its index, so the steps keep their order.
UPDATE `wizard` SET `draft` = (
	WITH RECURSIVE r(i, doc) AS (
		SELECT 0, `wizard`.`draft`
		UNION ALL
		SELECT i + 1, CASE json_extract(doc, '$.steps[' || i || '].model')
			WHEN 'standard' THEN json_set(doc, '$.steps[' || i || '].model', 'low')
			WHEN 'high' THEN json_set(doc, '$.steps[' || i || '].model', 'standard')
			WHEN 'highest' THEN json_set(doc, '$.steps[' || i || '].model', 'high')
			ELSE doc END
		FROM r WHERE i < json_array_length(`wizard`.`draft`, '$.steps')
	)
	SELECT json_set(doc, '$.version', 2) FROM r ORDER BY i DESC LIMIT 1)
	WHERE json_valid(`draft`) AND coalesce(json_extract(`draft`, '$.version'), 1) = 1;--> statement-breakpoint
UPDATE `wizard_version` SET `definition` = (
	WITH RECURSIVE r(i, doc) AS (
		SELECT 0, `wizard_version`.`definition`
		UNION ALL
		SELECT i + 1, CASE json_extract(doc, '$.steps[' || i || '].model')
			WHEN 'standard' THEN json_set(doc, '$.steps[' || i || '].model', 'low')
			WHEN 'high' THEN json_set(doc, '$.steps[' || i || '].model', 'standard')
			WHEN 'highest' THEN json_set(doc, '$.steps[' || i || '].model', 'high')
			ELSE doc END
		FROM r WHERE i < json_array_length(`wizard_version`.`definition`, '$.steps')
	)
	SELECT json_set(doc, '$.version', 2) FROM r ORDER BY i DESC LIMIT 1)
	WHERE json_valid(`definition`) AND coalesce(json_extract(`definition`, '$.version'), 1) = 1;--> statement-breakpoint
UPDATE `run` SET `definition` = (
	WITH RECURSIVE r(i, doc) AS (
		SELECT 0, `run`.`definition`
		UNION ALL
		SELECT i + 1, CASE json_extract(doc, '$.steps[' || i || '].model')
			WHEN 'standard' THEN json_set(doc, '$.steps[' || i || '].model', 'low')
			WHEN 'high' THEN json_set(doc, '$.steps[' || i || '].model', 'standard')
			WHEN 'highest' THEN json_set(doc, '$.steps[' || i || '].model', 'high')
			ELSE doc END
		FROM r WHERE i < json_array_length(`run`.`definition`, '$.steps')
	)
	SELECT json_set(doc, '$.version', 2) FROM r ORDER BY i DESC LIMIT 1)
	WHERE json_valid(`definition`) AND coalesce(json_extract(`definition`, '$.version'), 1) = 1;
