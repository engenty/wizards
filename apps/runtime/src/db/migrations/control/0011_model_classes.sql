-- Definition version 2: the bindings of the text classes standard, high and highest of version 1
-- belong to low, standard and high now. json_patch leaves out a class that had no binding.
UPDATE `setting` SET `value` = json_set(`value`, '$.bindings', json_patch(
	json_remove(json_extract(`value`, '$.bindings'), '$.standard', '$.high', '$.highest'),
	json_object(
		'low', json_extract(`value`, '$.bindings.standard'),
		'standard', json_extract(`value`, '$.bindings.high'),
		'high', json_extract(`value`, '$.bindings.highest')
	)))
	WHERE (`key` = 'models' OR `key` LIKE 'models:%')
		AND json_valid(`value`) AND json_type(`value`, '$.bindings') = 'object';
