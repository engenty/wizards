ALTER TABLE run_log_entry RENAME COLUMN project_id TO space_id;
DROP INDEX run_log_entry_project;
CREATE INDEX run_log_entry_space ON run_log_entry (space_id, ended_at);
