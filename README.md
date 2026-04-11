# google-workspace-mcp

MCP server for Google Workspace — Gmail, Drive, Google Forms, and Google Classroom.

Exposes 42 tools to Claude (or any MCP-compatible AI) via stdio.

## Features

| Module | Tools | Scopes required |
|--------|-------|-----------------|
| Gmail | 19 | `gmail.readonly`, `gmail.modify`, `gmail.settings.basic` |
| Drive | 17 | `drive` |
| Forms | 3 | `forms.body.readonly`, `forms.responses.readonly` |
| Classroom | 3 | `classroom.courses.readonly`, `classroom.coursework.me.readonly`, `classroom.rosters.readonly` |

## Prerequisites

- Node.js >= 18
- A Google Cloud Project with OAuth 2.0 credentials (Desktop app type)
- APIs enabled: Gmail API, Google Drive API, Google Forms API, Google Classroom API

## Setup

### 1. Create OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create credentials → OAuth 2.0 Client ID → Desktop app
3. Download the JSON and save it as `credentials.json` in this directory
4. Enable the required APIs in your GCP project

See `credentials.json.example` for the expected format.

### 2. Install and authenticate

```bash
npm install
npm run auth      # opens browser for OAuth consent
npm run build
```

### 3. Configure Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
"google-workspace": {
  "command": "node",
  "args": ["/path/to/google-workspace-mcp/dist/index.js"],
  "env": {}
}
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run auth` | Interactive OAuth flow — run once to generate `tokens.json` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run directly with `tsx` (no build needed) |
| `npm start` | Run compiled server |

## Token refresh

Tokens are stored in `tokens.json` and refreshed automatically by `google-auth-library`. If a token is corrupted, delete `tokens.json` and run `npm run auth` again.

## Using only Gmail + Drive (no Forms/Classroom)

Remove the imports in `src/tools.ts` and `src/index.ts` for the modules you don't need, and remove the corresponding scopes from `src/auth.ts`.
