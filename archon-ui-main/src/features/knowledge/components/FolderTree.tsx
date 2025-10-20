/**
 * FolderTree Component
 * Displays hierarchical folder structure with expand/collapse and drag-and-drop functionality
 */

import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  File,
  Folder as FolderIcon,
  FolderOpen,
  GripVertical,
  MoreVertical,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/features/ui/primitives/styles";
import type {
  DragItemData,
  DropZoneData,
  FolderTreeNode,
  FolderTreeResponse,
  SourceInFolder,
  TreeNode,
} from "../types/folders";
import { useDragAndDrop } from "../hooks/useDragAndDrop";

interface FolderTreeProps {
  tree: FolderTreeNode[];
  folderTree?: FolderTreeResponse;
  onFolderClick?: (folderId: string) => void;
  onSourceClick?: (sourceId: string) => void;
  onFolderContextMenu?: (folderId: string, event: React.MouseEvent) => void;
  onSourceContextMenu?: (sourceId: string, event: React.MouseEvent) => void;
  onMoveSource?: (sourceId: string, folderId: string | null) => Promise<void>;
  onMoveFolder?: (folderId: string, newParentId: string | null) => Promise<void>;
  onBatchMove?: (sourceIds: string[], folderId: string | null) => Promise<void>;
  selectedFolderId?: string | null;
  selectedSourceId?: string | null;
  selectedSourceIds?: Set<string>;
  enableDragDrop?: boolean;
  className?: string;
}

interface TreeNodeProps {
  node: TreeNode;
  level: number;
  onFolderClick?: (folderId: string) => void;
  onSourceClick?: (sourceId: string) => void;
  onFolderContextMenu?: (folderId: string, event: React.MouseEvent) => void;
  onSourceContextMenu?: (sourceId: string, event: React.MouseEvent) => void;
  selectedFolderId?: string | null;
  selectedSourceId?: string | null;
  selectedSourceIds?: Set<string>;
  expandedFolders: Set<string>;
  onToggleExpand: (folderId: string) => void;
  enableDragDrop?: boolean;
  onDragStart?: (item: DragItemData) => void;
  onDragOver?: (dropZone: DropZoneData) => void;
  onDragLeave?: () => void;
  onDragEnd?: () => void;
  onDrop?: (dropZone: DropZoneData) => void;
  draggedItemId?: string | null;
  currentDropTarget?: string | null;
  isValidDropTarget?: boolean;
}

const TreeNodeComponent: React.FC<TreeNodeProps> = ({
  node,
  level,
  onFolderClick,
  onSourceClick,
  onFolderContextMenu,
  onSourceContextMenu,
  selectedFolderId,
  selectedSourceId,
  selectedSourceIds,
  expandedFolders,
  onToggleExpand,
  enableDragDrop = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
  draggedItemId,
  currentDropTarget,
  isValidDropTarget,
}) => {
  const [isHovering, setIsHovering] = useState(false);

  const isFolder = node.node_type === "folder";
  const isExpanded = isFolder && expandedFolders.has(node.id);
  const isSelected = isFolder
    ? selectedFolderId === node.id
    : selectedSourceId === (node as SourceInFolder).source_id;

  const folderNode = isFolder ? (node as FolderTreeNode) : null;
  const sourceNode = !isFolder ? (node as SourceInFolder) : null;
  const hasChildren = folderNode && folderNode.children.length > 0;

  const isDragged = draggedItemId === node.id;
  const isDropTarget = isFolder && currentDropTarget === node.id;
  const isMultiSelected = !isFolder && selectedSourceIds?.has((node as SourceInFolder).source_id);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isFolder) {
        onFolderClick?.(node.id);
      } else {
        onSourceClick?.((node as SourceInFolder).source_id);
      }
    },
    [isFolder, node, onFolderClick, onSourceClick],
  );

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isFolder) {
        onToggleExpand(node.id);
      }
    },
    [isFolder, node.id, onToggleExpand],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFolder) {
        onFolderContextMenu?.(node.id, e);
      } else {
        onSourceContextMenu?.((node as SourceInFolder).source_id, e);
      }
    },
    [isFolder, node, onFolderContextMenu, onSourceContextMenu],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (isFolder) {
          onFolderClick?.(node.id);
        } else {
          onSourceClick?.((node as SourceInFolder).source_id);
        }
      } else if (e.key === "ArrowRight" && isFolder && !isExpanded) {
        e.preventDefault();
        onToggleExpand(node.id);
      } else if (e.key === "ArrowLeft" && isFolder && isExpanded) {
        e.preventDefault();
        onToggleExpand(node.id);
      }
    },
    [isFolder, isExpanded, node, onFolderClick, onSourceClick, onToggleExpand],
  );

  // Drag and drop handlers
  const handleDragStartEvent = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop) return;

      e.stopPropagation();

      const dragItem: DragItemData = {
        type: isFolder ? "folder" : "source",
        id: node.id,
        name: isFolder ? folderNode?.name : sourceNode?.title || sourceNode?.source_display_name,
        folder_id: isFolder ? folderNode?.parent_id : sourceNode?.folder_id,
      };

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/json", JSON.stringify(dragItem));

      onDragStart?.(dragItem);
    },
    [enableDragDrop, isFolder, node, folderNode, sourceNode, onDragStart],
  );

  const handleDragOverEvent = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop || !isFolder) return;

      e.preventDefault();
      e.stopPropagation();

      const dropZone: DropZoneData = {
        type: "folder",
        folder_id: node.id,
      };

      onDragOver?.(dropZone);
      setIsHovering(true);
    },
    [enableDragDrop, isFolder, node.id, onDragOver],
  );

  const handleDragLeaveEvent = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop) return;

      e.stopPropagation();
      setIsHovering(false);
      onDragLeave?.();
    },
    [enableDragDrop, onDragLeave],
  );

  const handleDropEvent = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop || !isFolder) return;

      e.preventDefault();
      e.stopPropagation();

      const dropZone: DropZoneData = {
        type: "folder",
        folder_id: node.id,
      };

      onDrop?.(dropZone);
      setIsHovering(false);
    },
    [enableDragDrop, isFolder, node.id, onDrop],
  );

  const handleDragEndEvent = useCallback(() => {
    if (!enableDragDrop) return;
    onDragEnd?.();
  }, [enableDragDrop, onDragEnd]);

  const Icon = isFolder ? (isExpanded ? FolderOpen : FolderIcon) : File;

  return (
    <div className="relative">
      <motion.div
        role={isFolder ? "treeitem" : "button"}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-level={level + 1}
        aria-selected={isSelected}
        tabIndex={0}
        draggable={enableDragDrop}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        onDragStart={handleDragStartEvent}
        onDragOver={handleDragOverEvent}
        onDragLeave={handleDragLeaveEvent}
        onDrop={handleDropEvent}
        onDragEnd={handleDragEndEvent}
        className={cn(
          "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer",
          "transition-all duration-200",
          "hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500",
          isSelected && "bg-cyan-500/20 dark:bg-cyan-400/20 text-cyan-700 dark:text-cyan-300",
          isMultiSelected && "bg-cyan-500/15 dark:bg-cyan-400/15 ring-1 ring-cyan-500/30",
          !isSelected && !isMultiSelected && "text-gray-700 dark:text-gray-300",
          isDragged && "opacity-40",
          isDropTarget && isValidDropTarget && "ring-2 ring-cyan-500 bg-cyan-500/20",
          isDropTarget && !isValidDropTarget && "ring-2 ring-red-500/50",
          enableDragDrop && "cursor-grab active:cursor-grabbing",
        )}
        style={{ paddingLeft: `${level * 20 + 12}px` }}
        whileHover={!isDragged ? { x: 4 } : {}}
        transition={{ duration: 0.15 }}
      >
        {/* Drag handle (visible on hover when drag enabled) */}
        {enableDragDrop && (
          <GripVertical
            className={cn(
              "w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500",
              "opacity-0 group-hover:opacity-100 transition-opacity",
            )}
            aria-hidden="true"
          />
        )}

        {/* Expand/collapse button for folders with children */}
        {isFolder && (
          <button
            type="button"
            onClick={handleToggleExpand}
            className={cn(
              "flex items-center justify-center w-5 h-5 rounded",
              "hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20",
              "transition-colors",
              !hasChildren && "invisible",
            )}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
            aria-expanded={isExpanded}
          >
            <motion.div animate={{ rotate: isExpanded ? 0 : -90 }} transition={{ duration: 0.2 }}>
              <ChevronDown className="w-4 h-4" />
            </motion.div>
          </button>
        )}

        {/* Spacer for sources (no expand button) */}
        {!isFolder && <div className="w-5" />}

        {/* Icon */}
        <Icon
          className={cn(
            "w-4 h-4 shrink-0",
            isFolder
              ? isSelected
                ? "text-cyan-600 dark:text-cyan-400"
                : "text-gray-500 dark:text-gray-400"
              : "text-gray-400 dark:text-gray-500",
          )}
          aria-hidden="true"
        />

        {/* Name */}
        <span className={cn("flex-1 truncate text-sm font-medium", isSelected && "font-semibold")}>
          {isFolder ? folderNode?.name : sourceNode?.title || sourceNode?.source_display_name || "Untitled"}
        </span>

        {/* Counts for folders */}
        {isFolder && folderNode && (
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            {folderNode.source_count > 0 && (
              <span
                className="px-1.5 py-0.5 rounded bg-gray-200/50 dark:bg-gray-700/50"
                aria-label={`${folderNode.source_count} source${folderNode.source_count !== 1 ? "s" : ""}`}
              >
                {folderNode.source_count}
              </span>
            )}
          </div>
        )}

        {/* Multi-select indicator */}
        {isMultiSelected && (
          <div className="w-2 h-2 rounded-full bg-cyan-500" aria-label="Selected" />
        )}

        {/* Context menu trigger */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleContextMenu(e);
          }}
          className={cn(
            "opacity-0 group-hover:opacity-100 focus:opacity-100",
            "p-1 rounded hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20",
            "transition-opacity",
          )}
          aria-label="More options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </motion.div>

      {/* Children (folders and sources) */}
      <AnimatePresence>
        {isFolder && isExpanded && hasChildren && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {folderNode?.children.map((child) => (
              <TreeNodeComponent
                key={child.id}
                node={child}
                level={level + 1}
                onFolderClick={onFolderClick}
                onSourceClick={onSourceClick}
                onFolderContextMenu={onFolderContextMenu}
                onSourceContextMenu={onSourceContextMenu}
                selectedFolderId={selectedFolderId}
                selectedSourceId={selectedSourceId}
                selectedSourceIds={selectedSourceIds}
                expandedFolders={expandedFolders}
                onToggleExpand={onToggleExpand}
                enableDragDrop={enableDragDrop}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDragEnd={onDragEnd}
                onDrop={onDrop}
                draggedItemId={draggedItemId}
                currentDropTarget={currentDropTarget}
                isValidDropTarget={isValidDropTarget}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const FolderTree: React.FC<FolderTreeProps> = ({
  tree,
  folderTree,
  onFolderClick,
  onSourceClick,
  onFolderContextMenu,
  onSourceContextMenu,
  onMoveSource,
  onMoveFolder,
  onBatchMove,
  selectedFolderId,
  selectedSourceId,
  selectedSourceIds = new Set(),
  enableDragDrop = true,
  className,
}) => {
  // Manage expanded folders state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Initialize drag and drop
  const { dragState, handleDragStart, handleDragOver, handleDrop, handleDragEnd } = useDragAndDrop({
    folderTree,
    onMoveSource,
    onMoveFolder,
    onBatchMove,
    selectedSourceIds,
  });

  // Load expanded state from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("archon_folder_expanded");
      if (saved) {
        const parsed = JSON.parse(saved);
        setExpandedFolders(new Set(Object.keys(parsed).filter((key) => parsed[key])));
      }
    } catch (error) {
      console.error("Failed to load folder expansion state:", error);
    }
  }, []);

  // Save expanded state to localStorage when it changes
  useEffect(() => {
    try {
      const state: Record<string, boolean> = {};
      for (const folderId of expandedFolders) {
        state[folderId] = true;
      }
      localStorage.setItem("archon_folder_expanded", JSON.stringify(state));
    } catch (error) {
      console.error("Failed to save folder expansion state:", error);
    }
  }, [expandedFolders]);

  const handleToggleExpand = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // Handle drag over root (for dropping at root level)
  const handleRootDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop) return;

      e.preventDefault();
      handleDragOver({ type: "root", folder_id: null });
    },
    [enableDragDrop, handleDragOver],
  );

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enableDragDrop) return;

      e.preventDefault();
      handleDrop({ type: "root", folder_id: null });
    },
    [enableDragDrop, handleDrop],
  );

  if (!tree || tree.length === 0) {
    return (
      <div
        className={cn("flex flex-col items-center justify-center py-12 px-4", className)}
        onDragOver={handleRootDragOver}
        onDrop={handleRootDrop}
      >
        <FolderIcon className="w-12 h-12 text-gray-400 dark:text-gray-600 mb-3" />
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center">No folders yet</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-1">
          Create folders to organize your knowledge sources
        </p>
        {dragState.isDragging && (
          <p className="text-xs text-cyan-500 dark:text-cyan-400 text-center mt-2">
            Drop here to move to root level
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role="tree"
      aria-label="Knowledge base folder tree"
      className={cn("space-y-1 py-2", className)}
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {tree.map((node) => (
        <TreeNodeComponent
          key={node.id}
          node={node}
          level={0}
          onFolderClick={onFolderClick}
          onSourceClick={onSourceClick}
          onFolderContextMenu={onFolderContextMenu}
          onSourceContextMenu={onSourceContextMenu}
          selectedFolderId={selectedFolderId}
          selectedSourceId={selectedSourceId}
          selectedSourceIds={selectedSourceIds}
          expandedFolders={expandedFolders}
          onToggleExpand={handleToggleExpand}
          enableDragDrop={enableDragDrop}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          draggedItemId={dragState.draggedItem?.id}
          currentDropTarget={dragState.dropTarget?.folder_id}
          isValidDropTarget={dragState.isValidDrop}
        />
      ))}
    </div>
  );
};
