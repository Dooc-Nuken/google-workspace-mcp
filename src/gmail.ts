import { gmail_v1, gmail } from "@googleapis/gmail";
import type { OAuth2Client } from "google-auth-library";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

function getClient(auth: OAuth2Client): gmail_v1.Gmail {
  return gmail({ version: "v1", auth });
}

// ── Cached sender display name ──

let cachedSenderFrom: string | null = null;

async function getSenderFrom(auth: OAuth2Client): Promise<string | null> {
  if (cachedSenderFrom !== null) return cachedSenderFrom;
  try {
    const client = getClient(auth);
    const res = await client.users.settings.sendAs.list({ userId: "me" });
    const primary = res.data.sendAs?.find((s) => s.isPrimary);
    if (primary?.displayName && primary?.sendAsEmail) {
      cachedSenderFrom = `${primary.displayName} <${primary.sendAsEmail}>`;
    } else {
      cachedSenderFrom = "";
    }
  } catch {
    cachedSenderFrom = "";
  }
  return cachedSenderFrom || null;
}

function truncate(text: string, max = 12000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} chars omitted]`;
}

// ── Header extraction ──

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | null {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

// ── Body extraction ──

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Direct body (text/plain)
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart: look for text/plain first, then text/html
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }

    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      return stripHtml(html);
    }

    // Nested multipart (e.g., multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Check attachments ──

function hasAttachments(payload: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    return true;
  }
  return payload.parts?.some((p) => hasAttachments(p)) ?? false;
}

// ── Label name/ID resolution ──

export interface LabelInfo {
  id: string;
  name: string;
  type: string;
}

async function getAllLabels(client: gmail_v1.Gmail): Promise<LabelInfo[]> {
  const res = await client.users.labels.list({ userId: "me" });
  return (res.data.labels ?? []).map((l) => ({
    id: l.id ?? "",
    name: l.name ?? "",
    type: l.type ?? "user",
  }));
}

async function resolveLabelNames(
  client: gmail_v1.Gmail,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const labels = await getAllLabels(client);
  return names.map((name) => {
    const found = labels.find(
      (l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name,
    );
    if (!found) throw new Error(`Label not found: "${name}"`);
    return found.id;
  });
}

// ── Message formatting ──

export interface MessageSummary {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string;
  labels: string[];
  hasAttachments: boolean;
}

export interface MessageFull extends MessageSummary {
  cc: string | null;
  body: string;
}

function formatSummary(msg: gmail_v1.Schema$Message): MessageSummary {
  const headers = msg.payload?.headers;
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet ?? "",
    labels: msg.labelIds ?? [],
    hasAttachments: hasAttachments(msg.payload),
  };
}

function formatFull(msg: gmail_v1.Schema$Message): MessageFull {
  const headers = msg.payload?.headers;
  return {
    ...formatSummary(msg),
    cc: getHeader(headers, "Cc"),
    body: truncate(extractBody(msg.payload)),
  };
}

// ── Public API ──

export async function search(
  auth: OAuth2Client,
  query: string,
  limit: number,
): Promise<{ query: string; count: number; results: MessageSummary[] }> {
  const client = getClient(auth);
  const list = await client.users.messages.list({
    userId: "me",
    q: query,
    maxResults: limit,
  });

  const messageIds = (list.data.messages ?? []).filter(({ id }) => !!id);

  // Fetch in chunks of 10 to avoid rate limits
  const results: MessageSummary[] = [];
  const chunkSize = 10;
  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(
      chunk.map(({ id }) =>
        client.users.messages
          .get({
            userId: "me",
            id: id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          })
          .then((msg) => formatSummary(msg.data)),
      ),
    );
    results.push(...chunkResults);
  }

  return { query, count: results.length, results };
}

export async function getMessage(
  auth: OAuth2Client,
  id: string,
): Promise<MessageFull> {
  const client = getClient(auth);
  const msg = await client.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  return formatFull(msg.data);
}

export async function getThread(
  auth: OAuth2Client,
  id: string,
): Promise<{ id: string; messageCount: number; messages: MessageFull[] }> {
  const client = getClient(auth);
  const thread = await client.users.threads.get({
    userId: "me",
    id,
    format: "full",
  });
  const messages = (thread.data.messages ?? []).map(formatFull);
  return { id, messageCount: messages.length, messages };
}

export async function listLabels(
  auth: OAuth2Client,
): Promise<{ count: number; labels: LabelInfo[] }> {
  const client = getClient(auth);
  const labels = await getAllLabels(client);
  return { count: labels.length, labels };
}

export async function createLabel(
  auth: OAuth2Client,
  name: string,
): Promise<{ id: string; name: string }> {
  const client = getClient(auth);
  const res = await client.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return { id: res.data.id ?? "", name: res.data.name ?? name };
}

export async function deleteLabel(
  auth: OAuth2Client,
  name: string,
): Promise<{ deleted: string }> {
  const client = getClient(auth);
  const labels = await getAllLabels(client);
  const found = labels.find(
    (l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name,
  );
  if (!found) throw new Error(`Label not found: "${name}"`);
  if (found.type === "system") throw new Error(`Cannot delete system label: "${name}"`);
  await client.users.labels.delete({ userId: "me", id: found.id });
  return { deleted: found.name };
}

export async function modifyLabels(
  auth: OAuth2Client,
  ids: string[],
  addLabelNames: string[],
  removeLabelNames: string[],
): Promise<{ modified: number; ids: string[] }> {
  const client = getClient(auth);
  const allLabels = await getAllLabels(client);

  const resolve = (names: string[]) =>
    names.map((name) => {
      const found = allLabels.find(
        (l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name,
      );
      if (!found) throw new Error(`Label not found: "${name}"`);
      return found.id;
    });

  const addLabelIds = resolve(addLabelNames);
  const removeLabelIds = resolve(removeLabelNames);

  await client.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids,
      addLabelIds,
      removeLabelIds,
    },
  });

  return { modified: ids.length, ids: ids };
}

export async function markRead(
  auth: OAuth2Client,
  ids: string[],
  read: boolean,
): Promise<{ modified: number; ids: string[] }> {
  const client = getClient(auth);

  await client.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids,
      addLabelIds: read ? [] : ["UNREAD"],
      removeLabelIds: read ? ["UNREAD"] : [],
    },
  });

  return { modified: ids.length, ids };
}

export interface FilterAction {
  addLabelNames?: string[];
  removeLabelNames?: string[];
  archive?: boolean;
  markRead?: boolean;
}

export interface FilterResult {
  id: string;
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

export async function createFilter(
  auth: OAuth2Client,
  criteria: { from?: string; to?: string; subject?: string; query?: string },
  action: FilterAction,
): Promise<FilterResult> {
  const client = getClient(auth);
  const allLabels = await getAllLabels(client);

  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];

  if (action.addLabelNames) {
    for (const name of action.addLabelNames) {
      const found = allLabels.find(
        (l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name,
      );
      if (!found) throw new Error(`Label not found: "${name}"`);
      addLabelIds.push(found.id);
    }
  }

  if (action.removeLabelNames) {
    for (const name of action.removeLabelNames) {
      const found = allLabels.find(
        (l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name,
      );
      if (!found) throw new Error(`Label not found: "${name}"`);
      removeLabelIds.push(found.id);
    }
  }

  if (action.archive) removeLabelIds.push("INBOX");
  if (action.markRead) removeLabelIds.push("UNREAD");

  const res = await client.users.settings.filters.create({
    userId: "me",
    requestBody: {
      criteria: {
        from: criteria.from,
        to: criteria.to,
        subject: criteria.subject,
        query: criteria.query,
      },
      action: {
        addLabelIds: addLabelIds.length > 0 ? addLabelIds : undefined,
        removeLabelIds: removeLabelIds.length > 0 ? removeLabelIds : undefined,
      },
    },
  });

  return {
    id: res.data.id ?? "",
    ...criteria,
    addLabelIds,
    removeLabelIds,
  };
}

export async function listFilters(
  auth: OAuth2Client,
): Promise<{ count: number; filters: unknown[] }> {
  const client = getClient(auth);
  const res = await client.users.settings.filters.list({ userId: "me" });
  return { count: (res.data.filter ?? []).length, filters: res.data.filter ?? [] };
}

export async function batchTrash(
  auth: OAuth2Client,
  ids: string[],
): Promise<{ trashed: number; ids: string[] }> {
  const client = getClient(auth);
  // Process in chunks of 5 to avoid rate limits
  const chunkSize = 5;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map((id) => client.users.messages.trash({ userId: "me", id })),
    );
  }
  return { trashed: ids.length, ids };
}

// ── MIME helpers ──

// ── Path safety ──

const SENSITIVE_DIRS = [".ssh", ".gnupg", ".gmail-mcp", ".config", ".claude", ".local"];
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
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    "7z": "application/x-7z-compressed",
    rar: "application/vnd.rar",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wav: "audio/wav",
  };
  return types[ext] ?? "application/octet-stream";
}

interface AttachmentData {
  filename: string;
  content: Buffer;
  mimeType: string;
}

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 MB (Gmail limit is 25 MB)

async function loadLocalAttachments(paths: string[]): Promise<AttachmentData[]> {
  const attachments: AttachmentData[] = [];
  for (const p of paths) {
    const resolved = resolveHome(p);
    assertSafePath(resolved);
    const fileStat = await stat(resolved);
    if (fileStat.size > MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `Attachment too large: ${basename(resolved)} (${(fileStat.size / 1024 / 1024).toFixed(1)} MB, max 20 MB)`,
      );
    }
    const content = await readFile(resolved);
    attachments.push({
      filename: basename(resolved),
      content,
      mimeType: getMimeType(resolved),
    });
  }
  return attachments;
}

/** Strip CR and LF from header values to prevent MIME header injection. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/**
 * Transform body for RFC 3676 format=flowed.
 * Adds trailing space to flowable lines so clients can re-wrap them based on
 * display width. Lines starting with list/quote/header markers stay "fixed"
 * (no trailing space). Empty lines are paragraph breaks.
 */
function formatFlowedBody(body: string): string {
  const lines = body.split(/\r?\n/);
  return lines
    .map((line) => {
      if (line.length === 0) return line;
      if (/^[-*>#]/.test(line)) return line;
      if (/^\s/.test(line)) return line;
      if (line.endsWith(" ")) return line;
      return line + " ";
    })
    .join("\r\n");
}

function buildRawMessage(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: AttachmentData[];
}): string {
  const boundary = `__mcp_${Date.now()}_${randomBytes(12).toString("hex")}__`;
  const hasAttachments = opts.attachments && opts.attachments.length > 0;

  let msg = "";
  if (opts.from) msg += `From: ${sanitizeHeader(opts.from)}\r\n`;
  msg += `To: ${sanitizeHeader(opts.to)}\r\n`;
  if (opts.cc) msg += `Cc: ${sanitizeHeader(opts.cc)}\r\n`;
  if (opts.bcc) msg += `Bcc: ${sanitizeHeader(opts.bcc)}\r\n`;
  msg += `Subject: ${sanitizeHeader(opts.subject)}\r\n`;
  if (opts.inReplyTo) msg += `In-Reply-To: ${sanitizeHeader(opts.inReplyTo)}\r\n`;
  if (opts.references) msg += `References: ${sanitizeHeader(opts.references)}\r\n`;
  msg += `MIME-Version: 1.0\r\n`;

  if (hasAttachments) {
    msg += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    msg += `--${boundary}\r\n`;
    msg += `Content-Type: text/plain; charset="utf-8"; format=flowed\r\n\r\n`;
    msg += `${formatFlowedBody(opts.body)}\r\n`;
    for (const att of opts.attachments!) {
      msg += `\r\n--${boundary}\r\n`;
      msg += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
      msg += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
      msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
      // Split base64 into 76-char lines per RFC 2045
      const b64 = att.content.toString("base64");
      msg += b64.replace(/(.{76})/g, "$1\r\n") + "\r\n";
    }
    msg += `--${boundary}--`;
  } else {
    msg += `Content-Type: text/plain; charset="utf-8"; format=flowed\r\n\r\n`;
    msg += formatFlowedBody(opts.body);
  }

  return Buffer.from(msg).toString("base64url");
}

// ── Extract attachment metadata from a message ──

interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

function extractAttachmentInfoFromPayload(
  payload: gmail_v1.Schema$MessagePart | undefined,
): AttachmentInfo[] {
  if (!payload) return [];
  const result: AttachmentInfo[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    result.push({
      attachmentId: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body.size ?? 0,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      result.push(...extractAttachmentInfoFromPayload(part));
    }
  }

  return result;
}

// ── 1. Send email ──

export interface SendResult {
  id: string;
  threadId: string;
  to: string;
  subject: string;
}

export async function sendEmail(
  auth: OAuth2Client,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  attachmentPaths?: string[],
): Promise<SendResult> {
  const client = getClient(auth);
  const attachments = attachmentPaths ? await loadLocalAttachments(attachmentPaths) : undefined;
  const from = await getSenderFrom(auth) ?? undefined;

  const raw = buildRawMessage({ to, subject, body, from, cc, bcc, attachments });

  const res = await client.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return {
    id: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
    to,
    subject,
  };
}

// ── 2. Reply to email ──

export interface ReplyResult {
  id: string;
  threadId: string;
  inReplyTo: string;
  replyAll: boolean;
}

export async function replyToMessage(
  auth: OAuth2Client,
  messageId: string,
  body: string,
  replyAll: boolean = false,
  attachmentPaths?: string[],
): Promise<ReplyResult> {
  const client = getClient(auth);

  // Get original message headers
  const original = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Subject", "Message-ID", "References"],
  });

  const headers = original.data.payload?.headers;
  const origFrom = getHeader(headers, "From") ?? "";
  const origTo = getHeader(headers, "To") ?? "";
  const origCc = getHeader(headers, "Cc");
  const origSubject = getHeader(headers, "Subject") ?? "";
  const origMessageId = getHeader(headers, "Message-ID") ?? "";
  const origReferences = getHeader(headers, "References");
  const threadId = original.data.threadId ?? "";

  // Determine recipients
  const to = origFrom; // Reply goes to the sender
  let cc: string | undefined;
  if (replyAll) {
    // Get our own email to exclude from CC
    const profile = await client.users.getProfile({ userId: "me" });
    const myEmail = (profile.data.emailAddress ?? "").toLowerCase();
    const allRecipients = [origTo, origCc]
      .filter(Boolean)
      .join(", ")
      .split(",")
      .map((addr) => addr.trim())
      .filter((addr) => {
        // Exclude our own address (handles "Name <email>" format)
        const match = addr.match(/<([^>]+)>/);
        const email = (match ? match[1] : addr).toLowerCase();
        return email !== myEmail;
      })
      .join(", ");
    cc = allRecipients || undefined;
  }

  // Build subject
  const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;

  // Build references chain
  const references = origReferences
    ? `${origReferences} ${origMessageId}`
    : origMessageId;

  const attachments = attachmentPaths ? await loadLocalAttachments(attachmentPaths) : undefined;
  const from = await getSenderFrom(auth) ?? undefined;

  const raw = buildRawMessage({
    to,
    subject,
    body,
    from,
    cc,
    inReplyTo: origMessageId,
    references,
    attachments,
  });

  const res = await client.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId },
  });

  return {
    id: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
    inReplyTo: origMessageId,
    replyAll,
  };
}

// ── 3. Forward email ──

export interface ForwardResult {
  id: string;
  threadId: string;
  forwardedFrom: string;
  to: string;
}

export async function forwardMessage(
  auth: OAuth2Client,
  messageId: string,
  to: string,
  additionalMessage?: string,
  includeAttachments: boolean = true,
): Promise<ForwardResult> {
  const client = getClient(auth);

  // Get full original message
  const original = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = original.data.payload?.headers;
  const origFrom = getHeader(headers, "From") ?? "";
  const origTo = getHeader(headers, "To") ?? "";
  const origDate = getHeader(headers, "Date") ?? "";
  const origSubject = getHeader(headers, "Subject") ?? "";
  const origBody = extractBody(original.data.payload);

  const subject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`;

  // Build forwarded body
  let body = "";
  if (additionalMessage) {
    body += `${additionalMessage}\r\n\r\n`;
  }
  body += `---------- Forwarded message ----------\r\n`;
  body += `From: ${origFrom}\r\n`;
  body += `Date: ${origDate}\r\n`;
  body += `Subject: ${origSubject}\r\n`;
  body += `To: ${origTo}\r\n\r\n`;
  body += origBody;

  // Optionally include original attachments
  let attachments: AttachmentData[] | undefined;
  if (includeAttachments) {
    const attInfos = extractAttachmentInfoFromPayload(original.data.payload);
    if (attInfos.length > 0) {
      attachments = [];
      for (const info of attInfos) {
        const attRes = await client.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: info.attachmentId,
        });
        if (attRes.data.data) {
          attachments.push({
            filename: info.filename,
            content: Buffer.from(attRes.data.data, "base64url"),
            mimeType: info.mimeType,
          });
        }
      }
    }
  }

  const from = await getSenderFrom(auth) ?? undefined;
  const raw = buildRawMessage({ to, subject, body, from, attachments });

  const res = await client.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return {
    id: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
    forwardedFrom: origFrom,
    to,
  };
}

// ── 4. Create draft ──

export interface DraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

export async function createDraft(
  auth: OAuth2Client,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  replyToMessageId?: string,
  attachmentPaths?: string[],
): Promise<DraftResult> {
  const client = getClient(auth);
  const attachments = attachmentPaths ? await loadLocalAttachments(attachmentPaths) : undefined;

  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;

  // If replying, get original message headers
  if (replyToMessageId) {
    const original = await client.users.messages.get({
      userId: "me",
      id: replyToMessageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject"],
    });
    const headers = original.data.payload?.headers;
    inReplyTo = getHeader(headers, "Message-ID") ?? undefined;
    const origRefs = getHeader(headers, "References");
    references = origRefs ? `${origRefs} ${inReplyTo}` : inReplyTo;
    threadId = original.data.threadId ?? undefined;

    const origSubject = getHeader(headers, "Subject") ?? "";
    if (!subject) {
      subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
    }
  }

  const from = await getSenderFrom(auth) ?? undefined;
  const raw = buildRawMessage({ to, subject, body, from, cc, bcc, inReplyTo, references, attachments });

  const res = await client.users.drafts.create({
    userId: "me",
    requestBody: {
      message: { raw, threadId },
    },
  });

  return {
    draftId: res.data.id ?? "",
    messageId: res.data.message?.id ?? "",
    threadId: res.data.message?.threadId ?? "",
  };
}

// ── 5. Get / download attachment ──

export interface AttachmentResult {
  filename: string;
  mimeType: string;
  size: number;
  savedTo?: string;
  data?: string; // base64 if not saved to file
}

export async function getAttachment(
  auth: OAuth2Client,
  messageId: string,
  attachmentId?: string,
  filename?: string,
  savePath?: string,
): Promise<AttachmentResult> {
  const client = getClient(auth);

  // If no attachmentId, find it by filename
  let attId = attachmentId;
  let attFilename = filename ?? "attachment";
  let attMimeType = "application/octet-stream";

  if (!attId) {
    const msg = await client.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const infos = extractAttachmentInfoFromPayload(msg.data.payload);
    if (filename) {
      const found = infos.find((a) => a.filename.toLowerCase() === filename.toLowerCase());
      if (!found) throw new Error(`Attachment "${filename}" not found in message`);
      attId = found.attachmentId;
      attFilename = found.filename;
      attMimeType = found.mimeType;
    } else if (infos.length === 1) {
      attId = infos[0].attachmentId;
      attFilename = infos[0].filename;
      attMimeType = infos[0].mimeType;
    } else if (infos.length === 0) {
      throw new Error("No attachments found in this message");
    } else {
      throw new Error(
        `Multiple attachments found. Specify filename or attachmentId. Available: ${infos.map((a) => a.filename).join(", ")}`,
      );
    }
  }

  const res = await client.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attId,
  });

  const data = res.data.data;
  if (!data) throw new Error("Attachment data is empty");

  const buffer = Buffer.from(data, "base64url");

  if (savePath) {
    const resolved = resolveHome(savePath);
    assertSafePath(resolved);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, buffer);
    return {
      filename: attFilename,
      mimeType: attMimeType,
      size: buffer.length,
      savedTo: resolved,
    };
  }

  return {
    filename: attFilename,
    mimeType: attMimeType,
    size: buffer.length,
    data: buffer.toString("base64"),
  };
}

// ── 6. Delete filter ──

export async function deleteFilter(
  auth: OAuth2Client,
  filterId: string,
): Promise<{ deleted: string }> {
  const client = getClient(auth);
  await client.users.settings.filters.delete({ userId: "me", id: filterId });
  return { deleted: filterId };
}

// ── 7. List attachments in a message ──

export async function listAttachments(
  auth: OAuth2Client,
  messageId: string,
): Promise<{ messageId: string; count: number; attachments: AttachmentInfo[] }> {
  const client = getClient(auth);
  const msg = await client.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const attachments = extractAttachmentInfoFromPayload(msg.data.payload);
  return { messageId, count: attachments.length, attachments };
}

// ── 8. Inbox summary ──

export interface InboxSummary {
  totalMessages: number;
  unreadMessages: number;
  threadsTotal: number;
  threadsUnread: number;
  labelStats: Array<{
    name: string;
    messagesTotal: number;
    messagesUnread: number;
  }>;
  recentMessages: MessageSummary[];
}

export async function inboxSummary(
  auth: OAuth2Client,
): Promise<InboxSummary> {
  const client = getClient(auth);

  // Get stats for key labels (includes INBOX)
  const keyLabelIds = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "SPAM", "TRASH"];
  const labelStats = await Promise.all(
    keyLabelIds.map(async (id) => {
      try {
        const res = await client.users.labels.get({ userId: "me", id });
        return {
          id,
          name: res.data.name ?? id,
          messagesTotal: res.data.messagesTotal ?? 0,
          messagesUnread: res.data.messagesUnread ?? 0,
          threadsTotal: res.data.threadsTotal ?? 0,
          threadsUnread: res.data.threadsUnread ?? 0,
        };
      } catch {
        return null;
      }
    }),
  );

  const validStats = labelStats.filter((s): s is NonNullable<typeof s> => s !== null);
  const inboxStats = validStats.find((s) => s.id === "INBOX");

  // Get 5 most recent messages
  const recentList = await client.users.messages.list({
    userId: "me",
    q: "in:inbox",
    maxResults: 5,
  });

  const recentMessages = await Promise.all(
    (recentList.data.messages ?? [])
      .filter(({ id }) => !!id)
      .map(({ id }) =>
        client.users.messages
          .get({
            userId: "me",
            id: id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          })
          .then((msg) => formatSummary(msg.data)),
      ),
  );

  return {
    totalMessages: inboxStats?.messagesTotal ?? 0,
    unreadMessages: inboxStats?.messagesUnread ?? 0,
    threadsTotal: inboxStats?.threadsTotal ?? 0,
    threadsUnread: inboxStats?.threadsUnread ?? 0,
    labelStats: validStats.map(({ id: _, ...rest }) => rest),
    recentMessages,
  };
}
