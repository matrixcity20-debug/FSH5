import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  UploadCloud, File, AlertCircle, Clock, Zap, Code2,
  Shield, Radio, Server, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";

const TTL_OPTIONS = [
  { value: "", label: "Never expire" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const FEATURES = [
  { icon: Zap, title: "Instant splitting", desc: "Files split into 1 MB chunks automatically" },
  { icon: Code2, title: "Zero-dependency embed", desc: "Drop a JS snippet anywhere to add a download button" },
  { icon: Shield, title: "Auto-expiry", desc: "Set a TTL and files delete themselves" },
];

const CHUNK_SIZE = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Parse error message from API JSON response body, fallback to statusText */
async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const json = await res.clone().json() as Record<string, unknown>;
    if (typeof json.error === "string") return json.error;
    if (typeof json.message === "string") return json.message;
  } catch { /* ignore */ }
  return res.statusText || "An error occurred";
}

/**
 * Read file in CHUNK_SIZE slices, reporting progress.
 * Uses File.slice() + Uint8Array — never loads more than one chunk at a time.
 */
function readFileChunks(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ArrayBuffer[]> {
  return new Promise((resolve, reject) => {
    const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
    const chunks: ArrayBuffer[] = [];
    let index = 0;

    function readNext() {
      if (index >= chunkCount) { resolve(chunks); return; }
      const slice = file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      const reader = new FileReader();
      reader.onload = (e) => {
        if (!e.target?.result) { reject(new Error("Failed to read chunk")); return; }
        chunks.push(e.target.result as ArrayBuffer);
        index++;
        onProgress?.(index, chunkCount);
        readNext();
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(slice);
    }

    readNext();
  });
}

type SeedStatus = "idle" | "registering" | "seeding" | "offline";

interface SeederState {
  fileId: string;
  fileName: string;
  fileSize: number;
  chunkCount: number;
  connectedPeers: number;
  status: SeedStatus;
  bytesServed: number;
}

type UploadStep =
  | { phase: "idle" }
  | { phase: "hashing" }
  | { phase: "uploading"; done: number; total: number }
  | { phase: "finalizing" }
  | { phase: "chunking"; done: number; total: number }
  | { phase: "connecting" };

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadStep, setUploadStep] = useState<UploadStep>({ phase: "idle" });
  const [ttl, setTtl] = useState("");
  const [seederState, setSeederState] = useState<SeederState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const abortRef = useRef(false);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      peersRef.current.forEach((pc) => pc.close());
      xhrRef.current?.abort();
    };
  }, []);

  const resetState = () => {
    xhrRef.current?.abort();
    wsRef.current?.close();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    chunksRef.current = [];
    abortRef.current = false;
    setUploadStep({ phase: "idle" });
  };

  const cancelUpload = () => {
    abortRef.current = true;
    resetState();
    toast({ title: "Upload cancelled" });
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
  }, []);

  const isUploading = uploadStep.phase !== "idle";

  // ── Server upload (chunked, with SHA-256 integrity check) ─────────────────
  const handleUpload = async () => {
    if (!file) return;
    abortRef.current = false;

    const PART_SIZE = 5 * 1024 * 1024; // 5 MB per HTTP request

    try {
      // 1. Compute SHA-256 of the full file in the browser
      setUploadStep({ phase: "hashing" });
      const fileBuffer = await file.arrayBuffer();
      if (abortRef.current) return;
      const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
      const sha256 = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // 2. Initialise upload session on the server
      const initRes = await fetch("/api/files/upload-init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
        }),
      });
      if (abortRef.current) return;
      if (!initRes.ok) {
        const msg = await parseErrorMessage(initRes);
        throw new Error(msg);
      }
      const { uploadId } = await initRes.json() as { uploadId: string };

      // 3. Upload parts sequentially
      const totalParts = Math.ceil(file.size / PART_SIZE);
      let bytesDone = 0;
      setUploadStep({ phase: "uploading", done: 0, total: file.size });

      for (let i = 0; i < totalParts; i++) {
        if (abortRef.current) return;
        const slice = file.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
        const fd = new FormData();
        fd.append("uploadId", uploadId);
        fd.append("partIndex", String(i));
        fd.append("part", slice, file.name);

        const partRes = await fetch("/api/files/upload-part", {
          method: "POST",
          body: fd,
        });
        if (abortRef.current) return;
        if (!partRes.ok) {
          const msg = await parseErrorMessage(partRes);
          throw new Error(`Part ${i} failed: ${msg}`);
        }

        bytesDone += slice.size;
        setUploadStep({ phase: "uploading", done: bytesDone, total: file.size });
      }

      // 4. Finalise — server assembles, verifies SHA-256, splits into chunks
      if (abortRef.current) return;
      setUploadStep({ phase: "finalizing" });

      const finalRes = await fetch("/api/files/upload-finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId,
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          totalParts,
          sha256,
          ...(ttl ? { ttl } : {}),
        }),
      });
      if (abortRef.current) return;
      if (!finalRes.ok) {
        const msg = await parseErrorMessage(finalRes);
        throw new Error(msg);
      }

      const meta = await finalRes.json() as { id: string };
      toast({ title: "Upload complete ✓", description: "Integrity verified — file split and stored successfully." });
      setLocation(`/files/${meta.id}`);

    } catch (err) {
      if (abortRef.current) return;
      const msg = err instanceof Error ? err.message : "An error occurred";
      toast({ variant: "destructive", title: "Upload failed", description: msg });
      resetState();
    }
  };

  // ── P2P seed ───────────────────────────────────────────────────────────────
  const handleSeed = async () => {
    if (!file) return;
    abortRef.current = false;

    try {
      // 1. Register seed with API
      setUploadStep({ phase: "connecting" });
      const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

      const res = await fetch("/api/files/register-seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          chunkCount,
        }),
      });

      if (!res.ok) {
        const msg = await parseErrorMessage(res);
        throw new Error(msg);
      }
      if (abortRef.current) return;

      const meta = await res.json() as { id: string };
      const fileId = meta.id;

      // 2. Read file into chunks — show real progress
      setUploadStep({ phase: "chunking", done: 0, total: chunkCount });
      const chunks = await readFileChunks(file, (done, total) => {
        if (!abortRef.current) {
          setUploadStep({ phase: "chunking", done, total });
        }
      });
      if (abortRef.current) return;
      chunksRef.current = chunks;

      // 3. Connect WebSocket and start seeding
      setUploadStep({ phase: "connecting" });
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "seed", fileId }));
      };

      ws.onmessage = async (event) => {
        if (abortRef.current) return;
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        if (msg.type === "seeding") {
          setUploadStep({ phase: "idle" });
          setSeederState({
            fileId,
            fileName: file.name,
            fileSize: file.size,
            chunkCount,
            connectedPeers: 0,
            status: "seeding",
            bytesServed: 0,
          });
          toast({ title: "Seeding active", description: "Share the link — peers download directly from your browser." });
        }

        if (msg.type === "peer-joined") {
          const leecherId = msg.leecherId as string;
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
            ],
          });
          peersRef.current.set(leecherId, pc);
          setSeederState((prev) => prev ? { ...prev, connectedPeers: prev.connectedPeers + 1 } : prev);

          const dc = pc.createDataChannel("file", { ordered: true });
          const BUFFER_HIGH = 4 * 1024 * 1024;
          const BUFFER_LOW  = 1 * 1024 * 1024;
          dc.bufferedAmountLowThreshold = BUFFER_LOW;

          function waitForDrain(): Promise<void> {
            return new Promise((resolve) => {
              const prev = dc.onbufferedamountlow;
              dc.onbufferedamountlow = (e) => {
                dc.onbufferedamountlow = prev;
                resolve();
                if (typeof prev === "function") prev.call(dc, e);
              };
            });
          }

          dc.onopen = async () => {
            if (dc.readyState !== "open") return;
            dc.send(JSON.stringify({
              name: file.name,
              size: file.size,
              mimeType: file.type || "application/octet-stream",
              chunkCount: chunksRef.current.length,
            }));
            for (const chunk of chunksRef.current) {
              if (dc.readyState !== "open") break;
              while (dc.bufferedAmount > BUFFER_HIGH) {
                if (dc.readyState !== "open") break;
                await waitForDrain();
              }
              if (dc.readyState !== "open") break;
              dc.send(chunk);
              setSeederState((prev) =>
                prev ? { ...prev, bytesServed: prev.bytesServed + chunk.byteLength } : prev
              );
            }
            if (dc.readyState === "open") dc.send("__DONE__");
          };

          dc.onclose = () => {
            setSeederState((prev) =>
              prev ? { ...prev, connectedPeers: Math.max(0, prev.connectedPeers - 1) } : prev
            );
            peersRef.current.delete(leecherId);
            pc.close();
          };

          // Queue ICE candidates until after setRemoteDescription
          const pendingCandidates: RTCIceCandidateInit[] = [];
          let remoteSet = false;

          const flushCandidates = async () => {
            for (const c of pendingCandidates) {
              try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* ignore */ }
            }
            pendingCandidates.length = 0;
          };

          pc.onicecandidate = (e) => {
            if (e.candidate) {
              ws.send(JSON.stringify({ type: "ice", to: leecherId, candidate: e.candidate }));
            }
          };

          pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
              setSeederState((prev) =>
                prev ? { ...prev, connectedPeers: Math.max(0, prev.connectedPeers - 1) } : prev
              );
              peersRef.current.delete(leecherId);
              pc.close();
            }
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: "offer", to: leecherId, sdp: pc.localDescription }));

          // Attach answer handler via message filtering
          const origOnmessage = ws.onmessage;
          ws.addEventListener("message", async (ev: MessageEvent) => {
            const m = JSON.parse(ev.data as string) as Record<string, unknown>;
            if (m.type === "answer" && m.from === leecherId) {
              await pc.setRemoteDescription(new RTCSessionDescription(m.sdp as RTCSessionDescriptionInit));
              remoteSet = true;
              await flushCandidates();
            }
            if (m.type === "ice" && m.from === leecherId) {
              if (remoteSet) {
                try { await pc.addIceCandidate(new RTCIceCandidate(m.candidate as RTCIceCandidateInit)); } catch { /* ignore */ }
              } else {
                pendingCandidates.push(m.candidate as RTCIceCandidateInit);
              }
            }
          });
          void origOnmessage;
        }
      };

      ws.onerror = () => {
        if (!abortRef.current) {
          toast({ variant: "destructive", title: "WebSocket error", description: "Could not connect to signaling server." });
          resetState();
        }
      };

      ws.onclose = () => {
        setSeederState((prev) => prev ? { ...prev, status: "offline" } : prev);
      };

    } catch (err) {
      if (abortRef.current) return;
      const msg = err instanceof Error ? err.message : "Could not start seeding";
      toast({ variant: "destructive", title: "Seed failed", description: msg });
      resetState();
    }
  };

  const stopSeeding = () => {
    wsRef.current?.close();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    setSeederState(null);
    setFile(null);
    chunksRef.current = [];
    abortRef.current = false;
  };

  // ── Seeder active view ──────────────────────────────────────────────────────
  if (seederState) {
    const shareUrl = `${window.location.origin}/files/${seederState.fileId}`;
    const isOnline = seederState.status === "seeding";

    return (
      <div className="max-w-2xl mx-auto space-y-6 mt-8">
        <div className="text-center space-y-2">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-mono mb-2 ${isOnline ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
            {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isOnline ? "Seeding active" : "Seeder offline"}
          </div>
          <h1 className="text-3xl font-bold font-mono gradient-text">{seederState.fileName}</h1>
          <p className="text-muted-foreground text-sm">
            {formatBytes(seederState.fileSize)} · {seederState.chunkCount} chunks
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-border/60 bg-card/60 text-center">
            <Users className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-2xl font-bold font-mono text-foreground">{seederState.connectedPeers}</p>
            <p className="text-xs text-muted-foreground">Active peers</p>
          </div>
          <div className="p-4 rounded-xl border border-border/60 bg-card/60 text-center">
            <Radio className="w-5 h-5 text-primary mx-auto mb-1" />
            <p className="text-2xl font-bold font-mono text-foreground">{formatBytes(seederState.bytesServed)}</p>
            <p className="text-xs text-muted-foreground">Data served</p>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Share link</p>
          <code className="text-xs font-mono text-primary break-all">{shareUrl}</code>
          <Button
            size="sm"
            className="w-full text-xs font-mono"
            onClick={() => navigator.clipboard.writeText(shareUrl).then(() => toast({ title: "Copied!" }))}
          >
            Copy Share Link
          </Button>
        </div>

        <div className="p-3 rounded-lg border border-amber-500/20 bg-amber-500/5 flex gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400/80">Keep this tab open while seeding. Closing it will disconnect all peers.</p>
        </div>

        <Button variant="destructive" className="w-full text-xs font-mono" onClick={stopSeeding}>
          Stop Seeding
        </Button>
      </div>
    );
  }

  // ── Upload progress label ───────────────────────────────────────────────────
  const progressLabel = (() => {
    if (uploadStep.phase === "hashing")    return "Computing hash…";
    if (uploadStep.phase === "uploading")  return `Uploading… ${formatBytes(uploadStep.done)} / ${formatBytes(uploadStep.total)}`;
    if (uploadStep.phase === "finalizing") return "Assembling & verifying integrity…";
    if (uploadStep.phase === "chunking")   return `Splitting… ${uploadStep.done}/${uploadStep.total} chunks`;
    if (uploadStep.phase === "connecting") return "Connecting…";
    return "Processing…";
  })();

  const progressValue = (() => {
    if (uploadStep.phase === "hashing")    return 2;
    if (uploadStep.phase === "uploading")  return 5 + (uploadStep.done / Math.max(1, uploadStep.total)) * 88;
    if (uploadStep.phase === "finalizing") return 96;
    if (uploadStep.phase === "chunking")   return (uploadStep.done / Math.max(1, uploadStep.total)) * 100;
    if (uploadStep.phase === "connecting") return 99;
    return 0;
  })();

  // ── Main view ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-10 mt-8">
      <div className="space-y-4 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-mono mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          Ready to split
        </div>
        <h1 className="text-5xl font-bold font-mono tracking-tight gradient-text leading-tight">
          Split. Embed.<br />Distribute.
        </h1>
        <p className="text-muted-foreground max-w-md mx-auto text-sm leading-relaxed">
          Upload any file to automatically split it into optimized chunks and generate a zero-dependency JS download embed.
        </p>
      </div>

      <div
        className={`relative rounded-xl border-2 border-dashed transition-all duration-200 overflow-hidden
          ${dragActive
            ? "border-primary/70 bg-primary/5 dropzone-active"
            : file
              ? "border-primary/30 bg-card cursor-default"
              : "border-border hover:border-primary/30 hover:bg-muted/20 bg-card cursor-pointer"
          }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !isUploading && !file && inputRef.current?.click()}
      >
        <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary/40 rounded-tl-xl" />
        <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary/40 rounded-tr-xl" />
        <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary/40 rounded-bl-xl" />
        <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary/40 rounded-br-xl" />

        <input
          type="file"
          ref={inputRef}
          className="hidden"
          onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
          disabled={isUploading}
        />

        <div className="p-14 text-center">
          {isUploading ? (
            <div className="space-y-6 max-w-sm mx-auto">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center glow-cyan-sm">
                <UploadCloud className="w-8 h-8 text-primary animate-pulse" />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-sm font-mono text-muted-foreground">
                  <span>{progressLabel}</span>
                  <span className="text-primary">{Math.round(progressValue)}%</span>
                </div>
                <Progress value={progressValue} className="h-1.5" />
                {file && (
                  <p className="text-xs text-muted-foreground/60 font-mono">{file.name} · {formatBytes(file.size)}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs font-mono text-muted-foreground gap-1.5"
                onClick={cancelUpload}
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </Button>
            </div>
          ) : file ? (
            <div className="space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <File className="w-8 h-8 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-mono text-base font-bold text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">{formatBytes(file.size)}</p>
              </div>

              <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 bg-muted/50 border border-border rounded-lg px-3 py-2">
                  <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                  <select
                    value={ttl}
                    onChange={(e) => setTtl(e.target.value)}
                    className="bg-transparent text-sm font-mono text-foreground focus:outline-none"
                  >
                    {TTL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-card">{opt.label}</option>
                    ))}
                  </select>
                </div>

                <p className="text-xs text-muted-foreground font-mono">How do you want to share this file?</p>

                <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
                  <button
                    onClick={handleUpload}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-border hover:border-primary/40 bg-card hover:bg-primary/5 transition-all cursor-pointer"
                  >
                    <Server className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs font-mono font-semibold text-foreground">Store on Server</span>
                    <span className="text-[10px] text-muted-foreground text-center leading-tight">Upload to server, always available</span>
                  </button>
                  <button
                    onClick={handleSeed}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-primary/40 bg-primary/5 hover:border-primary/70 hover:bg-primary/10 transition-all cursor-pointer"
                  >
                    <Radio className="w-5 h-5 text-primary" />
                    <span className="text-xs font-mono font-semibold text-primary">Seed from Browser</span>
                    <span className="text-[10px] text-muted-foreground text-center leading-tight">P2P — tab must stay open</span>
                  </button>
                </div>

                <Button variant="ghost" size="sm" onClick={() => setFile(null)} className="font-mono text-xs text-muted-foreground">
                  Clear
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-muted/50 border border-border flex items-center justify-center">
                <UploadCloud className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">Drag & drop a file here</p>
                <p className="text-sm text-muted-foreground">or click to browse from your computer</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center font-mono">
        <AlertCircle className="w-3.5 h-3.5" />
        <span>Max file size: 500 MB · Chunks: 1 MB each</span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="p-4 rounded-xl border border-border/60 bg-card/60 space-y-2 hover:border-primary/20 hover:bg-card transition-all">
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">{title}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
