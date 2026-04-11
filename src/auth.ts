import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths relative to the project root (parent of src/)
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");

const CREDENTIALS_PATH = resolve(PROJECT_ROOT, "credentials.json");
const TOKENS_PATH = resolve(PROJECT_ROOT, "tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const REDIRECT_URI = "http://localhost:3000/oauth2callback";

interface CredentialsFile {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

async function loadCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const raw = await readFile(CREDENTIALS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as CredentialsFile;
  const creds = parsed.installed ?? parsed.web;
  if (!creds) throw new Error("Invalid credentials.json: no 'installed' or 'web' key");
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

function createOAuth2Client(clientId: string, clientSecret: string): OAuth2Client {
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
}

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(TOKENS_PATH), { recursive: true, mode: 0o700 });
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function loadTokens(): Promise<StoredTokens> {
  try {
    const raw = await readFile(TOKENS_PATH, "utf-8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    throw new Error(
      `Tokens not found at ${TOKENS_PATH}. Run "npm run auth" to authenticate.`,
    );
  }
}

/**
 * Returns an authenticated OAuth2Client with valid tokens.
 * Tokens are loaded from disk; google-auth-library handles refresh automatically.
 */
export async function getAuthClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await loadCredentials();
  const client = createOAuth2Client(clientId, clientSecret);
  const tokens = await loadTokens();
  client.setCredentials(tokens);

  client.on("tokens", (newTokens) => {
    if (newTokens.access_token) {
      saveTokens({
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
        expiry_date: newTokens.expiry_date ?? 0,
      }).catch((err) => {
        console.error("[google-pro] failed to persist refreshed tokens:", err);
      });
    }
  });

  return client;
}

/**
 * Interactive OAuth flow. Run with `npm run auth`.
 * Opens browser for consent, receives code via local HTTP server, saves tokens.
 */
async function interactiveAuth(): Promise<void> {
  const { clientId, clientSecret } = await loadCredentials();
  const client = createOAuth2Client(clientId, clientSecret);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n=== Google Workspace MCP — OAuth Setup ===\n");
  console.log("Opening browser for Google authorization...\n");
  console.log("If the browser does not open, visit this URL manually:\n");
  console.log(authUrl);
  console.log();

  // Open browser (best-effort, non-blocking)
  const { spawn } = await import("node:child_process");
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(openCmd, [authUrl], { detached: true, stdio: "ignore" }).unref();

  // Wait for the OAuth callback
  const code = await new Promise<string>((resolveCode, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost:3000");

      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400);
        res.end(`Authorization error: ${error}`);
        reject(new Error(`OAuth error: ${error}`));
        server.close();
        return;
      }

      const authCode = url.searchParams.get("code");
      if (!authCode) {
        res.writeHead(400);
        res.end("Missing authorization code");
        reject(new Error("Missing authorization code"));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Google Workspace MCP authorized!</h2><p>You can close this tab.</p></body></html>",
      );
      resolveCode(authCode);
      server.close();
    });

    server.listen(3000, () => {
      console.log("Waiting for authorization on http://localhost:3000 ...\n");
    });

    server.on("error", reject);
  });

  // Exchange code for tokens
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(
      "Token exchange failed: missing access_token or refresh_token",
    );
  }

  await saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? 0,
  });

  console.log(`Tokens saved to ${TOKENS_PATH}`);
  console.log("Setup complete! You can now start the MCP server.\n");
}

// When run directly: `npm run auth` / `tsx src/auth.ts`
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  interactiveAuth().catch((err) => {
    console.error("Auth failed:", err);
    process.exit(1);
  });
}
