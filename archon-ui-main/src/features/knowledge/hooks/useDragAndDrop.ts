/**
 * Drag and Drop Hook for Folders and Sources
 * Provides drag-and-drop functionality with validation and visual feedback
 */

import { useCallback, useState } from "react";
import type {
  DragItemData,
  DragState,
  DropZoneData,
  FolderTreeResponse,
} from "../types/folders";
import { folderService } from "../services";

interface UseDragAndDropOptions {
  folderTree?: FolderTreeResponse;
  onMoveSource?: (sourceId: string, folderId: string | null) => Promise<void>;
  onMoveFolder?: (folderId: string, newParentId: string | null) => Promise<void>;
  onBatchMove?: (sourceIds: string[], folderId: string | null) => Promise<void>;
  selectedSourceIds?: Set<string>;
}

export function useDragAndDrop({
  folderTree,
  onMoveSource,
  onMoveFolder,
  onBatchMove,
  selectedSourceIds = new Set(),
}: UseDragAndDropOptions) {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    draggedItem: null,
    draggedItems: [],
    dropTarget: null,
    isValidDrop: false,
  });

  /**
   * Start dragging an item
   */
  const handleDragStart = useCallback(
    (item: DragItemData) => {
      // If dragging a selected source, include all selected sources
      const draggedItems =
        item.type === "source" && selectedSourceIds.has(item.id)
          ? Array.from(selectedSourceIds).map((id) => ({
              type: "source" as const,
              id,
            }))
          : [item];

      setDragState({
        isDragging: true,
        draggedItem: item,
        draggedItems,
        dropTarget: null,
        isValidDrop: false,
      });
    },
    [selectedSourceIds],
  );

  /**
   * Handle drag over a potential drop target
   */
  const handleDragOver = useCallback(
    (dropZone: DropZoneData) => {
      if (!dragState.isDragging || !dragState.draggedItem) {
        return;
      }

      const draggedItem = dragState.draggedItem;
      const isValid = validateDrop(draggedItem, dragState.draggedItems, dropZone, folderTree);

      setDragState((prev) => ({
        ...prev,
        dropTarget: dropZone,
        isValidDrop: isValid,
      }));
    },
    [dragState.isDragging, dragState.draggedItem, dragState.draggedItems, folderTree],
  );

  /**
   * Handle drop operation
   */
  const handleDrop = useCallback(
    async (dropZone: DropZoneData) => {
      if (!dragState.isDragging || !dragState.isValidDrop || !dragState.draggedItem) {
        return;
      }

      const { draggedItem, draggedItems } = dragState;
      const targetFolderId = dropZone.type === "root" ? null : dropZone.folder_id || null;

      try {
        if (draggedItem.type === "folder") {
          // Move folder
          await onMoveFolder?.(draggedItem.id, targetFolderId);
        } else if (draggedItems.length > 1) {
          // Batch move sources
          const sourceIds = draggedItems.map((item) => item.id);
          await onBatchMove?.(sourceIds, targetFolderId);
        } else {
          // Move single source
          await onMoveSource?.(draggedItem.id, targetFolderId);
        }
      } catch (error) {
        console.error("Drop operation failed:", error);
      } finally {
        handleDragEnd();
      }
    },
    [dragState, onMoveFolder, onMoveSource, onBatchMove],
  );

  /**
   * End dragging
   */
  const handleDragEnd = useCallback(() => {
    setDragState({
      isDragging: false,
      draggedItem: null,
      draggedItems: [],
      dropTarget: null,
      isValidDrop: false,
    });
  }, []);

  /**
   * Cancel drag operation
   */
  const handleDragCancel = useCallback(() => {
    handleDragEnd();
  }, [handleDragEnd]);

  return {
    dragState,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    handleDragCancel,
  };
}

/**
 * Validate if a drop operation is valid
 */
function validateDrop(
  draggedItem: DragItemData,
  draggedItems: DragItemData[],
  dropZone: DropZoneData,
  folderTree?: FolderTreeResponse,
): boolean {
  // Can't drop on itself
  if (draggedItem.type === "folder" && dropZone.type === "folder" && draggedItem.id === dropZone.folder_id) {
    return false;
  }

  // If dragging a folder, check for circular reference
  if (draggedItem.type === "folder" && dropZone.type === "folder" && folderTree) {
    const targetFolderId = dropZone.folder_id;
    if (targetFolderId && folderService.wouldCreateCircularReference(draggedItem.id, targetFolderId, folderTree)) {
      return false;
    }
  }

  // Can't drop source into its current folder
  if (draggedItem.type === "source") {
    const targetFolderId = dropZone.type === "root" ? null : dropZone.folder_id || null;
    if (draggedItem.folder_id === targetFolderId) {
      return false;
    }
  }

  // All multi-select items must be sources
  if (draggedItems.length > 1 && draggedItems.some((item) => item.type !== "source")) {
    return false;
  }

  return true;
}

