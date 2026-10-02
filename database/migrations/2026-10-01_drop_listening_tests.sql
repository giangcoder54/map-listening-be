-- =====================================================================
-- Drop the old exercises (listening_tests): the site is the Listening Lab only now.
-- Backup of the data and the Directus metadata: database/backups/2026-10-01_before_drop_listening_tests.sql
-- Their uploaded files (audio, map images) stay in directus_files.
-- =====================================================================

BEGIN;

DELETE FROM directus_permissions WHERE collection IN ('listening_tests', 'listening_tests_files');
DELETE FROM directus_presets     WHERE collection IN ('listening_tests', 'listening_tests_files');
DELETE FROM directus_relations   WHERE many_collection IN ('listening_tests', 'listening_tests_files')
                                    OR one_collection  IN ('listening_tests', 'listening_tests_files');
DELETE FROM directus_fields      WHERE collection IN ('listening_tests', 'listening_tests_files');
DELETE FROM directus_collections WHERE collection IN ('listening_tests', 'listening_tests_files');

DROP TABLE IF EXISTS listening_tests_files;
DROP TABLE IF EXISTS listening_tests;

COMMIT;
