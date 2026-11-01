-- Scans are read by OCR and old Word files by their text now (docs/plans/document-reading.md):
-- PDFs indexed without a passage of text and .doc files are read once more.
UPDATE `space_mount_file` SET `status` = 'pending'
WHERE `status` IN ('ready', 'failed')
  AND (
    `mime` = 'application/msword'
    OR (
      `mime` = 'application/pdf'
      AND NOT EXISTS (
        SELECT 1 FROM `space_mount_unit` u
        WHERE u.`file_id` = `space_mount_file`.`id` AND u.`kind` IS NULL AND u.`idx` > 0
      )
    )
  );
