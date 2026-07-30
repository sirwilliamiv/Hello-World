-- Rollback for 20260701_create_data_files.
--
-- Dropping these tables does NOT remove the stored objects — nothing in a database
-- rollback can reach the bucket. Rolling this migration back in an environment that
-- has taken uploads therefore orphans every object; delete the bucket prefix as a
-- separate, deliberate step.

DROP TABLE IF EXISTS data_files_thumbnail;
DROP TABLE IF EXISTS data_files_upload_session;
DROP TABLE IF EXISTS data_files_file_version;
DROP TABLE IF EXISTS data_files_file;
