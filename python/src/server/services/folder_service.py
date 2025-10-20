"""
Folder Service

Handles all folder-related operations including CRUD, hierarchy management,
and source-to-folder associations for knowledge base organization.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from ..config.logfire_config import safe_logfire_error, safe_logfire_info
from ..models.folder_models import (
    Folder,
    FolderCreate,
    FolderTreeNode,
    FolderUpdate,
    FolderWithContents,
    SourceInFolder,
)


class FolderService:
    """
    Service for managing knowledge base folder hierarchy and organization.
    """

    def __init__(self, supabase_client):
        """
        Initialize the folder service.

        Args:
            supabase_client: The Supabase client for database operations
        """
        self.supabase = supabase_client

    async def create_folder(self, folder_data: FolderCreate) -> Folder:
        """
        Create a new folder in the hierarchy.

        Args:
            folder_data: Folder creation data

        Returns:
            Created folder with ID and timestamps

        Raises:
            ValueError: If parent_id doesn't exist or creates circular reference
        """
        try:
            safe_logfire_info(f"Creating folder: {folder_data.name} with parent_id={folder_data.parent_id}")

            # Validate parent exists if provided
            if folder_data.parent_id:
                parent_result = self.supabase.from_("archon_knowledge_folders").select("id").eq("id", str(folder_data.parent_id)).execute()

                if not parent_result.data:
                    raise ValueError(f"Parent folder {folder_data.parent_id} does not exist")

            # Insert folder
            insert_data = {
                "name": folder_data.name,
                "description": folder_data.description,
                "parent_id": str(folder_data.parent_id) if folder_data.parent_id else None,
                "color": folder_data.color,
                "icon": folder_data.icon,
                "position": folder_data.position,
                "metadata": folder_data.metadata,
            }

            result = self.supabase.from_("archon_knowledge_folders").insert(insert_data).execute()

            if not result.data:
                raise ValueError("Failed to create folder")

            folder_record = result.data[0]
            
            # Get counts
            source_count = await self._count_sources_in_folder(folder_record["id"])
            subfolder_count = await self._count_subfolders(folder_record["id"])

            return Folder(
                **folder_record,
                source_count=source_count,
                subfolder_count=subfolder_count,
                total_sources=source_count,
            )

        except Exception as e:
            safe_logfire_error(f"Failed to create folder: {str(e)}", exc_info=True)
            raise

    async def get_folder_by_id(self, folder_id: UUID) -> Folder | None:
        """
        Get a folder by its ID.

        Args:
            folder_id: Folder UUID

        Returns:
            Folder if found, None otherwise
        """
        try:
            result = self.supabase.from_("archon_knowledge_folders").select("*").eq("id", str(folder_id)).execute()

            if not result.data:
                return None

            folder_record = result.data[0]

            # Get counts
            source_count = await self._count_sources_in_folder(folder_id)
            subfolder_count = await self._count_subfolders(folder_id)
            total_sources = await self._count_total_sources_recursive(folder_id)

            return Folder(
                **folder_record,
                source_count=source_count,
                subfolder_count=subfolder_count,
                total_sources=total_sources,
            )

        except Exception as e:
            safe_logfire_error(f"Failed to get folder {folder_id}: {str(e)}", exc_info=True)
            return None

    async def list_folders(
        self,
        parent_id: UUID | None = None,
        include_counts: bool = True,
    ) -> list[Folder]:
        """
        List folders, optionally filtered by parent.

        Args:
            parent_id: Parent folder ID to filter by (None for root folders)
            include_counts: Whether to include source and subfolder counts

        Returns:
            List of folders
        """
        try:
            query = self.supabase.from_("archon_knowledge_folders").select("*")

            if parent_id is None:
                query = query.is_("parent_id", "null")
            else:
                query = query.eq("parent_id", str(parent_id))

            query = query.order("position").order("name")

            result = query.execute()
            folders = []

            for folder_record in result.data if result.data else []:
                if include_counts:
                    source_count = await self._count_sources_in_folder(folder_record["id"])
                    subfolder_count = await self._count_subfolders(folder_record["id"])
                    total_sources = await self._count_total_sources_recursive(folder_record["id"])
                else:
                    source_count = 0
                    subfolder_count = 0
                    total_sources = 0

                folders.append(
                    Folder(
                        **folder_record,
                        source_count=source_count,
                        subfolder_count=subfolder_count,
                        total_sources=total_sources,
                    )
                )

            return folders

        except Exception as e:
            safe_logfire_error(f"Failed to list folders: {str(e)}", exc_info=True)
            return []

    async def get_folder_tree(self) -> list[FolderTreeNode]:
        """
        Get complete folder hierarchy as a tree structure.

        Returns:
            List of root-level folders with nested children
        """
        try:
            safe_logfire_info("Building folder tree")

            # Get all folders
            all_folders = await self.list_folders(include_counts=True)

            # Get all folders with their full data
            all_folders_query = self.supabase.from_("archon_knowledge_folders").select("*").execute()
            all_folders_data = {f["id"]: f for f in all_folders_query.data or []}

            # Build tree recursively
            folder_map: dict[str, FolderTreeNode] = {}

            # First pass: create all nodes
            for folder_record in all_folders_query.data or []:
                source_count = await self._count_sources_in_folder(folder_record["id"])
                subfolder_count = await self._count_subfolders(folder_record["id"])
                total_sources = await self._count_total_sources_recursive(folder_record["id"])

                folder_map[folder_record["id"]] = FolderTreeNode(
                    **folder_record,
                    source_count=source_count,
                    subfolder_count=subfolder_count,
                    total_sources=total_sources,
                    children=[],
                )

            # Second pass: build hierarchy
            root_nodes: list[FolderTreeNode] = []

            for folder_id, folder_node in folder_map.items():
                if folder_node.parent_id:
                    # Add to parent's children
                    parent_id_str = str(folder_node.parent_id)
                    if parent_id_str in folder_map:
                        folder_map[parent_id_str].children.append(folder_node)
                else:
                    # Root level folder
                    root_nodes.append(folder_node)

            # Sort root nodes and children
            root_nodes.sort(key=lambda f: (f.position, f.name))
            for node in folder_map.values():
                node.children.sort(key=lambda c: (c.position if hasattr(c, 'position') else 0, c.name if hasattr(c, 'name') else c.title))

            return root_nodes

        except Exception as e:
            safe_logfire_error(f"Failed to build folder tree: {str(e)}", exc_info=True)
            return []

    async def get_folder_contents(
        self,
        folder_id: UUID,
        include_sources: bool = True,
        include_subfolders: bool = True,
    ) -> FolderWithContents:
        """
        Get folder with its immediate contents (non-recursive).

        Args:
            folder_id: Folder UUID
            include_sources: Whether to include sources
            include_subfolders: Whether to include subfolders

        Returns:
            Folder with contents and path
        """
        try:
            # Get the folder itself
            folder = await self.get_folder_by_id(folder_id)
            if not folder:
                raise ValueError(f"Folder {folder_id} not found")

            # Get immediate subfolders
            subfolders = []
            if include_subfolders:
                subfolders = await self.list_folders(parent_id=folder_id, include_counts=True)

            # Get sources in this folder
            sources = []
            if include_sources:
                sources_result = (
                    self.supabase.from_("archon_sources")
                    .select("*")
                    .eq("folder_id", str(folder_id))
                    .order("created_at", desc=True)
                    .execute()
                )

                for source_record in sources_result.data if sources_result.data else []:
                    metadata = source_record.get("metadata", {})
                    sources.append(
                        SourceInFolder(
                            id=source_record["source_id"],
                            source_id=source_record["source_id"],
                            title=source_record.get("title"),
                            source_url=source_record.get("source_url"),
                            source_display_name=source_record.get("source_display_name"),
                            folder_id=source_record.get("folder_id"),
                            created_at=source_record["created_at"],
                            knowledge_type=metadata.get("knowledge_type"),
                            tags=metadata.get("tags", []),
                        )
                    )

            # Get folder path
            path = await self._get_folder_path(folder_id)

            return FolderWithContents(
                **folder.model_dump(),
                subfolders=subfolders,
                sources=sources,
                path=path,
            )

        except Exception as e:
            safe_logfire_error(f"Failed to get folder contents for {folder_id}: {str(e)}", exc_info=True)
            raise

    async def update_folder(self, folder_id: UUID, updates: FolderUpdate) -> Folder:
        """
        Update a folder's properties.

        Args:
            folder_id: Folder UUID
            updates: Fields to update

        Returns:
            Updated folder

        Raises:
            ValueError: If folder doesn't exist or update creates circular reference
        """
        try:
            safe_logfire_info(f"Updating folder {folder_id}")

            # Check folder exists
            existing = await self.get_folder_by_id(folder_id)
            if not existing:
                raise ValueError(f"Folder {folder_id} not found")

            # Prepare update data (only include non-None values)
            update_data = {}
            if updates.name is not None:
                update_data["name"] = updates.name
            if updates.description is not None:
                update_data["description"] = updates.description
            if updates.color is not None:
                update_data["color"] = updates.color
            if updates.icon is not None:
                update_data["icon"] = updates.icon
            if updates.position is not None:
                update_data["position"] = updates.position
            if updates.metadata is not None:
                update_data["metadata"] = updates.metadata
            if updates.parent_id is not None:
                # Moving folder - check for circular reference
                if await self._would_create_circular_reference(folder_id, updates.parent_id):
                    raise ValueError("Cannot move folder: would create circular reference")
                update_data["parent_id"] = str(updates.parent_id)

            if not update_data:
                # No updates provided, return existing
                return existing

            update_data["updated_at"] = datetime.now().isoformat()

            result = (
                self.supabase.from_("archon_knowledge_folders")
                .update(update_data)
                .eq("id", str(folder_id))
                .execute()
            )

            if not result.data:
                raise ValueError("Failed to update folder")

            return await self.get_folder_by_id(folder_id)

        except Exception as e:
            safe_logfire_error(f"Failed to update folder {folder_id}: {str(e)}", exc_info=True)
            raise

    async def delete_folder(
        self,
        folder_id: UUID,
        move_contents_to_parent: bool = True,
    ) -> dict[str, Any]:
        """
        Delete a folder, optionally moving its contents to parent.

        Args:
            folder_id: Folder UUID to delete
            move_contents_to_parent: If True, move contents to parent. If False, delete recursively.

        Returns:
            Dict with success status and details

        Raises:
            ValueError: If folder doesn't exist
        """
        try:
            safe_logfire_info(f"Deleting folder {folder_id}, move_contents={move_contents_to_parent}")

            # Get folder to check existence and get parent_id
            folder = await self.get_folder_by_id(folder_id)
            if not folder:
                raise ValueError(f"Folder {folder_id} not found")

            if move_contents_to_parent:
                # Move sources to parent
                self.supabase.from_("archon_sources").update(
                    {"folder_id": str(folder.parent_id) if folder.parent_id else None}
                ).eq("folder_id", str(folder_id)).execute()

                # Move subfolders to parent
                self.supabase.from_("archon_knowledge_folders").update(
                    {"parent_id": str(folder.parent_id) if folder.parent_id else None}
                ).eq("parent_id", str(folder_id)).execute()

            else:
                # Recursive delete: delete all sources and subfolders
                await self._delete_folder_contents_recursive(folder_id)

            # Delete the folder itself
            self.supabase.from_("archon_knowledge_folders").delete().eq("id", str(folder_id)).execute()

            return {
                "success": True,
                "message": f"Folder '{folder.name}' deleted successfully",
                "moved_to_parent": move_contents_to_parent,
            }

        except Exception as e:
            safe_logfire_error(f"Failed to delete folder {folder_id}: {str(e)}", exc_info=True)
            raise

    async def move_source_to_folder(
        self,
        source_id: str,
        folder_id: UUID | None,
    ) -> dict[str, Any]:
        """
        Move a source to a folder (or root if folder_id is None).

        Args:
            source_id: Source ID to move
            folder_id: Target folder ID (None for root)

        Returns:
            Dict with success status
        """
        try:
            safe_logfire_info(f"Moving source {source_id} to folder {folder_id}")

            # Verify folder exists if provided
            if folder_id:
                folder = await self.get_folder_by_id(folder_id)
                if not folder:
                    raise ValueError(f"Folder {folder_id} not found")

            # Update source
            self.supabase.from_("archon_sources").update(
                {"folder_id": str(folder_id) if folder_id else None}
            ).eq("source_id", source_id).execute()

            return {
                "success": True,
                "message": "Source moved successfully",
                "source_id": source_id,
                "folder_id": str(folder_id) if folder_id else None,
            }

        except Exception as e:
            safe_logfire_error(f"Failed to move source {source_id}: {str(e)}", exc_info=True)
            raise

    async def batch_move_sources(
        self,
        source_ids: list[str],
        folder_id: UUID | None,
    ) -> dict[str, Any]:
        """
        Move multiple sources to a folder in a single operation.

        Args:
            source_ids: List of source IDs to move
            folder_id: Target folder ID (None for root)

        Returns:
            Dict with success status and count
        """
        try:
            safe_logfire_info(f"Batch moving {len(source_ids)} sources to folder {folder_id}")

            # Verify folder exists if provided
            if folder_id:
                folder = await self.get_folder_by_id(folder_id)
                if not folder:
                    raise ValueError(f"Folder {folder_id} not found")

            # Batch update
            for source_id in source_ids:
                self.supabase.from_("archon_sources").update(
                    {"folder_id": str(folder_id) if folder_id else None}
                ).eq("source_id", source_id).execute()

            return {
                "success": True,
                "message": f"Moved {len(source_ids)} sources successfully",
                "count": len(source_ids),
                "folder_id": str(folder_id) if folder_id else None,
            }

        except Exception as e:
            safe_logfire_error(f"Failed to batch move sources: {str(e)}", exc_info=True)
            raise

    # Private helper methods

    async def _count_sources_in_folder(self, folder_id: str | UUID) -> int:
        """Count sources directly in a folder (non-recursive)."""
        try:
            result = (
                self.supabase.from_("archon_sources")
                .select("*", count="exact", head=True)
                .eq("folder_id", str(folder_id))
                .execute()
            )
            return result.count if hasattr(result, "count") else 0
        except Exception:
            return 0

    async def _count_subfolders(self, folder_id: str | UUID) -> int:
        """Count immediate subfolders."""
        try:
            result = (
                self.supabase.from_("archon_knowledge_folders")
                .select("*", count="exact", head=True)
                .eq("parent_id", str(folder_id))
                .execute()
            )
            return result.count if hasattr(result, "count") else 0
        except Exception:
            return 0

    async def _count_total_sources_recursive(self, folder_id: str | UUID) -> int:
        """Count all sources in folder and subfolders (recursive)."""
        try:
            # Use database function if available
            result = self.supabase.rpc("archon_count_folder_sources", {"target_folder_id": str(folder_id)}).execute()
            
            if result.data is not None:
                return result.data
            
            # Fallback: manual recursion
            total = await self._count_sources_in_folder(folder_id)
            subfolders = await self.list_folders(parent_id=UUID(str(folder_id)), include_counts=False)
            
            for subfolder in subfolders:
                total += await self._count_total_sources_recursive(subfolder.id)
            
            return total
        except Exception:
            return 0

    async def _get_folder_path(self, folder_id: UUID) -> list[str]:
        """Get full path from root to folder."""
        try:
            # Use database function if available
            result = self.supabase.rpc("archon_get_folder_path", {"target_folder_id": str(folder_id)}).execute()
            
            if result.data:
                return result.data
            
            # Fallback: manual traversal
            path = []
            current_id = folder_id
            max_depth = 100  # Prevent infinite loops
            
            for _ in range(max_depth):
                folder = await self.get_folder_by_id(current_id)
                if not folder:
                    break
                    
                path.insert(0, folder.name)
                
                if not folder.parent_id:
                    break
                    
                current_id = folder.parent_id
            
            return path
        except Exception:
            return []

    async def _would_create_circular_reference(
        self,
        folder_id: UUID,
        new_parent_id: UUID,
    ) -> bool:
        """Check if moving folder would create circular reference."""
        try:
            # Use database function if available
            result = self.supabase.rpc(
                "archon_is_folder_descendant",
                {
                    "target_folder_id": str(new_parent_id),
                    "potential_ancestor_id": str(folder_id),
                },
            ).execute()
            
            if result.data is not None:
                return result.data
            
            # Fallback: manual check - walk up from new_parent to see if we hit folder_id
            current_id = new_parent_id
            max_depth = 100
            
            for _ in range(max_depth):
                if current_id == folder_id:
                    return True
                    
                folder = await self.get_folder_by_id(current_id)
                if not folder or not folder.parent_id:
                    break
                    
                current_id = folder.parent_id
            
            return False
        except Exception:
            # If check fails, assume circular to be safe
            return True

    async def _delete_folder_contents_recursive(self, folder_id: UUID):
        """Recursively delete all contents of a folder."""
        # Get all subfolders
        subfolders = await self.list_folders(parent_id=folder_id, include_counts=False)
        
        # Recursively delete subfolders
        for subfolder in subfolders:
            await self._delete_folder_contents_recursive(subfolder.id)
            self.supabase.from_("archon_knowledge_folders").delete().eq("id", str(subfolder.id)).execute()
        
        # Delete all sources in this folder
        self.supabase.from_("archon_sources").delete().eq("folder_id", str(folder_id)).execute()

