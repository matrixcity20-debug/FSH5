import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive, Trash2, ChevronRight, File, Clock, Plus } from "lucide-react";
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

export default function FileListPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold font-mono gradient-text">File Library</h1>
          <p className="text-muted-foreground text-sm">Manage your split files and embed codes.</p>
        </div>
        <Link href="/">
          <Button className="gap-2 text-xs font-mono">
            <Plus className="w-3.5 h-3.5" />
            New Upload
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-border bg-card/60 animate-pulse" />
          ))}
        </div>
      ) : files && files.length > 0 ? (
        <div className="space-y-2">
          {files.map((file) => {
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
                    <p className="font-mono text-sm font-semibold text-foreground truncate max-w-[280px]" title={file.name}>
                      {file.name}
                    </p>
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
        </div>
      ) : (
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

      {files && files.length > 0 && (
        <p className="text-center text-xs text-muted-foreground/50 font-mono">
          {files.length} file{files.length !== 1 ? "s" : ""} stored
        </p>
      )}
    </div>
  );
}
