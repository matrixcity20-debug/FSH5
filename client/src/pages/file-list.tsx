import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  HardDrive, Trash2, ChevronRight, File, Clock, Plus,
  GitBranch, Folder, FolderOpen, FolderPlus, ArrowLeft, X,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import {
  useListFiles,
  getListFilesQueryKey,
  useDeleteFile,
} from "@/lib/generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

interface FolderMeta {
  id: string;
  name: string;
  createdAt: string;
}

export default function FileListPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;

  const { data: files, isLoading } = useListFiles();
  const deleteFile = useDeleteFile({
    mutation: {
      onSuccess: () => {
        toast({ title: "File deleted" });
        queryClient.invalidateQueries({ queryKey: getListFilesQueryKey() });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to delete file" });
      },
    },
  });

  const loadFolders = () => {
    fetch("/api/folders")
      .then((r) => r.ok ? r.json() as Promise<FolderMeta[]> : [])
      .then(setFolders)
      .catch(() => setFolders([]));
  };

  useEffect(() => {
    loadFolders();
  }, []);

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to create folder");
      }
      toast({ title: "Folder created" });
      setNewFolderName("");
      setShowNewFolder(false);
      loadFolders();
    } catch (err) {
      toast({ variant: "destructive", title: err instanceof Error ? err.message : "Failed to create folder" });
    } finally {
      setCreatingFolder(false);
    }
  };

  const deleteFolder = async (folderId: string, folderName: string) => {
    if (!confirm(`Delete folder "${folderName}"? Files inside will be moved to root.`)) return;
    try {
      const res = await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete folder");
      toast({ title: "Folder deleted", description: "Files moved to root." });
      if (currentFolderId === folderId) setCurrentFolderId(null);
      loadFolders();
      queryClient.invalidateQueries({ queryKey: getListFilesQueryKey() });
    } catch {
      toast({ variant: "destructive", title: "Failed to delete folder" });
    }
  };

  const visibleFiles = (files ?? []).filter((f) => {
    const fileFolderId = (f as unknown as { folderId?: string }).folderId;
    if (currentFolderId === null) return !fileFolderId;
    return fileFolderId === currentFolderId;
  });

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {currentFolderId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => setCurrentFolderId(null)}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
          )}
          <div className="space-y-0.5">
            <h1 className="text-2xl font-bold font-mono gradient-text">
              {currentFolder ? currentFolder.name : "File Library"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {currentFolder
                ? "Files in this folder"
                : "Manage your split files and folders."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!currentFolderId && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-xs font-mono"
              onClick={() => setShowNewFolder((v) => !v)}
            >
              <FolderPlus className="w-3.5 h-3.5" />
              New Folder
            </Button>
          )}
          <Link href={currentFolderId ? `/?folderId=${currentFolderId}` : "/"}>
            <Button className="gap-2 text-xs font-mono" size="sm">
              <Plus className="w-3.5 h-3.5" />
              New Upload
            </Button>
          </Link>
        </div>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-primary/20 bg-primary/5">
          <Folder className="w-4 h-4 text-primary shrink-0" />
          <input
            type="text"
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createFolder();
              if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); }
            }}
            placeholder="Folder name…"
            className="flex-1 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <Button
            size="sm"
            className="text-xs font-mono px-3"
            disabled={!newFolderName.trim() || creatingFolder}
            onClick={createFolder}
          >
            {creatingFolder ? "…" : "Create"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground px-2"
            onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-border bg-card/60 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {/* Folders (only shown at root) */}
          {currentFolderId === null && folders.map((folder) => {
            const folderFileCount = (files ?? []).filter(
              (f) => (f as unknown as { folderId?: string }).folderId === folder.id
            ).length;

            return (
              <div
                key={folder.id}
                className="group flex items-center justify-between p-4 rounded-xl border border-border/60 bg-card/60 hover:bg-card hover:border-primary/20 transition-all cursor-pointer"
                onClick={() => setCurrentFolderId(folder.id)}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-primary/8 border border-primary/15 flex items-center justify-center shrink-0 group-hover:bg-primary/12 transition-colors">
                    <FolderOpen className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-foreground truncate max-w-[260px]">
                      {folder.name}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">
                      {folderFileCount} file{folderFileCount !== 1 ? "s" : ""} · Created {format(new Date(folder.createdAt), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <div onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                      onClick={() => deleteFolder(folder.id, folder.name)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />
                </div>
              </div>
            );
          })}

          {/* Files */}
          {visibleFiles.map((file) => {
            const soonExpiring = file.expiresAt
              ? new Date(file.expiresAt) < new Date(Date.now() + 24 * 60 * 60 * 1000)
              : false;

            return (
              <div
                key={file.id}
                className="group flex items-center justify-between p-4 rounded-xl border border-border/60 bg-card/60 hover:bg-card hover:border-primary/20 transition-all cursor-pointer"
                onClick={() => setLocation(`/files/${file.id}`)}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-primary/8 border border-primary/15 flex items-center justify-center shrink-0 group-hover:bg-primary/12 transition-colors">
                    <File className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-sm font-semibold text-foreground truncate max-w-[260px]" title={file.name}>
                        {file.name}
                      </p>
                      {(file as unknown as { version?: number }).version !== undefined && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-primary/20 bg-primary/5 text-primary text-[10px] font-mono shrink-0">
                          <GitBranch className="w-2.5 h-2.5" />
                          v{(file as unknown as { version?: number }).version}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-muted-foreground font-mono">{formatBytes(file.size)}</span>
                      <span className="text-xs text-muted-foreground/40">·</span>
                      <span className="text-xs text-muted-foreground font-mono">{file.chunkCount} chunks</span>
                      <span className="text-xs text-muted-foreground/40">·</span>
                      <span className="text-xs text-muted-foreground">{format(new Date(file.uploadedAt), "MMM d, yyyy")}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {file.expiresAt && (
                    <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-mono
                      ${soonExpiring
                        ? "border-amber-500/30 bg-amber-500/5 text-amber-400"
                        : "border-border bg-muted/30 text-muted-foreground"
                      }`}
                    >
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(file.expiresAt), { addSuffix: true })}
                    </div>
                  )}
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                      onClick={() => deleteFile.mutate({ fileId: file.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />
                </div>
              </div>
            );
          })}

          {/* Empty state */}
          {folders.length === 0 && visibleFiles.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center py-24 text-center rounded-xl border border-dashed border-border bg-card/30">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 border border-border flex items-center justify-center mb-4">
                <HardDrive className="w-7 h-7 text-muted-foreground" />
              </div>
              <h3 className="font-mono text-base font-bold mb-1">Library Empty</h3>
              <p className="text-muted-foreground text-sm mb-6 max-w-xs">You haven't uploaded any files yet.</p>
              <Link href="/">
                <Button className="gap-2 font-mono text-xs">
                  <Plus className="w-3.5 h-3.5" />
                  Upload your first file
                </Button>
              </Link>
            </div>
          )}

          {currentFolderId !== null && visibleFiles.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center py-16 text-center rounded-xl border border-dashed border-border bg-card/30">
              <div className="w-12 h-12 rounded-xl bg-muted/50 border border-border flex items-center justify-center mb-3">
                <Folder className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="font-mono text-sm font-bold mb-1">Folder is empty</h3>
              <p className="text-muted-foreground text-xs mb-4">Upload a file to this folder.</p>
              <Link href={`/?folderId=${currentFolderId}`}>
                <Button size="sm" className="gap-2 font-mono text-xs">
                  <Plus className="w-3.5 h-3.5" />
                  Upload here
                </Button>
              </Link>
            </div>
          )}
        </div>
      )}

      {(folders.length > 0 || visibleFiles.length > 0) && (
        <p className="text-center text-xs text-muted-foreground/50 font-mono">
          {currentFolderId === null
            ? `${folders.length} folder${folders.length !== 1 ? "s" : ""} · ${(files ?? []).length} file${(files ?? []).length !== 1 ? "s" : ""} total`
            : `${visibleFiles.length} file${visibleFiles.length !== 1 ? "s" : ""} in folder`}
        </p>
      )}
    </div>
  );
}
