import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy, Download, Trash2, Terminal, ArrowLeft, Layers,
  FileCode2, Check, Link2, Clock, Radio, WifiOff, Loader2, GitBranch, Plus,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import {
  useGetFile,
  getGetFileQueryKey,
  useDeleteFile,
  useGetFileSnippet,
  getListFilesQueryKey,
  getDownloadChunkUrl,
  getDownloadFileUrl,
} from "@/lib/generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

interface VersionMeta {
  id: string;
  name: string;
  size: number;
  uploadedAt: string;
  version?: number;
  groupId?: string;
}

function VersionHistory({ groupId, currentFileId }: { groupId: string; currentFileId: string }) {
  const { data: versions, isLoading } = useQuery<VersionMeta[]>({
    queryKey: ["group", groupId],
    queryFn: async () => {
      const res = await fetch(`/api/files/group/${groupId}`);
      if (!res.ok) throw new Error("Failed to load versions");
      return res.json() as Promise<VersionMeta[]>;
    },
  });

  if (isLoading) {
    return <div className="h-8 animate-pulse bg-muted rounded-lg" />;
  }

  if (!versions || versions.length < 2) return null;

  return (
    <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="font-mono text-sm flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-primary" />
          Version History
          <span className="ml-auto text-xs font-normal text-muted-foreground font-sans">{versions.length} versions</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {[...versions].reverse().map((v) => {
          const isCurrent = v.id === currentFileId;
          return (
            <div
              key={v.id}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all ${
                isCurrent
                  ? "border-primary/30 bg-primary/5"
                  : "border-border/40 bg-muted/10 hover:bg-muted/20 hover:border-border/70"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-xs font-mono font-bold shrink-0 ${isCurrent ? "text-primary" : "text-muted-foreground"}`}>
                  v{v.version ?? "?"}
                </span>
                <span className="text-xs font-mono text-foreground truncate max-w-[180px]">{v.name}</span>
                {isCurrent && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary shrink-0">
                    current
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground font-mono hidden sm:block">
                  {format(new Date(v.uploadedAt), "MMM d, yyyy")}
                </span>
                {!isCurrent && (
                  <Link href={`/files/${v.id}`}>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] font-mono">
                      View
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          );
        })}
        <div className="pt-1">
          <Link href={`/?parentFileId=${currentFileId}`}>
            <Button variant="outline" size="sm" className="w-full gap-2 text-xs font-mono">
              <Plus className="w-3.5 h-3.5" />
              Upload new version
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function MetaRow({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider shrink-0">{label}</span>
      <span className={`text-xs font-mono text-right ${className ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

type P2PStatus = "idle" | "connecting" | "receiving" | "done" | "error" | "offline";
type SeederPresence = "checking" | "online" | "offline" | "unknown";

function P2PDownloader({
  fileId, fileName, fileSize, mimeType,
}: { fileId: string; fileName: string; fileSize: number; mimeType: string }) {
  const [status, setStatus] = useState<P2PStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [presence, setPresence] = useState<SeederPresence>("checking");
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // On mount, ask the signaling server whether the seeder for this file is
  // currently connected, so the user sees an online/offline badge before
  // they bother clicking "Download via P2P".
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "seeder-status", fileId }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      if (msg.type === "seeder-status" && msg.fileId === fileId) {
        setPresence(msg.online ? "online" : "offline");
        ws.close();
      }
    };

    ws.onerror = () => setPresence("unknown");

    const timeout = setTimeout(() => {
      setPresence((prev) => (prev === "checking" ? "unknown" : prev));
      ws.close();
    }, 5000);

    return () => {
      clearTimeout(timeout);
      ws.close();
    };
  }, [fileId]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      pcRef.current?.close();
    };
  }, []);

  const startDownload = () => {
    setStatus("connecting");
    setProgress(0);
    setErrorMsg("");

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "leech", fileId }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;

      if (msg.type === "seeder-offline") {
        setStatus("offline");
        setErrorMsg("Seeder is offline. The file owner's browser is not open.");
        ws.close();
        return;
      }

      if (msg.type === "offer") {
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
          ],
        });
        pcRef.current = pc;

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            ws.send(JSON.stringify({ type: "ice", to: msg.from, candidate: e.candidate }));
          }
        };

        const receivedChunks: ArrayBuffer[] = [];
        let headerParsed = false;
        let totalChunks = 0;

        pc.ondatachannel = (e) => {
          const dc = e.channel;
          setStatus("receiving");

          dc.onmessage = (ev) => {
            if (!headerParsed) {
              const header = JSON.parse(ev.data as string) as { chunkCount: number };
              totalChunks = header.chunkCount;
              headerParsed = true;
              return;
            }

            if (ev.data === "__DONE__") {
              const blob = new Blob(receivedChunks, { type: mimeType });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = fileName;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              setStatus("done");
              setProgress(100);
              ws.close();
              return;
            }

            receivedChunks.push(ev.data as ArrayBuffer);
            if (totalChunks > 0) {
              setProgress(Math.round((receivedChunks.length / totalChunks) * 100));
            }
          };
        };

        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", to: msg.from, sdp: pc.localDescription }));
      }

      if (msg.type === "ice") {
        if (pcRef.current) {
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit)); } catch { /* ignore */ }
        }
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setErrorMsg("WebSocket connection failed.");
    };
  };

  return (
    <div className="space-y-4">
      {status === "idle" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 rounded-lg border border-primary/20 bg-primary/5">
            <Radio className="w-4 h-4 text-primary shrink-0" />
            <p className="text-xs text-muted-foreground font-mono">This file is seeded peer-to-peer. The download streams directly from the owner's browser.</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-mono">
            {presence === "checking" && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking seeder status…
              </span>
            )}
            {presence === "online" && (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Seeder is online
              </span>
            )}
            {presence === "offline" && (
              <span className="flex items-center gap-1.5 text-amber-400">
                <WifiOff className="w-3 h-3" /> Seeder appears offline — download will likely fail
              </span>
            )}
            {presence === "unknown" && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                Could not check seeder status
              </span>
            )}
          </div>
          <Button className="w-full gap-2 text-xs font-mono" onClick={startDownload}>
            <Download className="w-3.5 h-3.5" />
            Download via P2P
          </Button>
        </div>
      )}

      {status === "connecting" && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-xs font-mono text-muted-foreground">Connecting to seeder...</p>
        </div>
      )}

      {status === "receiving" && (
        <div className="space-y-3">
          <div className="flex justify-between text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1"><Radio className="w-3.5 h-3.5 text-primary animate-pulse" /> Receiving from peer...</span>
            <span className="text-primary">{progress}%</span>
          </div>
          <Progress value={progress} className="h-1.5" />
          <p className="text-xs text-muted-foreground font-mono text-center">
            {formatBytes(fileSize * progress / 100)} / {formatBytes(fileSize)}
          </p>
        </div>
      )}

      {status === "done" && (
        <div className="flex flex-col items-center gap-2 py-3">
          <Check className="w-8 h-8 text-emerald-400" />
          <p className="text-xs font-mono text-emerald-400">Download complete!</p>
          <Button variant="outline" size="sm" className="text-xs font-mono mt-1" onClick={() => setStatus("idle")}>
            Download again
          </Button>
        </div>
      )}

      {(status === "offline" || status === "error") && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <WifiOff className="w-4 h-4 text-red-400 shrink-0" />
            <p className="text-xs text-red-400/80 font-mono">{errorMsg}</p>
          </div>
          <Button variant="outline" className="w-full gap-2 text-xs font-mono" onClick={startDownload}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export default function FileDetailPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedChunks, setCopiedChunks] = useState<Record<number, boolean>>({});

  const { data: file, isLoading: fileLoading } = useGetFile(fileId, {
    query: { enabled: !!fileId, queryKey: getGetFileQueryKey(fileId) },
  });

  const isSeedOnly = !!(file as { seedOnly?: boolean } | undefined)?.seedOnly;

  const { data: snippetData, isLoading: snippetLoading } = useGetFileSnippet(fileId, {
    query: { enabled: !!fileId && !isSeedOnly, queryKey: ["snippet", fileId] },
  });

  const deleteFile = useDeleteFile({
    mutation: {
      onSuccess: () => {
        toast({ title: "File deleted" });
        queryClient.invalidateQueries({ queryKey: getListFilesQueryKey() });
        setLocation("/files");
      },
      onError: () => {
        toast({ variant: "destructive", title: "Failed to delete file" });
      },
    },
  });

  const copyToClipboard = async (text: string, type: "snippet" | "chunk" | "link", index?: number) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "snippet") {
        setCopiedSnippet(true);
        setTimeout(() => setCopiedSnippet(false), 2000);
      } else if (type === "link") {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else if (type === "chunk" && index !== undefined) {
        setCopiedChunks((prev) => ({ ...prev, [index]: true }));
        setTimeout(() => setCopiedChunks((prev) => ({ ...prev, [index]: false })), 2000);
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to copy" });
    }
  };

  if (fileLoading || (snippetLoading && !isSeedOnly)) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 animate-pulse">
        <div className="h-8 bg-muted rounded-lg w-1/3" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <div className="h-48 bg-card rounded-xl border border-border" />
            <div className="h-48 bg-card rounded-xl border border-border" />
          </div>
          <div className="h-72 bg-card rounded-xl border border-border" />
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="text-center py-24">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-muted/50 border border-border flex items-center justify-center mb-4">
          <FileCode2 className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-mono font-bold mb-2">File not found</h2>
        <p className="text-muted-foreground text-sm mb-6">This file does not exist or has been deleted.</p>
        <Link href="/files">
          <Button className="font-mono text-xs">Return to Library</Button>
        </Link>
      </div>
    );
  }

  const downloadUrl = `${window.location.origin}${getDownloadFileUrl(fileId)}`;
  const shareUrl = `${window.location.origin}/files/${fileId}`;
  const isExpired = file.expiresAt ? new Date(file.expiresAt) < new Date() : false;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href="/files">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground mt-0.5 shrink-0">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold font-mono text-foreground truncate max-w-xl" title={file.name}>
                {file.name}
              </h1>
              {(file as unknown as { version?: number }).version !== undefined && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px] font-mono shrink-0">
                  <GitBranch className="w-2.5 h-2.5" /> v{(file as unknown as { version?: number }).version}
                </span>
              )}
              {isSeedOnly && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px] font-mono shrink-0">
                  <Radio className="w-2.5 h-2.5" /> P2P Seed
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">{formatBytes(file.size)}</span>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <span className="text-xs text-muted-foreground">{format(new Date(file.uploadedAt), "MMM d, yyyy HH:mm")}</span>
              {file.expiresAt && (
                <>
                  <span className="text-muted-foreground/30 text-xs">·</span>
                  <span className={`flex items-center gap-1 text-xs font-mono ${isExpired ? "text-destructive" : "text-amber-400"}`}>
                    <Clock className="w-3 h-3" />
                    {isExpired ? "Expired" : `Expires ${formatDistanceToNow(new Date(file.expiresAt), { addSuffix: true })}`}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-mono"
            onClick={() => copyToClipboard(shareUrl, "link")}
          >
            {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Link2 className="w-3.5 h-3.5" />}
            {copiedLink ? "Copied!" : "Copy Link"}
          </Button>
          {!isSeedOnly && (
            <a href={getDownloadFileUrl(fileId)} download={file.name}>
              <Button size="sm" variant="secondary" className="gap-2 text-xs font-mono">
                <Download className="w-3.5 h-3.5" />
                Download
              </Button>
            </a>
          )}
          <Button
            size="sm"
            variant="destructive"
            className="gap-2 text-xs font-mono"
            onClick={() => deleteFile.mutate({ fileId })}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {isSeedOnly ? (
            <Card className="border-primary/20 bg-primary/5 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 font-mono text-sm">
                  <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Radio className="w-3.5 h-3.5 text-primary" />
                  </div>
                  P2P Download
                </CardTitle>
                <CardDescription className="text-xs">
                  This file is shared peer-to-peer. It streams directly from the uploader's browser via WebRTC — no server storage.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <P2PDownloader
                  fileId={fileId}
                  fileName={file.name}
                  fileSize={file.size}
                  mimeType={file.mimeType || "application/octet-stream"}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 font-mono text-sm">
                    <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <Terminal className="w-3.5 h-3.5 text-primary" />
                    </div>
                    JS Embed Snippet
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Paste this zero-dependency snippet into any HTML page to add a download button.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <div className="absolute right-3 top-3 z-10">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-3 font-mono text-xs bg-card/80 backdrop-blur-sm border border-border hover:bg-muted"
                        onClick={() => copyToClipboard(snippetData?.snippet ?? "", "snippet")}
                      >
                        {copiedSnippet ? <Check className="w-3 h-3 mr-1.5 text-emerald-400" /> : <Copy className="w-3 h-3 mr-1.5" />}
                        {copiedSnippet ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <pre className="p-4 rounded-lg bg-[#050a0a] border border-primary/10 text-emerald-400 font-mono text-xs overflow-x-auto leading-relaxed">
                      <code>{snippetData?.snippet}</code>
                    </pre>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 font-mono text-sm">
                    <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <Layers className="w-3.5 h-3.5 text-primary" />
                    </div>
                    Raw Chunks
                    <span className="ml-auto text-xs font-normal text-muted-foreground font-sans">{file.chunkCount} pieces</span>
                  </CardTitle>
                  <CardDescription className="text-xs">Direct access to individual split chunks.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5">
                    {Array.from({ length: file.chunkCount }).map((_, i) => {
                      const chunkUrl = file.chunkUrls?.[i] ?? getDownloadChunkUrl(fileId, i);
                      const fullUrl = window.location.origin + chunkUrl;
                      return (
                        <div
                          key={i}
                          className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 hover:border-border/70 transition-all group"
                        >
                          <div className="flex items-center gap-3">
                            <FileCode2 className="w-3.5 h-3.5 text-primary/60" />
                            <span className="font-mono text-xs text-muted-foreground">
                              chunk_<span className="text-foreground">{String(i).padStart(3, "0")}</span>.bin
                            </span>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              onClick={() => copyToClipboard(fullUrl, "chunk", i)}
                              title="Copy URL"
                            >
                              {copiedChunks[i] ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            </Button>
                            <a href={chunkUrl} download={`${file.name}.part${i}`} target="_blank" rel="noreferrer">
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" title="Download chunk">
                                <Download className="w-3.5 h-3.5" />
                              </Button>
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <div className="space-y-5">
          <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm">Metadata</CardTitle>
            </CardHeader>
            <CardContent className="px-5">
              <MetaRow label="Type" value={isSeedOnly ? (
                <span className="flex items-center gap-1 text-primary"><Radio className="w-3 h-3" /> P2P Seed</span>
              ) : "Server stored"} />
              <MetaRow label="MIME" value={file.mimeType || "application/octet-stream"} />
              <MetaRow label="Size" value={formatBytes(file.size)} />
              <MetaRow label="Chunk size" value={formatBytes(file.chunkSize)} />
              <MetaRow label="Chunks" value={`${file.chunkCount} pieces`} />
              {file.expiresAt && (
                <MetaRow
                  label="Expires"
                  value={format(new Date(file.expiresAt), "MMM d, yyyy HH:mm")}
                  className={isExpired ? "text-destructive" : "text-amber-400"}
                />
              )}
            </CardContent>
          </Card>

          {(file as unknown as { groupId?: string }).groupId && (
            <VersionHistory
              groupId={(file as unknown as { groupId?: string }).groupId!}
              currentFileId={fileId}
            />
          )}

          <Card className="border-border/60 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm flex items-center gap-2">
                <Link2 className="w-3.5 h-3.5 text-primary" />
                Share Link
              </CardTitle>
              <CardDescription className="text-xs">
                {isSeedOnly
                  ? "Share this link — peers connect directly to your browser."
                  : "Share this URL to let anyone download the full file."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
                <code className="text-xs font-mono text-muted-foreground break-all leading-relaxed">
                  {isSeedOnly ? shareUrl : downloadUrl}
                </code>
              </div>
              <Button
                className="w-full gap-2 text-xs font-mono"
                onClick={() => copyToClipboard(isSeedOnly ? shareUrl : downloadUrl, "link")}
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedLink ? "Copied!" : "Copy Link"}
              </Button>
              {!isSeedOnly && (
                <a href={getDownloadFileUrl(fileId)} download={file.name} className="block">
                  <Button variant="outline" className="w-full gap-2 text-xs font-mono">
                    <Download className="w-3.5 h-3.5" />
                    Download File
                  </Button>
                </a>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
