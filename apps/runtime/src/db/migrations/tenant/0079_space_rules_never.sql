-- „Mit Freigabe“ asks the person who signed in to a connection. A connection that signs in as the
-- space has nobody to ask, so its rules are „Erlaubt“ or „Nie“: where one says „Mit Freigabe“,
-- which never ran there, it says „Nie“.
UPDATE `space_connection` SET `rules` = json_set(`rules`, '$.read', 'deny')
WHERE `sign_in` = 'space' AND json_extract(`rules`, '$.read') = 'ask';
--> statement-breakpoint
UPDATE `space_connection` SET `rules` = json_set(`rules`, '$.write', 'deny')
WHERE `sign_in` = 'space' AND json_extract(`rules`, '$.write') = 'ask';
--> statement-breakpoint
UPDATE `space_connection` SET `rules` = json_set(`rules`, '$.destructive', 'deny')
WHERE `sign_in` = 'space' AND json_extract(`rules`, '$.destructive') = 'ask';
--> statement-breakpoint
UPDATE `space_connection` SET `rules` = json_set(`rules`, '$.send', 'deny')
WHERE `sign_in` = 'space' AND json_extract(`rules`, '$.send') = 'ask';
