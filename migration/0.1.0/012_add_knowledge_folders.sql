-- =====================================================
-- Add Knowledge Folders for Hierarchical Organization
-- =====================================================
-- This migration adds folder organization to the knowledge base
-- allowing users to categorize sources into a hierarchical structure
--
-- Features:
-- - Unlimited nesting depth with adjacency list pattern
-- - Folder-to-folder hierarchy via parent_id
-- - Source-to-folder association
-- - Support for future multi-user scenarios
-- - Circular reference prevention via constraints
-- =====================================================

-- Create archon_knowledge_folders table
CREATE TABLE IF NOT EXISTS archon_knowledge_folders (
    -- Primary identification
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Folder information
    name TEXT NOT NULL,
    description TEXT,
    
    -- Hierarchy (adjacency list pattern)
    parent_id UUID REFERENCES archon_knowledge_folders(id) ON DELETE CASCADE,
    
    -- Future multi-user support (currently not enforced but ready)
    -- user_id UUID,  -- Can be added when auth is implemented
    
    -- Display customization (optional features)
    color TEXT,  -- Hex color for folder icon (e.g., '#00ff41')
    icon TEXT,   -- Icon identifier (e.g., 'folder', 'book', 'code')
    
    -- Manual sort order within same parent
    position INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    
    -- Flexible metadata storage
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Constraints
    CONSTRAINT archon_knowledge_folders_no_self_reference 
        CHECK (parent_id IS DISTINCT FROM id)
);

-- Add folder_id column to archon_sources table
-- NULLABLE because existing sources remain at root level
ALTER TABLE archon_sources
ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES archon_knowledge_folders(id) ON DELETE SET NULL;

-- Create indexes for query performance

-- Folder indexes
CREATE INDEX IF NOT EXISTS idx_archon_knowledge_folders_parent_id 
    ON archon_knowledge_folders(parent_id);

CREATE INDEX IF NOT EXISTS idx_archon_knowledge_folders_name 
    ON archon_knowledge_folders(name);

CREATE INDEX IF NOT EXISTS idx_archon_knowledge_folders_parent_position 
    ON archon_knowledge_folders(parent_id, position);

CREATE INDEX IF NOT EXISTS idx_archon_knowledge_folders_created_at 
    ON archon_knowledge_folders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_archon_knowledge_folders_metadata 
    ON archon_knowledge_folders USING GIN(metadata);

-- Source folder index
CREATE INDEX IF NOT EXISTS idx_archon_sources_folder_id 
    ON archon_sources(folder_id);

-- Composite index for folder contents query
CREATE INDEX IF NOT EXISTS idx_archon_sources_folder_created 
    ON archon_sources(folder_id, created_at DESC);

-- Add comments to document the table structure
COMMENT ON TABLE archon_knowledge_folders IS 'Hierarchical folder structure for organizing knowledge sources';
COMMENT ON COLUMN archon_knowledge_folders.id IS 'Unique identifier for the folder';
COMMENT ON COLUMN archon_knowledge_folders.name IS 'Display name of the folder';
COMMENT ON COLUMN archon_knowledge_folders.description IS 'Optional description of folder contents';
COMMENT ON COLUMN archon_knowledge_folders.parent_id IS 'Foreign key to parent folder (NULL for root-level folders)';
COMMENT ON COLUMN archon_knowledge_folders.color IS 'Optional hex color for folder icon customization';
COMMENT ON COLUMN archon_knowledge_folders.icon IS 'Optional icon identifier for folder display';
COMMENT ON COLUMN archon_knowledge_folders.position IS 'Manual sort order within same parent folder';
COMMENT ON COLUMN archon_knowledge_folders.metadata IS 'Flexible JSON metadata for future extensions';
COMMENT ON COLUMN archon_sources.folder_id IS 'Foreign key linking source to containing folder (NULL for root level)';

-- Create trigger to automatically update updated_at timestamp
CREATE TRIGGER update_archon_knowledge_folders_updated_at
    BEFORE UPDATE ON archon_knowledge_folders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Helper function to get all descendant folders (for circular reference checking)
-- Returns TRUE if target_folder_id is a descendant of potential_ancestor_id
CREATE OR REPLACE FUNCTION archon_is_folder_descendant(
    target_folder_id UUID,
    potential_ancestor_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    current_parent_id UUID;
    max_depth INTEGER := 100;  -- Prevent infinite loops
    current_depth INTEGER := 0;
BEGIN
    -- If either is NULL, not a descendant
    IF target_folder_id IS NULL OR potential_ancestor_id IS NULL THEN
        RETURN FALSE;
    END IF;
    
    -- If they're the same, it's a self-reference (also a form of circular)
    IF target_folder_id = potential_ancestor_id THEN
        RETURN TRUE;
    END IF;
    
    -- Walk up the tree from target to see if we hit the potential ancestor
    current_parent_id := (SELECT parent_id FROM archon_knowledge_folders WHERE id = target_folder_id);
    
    WHILE current_parent_id IS NOT NULL AND current_depth < max_depth LOOP
        IF current_parent_id = potential_ancestor_id THEN
            RETURN TRUE;
        END IF;
        
        current_parent_id := (SELECT parent_id FROM archon_knowledge_folders WHERE id = current_parent_id);
        current_depth := current_depth + 1;
    END LOOP;
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION archon_is_folder_descendant IS 'Checks if target_folder_id is a descendant of potential_ancestor_id to prevent circular references';

-- Helper function to get folder tree path (for breadcrumbs)
-- Returns array of folder names from root to target folder
CREATE OR REPLACE FUNCTION archon_get_folder_path(target_folder_id UUID)
RETURNS TEXT[] AS $$
DECLARE
    path TEXT[] := ARRAY[]::TEXT[];
    current_id UUID := target_folder_id;
    current_name TEXT;
    current_parent UUID;
    max_depth INTEGER := 100;
    current_depth INTEGER := 0;
BEGIN
    IF target_folder_id IS NULL THEN
        RETURN path;
    END IF;
    
    WHILE current_id IS NOT NULL AND current_depth < max_depth LOOP
        SELECT name, parent_id INTO current_name, current_parent
        FROM archon_knowledge_folders
        WHERE id = current_id;
        
        IF current_name IS NULL THEN
            EXIT;
        END IF;
        
        -- Prepend to array (builds path from leaf to root)
        path := array_prepend(current_name, path);
        
        current_id := current_parent;
        current_depth := current_depth + 1;
    END LOOP;
    
    RETURN path;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION archon_get_folder_path IS 'Returns array of folder names from root to target folder for breadcrumb navigation';

-- Helper function to count sources in folder and all subfolders (recursive)
CREATE OR REPLACE FUNCTION archon_count_folder_sources(target_folder_id UUID)
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        WITH RECURSIVE folder_tree AS (
            -- Base case: the target folder
            SELECT id FROM archon_knowledge_folders WHERE id = target_folder_id
            UNION ALL
            -- Recursive case: all descendant folders
            SELECT f.id
            FROM archon_knowledge_folders f
            INNER JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT COUNT(*)::INTEGER
        FROM archon_sources s
        WHERE s.folder_id IN (SELECT id FROM folder_tree)
    );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION archon_count_folder_sources IS 'Returns total count of sources in folder and all subfolders (recursive)';

-- Helper function to count immediate subfolders
CREATE OR REPLACE FUNCTION archon_count_subfolders(target_folder_id UUID)
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)::INTEGER
        FROM archon_knowledge_folders
        WHERE parent_id = target_folder_id
    );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION archon_count_subfolders IS 'Returns count of immediate subfolders (non-recursive)';

-- Record migration application for tracking
INSERT INTO archon_migrations (version, migration_name)
VALUES ('0.1.0', '012_add_knowledge_folders')
ON CONFLICT (version, migration_name) DO NOTHING;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- 
-- Next steps:
-- 1. Backend: Create folder service and API endpoints
-- 2. Frontend: Implement tree view and drag-and-drop UI
-- 3. Test folder operations and circular reference prevention
-- 
-- Rollback: Run 012_rollback_knowledge_folders.sql
-- =====================================================

