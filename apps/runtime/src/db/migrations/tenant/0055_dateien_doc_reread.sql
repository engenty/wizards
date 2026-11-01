-- Old Word files were skipped before they could be read (#481 reads them now): read them once.
UPDATE `space_mount_file` SET `status` = 'pending'
WHERE `status` = 'skipped' AND `mime` = 'application/msword';
