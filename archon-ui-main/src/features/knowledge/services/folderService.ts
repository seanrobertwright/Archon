/**
 * Folder Service
 * Handles all folder-related API operations for knowledge base organization
 */

import { callAPIWithETag } from "../../shared/api/apiClient";
import type {
  BatchMoveSourcesRequest,
  Folder,
  FolderCreate,
  FolderListResponse,
  FolderOperationResponse,
  FolderTreeResponse,
  FolderUpdate,
  FolderWithContents,
  MoveFolderRequest,
  MoveSourceRequest,
} from "../types/folders";

export const folderService = {
  /**
   * List folders, optionally filtered by parent
   */
  async getFolders(parentId?: string | null): Promise<FolderListResponse> {
    const params = new URLSearchParams();
    if (parentId !== undefined && parentId !== null) {
      params.append("parent_id", parentId);
    }

    const queryString = params.toString();
    const endpoint = `/api/folders${queryString ? `?${queryString}` : ""}`;

    return callAPIWithETag<FolderListResponse>(endpoint);
  },

  /**
   * Get complete folder hierarchy as a tree
   */
  async getFolderTree(): Promise<FolderTreeResponse> {
    return callAPIWithETag<FolderTreeResponse>("/api/folders/tree");
  },

  /**
   * Get a specific folder by ID
   */
  async getFolder(folderId: string): Promise<Folder> {
    return callAPIWithETag<Folder>(`/api/folders/${folderId}`);
  },

  /**
   * Get folder with its immediate contents (non-recursive)
   */
  async getFolderContents(
    folderId: string,
    options?: {
      include_sources?: boolean;
      include_subfolders?: boolean;
    },
  ): Promise<FolderWithContents> {
    const params = new URLSearchParams();

    if (options?.include_sources !== undefined) {
      params.append("include_sources", options.include_sources.toString());
    }
    if (options?.include_subfolders !== undefined) {
      params.append("include_subfolders", options.include_subfolders.toString());
    }

    const queryString = params.toString();
    const endpoint = `/api/folders/${folderId}/contents${queryString ? `?${queryString}` : ""}`;

    return callAPIWithETag<FolderWithContents>(endpoint);
  },

  /**
   * Create a new folder
   */
  async createFolder(folderData: FolderCreate): Promise<FolderOperationResponse> {
    const response = await callAPIWithETag<FolderOperationResponse>("/api/folders", {
      method: "POST",
      body: JSON.stringify(folderData),
    });

    return response;
  },

  /**
   * Update a folder's properties
   */
  async updateFolder(folderId: string, updates: FolderUpdate): Promise<FolderOperationResponse> {
    const response = await callAPIWithETag<FolderOperationResponse>(`/api/folders/${folderId}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });

    return response;
  },

  /**
   * Delete a folder
   */
  async deleteFolder(
    folderId: string,
    moveContentsToParent: boolean = true,
  ): Promise<FolderOperationResponse> {
    const params = new URLSearchParams({
      move_contents_to_parent: moveContentsToParent.toString(),
    });

    const response = await callAPIWithETag<FolderOperationResponse>(
      `/api/folders/${folderId}?${params.toString()}`,
      {
        method: "DELETE",
      },
    );

    return response;
  },

  /**
   * Move a folder to a new parent
   */
  async moveFolder(folderId: string, newParentId: string | null): Promise<FolderOperationResponse> {
    const body: Record<string, string | null> = {
      new_parent_id: newParentId,
    };

    const response = await callAPIWithETag<FolderOperationResponse>(`/api/folders/${folderId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return response;
  },

  /**
   * Move a source to a folder
   */
  async moveSourceToFolder(sourceId: string, folderId: string | null): Promise<{ success: boolean; message: string }> {
    const body: Record<string, string | null> = {
      folder_id: folderId,
    };

    const response = await callAPIWithETag<{ success: boolean; message: string }>(`/api/sources/${sourceId}/move`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    return response;
  },

  /**
   * Move multiple sources to a folder in a single operation
   */
  async batchMoveSources(request: BatchMoveSourcesRequest): Promise<{ success: boolean; message: string; count: number }> {
    const response = await callAPIWithETag<{ success: boolean; message: string; count: number }>(
      "/api/sources/batch-move",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );

    return response;
  },

  /**
   * Validate folder name (client-side validation)
   */
  validateFolderName(name: string): { valid: boolean; error?: string } {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: "Folder name is required" };
    }

    if (name.length > 255) {
      return { valid: false, error: "Folder name must be 255 characters or less" };
    }

    // Check for invalid characters that might cause issues
    const invalidChars = /[<>:"/\\|?*]/;
    if (invalidChars.test(name)) {
      return { valid: false, error: "Folder name contains invalid characters" };
    }

    return { valid: true };
  },

  /**
   * Validate hex color code
   */
  validateColor(color: string): boolean {
    const hexColorRegex = /^#[0-9a-fA-F]{6}$/;
    return hexColorRegex.test(color);
  },

  /**
   * Check if moving a folder would create a circular reference (client-side check)
   * Note: Server will also validate this, but client-side check provides better UX
   */
  wouldCreateCircularReference(
    folderId: string,
    targetParentId: string | null,
    folderTree: FolderTreeResponse,
  ): boolean {
    if (!targetParentId) {
      // Moving to root can never create circular reference
      return false;
    }

    // Check if target is the same as source
    if (folderId === targetParentId) {
      return true;
    }

    // Walk up from target to see if we hit the source folder
    const findParentPath = (nodeId: string, tree: any[], path: string[] = []): string[] | null => {
      for (const node of tree) {
        if (node.node_type === "folder") {
          if (node.id === nodeId) {
            return path;
          }

          const childResult = findParentPath(nodeId, node.children || [], [...path, node.id]);
          if (childResult) {
            return childResult;
          }
        }
      }
      return null;
    };

    const targetPath = findParentPath(targetParentId, folderTree.tree);
    return targetPath ? targetPath.includes(folderId) : false;
  },

  /**
   * Get folder path for breadcrumb navigation
   */
  getFolderPath(folderId: string, folderTree: FolderTreeResponse): string[] {
    const path: string[] = [];

    const findPath = (nodeId: string, tree: any[], currentPath: string[] = []): boolean => {
      for (const node of tree) {
        if (node.node_type === "folder") {
          if (node.id === nodeId) {
            path.push(...currentPath, node.name);
            return true;
          }

          if (findPath(nodeId, node.children || [], [...currentPath, node.name])) {
            return true;
          }
        }
      }
      return false;
    };

    findPath(folderId, folderTree.tree);
    return path;
  },

  /**
   * Find a folder in the tree by ID
   */
  findFolderInTree(folderId: string, folderTree: FolderTreeResponse): Folder | null {
    const search = (tree: any[]): Folder | null => {
      for (const node of tree) {
        if (node.node_type === "folder") {
          if (node.id === folderId) {
            return node as Folder;
          }

          const result = search(node.children || []);
          if (result) {
            return result;
          }
        }
      }
      return null;
    };

    return search(folderTree.tree);
  },
};

