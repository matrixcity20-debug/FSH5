import { Router, type IRouter } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import {
  ensureUploadsDir,
  saveMeta,
  readMeta,
  listAllFiles,
  deleteFile,
  splitAndSave,
  buildChunkUrls,
  generateSnippet,
  getChunkPath,
  isFileExpired,
  isValidFileId,
  CHUNK_SIZE,
  type FileMeta,
} from "../../lib/fileStore.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const TTL_OPTIONS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function getBaseUrl(req: {
  protocol: string;
  get: (h: string) => string | undefined;
}): string {
  const host = req.get("host") ?? "localhost";
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto ?? req.protocol ?? "http";
  return `${protocol}://${host}`;
}

router.post(
  "/files/upload",
  upload.single("file"),
  async (req, res): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    ensureUploadsDir();
    const fileId = uuidv4();
    const buffer = req.file.buffer;
    const chunkCount = splitAndSave(fileId, buffer);
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
      size: buffer.length,
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
  },
);

router.post("/files/register-seed", async (req, res): Promise<void> => {
  const { name, size, mimeType, chunkCount } = req.body as {
    name: string;
    size: number;
    mimeType: string;
    chunkCount: number;
  };

  if (!name || !size || !mimeType || !chunkCount) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  ensureUploadsDir();
  const fileId = uuidv4();
  const meta: FileMeta = {
    id: fileId,
    name,
    size,
    mimeType,
    chunkCount,
    chunkSize: CHUNK_SIZE,
    uploadedAt: new Date().toISOString(),
    chunkUrls: [],
    seedOnly: true,
  };

  saveMeta(meta);
  req.log.info({ fileId, name, chunkCount }, "Seed-only file registered");
  res.status(201).json(meta);
});

router.get("/files", async (req, res): Promise<void> => {
  ensureUploadsDir();
  const files = listAllFiles();
  res.json(files);
});

router.get("/files/:fileId", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "fileId is required" });
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

router.delete("/files/:fileId", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "fileId is required" });
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

router.get("/files/:fileId/snippet", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "fileId is required" });
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

router.get("/files/:fileId/download", async (req, res): Promise<void> => {
  const { fileId } = req.params;
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).json({ error: "fileId is required" });
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

  const chunks: Buffer[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const chunkPath = getChunkPath(fileId, i);
    if (!fs.existsSync(chunkPath)) {
      res.status(500).json({ error: `Chunk ${i} missing` });
      return;
    }
    chunks.push(fs.readFileSync(chunkPath));
  }

  const combined = Buffer.concat(chunks);
  const safeName = encodeURIComponent(meta.name).replace(/'/g, "%27");

  res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${safeName}`,
  );
  res.setHeader("Content-Length", combined.length);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(combined);
});

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
    res.sendFile(chunkPath);
  },
);

export default router;
