---
name: cirra-mcp
description: Connect to Cirra AI MCP server for external tools. Use this skill to call Cirra AI tools via the Model Context Protocol. Requires OAuth authentication (see setup instructions).
---

# Cirra AI MCP Integration

Connect to Cirra AI's MCP server at `https://mcp.cirra.ai/mcp` to access their tools.

## Prerequisites

- OAuth tokens must be configured (see Authentication below)

## Quick Start

### List Available Tools

```bash
node /root/clawd/skills/cirra-mcp/scripts/call-tool.js --list
```

### Call a Tool

```bash
node /root/clawd/skills/cirra-mcp/scripts/call-tool.js <tool_name> --arg1 value1 --arg2 value2
```

Example:

```bash
# Initialize Cirra AI session (required before other calls)
node /root/clawd/skills/cirra-mcp/scripts/call-tool.js cirra_ai_init

# Call a tool with arguments
node /root/clawd/skills/cirra-mcp/scripts/call-tool.js search --query "AI agents"
```

## Authentication

Cirra AI requires OAuth authentication. Since this runs in a headless container, you must authenticate locally first and then transfer the tokens.

### Step 1: Authenticate Locally

On your local machine (with a browser), run the OAuth flow script:

```bash
# From the moltworker directory
node skills/cirra-mcp/scripts/oauth-flow.js
```

This will:
1. Register a dynamic OAuth client
2. Open your browser for OAuth consent
3. Save tokens to `~/.mcporter/cirra-tokens.json`
4. Print the JSON to copy for the secret

### Step 2: Set as Secret

Copy the JSON output and set it as a Cloudflare Worker secret:

```bash
npx wrangler secret put CIRRA_OAUTH_CACHE
# Paste the JSON when prompted
```

### Step 3: Redeploy

```bash
npm run deploy
```

## Token Refresh

OAuth tokens expire periodically. When tokens expire:

1. Re-run the OAuth flow locally: `node skills/cirra-mcp/scripts/oauth-flow.js`
2. Update the secret: `npx wrangler secret put CIRRA_OAUTH_CACHE`
3. Restart the gateway via the admin UI at `/_admin/`

## Environment Variables

| Variable            | Description                                |
| ------------------- | ------------------------------------------ |
| `CIRRA_OAUTH_CACHE` | JSON containing OAuth tokens for Cirra AI  |

## Available Scripts

| Script           | Description                                     |
| ---------------- | ----------------------------------------------- |
| `oauth-flow.js`  | Run OAuth flow locally to get tokens            |
| `call-tool.js`   | Call MCP tools or list available tools          |

## Troubleshooting

- **"OAuth token expired"**: Re-run oauth-flow.js locally and update the secret
- **"Session not found"**: The script initializes a new session automatically
- **"Connection refused"**: Check that Cirra AI's MCP endpoint is reachable
- **Tool not found**: Run `call-tool.js --list` to see available tools
