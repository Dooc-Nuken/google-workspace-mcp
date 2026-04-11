import { z } from "zod";
import type { OAuth2Client } from "google-auth-library";
import * as gmail from "./gmail.js";
import * as gdrive from "./gdrive.js";
import * as forms from "./forms.js";
import * as classroom from "./classroom.js";

// ═══════════════════════════════════════════════════════════════════
// Tool definitions — combined from Gmail, Drive, Forms, Classroom
// ═══════════════════════════════════════════════════════════════════

const gmailToolDefinitions = [
  {
    name: "gmail_search",
    description:
      "Search emails using Gmail query syntax (e.g., 'is:unread', 'from:alice@example.com', 'after:2026/01/01 label:work').",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Gmail search query",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 20, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_get_message",
    description:
      "Get a single email by ID, including full body text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Gmail message ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_get_thread",
    description:
      "Get all messages in a thread by thread ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Gmail thread ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_list_labels",
    description: "List all labels in the Gmail account.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "gmail_create_label",
    description:
      'Create a new Gmail label. Supports nested labels with "/" separator (e.g., "Projects/Infrastructure").',
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Label name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gmail_delete_label",
    description:
      'Delete a Gmail label by name. Cannot delete system labels. Emails in the label are NOT deleted.',
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Label name or ID to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gmail_modify_labels",
    description:
      'Add or remove labels on one or more emails. Use label names (not IDs). To archive, use removeLabels: ["INBOX"].',
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Message IDs to modify",
        },
        addLabels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to add",
        },
        removeLabels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to remove",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "gmail_mark_read",
    description: "Mark emails as read or unread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Message IDs to mark",
        },
        read: {
          type: "boolean",
          description: "true = mark as read, false = mark as unread (default: true)",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "gmail_create_filter",
    description:
      'Create a Gmail filter to automatically label, archive, or mark-read incoming emails. Criteria: from, to, subject, query (Gmail search syntax). Actions: addLabels, removeLabels, archive, markRead.',
    inputSchema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description: "Match sender address (e.g. 'noreply@example.com')",
        },
        to: {
          type: "string",
          description: "Match recipient address",
        },
        subject: {
          type: "string",
          description: "Match subject text",
        },
        query: {
          type: "string",
          description: "Gmail search query for advanced matching",
        },
        addLabels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to add to matching emails",
        },
        removeLabels: {
          type: "array",
          items: { type: "string" },
          description: "Label names to remove from matching emails",
        },
        archive: {
          type: "boolean",
          description: "Remove from inbox (default: false)",
        },
        markRead: {
          type: "boolean",
          description: "Mark as read (default: false)",
        },
      },
    },
  },
  {
    name: "gmail_list_filters",
    description: "List all Gmail filters in the account.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "gmail_batch_trash",
    description: "Move emails to trash by IDs. Emails in trash are auto-deleted after 30 days.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Message IDs to trash",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "gmail_send",
    description:
      "Send a new email. Supports optional CC, BCC, and file attachments from local paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es), comma-separated",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Plain text email body",
        },
        cc: {
          type: "string",
          description: "CC recipients, comma-separated",
        },
        bcc: {
          type: "string",
          description: "BCC recipients, comma-separated",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_reply",
    description:
      "Reply to an email by message ID. Set replyAll to true to reply to all recipients. Supports file attachments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "ID of the message to reply to",
        },
        body: {
          type: "string",
          description: "Reply body text",
        },
        replyAll: {
          type: "boolean",
          description: "Reply to all recipients (default: false)",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach",
        },
      },
      required: ["messageId", "body"],
    },
  },
  {
    name: "gmail_forward",
    description:
      "Forward an email to another recipient. Original message is quoted. Original attachments are included by default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "ID of the message to forward",
        },
        to: {
          type: "string",
          description: "Recipient to forward to",
        },
        message: {
          type: "string",
          description: "Optional message to add above the forwarded content",
        },
        includeAttachments: {
          type: "boolean",
          description: "Include original attachments (default: true)",
        },
      },
      required: ["messageId", "to"],
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a draft email without sending it. Optionally a reply draft if replyToMessageId is provided. Supports file attachments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es)",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Email body text",
        },
        cc: {
          type: "string",
          description: "CC recipients",
        },
        bcc: {
          type: "string",
          description: "BCC recipients",
        },
        replyToMessageId: {
          type: "string",
          description: "Message ID to create a reply draft for",
        },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_get_attachment",
    description:
      "Download an attachment from a message. Specify by attachmentId or filename. If savePath is provided, saves to disk; otherwise returns base64 data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "Gmail message ID containing the attachment",
        },
        attachmentId: {
          type: "string",
          description: "Attachment ID (from message metadata)",
        },
        filename: {
          type: "string",
          description: "Attachment filename to find (alternative to attachmentId)",
        },
        savePath: {
          type: "string",
          description: "Local path to save the file (e.g. ~/Downloads/file.pdf)",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "gmail_list_attachments",
    description:
      "List all attachments in a message with their IDs, filenames, types and sizes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messageId: {
          type: "string",
          description: "Gmail message ID",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "gmail_delete_filter",
    description: "Delete a Gmail filter by ID. Use gmail_list_filters to find filter IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Filter ID to delete",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_inbox_summary",
    description:
      "Get a summary of the inbox: total/unread counts, stats per key label (Inbox, Starred, Important, Sent, Draft, Spam, Trash), and the 5 most recent inbox messages.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

const gdriveToolDefinitions = [
  {
    name: "gdrive_search",
    description:
      "Search files in Google Drive using Drive query syntax (e.g., \"name contains 'budget'\", \"mimeType = 'application/vnd.google-apps.folder'\", \"modifiedTime > '2026-01-01'\"). Use \"trashed = false\" to exclude trash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Google Drive search query (Drive API v3 syntax)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 20, max: 100)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gdrive_list_folder",
    description:
      "List files and subfolders in a Google Drive folder by folder ID. Use 'root' for the top-level My Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folderId: {
          type: "string",
          description: "Folder ID (use 'root' for My Drive root)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 50, max: 200)",
        },
      },
      required: ["folderId"],
    },
  },
  {
    name: "gdrive_get_file_info",
    description:
      "Get metadata for a file or folder: name, type, size, dates, sharing status, web link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_read_file",
    description:
      "Read the text content of a file. Google Docs are exported as plain text, Sheets as CSV, Slides as plain text. Binary files (PDF, images, etc.) return a message to use gdrive_download_file instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File ID to read",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_create_folder",
    description: "Create a new folder in Google Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Folder name",
        },
        parentId: {
          type: "string",
          description: "Parent folder ID (omit for root)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gdrive_create_doc",
    description:
      "Create a new Google Doc. Optionally provide initial text content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Document name",
        },
        content: {
          type: "string",
          description: "Initial text content (optional)",
        },
        parentId: {
          type: "string",
          description: "Parent folder ID (omit for root)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gdrive_create_sheet",
    description: "Create a new empty Google Sheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Spreadsheet name",
        },
        parentId: {
          type: "string",
          description: "Parent folder ID (omit for root)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "gdrive_upload_file",
    description:
      "Upload a local file to Google Drive. The MIME type is auto-detected from the file extension.",
    inputSchema: {
      type: "object" as const,
      properties: {
        localPath: {
          type: "string",
          description: "Local file path to upload (supports ~ for home)",
        },
        name: {
          type: "string",
          description: "Name in Drive (defaults to local filename)",
        },
        parentId: {
          type: "string",
          description: "Parent folder ID (omit for root)",
        },
      },
      required: ["localPath"],
    },
  },
  {
    name: "gdrive_download_file",
    description:
      "Download a file from Google Drive to a local path. Google Docs/Sheets/Slides are exported as docx/xlsx/pptx.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File ID to download",
        },
        savePath: {
          type: "string",
          description: "Local path to save to (supports ~ for home)",
        },
      },
      required: ["fileId", "savePath"],
    },
  },
  {
    name: "gdrive_move_file",
    description: "Move a file or folder to a different parent folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID to move",
        },
        newParentId: {
          type: "string",
          description: "Destination folder ID",
        },
      },
      required: ["fileId", "newParentId"],
    },
  },
  {
    name: "gdrive_copy_file",
    description: "Create a copy of a file. Optionally rename and/or place in a specific folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File ID to copy",
        },
        newName: {
          type: "string",
          description: "Name for the copy (defaults to 'Copy of ...')",
        },
        parentId: {
          type: "string",
          description: "Parent folder for the copy",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_rename_file",
    description: "Rename a file or folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID",
        },
        newName: {
          type: "string",
          description: "New name",
        },
      },
      required: ["fileId", "newName"],
    },
  },
  {
    name: "gdrive_trash_file",
    description: "Move a file or folder to the trash. Can be recovered from trash within 30 days.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID to trash",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_share_file",
    description:
      "Share a file or folder with a user by email. Roles: 'reader', 'commenter', 'writer', 'organizer' (folders only).",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID to share",
        },
        email: {
          type: "string",
          description: "Email address to share with",
        },
        role: {
          type: "string",
          description: "Permission role: reader, commenter, writer, or organizer",
        },
        notify: {
          type: "boolean",
          description: "Send notification email (default: true)",
        },
      },
      required: ["fileId", "email", "role"],
    },
  },
  {
    name: "gdrive_list_permissions",
    description: "List all permissions (who has access) for a file or folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_remove_permission",
    description:
      "Remove a permission from a file. Use gdrive_list_permissions to find the permission ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fileId: {
          type: "string",
          description: "File or folder ID",
        },
        permissionId: {
          type: "string",
          description: "Permission ID to remove",
        },
      },
      required: ["fileId", "permissionId"],
    },
  },
  {
    name: "gdrive_about",
    description:
      "Get account info: user name, email, and storage quota (total, used, in trash).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

const formsToolDefinitions = [
  {
    name: "gforms_get",
    description:
      "Get metadata for a Google Form: title, description, item count, linked sheet, responder URI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        formId: {
          type: "string",
          description: "Google Form ID",
        },
      },
      required: ["formId"],
    },
  },
  {
    name: "gforms_list_responses",
    description:
      "List responses submitted to a Google Form. Returns summary info for each response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        formId: {
          type: "string",
          description: "Google Form ID",
        },
        limit: {
          type: "number",
          description: "Maximum number of responses (default: 50, max: 200)",
        },
      },
      required: ["formId"],
    },
  },
  {
    name: "gforms_get_response",
    description:
      "Get a single response from a Google Form with all answers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        formId: {
          type: "string",
          description: "Google Form ID",
        },
        responseId: {
          type: "string",
          description: "Response ID",
        },
      },
      required: ["formId", "responseId"],
    },
  },
];

const classroomToolDefinitions = [
  {
    name: "classroom_courses",
    description:
      "List all Google Classroom courses. Returns course names, IDs, states, and links.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "classroom_course_details",
    description:
      "Get details for a specific Google Classroom course, including recent announcements.",
    inputSchema: {
      type: "object" as const,
      properties: {
        courseId: {
          type: "string",
          description: "Course ID",
        },
      },
      required: ["courseId"],
    },
  },
  {
    name: "classroom_assignments",
    description:
      "List assignments (course work) for a Google Classroom course.",
    inputSchema: {
      type: "object" as const,
      properties: {
        courseId: {
          type: "string",
          description: "Course ID",
        },
      },
      required: ["courseId"],
    },
  },
];

// ── Combined export ──

export const toolDefinitions = [
  ...gmailToolDefinitions,
  ...gdriveToolDefinitions,
  ...formsToolDefinitions,
  ...classroomToolDefinitions,
];

// ═══════════════════════════════════════════════════════════════════
// Input schemas (zod)
// ═══════════════════════════════════════════════════════════════════

// Handle arrays that arrive as JSON strings (MCP serialization quirk)
const safeJsonParse = (val: unknown) => {
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch { return val; }
};

const coerceStringArray = z.preprocess(safeJsonParse, z.array(z.string()));
const coerceStringArrayMin1 = z.preprocess(safeJsonParse, z.array(z.string().min(1)).min(1));

// Gmail schemas
const searchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(20),
});
const getMessageInput = z.object({ id: z.string().min(1) });
const getThreadInput = z.object({ id: z.string().min(1) });
const createLabelInput = z.object({ name: z.string().min(1) });
const deleteLabelInput = z.object({ name: z.string().min(1) });
const modifyLabelsInput = z.object({
  ids: z.preprocess(safeJsonParse, z.array(z.string().min(1)).min(1).max(100)),
  addLabels: coerceStringArray.optional().default([]),
  removeLabels: coerceStringArray.optional().default([]),
});
const markReadInput = z.object({
  ids: coerceStringArrayMin1,
  read: z.boolean().optional().default(true),
});
const createFilterInput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  query: z.string().optional(),
  addLabels: coerceStringArray.optional().default([]),
  removeLabels: coerceStringArray.optional().default([]),
  archive: z.boolean().optional().default(false),
  markRead: z.boolean().optional().default(false),
}).refine(
  (d) => d.from || d.to || d.subject || d.query,
  { message: "At least one filter criterion is required (from, to, subject, or query)" },
);
const batchTrashInput = z.object({ ids: z.preprocess(safeJsonParse, z.array(z.string().min(1)).min(1).max(100)) });
const sendInput = z.object({
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  attachments: coerceStringArray.optional(),
});
const replyInput = z.object({
  messageId: z.string().min(1),
  body: z.string(),
  replyAll: z.boolean().optional().default(false),
  attachments: coerceStringArray.optional(),
});
const forwardInput = z.object({
  messageId: z.string().min(1),
  to: z.string().min(1),
  message: z.string().optional(),
  includeAttachments: z.boolean().optional().default(true),
});
const createDraftInput = z.object({
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  replyToMessageId: z.string().optional(),
  attachments: coerceStringArray.optional(),
});
const getAttachmentInput = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().optional(),
  filename: z.string().optional(),
  savePath: z.string().optional(),
});
const listAttachmentsInput = z.object({ messageId: z.string().min(1) });
const deleteFilterInput = z.object({ id: z.string().min(1) });

// Drive schemas
const driveSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
const listFolderInput = z.object({
  folderId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional().default(50),
});
const fileIdInput = z.object({ fileId: z.string().min(1) });
const createFolderInput = z.object({
  name: z.string().min(1),
  parentId: z.string().optional(),
});
const createDocInput = z.object({
  name: z.string().min(1),
  content: z.string().optional(),
  parentId: z.string().optional(),
});
const createSheetInput = z.object({
  name: z.string().min(1),
  parentId: z.string().optional(),
});
const uploadFileInput = z.object({
  localPath: z.string().min(1),
  name: z.string().optional(),
  parentId: z.string().optional(),
});
const downloadFileInput = z.object({
  fileId: z.string().min(1),
  savePath: z.string().min(1),
});
const moveFileInput = z.object({
  fileId: z.string().min(1),
  newParentId: z.string().min(1),
});
const copyFileInput = z.object({
  fileId: z.string().min(1),
  newName: z.string().optional(),
  parentId: z.string().optional(),
});
const renameFileInput = z.object({
  fileId: z.string().min(1),
  newName: z.string().min(1),
});
const shareFileInput = z.object({
  fileId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["reader", "commenter", "writer", "organizer"]),
  notify: z.boolean().optional().default(true),
});
const removePermissionInput = z.object({
  fileId: z.string().min(1),
  permissionId: z.string().min(1),
});

// Forms schemas
const formIdInput = z.object({ formId: z.string().min(1) });
const listResponsesInput = z.object({
  formId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional().default(50),
});
const getResponseInput = z.object({
  formId: z.string().min(1),
  responseId: z.string().min(1),
});

// Classroom schemas
const courseIdInput = z.object({ courseId: z.string().min(1) });

// ═══════════════════════════════════════════════════════════════════
// Tool dispatch
// ═══════════════════════════════════════════════════════════════════

function asTextContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResponse(data: unknown) {
  return asTextContent(JSON.stringify(data, null, 2));
}

function errorResponse(tool: string, message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, tool }, null, 2) }],
  };
}

export async function handleToolCall(
  auth: OAuth2Client,
  tool: string,
  args: Record<string, unknown>,
) {
  try {
    switch (tool) {
      // ── Gmail ──
      case "gmail_search": {
        const input = searchInput.parse(args);
        return jsonResponse(await gmail.search(auth, input.query, input.limit));
      }
      case "gmail_get_message": {
        const input = getMessageInput.parse(args);
        return jsonResponse(await gmail.getMessage(auth, input.id));
      }
      case "gmail_get_thread": {
        const input = getThreadInput.parse(args);
        return jsonResponse(await gmail.getThread(auth, input.id));
      }
      case "gmail_list_labels": {
        return jsonResponse(await gmail.listLabels(auth));
      }
      case "gmail_create_label": {
        const input = createLabelInput.parse(args);
        return jsonResponse(await gmail.createLabel(auth, input.name));
      }
      case "gmail_delete_label": {
        const input = deleteLabelInput.parse(args);
        return jsonResponse(await gmail.deleteLabel(auth, input.name));
      }
      case "gmail_modify_labels": {
        const input = modifyLabelsInput.parse(args);
        return jsonResponse(await gmail.modifyLabels(auth, input.ids, input.addLabels, input.removeLabels));
      }
      case "gmail_mark_read": {
        const input = markReadInput.parse(args);
        return jsonResponse(await gmail.markRead(auth, input.ids, input.read));
      }
      case "gmail_create_filter": {
        const input = createFilterInput.parse(args);
        return jsonResponse(await gmail.createFilter(
          auth,
          { from: input.from, to: input.to, subject: input.subject, query: input.query },
          { addLabelNames: input.addLabels, removeLabelNames: input.removeLabels, archive: input.archive, markRead: input.markRead },
        ));
      }
      case "gmail_list_filters": {
        return jsonResponse(await gmail.listFilters(auth));
      }
      case "gmail_batch_trash": {
        const input = batchTrashInput.parse(args);
        return jsonResponse(await gmail.batchTrash(auth, input.ids));
      }
      case "gmail_send": {
        const input = sendInput.parse(args);
        return jsonResponse(await gmail.sendEmail(auth, input.to, input.subject, input.body, input.cc, input.bcc, input.attachments));
      }
      case "gmail_reply": {
        const input = replyInput.parse(args);
        return jsonResponse(await gmail.replyToMessage(auth, input.messageId, input.body, input.replyAll, input.attachments));
      }
      case "gmail_forward": {
        const input = forwardInput.parse(args);
        return jsonResponse(await gmail.forwardMessage(auth, input.messageId, input.to, input.message, input.includeAttachments));
      }
      case "gmail_create_draft": {
        const input = createDraftInput.parse(args);
        return jsonResponse(await gmail.createDraft(auth, input.to, input.subject, input.body, input.cc, input.bcc, input.replyToMessageId, input.attachments));
      }
      case "gmail_get_attachment": {
        const input = getAttachmentInput.parse(args);
        return jsonResponse(await gmail.getAttachment(auth, input.messageId, input.attachmentId, input.filename, input.savePath));
      }
      case "gmail_list_attachments": {
        const input = listAttachmentsInput.parse(args);
        return jsonResponse(await gmail.listAttachments(auth, input.messageId));
      }
      case "gmail_delete_filter": {
        const input = deleteFilterInput.parse(args);
        return jsonResponse(await gmail.deleteFilter(auth, input.id));
      }
      case "gmail_inbox_summary": {
        return jsonResponse(await gmail.inboxSummary(auth));
      }

      // ── Drive ──
      case "gdrive_search": {
        const input = driveSearchInput.parse(args);
        return jsonResponse(await gdrive.search(auth, input.query, input.limit));
      }
      case "gdrive_list_folder": {
        const input = listFolderInput.parse(args);
        return jsonResponse(await gdrive.listFolder(auth, input.folderId, input.limit));
      }
      case "gdrive_get_file_info": {
        const input = fileIdInput.parse(args);
        return jsonResponse(await gdrive.getFileInfo(auth, input.fileId));
      }
      case "gdrive_read_file": {
        const input = fileIdInput.parse(args);
        return jsonResponse(await gdrive.readFileContent(auth, input.fileId));
      }
      case "gdrive_create_folder": {
        const input = createFolderInput.parse(args);
        return jsonResponse(await gdrive.createFolder(auth, input.name, input.parentId));
      }
      case "gdrive_create_doc": {
        const input = createDocInput.parse(args);
        return jsonResponse(await gdrive.createDoc(auth, input.name, input.content, input.parentId));
      }
      case "gdrive_create_sheet": {
        const input = createSheetInput.parse(args);
        return jsonResponse(await gdrive.createSheet(auth, input.name, input.parentId));
      }
      case "gdrive_upload_file": {
        const input = uploadFileInput.parse(args);
        return jsonResponse(await gdrive.uploadFile(auth, input.localPath, input.name, input.parentId));
      }
      case "gdrive_download_file": {
        const input = downloadFileInput.parse(args);
        return jsonResponse(await gdrive.downloadFile(auth, input.fileId, input.savePath));
      }
      case "gdrive_move_file": {
        const input = moveFileInput.parse(args);
        return jsonResponse(await gdrive.moveFile(auth, input.fileId, input.newParentId));
      }
      case "gdrive_copy_file": {
        const input = copyFileInput.parse(args);
        return jsonResponse(await gdrive.copyFile(auth, input.fileId, input.newName, input.parentId));
      }
      case "gdrive_rename_file": {
        const input = renameFileInput.parse(args);
        return jsonResponse(await gdrive.renameFile(auth, input.fileId, input.newName));
      }
      case "gdrive_trash_file": {
        const input = fileIdInput.parse(args);
        return jsonResponse(await gdrive.trashFile(auth, input.fileId));
      }
      case "gdrive_share_file": {
        const input = shareFileInput.parse(args);
        return jsonResponse(await gdrive.shareFile(auth, input.fileId, input.email, input.role, input.notify));
      }
      case "gdrive_list_permissions": {
        const input = fileIdInput.parse(args);
        return jsonResponse(await gdrive.listPermissions(auth, input.fileId));
      }
      case "gdrive_remove_permission": {
        const input = removePermissionInput.parse(args);
        return jsonResponse(await gdrive.removePermission(auth, input.fileId, input.permissionId));
      }
      case "gdrive_about": {
        return jsonResponse(await gdrive.about(auth));
      }

      // ── Forms ──
      case "gforms_get": {
        const input = formIdInput.parse(args);
        return jsonResponse(await forms.getForm(auth, input.formId));
      }
      case "gforms_list_responses": {
        const input = listResponsesInput.parse(args);
        return jsonResponse(await forms.listResponses(auth, input.formId, input.limit));
      }
      case "gforms_get_response": {
        const input = getResponseInput.parse(args);
        return jsonResponse(await forms.getResponse(auth, input.formId, input.responseId));
      }

      // ── Classroom ──
      case "classroom_courses": {
        return jsonResponse(await classroom.listCourses(auth));
      }
      case "classroom_course_details": {
        const input = courseIdInput.parse(args);
        return jsonResponse(await classroom.getCourseDetails(auth, input.courseId));
      }
      case "classroom_assignments": {
        const input = courseIdInput.parse(args);
        return jsonResponse(await classroom.listAssignments(auth, input.courseId));
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[google-pro] tool error", tool, message);
    return errorResponse(tool, message);
  }
}
