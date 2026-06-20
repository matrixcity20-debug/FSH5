import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  UploadCloud, File, AlertCircle, Clock, Zap, Code2,
  Shield, Radio, Server, Users, Wifi, WifiOff,
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

function splitFileIntoChunks(file: File): Promise<ArrayBuffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: ArrayBuffer[] = [];
    let offset = 0;
    const reader = new FileReader();

    function readNext() {
      if (offset >= file.size) { resolve(chunks); return; }
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = (e) => {
      if (e.target?.result) {
        chunks.push(e.target.result as ArrayBuffer);
        offset += CHUNK_SIZE;
        readNext();
      } else {
        reject(new Error("Failed to read chunk"));
      }
    };
    reader.onerror = () => reject(reader.error);
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

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ttl, setTtl] = useState("");
  const [seederState, setSeederState] = useState<SeederState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      peersRef.current.forEach((pc) => pc.close());
    };
  }, []);

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

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setProgress(0);

    const formData = new FormData();
    formData.append("file", file);
    if (ttl) formData.append("ttl", ttl);

    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files/upload", true);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const response = JSON.parse(xhr.responseText);
          toast({ title: "Upload complete", description: "File successfully split and stored." });
          setLocation(`/files/${response.id}`);
        } else {
          toast({ variant: "destructive", title: "Upload failed", description: "An error occurred." });
          setUploading(false);
          setProgress(0);
        }
      };

      xhr.onerror = () => {
        toast({ variant: "destructive", title: "Upload failed", description: "Network error occurred." });
        setUploading(false);
        setProgress(0);
      };

      xhr.send(formData);
    } catch {
      setUploading(false);
      setProgress(0);
    }
  };

  const handleSeed = async () => {
    if (!file) return;
    setUploading(true);
    setProgress(10);

    try {
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

      if (!res.ok) throw new Error("Failed to register seed");
      const meta = await res.json() as { id: string };
      const fileId = meta.id;

      setProgress(30);
      const chunks = await splitFileIntoChunks(file);
      chunksRef.current = chunks;
      setProgress(80);

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "seed", fileId }));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        if (msg.type === "seeding") {
          setProgress(100);
          setSeederState({
            fileId,
            fileName: file.name,
            fileSize: file.size,
            chunkCount,
            connectedPeers: 0,
            status: "seeding",
            bytesServed: 0,
          });
          setUploading(false);
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

          const BUFFER_HIGH = 4 * 1024 * 1024; // 4 MB — pause sending above this
          const BUFFER_LOW  = 1 * 1024 * 1024; // 1 MB — resume when below this
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
            const header = JSON.stringify({
              name: file.name,
              size: file.size,
              mimeType: file.type || "application/octet-stream",
              chunkCount: chunksRef.current.length,
            });
            dc.send(header);
            for (const chunk of chunksRef.current) {
              if (dc.readyState !== "open") break;
              // Wait for drain if buffer is getting full
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
        }

        if (msg.type === "answer") {
          const pc = peersRef.current.get(msg.from as string);
          if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit));
        }

        if (msg.type === "ice") {
          const pc = peersRef.current.get(msg.from as string);
          if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate as RTCIceCandidateInit));
        }
      };

      ws.onclose = () => {
        setSeederState((prev) => prev ? { ...prev, status: "offline" } : prev);
      };
    } catch (err) {
      console.error(err);
      toast({ variant: "destructive", title: "Seed failed", description: "Could not start seeding." });
      setUploading(false);
      setProgress(0);
    }
  };

  const stopSeeding = () => {
    wsRef.current?.close();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    setSeederState(null);
    setFile(null);
    chunksRef.current = [];
  };

  if (seederState) {
    const shareUrl = `${window.location.origin}/files/${seederState.fileId}`;
    const isOnline = seederState.status === "seeding";
    const mb = (seederState.bytesServed / 1024 / 1024).toFixed(2);

    return (
      <div className="max-w-2xl mx-auto space-y-6 mt-8">
        <div className="text-center space-y-2">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-mono mb-2 ${isOnline ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-red-500/30 bg-red-500/10 text-red-400"}`}>
            {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {isOnline ? "Seeding active" : "Seeder offline"}
          </div>
          <h1 className="text-3xl font-bold font-mono gradient-text">{seederState.fileName}</h1>
          <p className="text-muted-foreground text-sm">
            {(seederState.fileSize / 1024 / 1024).toFixed(2)} MB · {seederState.chunkCount} chunks
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
            <p className="text-2xl font-bold font-mono text-foreground">{mb} MB</p>
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
        className={`relative rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer overflow-hidden
          ${dragActive
            ? "border-primary/70 bg-primary/5 dropzone-active"
            : file
              ? "border-primary/30 bg-card"
              : "border-border hover:border-primary/30 hover:bg-muted/20 bg-card"
          }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !uploading && !file && inputRef.current?.click()}
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
          disabled={uploading}
        />

        <div className="p-14 text-center">
          {uploading ? (
            <div className="space-y-6 max-w-sm mx-auto">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center glow-cyan-sm">
                <UploadCloud className="w-8 h-8 text-primary animate-pulse" />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-sm font-mono text-muted-foreground">
                  <span>Processing...</span>
                  <span className="text-primary">{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
            </div>
          ) : file ? (
            <div className="space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
                <File className="w-8 h-8 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="font-mono text-base font-bold text-foreground">{file.name}</p>
                <p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
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
