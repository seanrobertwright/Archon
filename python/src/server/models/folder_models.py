"""Pydantic models for knowledge folder organization."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class FolderBase(BaseModel):
    """Base folder model with common fields."""

    name: str = Field(..., min_length=1, max_length=255, description="Folder name")
    description: str | None = Field(None, description="Optional folder description")
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$", description="Hex color code (e.g., #00ff41)")
    icon: str | None = Field(None, description="Icon identifier (e.g., folder, book, code)")
    position: int = Field(0, description="Sort order within parent folder")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Flexible metadata storage")

    model_config = ConfigDict(
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class FolderCreate(FolderBase):
    """Model for creating a new folder."""

    parent_id: UUID | None = Field(None, description="Parent folder ID (null for root-level folders)")


class FolderUpdate(BaseModel):
    """Model for updating an existing folder."""

    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    icon: str | None = None
    position: int | None = None
    parent_id: UUID | None = None  # For moving folder to new parent
    metadata: dict[str, Any] | None = None

    model_config = ConfigDict(
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class Folder(FolderBase):
    """Complete folder model with all database fields."""

    id: UUID = Field(..., description="Unique folder identifier")
    parent_id: UUID | None = Field(None, description="Parent folder ID")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    # Computed fields (not in database, calculated on retrieval)
    source_count: int = Field(0, description="Number of sources directly in this folder")
    subfolder_count: int = Field(0, description="Number of immediate subfolders")
    total_sources: int = Field(0, description="Total sources including subfolders (recursive)")

    model_config = ConfigDict(
        populate_by_name=True,
        from_attributes=True,  # For SQLAlchemy/database row conversion
    )


class FolderTreeNode(Folder):
    """Folder with nested children for tree representation."""

    children: list["FolderTreeNode | SourceInFolder"] = Field(
        default_factory=list,
        description="Child folders and sources"
    )
    node_type: Literal["folder"] = "folder"

    model_config = ConfigDict(
        populate_by_name=True,
        from_attributes=True,
    )


class SourceInFolder(BaseModel):
    """Minimal source representation for folder tree view."""

    id: str = Field(..., description="Source ID")
    source_id: str = Field(..., description="Source identifier")
    title: str | None = Field(None, description="Source title")
    source_url: str | None = Field(None, description="Source URL")
    source_display_name: str | None = Field(None, description="Display name")
    folder_id: UUID | None = Field(None, description="Containing folder ID")
    created_at: datetime = Field(..., description="Creation timestamp")
    node_type: Literal["source"] = "source"
    
    # Metadata from JSONB field
    knowledge_type: str | None = Field(None, description="Technical or business")
    tags: list[str] = Field(default_factory=list, description="Source tags")

    model_config = ConfigDict(
        populate_by_name=True,
        from_attributes=True,
    )


class FolderWithContents(Folder):
    """Folder with immediate contents (non-recursive)."""

    subfolders: list[Folder] = Field(default_factory=list, description="Immediate subfolders")
    sources: list[SourceInFolder] = Field(default_factory=list, description="Sources in this folder")
    path: list[str] = Field(default_factory=list, description="Full path from root to this folder")

    model_config = ConfigDict(
        populate_by_name=True,
        from_attributes=True,
    )


class MoveFolderRequest(BaseModel):
    """Request to move a folder to a new parent."""

    folder_id: UUID = Field(..., description="ID of folder to move")
    new_parent_id: UUID | None = Field(..., description="New parent ID (null for root)")

    model_config = ConfigDict(populate_by_name=True)


class MoveSourceRequest(BaseModel):
    """Request to move a source to a folder."""

    source_id: str = Field(..., description="Source ID to move")
    folder_id: UUID | None = Field(..., description="Target folder ID (null for root)")

    model_config = ConfigDict(populate_by_name=True)


class BatchMoveSourcesRequest(BaseModel):
    """Request to move multiple sources to a folder."""

    source_ids: list[str] = Field(..., min_length=1, description="List of source IDs to move")
    folder_id: UUID | None = Field(..., description="Target folder ID (null for root)")

    model_config = ConfigDict(populate_by_name=True)


class DeleteFolderRequest(BaseModel):
    """Request to delete a folder with options for handling contents."""

    folder_id: UUID = Field(..., description="ID of folder to delete")
    move_contents_to_parent: bool = Field(
        True,
        description="If true, move contents to parent. If false, delete all recursively."
    )

    model_config = ConfigDict(populate_by_name=True)


class FolderOperationResponse(BaseModel):
    """Response for folder operations."""

    success: bool = Field(..., description="Operation success status")
    message: str = Field(..., description="Human-readable message")
    folder: Folder | None = Field(None, description="The affected folder (if applicable)")
    folders: list[Folder] | None = Field(None, description="Multiple folders (for batch operations)")

    model_config = ConfigDict(populate_by_name=True)


class FolderListResponse(BaseModel):
    """Response for listing folders."""

    folders: list[Folder] = Field(default_factory=list, description="List of folders")
    total: int = Field(0, description="Total count")

    model_config = ConfigDict(populate_by_name=True)


class FolderTreeResponse(BaseModel):
    """Response containing full folder tree."""

    tree: list[FolderTreeNode] = Field(default_factory=list, description="Root-level folders with children")
    total_folders: int = Field(0, description="Total folder count")
    total_sources: int = Field(0, description="Total source count")

    model_config = ConfigDict(populate_by_name=True)


# Update forward refs for recursive model
FolderTreeNode.model_rebuild()

