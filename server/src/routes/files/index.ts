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
  UPLOAD_PART_SIZE,
  uploadsDir,
  getUploadTempDir,
  getPartPath,
  cleanupUpload,
  assembleAndSplit,
  listVersions,
  nextVersion,
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

// ── POST /files/upload-init ──────────────────────────────────────────────────
// Initialises a multi-part upload session. Returns uploadId + partSize.
router.post("/files/upload-init", async (req, res): Promise<void> => {
  const { name, size, mimeType } = req.body as {
    name: string;
    size: number;
    mimeType: string;
  };

  if (!name || typeof name !== "string" || name.length > 512) {
    res.status(400).json({ error: "Invalid file name" });
    return;
  }
  if (typeof size !== "number" || size <= 0 || size > MAX_FILE_SIZE) {
    res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` });
    return;
  }
  if (!mimeType || typeof mimeType !== "string") {
    res.status(400).json({ error: "Invalid mimeType" });
    return;
  }

  const uploadId = uuidv4();
  ensureUploadsDir();
  fs.mkdirSync(getUploadTempDir(uploadId), { recursive: true });

  req.log.info({ uploadId, name, size }, "Upload session initialised");
  res.status(201).json({ uploadId, partSize: UPLOAD_PART_SIZE });
});

// ── POST /files/upload-part ───────────────────────────────────────────────────
// Receives one binary part. Body: multipart with fields uploadId, partIndex,
// totalParts and a file field named "part".
const partUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const uploadId = req.body?.uploadId as string | undefined;
      if (!uploadId) { cb(new Error("Missing uploadId"), ""); return; }
      const dir = getUploadTempDir(uploadId);
      if (!fs.existsSync(dir)) { cb(new Error("Unknown uploadId"), ""); return; }
      cb(null, dir);
    },
    filename: (req, _file, cb) => {
      const idx = parseInt(req.body?.partIndex ?? "", 10);
      cb(null, `part_${idx}`);
    },
  }),
  limits: { fileSize: UPLOAD_PART_SIZE + 1024 },
});

router.post(
  "/files/upload-part",
  partUpload.single("part"),
  async (req, res): Promise<void> => {
    const { uploadId } = req.body as { uploadId: string };
    const partIndex = parseInt(req.body?.partIndex ?? "", 10);

    if (!uploadId || isNaN(partIndex) || partIndex < 0) {
      res.status(400).json({ error: "Invalid uploadId or partIndex" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No part data" });
      return;
    }

    req.log.info({ uploadId, partIndex, bytes: req.file.size }, "Part received");
    res.json({ ok: true, partIndex });
  },
);

// ── POST /files/upload-finalize ───────────────────────────────────────────────
// Assembles all parts, verifies SHA-256 against client hash, splits into chunks.
router.post("/files/upload-finalize", async (req, res): Promise<void> => {
  const { uploadId, name, size, mimeType, totalParts, sha256, ttl, parentFileId } = req.body as {
    uploadId: string;
    name: string;
    size: number;
    mimeType: string;
    totalParts: number;
    sha256: string;
    ttl?: string;
    parentFileId?: string;
  };

  if (!uploadId || !name || !size || !mimeType || !totalParts || !sha256) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const tempDir = getUploadTempDir(uploadId);
  if (!fs.existsSync(tempDir)) {
    res.status(404).json({ error: "Upload session not found or already finalised" });
    return;
  }

  // Verify all parts are present
  for (let i = 0; i < totalParts; i++) {
    if (!fs.existsSync(getPartPath(uploadId, i))) {
      res.status(400).json({ error: `Missing part ${i}` });
      return;
    }
  }

  const fileId = uuidv4();

  try {
    const chunkCount = assembleAndSplit(uploadId, fileId, totalParts);
    const baseUrl = getBaseUrl(req);

    // Hash all stored chunks in sequence — this equals SHA-256 of the original file
    const { createHash } = await import("crypto");
    const fileHash = createHash("sha256");
    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = path.join(uploadsDir, fileId, `chunk_${i}.bin`);
      fileHash.update(fs.readFileSync(chunkPath));
    }
    const serverHash = fileHash.digest("hex");

    if (serverHash !== sha256.toLowerCase()) {
      // Hash mismatch — delete bad file and report
      deleteFile(fileId);
      req.log.warn({ uploadId, fileId, serverHash, clientHash: sha256 }, "SHA-256 mismatch");
      res.status(409).json({ error: "Integrity check failed: SHA-256 mismatch. Please try uploading again." });
      return;
    }

    const ttlKey = typeof ttl === "string" ? ttl : null;
    let expiresAt: string | undefined;
    if (ttlKey && TTL_OPTIONS[ttlKey]) {
      expiresAt = new Date(Date.now() + TTL_OPTIONS[ttlKey]).toISOString();
    }

    // ── Versioning ────────────────────────────────────────────────────────────
    let groupId: string | undefined;
    let version: number | undefined;

    if (parentFileId) {
      const parentMeta = readMeta(parentFileId);
      if (parentMeta) {
        if (parentMeta.groupId) {
          groupId = parentMeta.groupId;
        } else {
          // Retroactively promote parent to version 1 in a new group
          groupId = uuidv4();
          parentMeta.groupId = groupId;
          parentMeta.version = 1;
          saveMeta(parentMeta);
        }
        version = nextVersion(groupId);
      }
    }

    const chunkUrls = buildChunkUrls(fileId, chunkCount, baseUrl);
    const meta: FileMeta = {
      id: fileId,
      name,
      size: Number(size),
      mimeType: mimeType || "application/octet-stream",
      chunkCount,
      chunkSize: CHUNK_SIZE,
      uploadedAt: new Date().toISOString(),
      chunkUrls,
      sha256: serverHash,
      ...(expiresAt ? { expiresAt } : {}),
      ...(groupId ? { groupId, version } : {}),
    };

    saveMeta(meta);
    req.log.info({ fileId, name, chunkCount, sha256: serverHash, version }, "Chunked upload finalised");
    res.status(201).json(meta);
  } catch (err) {
    cleanupUpload(uploadId);
    try { deleteFile(fileId); } catch { /* ignore */ }
    req.log.error({ err }, "Finalise failed");
    res.status(500).json({ error: "Failed to assemble file" });
  }
});

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

// ── GET /files/group/:groupId ─────────────────────────────────────────────────
router.get("/files/group/:groupId", async (req, res): Promise<void> => {
  const { groupId } = req.params;
  if (!groupId || !isValidFileId(groupId)) {
    res.status(400).json({ error: "Invalid groupId" });
    return;
  }
  const versions = listVersions(groupId);
  res.json(versions);
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
