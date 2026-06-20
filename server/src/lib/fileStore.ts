import fs from "fs";
import path from "path";
import crypto from "crypto";

export const uploadsDir =
  process.env.NODE_ENV === "production"
    ? "/uploads"
    : path.resolve(process.cwd(), "uploads");

export const CHUNK_SIZE =
  Math.max(1, Math.min(100, Number(process.env.CHUNK_SIZE_MB ?? 1))) * 1024 * 1024;

export const MAX_FILE_SIZE =
  Math.max(1, Math.min(2000, Number(process.env.MAX_FILE_SIZE_MB ?? 500))) * 1024 * 1024;

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
  chunkSize: number;
  uploadedAt: string;
  chunkUrls: string[];
  expiresAt?: string;
  seedOnly?: boolean;
  sha256?: string;
}

export function ensureUploadsDir(): void {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
}

const FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidFileId(fileId: string): boolean {
  return FILE_ID_PATTERN.test(fileId);
}

export function getFileDir(fileId: string): string {
  if (!isValidFileId(fileId)) {
    throw new Error(`Invalid fileId: "${fileId}"`);
  }
  const dir = path.join(uploadsDir, fileId);
  const resolvedDir = path.resolve(dir);
  const resolvedRoot = path.resolve(uploadsDir);
  if (
    resolvedDir !== resolvedRoot &&
    !resolvedDir.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Invalid fileId: "${fileId}"`);
  }
  return dir;
}

export function getMetaPath(fileId: string): string {
  return path.join(getFileDir(fileId), "meta.json");
}

export function getChunkPath(fileId: string, chunkIndex: number): string {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`Invalid chunkIndex: ${chunkIndex}`);
  }
  return path.join(getFileDir(fileId), `chunk_${chunkIndex}.bin`);
}

export function saveMeta(meta: FileMeta): void {
  const dir = getFileDir(meta.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getMetaPath(meta.id), JSON.stringify(meta, null, 2));
}

export function readMeta(fileId: string): FileMeta | null {
  if (!isValidFileId(fileId)) return null;
  const metaPath = getMetaPath(fileId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as FileMeta;
  } catch {
    return null;
  }
}

export function isFileExpired(meta: FileMeta): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt) < new Date();
}

export function listAllFiles(): FileMeta[] {
  ensureUploadsDir();
  const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
  const files: FileMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip temp upload files
    if (entry.name.startsWith("tmp_")) continue;
    const meta = readMeta(entry.name);
    if (meta && !isFileExpired(meta)) files.push(meta);
  }
  return files.sort(
    (a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
}

export function deleteFile(fileId: string): boolean {
  if (!isValidFileId(fileId)) return false;
  const dir = getFileDir(fileId);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function purgeExpiredFiles(): number {
  ensureUploadsDir();
  const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("tmp_")) continue;
    const meta = readMeta(entry.name);
    if (meta && isFileExpired(meta)) {
      deleteFile(meta.id);
      count++;
    }
  }
  return count;
}

/**
 * Split a file from disk (temp path) into chunk files.
 * Reads the file in CHUNK_SIZE pieces — never loads the whole file into RAM.
 * Deletes the temp file when done.
 */
export function splitAndSaveFromPath(fileId: string, tempPath: string): number {
  const dir = getFileDir(fileId);
  fs.mkdirSync(dir, { recursive: true });

  const fileSize = fs.statSync(tempPath).size;
  const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);
  const fd = fs.openSync(tempPath, "r");

  try {
    for (let i = 0; i < chunkCount; i++) {
      const chunkLen = Math.min(CHUNK_SIZE, fileSize - i * CHUNK_SIZE);
      const buf = Buffer.allocUnsafe(chunkLen);
      fs.readSync(fd, buf, 0, chunkLen, i * CHUNK_SIZE);
      fs.writeFileSync(getChunkPath(fileId, i), buf);
    }
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  return chunkCount;
}

/**
 * Legacy in-memory split — kept for any callers that still use it.
 */
export function splitAndSave(fileId: string, buffer: Buffer): number {
  const dir = getFileDir(fileId);
  fs.mkdirSync(dir, { recursive: true });
  let chunkIndex = 0;
  let offset = 0;
  while (offset < buffer.length) {
    const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
    fs.writeFileSync(getChunkPath(fileId, chunkIndex), chunk);
    chunkIndex++;
    offset += CHUNK_SIZE;
  }
  return chunkIndex;
}

export function buildChunkUrls(
  fileId: string,
  chunkCount: number,
  baseUrl: string,
): string[] {
  return Array.from(
    { length: chunkCount },
    (_, i) => `${baseUrl}/api/files/${fileId}/chunks/${i}`,
  );
}

export const UPLOAD_PART_SIZE = 5 * 1024 * 1024; // 5 MB per HTTP part

export function getUploadTempDir(uploadId: string): string {
  return path.join(uploadsDir, `upload_${uploadId}`);
}

export function getPartPath(uploadId: string, partIndex: number): string {
  return path.join(getUploadTempDir(uploadId), `part_${partIndex}`);
}

export function cleanupUpload(uploadId: string): void {
  try { fs.rmSync(getUploadTempDir(uploadId), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** SHA-256 of a file on disk, streaming — never loads the whole file into RAM. */
export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Concatenate ordered parts into a single temp file, then split into chunks.
 * Returns chunk count. Cleans up both parts dir and assembled temp file.
 */
export function assembleAndSplit(uploadId: string, fileId: string, totalParts: number): number {
  ensureUploadsDir();
  const assembledPath = path.join(uploadsDir, `tmp_assembled_${fileId}`);
  const wfd = fs.openSync(assembledPath, "w");
  try {
    for (let i = 0; i < totalParts; i++) {
      const partPath = getPartPath(uploadId, i);
      const data = fs.readFileSync(partPath);
      fs.writeSync(wfd, data);
    }
  } finally {
    fs.closeSync(wfd);
  }
  cleanupUpload(uploadId);
  return splitAndSaveFromPath(fileId, assembledPath);
}

export function generateSnippet(meta: FileMeta, baseUrl: string): string {
  return `(function() {
  var fileId = "${meta.id}";
  var fileName = ${JSON.stringify(meta.name)};
  var mimeType = ${JSON.stringify(meta.mimeType)};
  var chunkCount = ${meta.chunkCount};
  var baseUrl = ${JSON.stringify(baseUrl)};

  function downloadFile() {
    var promises = [];
    for (var i = 0; i < chunkCount; i++) {
      promises.push(
        fetch(baseUrl + "/api/files/" + fileId + "/chunks/" + i)
          .then(function(r) { return r.arrayBuffer(); })
      );
    }
    Promise.all(promises).then(function(chunks) {
      var blob = new Blob(chunks, { type: mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function(err) {
      console.error("FileSplit download failed:", err);
    });
  }

  document.querySelectorAll('[data-filesplit="${meta.id}"]').forEach(function(el) {
    el.addEventListener("click", downloadFile);
  });

  window.FileSplit = window.FileSplit || {};
  window.FileSplit["${meta.id}"] = { download: downloadFile, fileName: fileName };
})();`;
}
