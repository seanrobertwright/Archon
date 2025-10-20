/**
 * Folder Types for Knowledge Base Organization
 * Matches backend models from folder_models.py
 */

export interface FolderMetadata {
  [key: string]: any;
}

export interface FolderBase {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  position: number;
  metadata: FolderMetadata;
}

export interface FolderCreate extends FolderBase {
  parent_id?: string | null;
}

export interface FolderUpdate {
  name?: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  position?: number | null;
  parent_id?: string | null;
  metadata?: FolderMetadata | null;
}

export interface Folder extends FolderBase {
  id: string;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
  source_count: number;
  subfolder_count: number;
  total_sources: number;
}

export type NodeType = "folder" | "source";

export interface SourceInFolder {
  id: string;
  source_id: string;
  title?: string | null;
  source_url?: string | null;
  source_display_name?: string | null;
  folder_id?: string | null;
  created_at: string;
  node_type: "source";
  knowledge_type?: string | null;
  tags: string[];
}

export interface FolderTreeNode extends Folder {
  children: (FolderTreeNode | SourceInFolder)[];
  node_type: "folder";
}

export interface FolderWithContents extends Folder {
  subfolders: Folder[];
  sources: SourceInFolder[];
  path: string[];
}

export interface MoveFolderRequest {
  folder_id: string;
  new_parent_id: string | null;
}

export interface MoveSourceRequest {
  source_id: string;
  folder_id: string | null;
}

export interface BatchMoveSourcesRequest {
  source_ids: string[];
  folder_id: string | null;
}

export interface DeleteFolderRequest {
  folder_id: string;
  move_contents_to_parent: boolean;
}

export interface FolderOperationResponse {
  success: boolean;
  message: string;
  folder?: Folder | null;
  folders?: Folder[] | null;
}

export interface FolderListResponse {
  folders: Folder[];
  total: number;
}

export interface FolderTreeResponse {
  tree: FolderTreeNode[];
  total_folders: number;
  total_sources?: number;
}

// Drag and drop types
export interface DragItemData {
  type: "folder" | "source";
  id: string;
  name?: string;
  folder_id?: string | null;
}

export interface DropZoneData {
  type: "folder" | "root";
  folder_id?: string | null;
}

export interface DragState {
  isDragging: boolean;
  draggedItem: DragItemData | null;
  draggedItems: DragItemData[];
  dropTarget: DropZoneData | null;
  isValidDrop: boolean;
}

// UI state types
export interface FolderExpansionState {
  [folderId: string]: boolean;
}

export interface FolderSelectionState {
  selectedItems: Set<string>;
  lastSelectedIndex: number | null;
  anchorIndex: number | null;
}

export interface FolderContextMenuData {
  type: "folder" | "source" | "multi-select";
  targetId: string;
  targetIds?: string[];
  position: { x: number; y: number };
}

// Helper types for tree operations
export type TreeNode = FolderTreeNode | SourceInFolder;

export interface TreeOperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

// Filter and search types
export interface FolderFilter {
  parent_id?: string | null;
  search?: string;
  include_empty?: boolean;
}

export interface FolderBreadcrumb {
  id: string;
  name: string;
  position: number;
}

// Form types
export interface FolderFormData {
  name: string;
  description?: string;
  parent_id?: string | null;
  color?: string;
  icon?: string;
}

export interface MoveFolderFormData {
  source_folder_id: string;
  target_parent_id: string | null;
}

// Validation types
export interface FolderValidationError {
  field: string;
  message: string;
}

export interface FolderValidationResult {
  valid: boolean;
  errors: FolderValidationError[];
}

