/**
 * CreateFolderDialog Component
 * Dialog for creating new folders in the knowledge base
 */

import { useState } from "react";
import { Folder, Loader2 } from "lucide-react";
import { cn } from "@/features/ui/primitives/styles";
import { Button } from "@/features/ui/primitives/button";
import { Input } from "@/features/ui/primitives/input";
import { Label } from "@/features/ui/primitives/label";
import { Textarea } from "@/features/ui/primitives/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/primitives/dialog";
import { useCreateFolder } from "../hooks";
import { folderService } from "../services";

interface CreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId?: string | null;
  onSuccess?: (folderId: string) => void;
}

export const CreateFolderDialog: React.FC<CreateFolderDialogProps> = ({
  open,
  onOpenChange,
  parentId,
  onSuccess,
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createFolder = useCreateFolder();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate folder name
    const validation = folderService.validateFolderName(name);
    if (!validation.valid) {
      setError(validation.error || "Invalid folder name");
      return;
    }

    try {
      const result = await createFolder.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        parent_id: parentId || null,
        position: 0,
        metadata: {},
      });

      if (result.success && result.folder) {
        onSuccess?.(result.folder.id);
        handleClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const handleClose = () => {
    setName("");
    setDescription("");
    setError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-cyan-500" />
            Create New Folder
          </DialogTitle>
          <DialogDescription>
            Organize your knowledge sources by creating folders and subfolders.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Folder Name */}
          <div className="space-y-2">
            <Label htmlFor="folder-name">
              Folder Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Documentation, Backend, APIs"
              maxLength={255}
              required
              autoFocus
              className={cn(error && "border-red-500 focus:border-red-500")}
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>

          {/* Description (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="folder-description">
              Description <span className="text-gray-400 text-xs">(optional)</span>
            </Label>
            <Textarea
              id="folder-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this folder contains..."
              rows={3}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              disabled={createFolder.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || createFolder.isPending}
              className="gap-2"
            >
              {createFolder.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Folder className="w-4 h-4" />
                  Create Folder
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

