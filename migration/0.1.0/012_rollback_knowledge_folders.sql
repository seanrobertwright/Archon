-- =====================================================
-- Rollback Knowledge Folders Migration
-- =====================================================
-- This script reverts the changes made by 012_add_knowledge_folders.sql
-- 
-- WARNING: This will permanently delete all folders and folder associations
-- Sources will remain intact but will be moved to root level
-- =====================================================

-- Drop helper functions
DROP FUNCTION IF EXISTS archon_count_subfolders(UUID);
DROP FUNCTION IF EXISTS archon_count_folder_sources(UUID);
DROP FUNCTION IF EXISTS archon_get_folder_path(UUID);
DROP FUNCTION IF EXISTS archon_is_folder_descendant(UUID, UUID);

-- Remove folder_id column from sources (this sets all to NULL automatically)
ALTER TABLE archon_sources
DROP COLUMN IF EXISTS folder_id;

-- Drop indexes
DROP INDEX IF EXISTS idx_archon_sources_folder_created;
DROP INDEX IF EXISTS idx_archon_sources_folder_id;
DROP INDEX IF EXISTS idx_archon_knowledge_folders_metadata;
DROP INDEX IF EXISTS idx_archon_knowledge_folders_created_at;
DROP INDEX IF EXISTS idx_archon_knowledge_folders_parent_position;
DROP INDEX IF EXISTS idx_archon_knowledge_folders_name;
DROP INDEX IF EXISTS idx_archon_knowledge_folders_parent_id;

-- Drop folders table (CASCADE will handle foreign key references)
DROP TABLE IF EXISTS archon_knowledge_folders CASCADE;

-- Remove migration tracking record
DELETE FROM archon_migrations 
WHERE version = '0.1.0' AND migration_name = '012_add_knowledge_folders';

-- =====================================================
-- ROLLBACK COMPLETE
-- =====================================================
-- All folder data has been removed
-- Sources remain intact and are now at root level
-- =====================================================

