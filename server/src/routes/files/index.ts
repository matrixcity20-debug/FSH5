import { Router, type IRouter } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import {
  ensureUploadsDir,
  saveMeta,
  readMeta,
  listAllFiles,
  deleteFile,
  splitAndSaveFromPath,
  buildChunkUrls,
  generateSnippet,
  getChunkPath,
  isFileExpired,
  isValidFileId,
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  uploadsDir,
  type FileMeta,
} from "../../lib/fileStore.js";

const router: IRouter = Router();

// ── Multer: write to disk, never buffer whole file in RAM ─────────────────
ensureUploadsDir();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureUploadsDir();
      cb(null, uploadsDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `tmp_${uuidv4()}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

const TTL_OPTIONS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const MAX_CHUNK_COUNT = 10_000;
const MAX_SEED_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB — sanity cap

function getBaseUrl(req: {
  protocol: string;
  get: (h: string) => string | undefined;
}): string {
  const host = req.get("host") ?? "localhost";
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto ?? req.protocol ?? "http";
  return `${protocol}://${host}`;
}

// ── POST /files/upload ───────────────────────────────────────────────────────
router.post(
  "/files/upload",
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const tempPath = path.join(uploadsDir, req.file.filename);

    try {
      ensureUploadsDir();
      const fileId = uuidv4();
      const fileSize = req.file.size;
      const chunkCount = splitAndSaveFromPath(fileId, tempPath);
      const baseUrl = getBaseUrl(req);
      const chunkUrls = buildChunkUrls(fileId, chunkCount, baseUrl);

      const ttlKey = typeof req.body?.ttl === "string" ? req.body.ttl : null;
      let expiresAt: string | undefined;
      if (ttlKey && TTL_OPTIONS[ttlKey]) {
        expiresAt = new Date(Date.now() + TTL_OPTIONS[ttlKey]).toISOString();
      }

      const meta: FileMeta = {
        id: fileId,
        name: req.file.originalname,
        size: fileSize,
        mimeType: req.file.mimetype || "application/octet-stream",
        chunkCount,
        chunkSize: CHUNK_SIZE,
        uploadedAt: new Date().toISOString(),
        chunkUrls,
        ...(expiresAt ? { expiresAt } : {}),
      };

      saveMeta(meta);
      req.log.info(
        { fileId, name: meta.name, chunkCount, expiresAt },
        "File uploaded and split",
      );
      res.status(201).json(meta);
    } catch (err) {
      // Clean up temp file if anything went wrong
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      req.log.error({ err }, "Upload failed");
      res.status(500).json({ error: "Upload failed" });
    }
  },
);

// ── POST /files/register-seed ────────────────────────────────────────────────
router.post("/files/register-seed", async (req, res): Promise<void> => {
  const { name, size, mimeType, chunkCount } = req.body as {
    name: string;
    size: number;
    mimeType: string;
    chunkCount: number;
  };

  if (!name || !size || !mimeType || !chunkCount) {
    res.status(400).json({ error: "Missing required fields: name, size, mimeType, chunkCount" });
    return;
  }

  if (typeof name !== "string" || name.length > 512) {
    res.status(400).json({ error: "Invalid file name" });
    return;
  }

  if (typeof size !== "number" || size <= 0 || size > MAX_SEED_SIZE) {
    res.status(400).json({ error: `Invalid size (max ${MAX_SEED_SIZE} bytes)` });
    return;
  }

  if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) {
    res.status(400).json({ error: `Invalid chunkCount (max ${MAX_CHUNK_COUNT})` });
    return;
  }

  ensureUploadsDir();
  const fileId = uuidv4();
  const meta: FileMeta = {
    id: fileId,
    name: String(name).slice(0, 512),
    size: Number(size),
    mimeType: String(mimeType).slice(0, 128),
    chunkCount: Number(chunkCount),
    chunkSize: CHUNK_SIZE,
    uploadedAt: new Date().toISOString(),
    chunkUrls: [],
    seedOnly: true,
  };

  saveMeta(meta);
  req.log.info({ fileId, name: meta.name, chunkCount }, "Seed-only file registered");
  res.status(201).json(meta);
});

// ── GET /files ───────────────────────────────────────────────────────────────
router.get("/files", async (_req, res): Promise<void> => {
  ensureUploadsDir();
  const files = listAllFiles();
  res.json(files);
});

// ── GET /files/:fileId ───────────────────────────────────────────────────────
router.get("/files/:fileId", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "File has expired and been deleted" });
    return;
  }

  res.json(meta);
});

// ── DELETE /files/:fileId ────────────────────────────────────────────────────
router.delete("/files/:fileId", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  const deleted = deleteFile(fileId);
  if (!deleted) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  req.log.info({ fileId }, "File deleted");
  res.sendStatus(204);
});

// ── GET /files/:fileId/snippet ───────────────────────────────────────────────
router.get("/files/:fileId/snippet", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "File has expired and been deleted" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const snippet = generateSnippet(meta, baseUrl);
  res.json({ fileId: meta.id, snippet });
});

// ── GET /files/:fileId/download ──────────────────────────────────────────────
// Streams chunks to client one-by-one — never loads whole file into RAM.
router.get("/files/:fileId/download", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  const meta = readMeta(fileId);
  if (!meta) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (isFileExpired(meta)) {
    deleteFile(meta.id);
    res.status(410).json({ error: "File has expired and been deleted" });
    return;
  }

  // Validate all chunks exist before starting the stream
  for (let i = 0; i < meta.chunkCount; i++) {
    if (!fs.existsSync(getChunkPath(fileId, i))) {
      res.status(500).json({ error: `Chunk ${i} is missing` });
      return;
    }
  }

  const safeName = encodeURIComponent(meta.name).replace(/'/g, "%27");
  res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${safeName}`);
  res.setHeader("Content-Length", meta.size);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");

  // Stream each chunk directly to response — no in-memory concat
  const streamChunk = (i: number): void => {
    if (i >= meta.chunkCount) {
      res.end();
      return;
    }
    const chunkPath = getChunkPath(fileId, i);
    const stream = fs.createReadStream(chunkPath);
    stream.on("error", () => res.destroy());
    stream.on("end", () => streamChunk(i + 1));
    stream.pipe(res, { end: false });
  };

  req.on("close", () => { /* client disconnected, stream will error naturally */ });
  streamChunk(0);
});

// ── GET /files/:fileId/chunks/:chunkIndex ────────────────────────────────────
router.get(
  "/files/:fileId/chunks/:chunkIndex",
  async (req, res): Promise<void> => {
    const { fileId } = req.params;
    const rawIdx = req.params.chunkIndex;
    const chunkIndex = parseInt(rawIdx ?? "", 10);

    if (!fileId || !isValidFileId(fileId) || isNaN(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ error: "Invalid parameters" });
      return;
    }

    const meta = readMeta(fileId);
    if (!meta) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    if (isFileExpired(meta)) {
      deleteFile(meta.id);
      res.status(410).json({ error: "File has expired and been deleted" });
      return;
    }

    if (chunkIndex >= meta.chunkCount) {
      res.status(404).json({ error: "Chunk not found" });
      return;
    }

    const chunkPath = getChunkPath(fileId, chunkIndex);
    if (!fs.existsSync(chunkPath)) {
      res.status(404).json({ error: "Chunk file missing" });
      return;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="chunk_${chunkIndex}.bin"`,
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(chunkPath);
  },
);

export default router;
