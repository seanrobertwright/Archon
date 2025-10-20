/**
 * Folder Query Hooks Tests
 * Tests for folder-related TanStack Query hooks
 */

import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFolders, useFolderTree, useCreateFolder, useDeleteFolder } from "../useFolderQueries";
import { folderService } from "../../services";
import type { FolderListResponse, FolderTreeResponse, FolderOperationResponse } from "../../types/folders";

// Mock the folder service
vi.mock("../../services", () => ({
  folderService: {
    getFolders: vi.fn(),
    getFolderTree: vi.fn(),
    createFolder: vi.fn(),
    deleteFolder: vi.fn(),
  },
}));

// Mock smart polling hook
vi.mock("@/features/shared/hooks", () => ({
  useSmartPolling: vi.fn(() => undefined),
}));

// Mock toast hook
vi.mock("@/features/shared/hooks/useToast", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

// Mock optimistic utilities
vi.mock("@/features/shared/utils/optimistic", () => ({
  createOptimisticId: () => "temp-id-123",
  createOptimisticEntity: (data: any) => ({ ...data, id: "temp-id-123", _optimistic: true }),
}));

describe("useFolders", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("should fetch folders successfully", async () => {
    const mockResponse: FolderListResponse = {
      folders: [
        {
          id: "folder-1",
          name: "Test Folder",
          description: null,
          parent_id: null,
          color: null,
          icon: null,
          position: 0,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source_count: 5,
          subfolder_count: 2,
          total_sources: 10,
        },
      ],
      total: 1,
    };

    vi.mocked(folderService.getFolders).mockResolvedValue(mockResponse);

    const { result } = renderHook(() => useFolders(), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(mockResponse);
    });

    expect(folderService.getFolders).toHaveBeenCalledWith(undefined);
  });

  it("should fetch folders with parent filter", async () => {
    const parentId = "parent-folder-id";
    const mockResponse: FolderListResponse = {
      folders: [],
      total: 0,
    };

    vi.mocked(folderService.getFolders).mockResolvedValue(mockResponse);

    const { result } = renderHook(() => useFolders(parentId), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(folderService.getFolders).toHaveBeenCalledWith(parentId);
  });
});

describe("useFolderTree", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("should fetch folder tree successfully", async () => {
    const mockResponse: FolderTreeResponse = {
      tree: [
        {
          id: "folder-1",
          name: "Root Folder",
          description: null,
          parent_id: null,
          color: null,
          icon: null,
          position: 0,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source_count: 3,
          subfolder_count: 1,
          total_sources: 5,
          children: [],
          node_type: "folder",
        },
      ],
      total_folders: 1,
    };

    vi.mocked(folderService.getFolderTree).mockResolvedValue(mockResponse);

    const { result } = renderHook(() => useFolderTree(), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(mockResponse);
    });

    expect(folderService.getFolderTree).toHaveBeenCalled();
  });
});

describe("useCreateFolder", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("should create folder with optimistic update", async () => {
    const mockResponse: FolderOperationResponse = {
      success: true,
      message: "Folder created",
      folder: {
        id: "new-folder-id",
        name: "New Folder",
        description: null,
        parent_id: null,
        color: null,
        icon: null,
        position: 0,
        metadata: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source_count: 0,
        subfolder_count: 0,
        total_sources: 0,
      },
    };

    vi.mocked(folderService.createFolder).mockResolvedValue(mockResponse);

    const { result } = renderHook(() => useCreateFolder(), { wrapper });

    await waitFor(() => expect(result.current).toBeDefined());

    result.current.mutate({
      name: "New Folder",
      position: 0,
      metadata: {},
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(folderService.createFolder).toHaveBeenCalledWith({
      name: "New Folder",
      position: 0,
      metadata: {},
    });
  });
});

describe("useDeleteFolder", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("should delete folder with optimistic update", async () => {
    const mockResponse: FolderOperationResponse = {
      success: true,
      message: "Folder deleted",
    };

    vi.mocked(folderService.deleteFolder).mockResolvedValue(mockResponse);

    const { result } = renderHook(() => useDeleteFolder(), { wrapper });

    await waitFor(() => expect(result.current).toBeDefined());

    result.current.mutate({
      folderId: "folder-to-delete",
      moveContentsToParent: true,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(folderService.deleteFolder).toHaveBeenCalledWith("folder-to-delete", true);
  });
});

