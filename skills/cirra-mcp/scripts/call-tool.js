#!/usr/bin/env node
/**
 * Cirra AI MCP - Call a Tool
 *
 * Usage:
 *   node call-tool.js <tool_name> [--arg1 value1] [--arg2 value2]
 *   node call-tool.js --list
 *
 * Examples:
 *   node call-tool.js search --query "AI agents"
 *   node call-tool.js get_document --id "doc-123"
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MCP_BASE = 'https://mcp.cirra.ai';

// Generate a unique session ID
let sessionId = null;
let messageId = 0;

// Load tokens from file or environment
function loadTokens() {
  // Try environment variable first (for container)
  if (process.env.CIRRA_OAUTH_CACHE) {
    try {
      return JSON.parse(process.env.CIRRA_OAUTH_CACHE);
    } catch (e) {
      console.error('Failed to parse CIRRA_OAUTH_CACHE:', e.message);
    }
  }

  // Try local file
  const tokenPath = path.join(process.env.HOME, '.mcporter', 'cirra-tokens.json');
  if (fs.existsSync(tokenPath)) {
    try {
      return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    } catch (e) {
      console.error('Failed to read tokens file:', e.message);
    }
  }

  return null;
}

// Refresh tokens if expired
async function refreshTokens(tokens) {
  if (!tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id
  });

  const response = await fetch(`${MCP_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const newTokens = await response.json();

  // Update token data
  tokens.access_token = newTokens.access_token;
  if (newTokens.refresh_token) {
    tokens.refresh_token = newTokens.refresh_token;
  }
  tokens.expires_at = newTokens.expires_in
    ? Date.now() + (newTokens.expires_in * 1000)
    : null;

  // Save updated tokens (only if running locally)
  if (!process.env.CIRRA_OAUTH_CACHE) {
    const tokenPath = path.join(process.env.HOME, '.mcporter', 'cirra-tokens.json');
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  }

  return tokens;
}

// Parse command line arguments
function parseArgs(args) {
  const toolName = args[0];
  const params = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[++i];
      // Try to parse JSON values
      try {
        params[key] = JSON.parse(value);
      } catch {
        params[key] = value;
      }
    } else if (arg.includes(':')) {
      // Support key:value syntax
      const [key, ...valueParts] = arg.split(':');
      const value = valueParts.join(':');
      try {
        params[key] = JSON.parse(value);
      } catch {
        params[key] = value;
      }
    }
  }

  return { toolName, params };
}

// Parse SSE response
function parseSSEResponse(text) {
  const lines = text.split('\n');
  let result = null;

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data);
          // Look for the response message
          if (parsed.jsonrpc === '2.0' && parsed.id !== undefined) {
            result = parsed;
          }
        } catch (e) {
          // Skip non-JSON lines
        }
      }
    }
  }

  return result;
}

// Make MCP JSON-RPC call over HTTP+SSE
async function mcpCall(tokens, method, params, isInitialize = false) {
  // Check if token is expired
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    console.error('Token expired, refreshing...');
    tokens = await refreshTokens(tokens);
  }

  const request = {
    jsonrpc: '2.0',
    id: ++messageId,
    method,
    params
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${tokens.access_token}`
  };

  // Add session ID for non-initialize calls
  if (!isInitialize && sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  const response = await fetch(`${MCP_BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request)
  });

  // Capture session ID from response header
  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) {
    sessionId = newSessionId;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MCP call failed: ${response.status} ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // Handle SSE response
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const result = parseSSEResponse(text);
    if (result) {
      return result;
    }
    throw new Error('No response received from SSE stream');
  }

  // Handle regular JSON response
  return response.json();
}

// Initialize MCP session
async function initializeSession(tokens) {
  const result = await mcpCall(tokens, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {
      roots: { listChanged: false },
      sampling: {}
    },
    clientInfo: {
      name: 'openclaw-mcp-client',
      version: '1.0.0'
    }
  }, true);

  if (result.error) {
    throw new Error(`Initialize failed: ${result.error.message}`);
  }

  // Send initialized notification
  await mcpCall(tokens, 'notifications/initialized', {});

  return result;
}

// Call MCP tool
async function callTool(tokens, toolName, params) {
  return mcpCall(tokens, 'tools/call', {
    name: toolName,
    arguments: params
  });
}

// List available tools
async function listTools(tokens) {
  return mcpCall(tokens, 'tools/list', {});
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node call-tool.js <tool_name> [--arg value ...]');
    console.error('       node call-tool.js --list');
    console.error('');
    console.error('Examples:');
    console.error('  node call-tool.js search --query "AI agents"');
    console.error('  node call-tool.js --list');
    process.exit(1);
  }

  // Load tokens
  const tokens = loadTokens();
  if (!tokens) {
    console.error('No OAuth tokens found.');
    console.error('Run: node oauth-flow.js');
    console.error('Or set CIRRA_OAUTH_CACHE environment variable');
    process.exit(1);
  }

  // Initialize session first
  try {
    await initializeSession(tokens);
  } catch (err) {
    console.error('Failed to initialize MCP session:', err.message);
    process.exit(1);
  }

  // Handle --list command
  if (args[0] === '--list') {
    try {
      const result = await listTools(tokens);
      if (result.error) {
        console.error('Error:', result.error.message);
        process.exit(1);
      }
      console.log(JSON.stringify(result.result, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  // Parse tool call
  const { toolName, params } = parseArgs(args);

  try {
    const result = await callTool(tokens, toolName, params);

    if (result.error) {
      console.error('Error:', result.error.message);
      process.exit(1);
    }

    // Format output
    if (result.result?.content) {
      for (const item of result.result.content) {
        if (item.type === 'text') {
          console.log(item.text);
        } else if (item.type === 'image') {
          console.log(`[Image: ${item.mimeType}]`);
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
    } else {
      console.log(JSON.stringify(result.result, null, 2));
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
