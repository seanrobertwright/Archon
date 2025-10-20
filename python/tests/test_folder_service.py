"""
Tests for Folder Service

Tests folder CRUD operations, hierarchy management, and circular reference prevention.
"""

import pytest
from uuid import uuid4
from unittest.mock import AsyncMock, MagicMock, patch

from src.server.models.folder_models import FolderCreate, FolderUpdate
from src.server.services.folder_service import FolderService


@pytest.fixture
def mock_supabase():
    """Mock Supabase client."""
    return MagicMock()


@pytest.fixture
def folder_service(mock_supabase):
    """Create FolderService with mocked Supabase."""
    return FolderService(mock_supabase)


class TestFolderService:
    """Test suite for FolderService."""

    @pytest.mark.asyncio
    async def test_create_folder_root_level(self, folder_service, mock_supabase):
        """Test creating a folder at root level."""
        folder_id = str(uuid4())
        folder_data = FolderCreate(
            name="Test Folder",
            description="Test description",
            parent_id=None,
        )

        # Mock database response
        mock_result = MagicMock()
        mock_result.data = [
            {
                "id": folder_id,
                "name": "Test Folder",
                "description": "Test description",
                "parent_id": None,
                "color": None,
                "icon": None,
                "position": 0,
                "metadata": {},
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        mock_supabase.from_().insert().execute.return_value = mock_result
        mock_supabase.from_().select().eq().execute.return_value = MagicMock(count=0)

        # Create folder
        result = await folder_service.create_folder(folder_data)

        # Assertions
        assert result.name == "Test Folder"
        assert result.description == "Test description"
        assert result.parent_id is None
        assert result.source_count == 0
        assert result.subfolder_count == 0

    @pytest.mark.asyncio
    async def test_create_folder_with_parent(self, folder_service, mock_supabase):
        """Test creating a subfolder with parent."""
        parent_id = uuid4()
        folder_id = uuid4()

        folder_data = FolderCreate(
            name="Subfolder",
            parent_id=parent_id,
        )

        # Mock parent exists check
        mock_parent_result = MagicMock()
        mock_parent_result.data = [{"id": str(parent_id)}]

        # Mock insert result
        mock_insert_result = MagicMock()
        mock_insert_result.data = [
            {
                "id": str(folder_id),
                "name": "Subfolder",
                "description": None,
                "parent_id": str(parent_id),
                "color": None,
                "icon": None,
                "position": 0,
                "metadata": {},
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        mock_supabase.from_().select().eq().execute.return_value = mock_parent_result
        mock_supabase.from_().insert().execute.return_value = mock_insert_result

        result = await folder_service.create_folder(folder_data)

        assert result.name == "Subfolder"
        assert str(result.parent_id) == str(parent_id)

    @pytest.mark.asyncio
    async def test_create_folder_invalid_parent(self, folder_service, mock_supabase):
        """Test creating folder with non-existent parent fails."""
        parent_id = uuid4()

        folder_data = FolderCreate(
            name="Subfolder",
            parent_id=parent_id,
        )

        # Mock parent doesn't exist
        mock_result = MagicMock()
        mock_result.data = []

        mock_supabase.from_().select().eq().execute.return_value = mock_result

        # Should raise ValueError
        with pytest.raises(ValueError, match="Parent folder .* does not exist"):
            await folder_service.create_folder(folder_data)

    @pytest.mark.asyncio
    async def test_move_source_to_folder(self, folder_service, mock_supabase):
        """Test moving a source to a folder."""
        source_id = "source-123"
        folder_id = uuid4()

        # Mock folder exists
        mock_folder_result = MagicMock()
        mock_folder_result.data = [
            {
                "id": str(folder_id),
                "name": "Target Folder",
                "parent_id": None,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        # Mock update result
        mock_update_result = MagicMock()
        mock_update_result.data = [{"source_id": source_id}]

        mock_supabase.from_().select().eq().execute.return_value = mock_folder_result
        mock_supabase.from_().update().eq().execute.return_value = mock_update_result

        result = await folder_service.move_source_to_folder(source_id, folder_id)

        assert result["success"] is True
        assert result["source_id"] == source_id

    @pytest.mark.asyncio
    async def test_batch_move_sources(self, folder_service, mock_supabase):
        """Test batch moving multiple sources."""
        source_ids = ["source-1", "source-2", "source-3"]
        folder_id = uuid4()

        # Mock folder exists
        mock_folder_result = MagicMock()
        mock_folder_result.data = [{"id": str(folder_id)}]

        mock_supabase.from_().select().eq().execute.return_value = mock_folder_result

        result = await folder_service.batch_move_sources(source_ids, folder_id)

        assert result["success"] is True
        assert result["count"] == 3

    @pytest.mark.asyncio
    async def test_delete_folder_move_contents(self, folder_service, mock_supabase):
        """Test deleting folder and moving contents to parent."""
        folder_id = uuid4()
        parent_id = uuid4()

        # Mock folder
        mock_folder = MagicMock()
        mock_folder.data = [
            {
                "id": str(folder_id),
                "name": "Folder to Delete",
                "parent_id": str(parent_id),
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        mock_supabase.from_().select().eq().execute.return_value = mock_folder

        result = await folder_service.delete_folder(folder_id, move_contents_to_parent=True)

        assert result["success"] is True
        assert result["moved_to_parent"] is True

    @pytest.mark.asyncio
    async def test_list_folders_root_only(self, folder_service, mock_supabase):
        """Test listing root-level folders only."""
        mock_result = MagicMock()
        mock_result.data = [
            {
                "id": str(uuid4()),
                "name": "Root Folder 1",
                "parent_id": None,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        mock_supabase.from_().select().is_().order().order().execute.return_value = mock_result

        folders = await folder_service.list_folders(parent_id=None, include_counts=False)

        assert len(folders) == 1
        assert folders[0].name == "Root Folder 1"
        assert folders[0].parent_id is None


class TestCircularReferenceValidation:
    """Test circular reference prevention."""

    @pytest.mark.asyncio
    async def test_prevent_self_reference(self, folder_service, mock_supabase):
        """Test that folder cannot be its own parent."""
        folder_id = uuid4()

        # Mock _would_create_circular_reference to return True
        with patch.object(folder_service, "_would_create_circular_reference", return_value=True):
            updates = FolderUpdate(parent_id=folder_id)

            # Mock folder exists
            mock_folder = MagicMock()
            mock_folder.data = [
                {
                    "id": str(folder_id),
                    "name": "Test Folder",
                    "parent_id": None,
                    "created_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z",
                }
            ]

            mock_supabase.from_().select().eq().execute.return_value = mock_folder

            with pytest.raises(ValueError, match="circular reference"):
                await folder_service.update_folder(folder_id, updates)

