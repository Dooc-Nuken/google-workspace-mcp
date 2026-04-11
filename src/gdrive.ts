import { drive_v3, drive } from "@googleapis/drive";
import type { OAuth2Client } from "google-auth-library";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";

function getClient(auth: OAuth2Client): drive_v3.Drive {
  return drive({ version: "v3", auth });
}

function truncate(text: string, max = 12000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} chars omitted]`;
}

// ── Path safety ──

const SENSITIVE_DIRS = [".ssh", ".gnupg", ".gmail-mcp", ".gdrive-mcp", ".config", ".claude", ".local"];
const SENSITIVE_FILES = [".env", "tokens.json", "credentials.json", "id_rsa", "id_ed25519"];

function resolveHome(p: string): string {
  return resolve(p.replace(/^~/, process.env.HOME ?? homedir()));
}

function assertSafePath(filepath: string): void {
  const resolved = resolve(filepath);
  const parts = resolved.split("/");
  for (const dir of SENSITIVE_DIRS) {
    if (parts.includes(dir)) {
      throw new Error("Access denied: path not permitted.");
    }
  }
  const base = basename(resolved).toLowerCase();
  for (const name of SENSITIVE_FILES) {
    if (base === name || base.startsWith(".env")) {
      throw new Error("Access denied: path not permitted.");
    }
  }
}

// ── MIME type helpers ──

const GOOGLE_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.site": "Google Site",
  "application/vnd.google-apps.shortcut": "Shortcut",
};

const EXPORT_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

// For downloading as office formats
const DOWNLOAD_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.google-apps.drawing": "application/pdf",
};

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    json: "application/json",
    xml: "application/xml",
    md: "text/markdown",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wav: "audio/wav",
  };
  return types[ext] ?? "application/octet-stream";
}

// Binary MIME types that can't be read as text
const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/", "application/zip", "application/gzip",
  "application/x-tar", "application/x-7z", "application/vnd.rar", "application/octet-stream",
  "application/vnd.openxmlformats", "application/msword", "application/vnd.ms-"];

function isBinaryMime(mimeType: string): boolean {
  if (mimeType === "application/pdf") return true;
  return BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

// ── File info type ──

export interface FileInfo {
  id: string;
  name: string;
  mimeType: string;
  friendlyType: string;
  size: string | null;
  modifiedTime: string | null;
  createdTime: string | null;
  parents: string[];
  webViewLink: string | null;
  shared: boolean;
}

const FILE_FIELDS =
  "id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink, shared";

function formatFileInfo(file: drive_v3.Schema$File): FileInfo {
  return {
    id: file.id ?? "",
    name: file.name ?? "",
    mimeType: file.mimeType ?? "",
    friendlyType: GOOGLE_MIME_TYPES[file.mimeType ?? ""] ?? file.mimeType ?? "Unknown",
    size: file.size ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    parents: file.parents ?? [],
    webViewLink: file.webViewLink ?? null,
    shared: file.shared ?? false,
  };
}

// ── Public API ──

export async function search(
  auth: OAuth2Client,
  query: string,
  limit: number,
): Promise<{ query: string; count: number; results: FileInfo[] }> {
  const client = getClient(auth);
  const fullQuery = query.toLowerCase().includes("trashed")
    ? query
    : `${query} and trashed = false`;
  const res = await client.files.list({
    q: fullQuery,
    pageSize: limit,
    fields: `files(${FILE_FIELDS})`,
    orderBy: "modifiedTime desc",
    includeItemsFromAllDrives: false,
  });
  const results = (res.data.files ?? []).map(formatFileInfo);
  return { query, count: results.length, results };
}

export async function listFolder(
  auth: OAuth2Client,
  folderId: string,
  limit: number,
): Promise<{ folderId: string; count: number; files: FileInfo[] }> {
  const client = getClient(auth);
  if (folderId !== "root" && !/^[\w-]+$/.test(folderId)) {
    throw new Error(`Invalid folder ID: "${folderId}"`);
  }
  const q = `'${folderId}' in parents and trashed = false`;
  const res = await client.files.list({
    q,
    pageSize: limit,
    fields: `files(${FILE_FIELDS})`,
    orderBy: "folder, name",
  });
  const files = (res.data.files ?? []).map(formatFileInfo);
  return { folderId, count: files.length, files };
}

export async function getFileInfo(
  auth: OAuth2Client,
  fileId: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const res = await client.files.get({
    fileId,
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function readFileContent(
  auth: OAuth2Client,
  fileId: string,
): Promise<{ id: string; name: string; mimeType: string; content: string }> {
  const client = getClient(auth);

  // Get file metadata to determine type
  const meta = await client.files.get({
    fileId,
    fields: "id, name, mimeType, size",
  });

  const mimeType = meta.data.mimeType ?? "";
  const name = meta.data.name ?? "";

  // Google native files — export as text
  if (EXPORT_MIME_TYPES[mimeType]) {
    const exportMime = EXPORT_MIME_TYPES[mimeType];
    const res = await client.files.export(
      { fileId, mimeType: exportMime },
      { responseType: "text" },
    );
    const content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return { id: fileId, name, mimeType, content: truncate(content) };
  }

  // Binary files — can't read as text
  if (isBinaryMime(mimeType)) {
    return {
      id: fileId,
      name,
      mimeType,
      content: `[Binary file: ${name} (${mimeType}, ${meta.data.size ?? "unknown"} bytes). Use gdrive_download_file to save locally.]`,
    };
  }

  // Text-based files — download content
  const res = await client.files.get(
    { fileId, alt: "media" },
    { responseType: "text" },
  );
  const content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return { id: fileId, name, mimeType, content: truncate(content) };
}

export async function createFolder(
  auth: OAuth2Client,
  name: string,
  parentId?: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const res = await client.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function createDoc(
  auth: OAuth2Client,
  name: string,
  content?: string,
  parentId?: string,
): Promise<FileInfo> {
  const client = getClient(auth);

  if (content) {
    // Create doc with content by uploading text converted to Google Doc
    const res = await client.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.document",
        parents: parentId ? [parentId] : undefined,
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from(Buffer.from(content, "utf-8")),
      },
      fields: FILE_FIELDS,
    });
    return formatFileInfo(res.data);
  }

  const res = await client.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.document",
      parents: parentId ? [parentId] : undefined,
    },
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function createSheet(
  auth: OAuth2Client,
  name: string,
  parentId?: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const res = await client.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: parentId ? [parentId] : undefined,
    },
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function uploadFile(
  auth: OAuth2Client,
  localPath: string,
  name?: string,
  parentId?: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const resolved = resolveHome(localPath);
  assertSafePath(resolved);

  const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB
  const fileStat = await stat(resolved);
  if (fileStat.size > MAX_UPLOAD_SIZE) {
    throw new Error(
      `File too large: ${basename(resolved)} (${(fileStat.size / 1024 / 1024).toFixed(1)} MB, max 20 MB)`,
    );
  }
  const content = await readFile(resolved);
  const fileName = name ?? basename(resolved);
  const mimeType = getMimeType(fileName);

  const res = await client.files.create({
    requestBody: {
      name: fileName,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from(content),
    },
    fields: FILE_FIELDS,
  });

  return formatFileInfo(res.data);
}

export async function downloadFile(
  auth: OAuth2Client,
  fileId: string,
  savePath: string,
): Promise<{ fileId: string; name: string; savedTo: string; size: number }> {
  const client = getClient(auth);
  const resolved = resolveHome(savePath);
  assertSafePath(resolved);

  // Get metadata first
  const meta = await client.files.get({
    fileId,
    fields: "mimeType, name",
  });

  const mimeType = meta.data.mimeType ?? "";
  const name = meta.data.name ?? "file";
  let buffer: Buffer;

  if (DOWNLOAD_EXPORT_TYPES[mimeType]) {
    // Google native — export as office format
    const exportMime = DOWNLOAD_EXPORT_TYPES[mimeType];
    const res = await client.files.export(
      { fileId, mimeType: exportMime },
      { responseType: "arraybuffer" },
    );
    buffer = Buffer.from(res.data as ArrayBuffer);
  } else {
    // Regular file — download
    const res = await client.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    buffer = Buffer.from(res.data as ArrayBuffer);
  }

  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, buffer);

  return { fileId, name, savedTo: resolved, size: buffer.length };
}

export async function moveFile(
  auth: OAuth2Client,
  fileId: string,
  newParentId: string,
): Promise<FileInfo> {
  const client = getClient(auth);

  // Get current parents to remove
  const file = await client.files.get({
    fileId,
    fields: "parents",
  });
  const previousParents = (file.data.parents ?? []).join(",");

  const res = await client.files.update({
    fileId,
    addParents: newParentId,
    removeParents: previousParents,
    fields: FILE_FIELDS,
  });

  return formatFileInfo(res.data);
}

export async function copyFile(
  auth: OAuth2Client,
  fileId: string,
  newName?: string,
  parentId?: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const res = await client.files.copy({
    fileId,
    requestBody: {
      name: newName ?? undefined,
      parents: parentId ? [parentId] : undefined,
    },
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function renameFile(
  auth: OAuth2Client,
  fileId: string,
  newName: string,
): Promise<FileInfo> {
  const client = getClient(auth);
  const res = await client.files.update({
    fileId,
    requestBody: { name: newName },
    fields: FILE_FIELDS,
  });
  return formatFileInfo(res.data);
}

export async function trashFile(
  auth: OAuth2Client,
  fileId: string,
): Promise<{ trashed: string; name: string }> {
  const client = getClient(auth);

  // Get name first for confirmation
  const meta = await client.files.get({ fileId, fields: "name" });

  await client.files.update({
    fileId,
    requestBody: { trashed: true },
  });

  return { trashed: fileId, name: meta.data.name ?? "" };
}

// ── Permissions ──

export interface PermissionInfo {
  id: string;
  type: string;
  role: string;
  emailAddress: string | null;
  displayName: string | null;
}

export async function shareFile(
  auth: OAuth2Client,
  fileId: string,
  email: string,
  role: string,
  notify: boolean,
): Promise<PermissionInfo> {
  const client = getClient(auth);
  const res = await client.permissions.create({
    fileId,
    sendNotificationEmail: notify,
    requestBody: {
      type: "user",
      role,
      emailAddress: email,
    },
    fields: "id, type, role, emailAddress, displayName",
  });
  return {
    id: res.data.id ?? "",
    type: res.data.type ?? "",
    role: res.data.role ?? "",
    emailAddress: res.data.emailAddress ?? null,
    displayName: res.data.displayName ?? null,
  };
}

export async function listPermissions(
  auth: OAuth2Client,
  fileId: string,
): Promise<{ fileId: string; count: number; permissions: PermissionInfo[] }> {
  const client = getClient(auth);
  const res = await client.permissions.list({
    fileId,
    fields: "permissions(id, type, role, emailAddress, displayName)",
  });
  const permissions = (res.data.permissions ?? []).map((p) => ({
    id: p.id ?? "",
    type: p.type ?? "",
    role: p.role ?? "",
    emailAddress: p.emailAddress ?? null,
    displayName: p.displayName ?? null,
  }));
  return { fileId, count: permissions.length, permissions };
}

export async function removePermission(
  auth: OAuth2Client,
  fileId: string,
  permissionId: string,
): Promise<{ removed: string }> {
  const client = getClient(auth);
  await client.permissions.delete({ fileId, permissionId });
  return { removed: permissionId };
}

// ── Storage info ──

export async function about(
  auth: OAuth2Client,
): Promise<{ user: string; email: string; storageTotal: string; storageUsed: string; storageTrash: string }> {
  const client = getClient(auth);
  const res = await client.about.get({
    fields: "user(displayName, emailAddress), storageQuota(limit, usage, usageInDrive, usageInDriveTrash)",
  });
  const quota = res.data.storageQuota;
  const user = res.data.user;

  const formatBytes = (b: string | null | undefined): string => {
    if (!b) return "unknown";
    const bytes = parseInt(b, 10);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return {
    user: user?.displayName ?? "",
    email: user?.emailAddress ?? "",
    storageTotal: formatBytes(quota?.limit),
    storageUsed: formatBytes(quota?.usage),
    storageTrash: formatBytes(quota?.usageInDriveTrash),
  };
}
