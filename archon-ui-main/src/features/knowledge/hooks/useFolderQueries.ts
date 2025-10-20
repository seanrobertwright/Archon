/**
 * Folder Query Hooks
 * Following TanStack Query best practices with query key factories
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSmartPolling } from "@/features/shared/hooks";
import { useToast } from "@/features/shared/hooks/useToast";
import { createOptimisticEntity, createOptimisticId } from "@/features/shared/utils/optimistic";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "../../shared/config/queryPatterns";
import { folderService } from "../services";
import type {
  BatchMoveSourcesRequest,
  Folder,
  FolderCreate,
  FolderListResponse,
  FolderOperationResponse,
  FolderTreeResponse,
  FolderUpdate,
  FolderWithContents,
} from "../types/folders";
import { knowledgeKeys } from "./useKnowledgeQueries";

// Query keys factory for better organization and type safety
export const folderKeys = {
  all: ["folders"] as const,
  lists: () => [...folderKeys.all, "list"] as const,
  list: (parentId?: string | null) => [...folderKeys.lists(), { parentId }] as const,
  tree: () => [...folderKeys.all, "tree"] as const,
  details: () => [...folderKeys.all, "detail"] as const,
  detail: (id: string) => [...folderKeys.details(), id] as const,
  contents: (id: string) => [...folderKeys.all, "contents", id] as const,
};

/**
 * Fetch folders list, optionally filtered by parent
 */
export function useFolders(parentId?: string | null) {
  const refetchInterval = useSmartPolling(5000); // Poll every 5 seconds when visible

  return useQuery<FolderListResponse>({
    queryKey: folderKeys.list(parentId),
    queryFn: () => folderService.getFolders(parentId),
    staleTime: STALE_TIMES.normal,
    refetchInterval,
  });
}

/**
 * Fetch complete folder tree
 */
export function useFolderTree() {
  const refetchInterval = useSmartPolling(10000); // Poll every 10 seconds when visible

  return useQuery<FolderTreeResponse>({
    queryKey: folderKeys.tree(),
    queryFn: () => folderService.getFolderTree(),
    staleTime: STALE_TIMES.normal,
    refetchInterval,
  });
}

/**
 * Fetch a specific folder by ID
 */
export function useFolder(folderId: string | null) {
  return useQuery<Folder>({
    queryKey: folderId ? folderKeys.detail(folderId) : DISABLED_QUERY_KEY,
    queryFn: () => (folderId ? folderService.getFolder(folderId) : Promise.reject("No folder ID")),
    enabled: !!folderId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Fetch folder contents (sources and subfolders)
 */
export function useFolderContents(
  folderId: string | null,
  options?: {
    include_sources?: boolean;
    include_subfolders?: boolean;
  },
) {
  return useQuery<FolderWithContents>({
    queryKey: folderId ? folderKeys.contents(folderId) : DISABLED_QUERY_KEY,
    queryFn: () => (folderId ? folderService.getFolderContents(folderId, options) : Promise.reject("No folder ID")),
    enabled: !!folderId,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Create folder mutation with optimistic updates
 */
export function useCreateFolder() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    FolderOperationResponse,
    Error,
    FolderCreate,
    {
      previousTree?: FolderTreeResponse;
      previousLists?: Array<[readonly unknown[], FolderListResponse | undefined]>;
      tempFolderId: string;
    }
  >({
    mutationFn: (folderData: FolderCreate) => folderService.createFolder(folderData),
    onMutate: async (folderData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: folderKeys.tree() });
      await queryClient.cancelQueries({ queryKey: folderKeys.lists() });

      // Snapshot previous values
      const previousTree = queryClient.getQueryData<FolderTreeResponse>(folderKeys.tree());
      const previousLists = queryClient.getQueriesData<FolderListResponse>({
        queryKey: folderKeys.lists(),
      });

      // Generate temporary ID for optimistic entity
      const tempFolderId = createOptimisticId();

      // Create optimistic folder
      const optimisticFolder = createOptimisticEntity<Folder>({
        name: folderData.name,
        description: folderData.description || null,
        parent_id: folderData.parent_id || null,
        color: folderData.color || null,
        icon: folderData.icon || null,
        position: folderData.position || 0,
        metadata: folderData.metadata || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_count: 0,
        subfolder_count: 0,
        total_sources: 0,
      });

      // Optimistically update the tree
      if (previousTree) {
        queryClient.setQueryData<FolderTreeResponse>(folderKeys.tree(), (old) => {
          if (!old) return old;

          const treeNode = {
            ...optimisticFolder,
            children: [],
            node_type: "folder" as const,
          };

          // If no parent, add to root
          if (!folderData.parent_id) {
            return {
              ...old,
              tree: [...old.tree, treeNode],
              total_folders: old.total_folders + 1,
            };
          }

          // Otherwise, find parent and add to its children
          const addToParent = (nodes: any[]): any[] => {
            return nodes.map((node) => {
              if (node.node_type === "folder") {
                if (node.id === folderData.parent_id) {
                  return {
                    ...node,
                    children: [...node.children, treeNode],
                    subfolder_count: node.subfolder_count + 1,
                  };
                }
                return {
                  ...node,
                  children: addToParent(node.children || []),
                };
              }
              return node;
            });
          };

          return {
            ...old,
            tree: addToParent(old.tree),
            total_folders: old.total_folders + 1,
          };
        });
      }

      // Optimistically update the list queries
      previousLists.forEach(([queryKey]) => {
        queryClient.setQueryData<FolderListResponse>(queryKey, (old) => {
          if (!old) return old;

          const listKey = queryKey[2] as { parentId?: string | null };
          const matchesParent =
            listKey?.parentId === folderData.parent_id ||
            (!listKey?.parentId && !folderData.parent_id) ||
            (listKey?.parentId === null && !folderData.parent_id);

          if (matchesParent) {
            return {
              folders: [...old.folders, optimisticFolder],
              total: old.total + 1,
            };
          }

          return old;
        });
      });

      return { previousTree, previousLists, tempFolderId };
    },
    onError: (_error, _variables, context) => {
      // Rollback optimistic updates
      if (context?.previousTree) {
        queryClient.setQueryData(folderKeys.tree(), context.previousTree);
      }

      context?.previousLists?.forEach(([queryKey, previousData]) => {
        queryClient.setQueryData(queryKey, previousData);
      });

      showToast({
        title: "Error creating folder",
        description: "Failed to create folder. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (response) => {
      showToast({
        title: "Folder created",
        description: `"${response.folder?.name}" created successfully`,
        variant: "default",
      });
    },
    onSettled: () => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
    },
  });
}

/**
 * Update folder mutation
 */
export function useUpdateFolder() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    FolderOperationResponse,
    Error,
    { folderId: string; updates: FolderUpdate },
    {
      previousFolder?: Folder;
      previousTree?: FolderTreeResponse;
    }
  >({
    mutationFn: ({ folderId, updates }) => folderService.updateFolder(folderId, updates),
    onMutate: async ({ folderId, updates }) => {
      // Cancel outgoing queries
      await queryClient.cancelQueries({ queryKey: folderKeys.detail(folderId) });
      await queryClient.cancelQueries({ queryKey: folderKeys.tree() });

      // Snapshot previous values
      const previousFolder = queryClient.getQueryData<Folder>(folderKeys.detail(folderId));
      const previousTree = queryClient.getQueryData<FolderTreeResponse>(folderKeys.tree());

      // Optimistically update folder detail
      if (previousFolder) {
        queryClient.setQueryData<Folder>(folderKeys.detail(folderId), (old) => {
          if (!old) return old;
          return {
            ...old,
            ...updates,
            updated_at: new Date().toISOString(),
          };
        });
      }

      return { previousFolder, previousTree };
    },
    onError: (_error, { folderId }, context) => {
      // Rollback
      if (context?.previousFolder) {
        queryClient.setQueryData(folderKeys.detail(folderId), context.previousFolder);
      }
      if (context?.previousTree) {
        queryClient.setQueryData(folderKeys.tree(), context.previousTree);
      }

      showToast({
        title: "Error updating folder",
        description: "Failed to update folder. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (response) => {
      showToast({
        title: "Folder updated",
        description: `"${response.folder?.name}" updated successfully`,
        variant: "default",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
    },
  });
}

/**
 * Delete folder mutation
 */
export function useDeleteFolder() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    FolderOperationResponse,
    Error,
    { folderId: string; moveContentsToParent?: boolean },
    {
      previousTree?: FolderTreeResponse;
    }
  >({
    mutationFn: ({ folderId, moveContentsToParent = true }) =>
      folderService.deleteFolder(folderId, moveContentsToParent),
    onMutate: async ({ folderId }) => {
      // Cancel outgoing queries
      await queryClient.cancelQueries({ queryKey: folderKeys.tree() });

      // Snapshot previous tree
      const previousTree = queryClient.getQueryData<FolderTreeResponse>(folderKeys.tree());

      // Optimistically remove from tree
      if (previousTree) {
        queryClient.setQueryData<FolderTreeResponse>(folderKeys.tree(), (old) => {
          if (!old) return old;

          const removeFolder = (nodes: any[]): any[] => {
            return nodes
              .filter((node) => !(node.node_type === "folder" && node.id === folderId))
              .map((node) => {
                if (node.node_type === "folder") {
                  return {
                    ...node,
                    children: removeFolder(node.children || []),
                  };
                }
                return node;
              });
          };

          return {
            ...old,
            tree: removeFolder(old.tree),
            total_folders: Math.max(0, old.total_folders - 1),
          };
        });
      }

      return { previousTree };
    },
    onError: (_error, _variables, context) => {
      // Rollback
      if (context?.previousTree) {
        queryClient.setQueryData(folderKeys.tree(), context.previousTree);
      }

      showToast({
        title: "Error deleting folder",
        description: "Failed to delete folder. Please try again.",
        variant: "destructive",
      });
    },
    onSuccess: (response) => {
      showToast({
        title: "Folder deleted",
        description: response.message,
        variant: "default",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
      // Also invalidate knowledge queries as sources may have moved
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

/**
 * Move source to folder mutation
 */
export function useMoveSourceToFolder() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<{ success: boolean; message: string }, Error, { sourceId: string; folderId: string | null }>({
    mutationFn: ({ sourceId, folderId }) => folderService.moveSourceToFolder(sourceId, folderId),
    onSuccess: () => {
      showToast({
        title: "Source moved",
        description: "Source moved successfully",
        variant: "default",
      });
    },
    onError: () => {
      showToast({
        title: "Error moving source",
        description: "Failed to move source. Please try again.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      // Invalidate both folder and knowledge queries
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

/**
 * Batch move sources mutation
 */
export function useBatchMoveSources() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    { success: boolean; message: string; count: number },
    Error,
    BatchMoveSourcesRequest
  >({
    mutationFn: (request) => folderService.batchMoveSources(request),
    onSuccess: (response) => {
      showToast({
        title: "Sources moved",
        description: `${response.count} source(s) moved successfully`,
        variant: "default",
      });
    },
    onError: () => {
      showToast({
        title: "Error moving sources",
        description: "Failed to move sources. Please try again.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      // Invalidate both folder and knowledge queries
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.all });
    },
  });
}

/**
 * Move folder mutation (change parent)
 */
export function useMoveFolder() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    FolderOperationResponse,
    Error,
    { folderId: string; newParentId: string | null }
  >({
    mutationFn: ({ folderId, newParentId }) => folderService.moveFolder(folderId, newParentId),
    onSuccess: (response) => {
      showToast({
        title: "Folder moved",
        description: `"${response.folder?.name}" moved successfully`,
        variant: "default",
      });
    },
    onError: () => {
      showToast({
        title: "Error moving folder",
        description: "Failed to move folder. Please try again.",
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: folderKeys.all });
    },
  });
}

