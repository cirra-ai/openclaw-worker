#!/usr/bin/env node
/**
 * Manual OAuth flow for Cirra AI MCP Server
 *
 * Usage: node oauth-flow.js
 *
 * This script:
 * 1. Registers a dynamic client (if needed)
 * 2. Opens browser for authorization
 * 3. Starts a local server to receive the callback
 * 4. Exchanges the code for tokens
 * 5. Saves tokens to ~/.mcporter/cirra-tokens.json
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MCP_BASE = 'https://mcp.cirra.ai';
const CALLBACK_PORT = 8976;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

// Generate PKCE challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

// Generate state for CSRF protection
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Dynamic client registration
async function registerClient() {
  const response = await fetch(`${MCP_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OpenClaw MCP Client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Client registration failed: ${response.status} ${text}`);
  }

  return response.json();
}

// Exchange authorization code for tokens
async function exchangeCode(code, clientId, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier
  });

  const response = await fetch(`${MCP_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  return response.json();
}

// Open URL in browser
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' :
              platform === 'win32' ? 'start' : 'xdg-open';
  execSync(`${cmd} "${url}"`);
}

// Start local server to receive OAuth callback
function startCallbackServer(state, pkce, clientId) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${error}: ${url.searchParams.get('error_description')}</p>`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Error</h1><p>State mismatch - possible CSRF attack</p>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      try {
        const tokens = await exchangeCode(code, clientId, pkce.verifier);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <h1>Success!</h1>
          <p>You can close this window and return to your terminal.</p>
          <script>window.close()</script>
        `);

        server.close();
        resolve({ tokens, clientId });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
        server.close();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`Callback server listening on port ${CALLBACK_PORT}`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out'));
    }, 5 * 60 * 1000);
  });
}

async function main() {
  console.log('Starting OAuth flow for Cirra AI...\n');

  // Step 1: Register client
  console.log('1. Registering OAuth client...');
  let client;
  try {
    client = await registerClient();
    console.log(`   Client ID: ${client.client_id}\n`);
  } catch (err) {
    console.error(`   Failed to register client: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // Step 3: Build authorization URL
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256'
  });
  const authUrl = `${MCP_BASE}/authorize?${authParams}`;

  // Step 4: Start callback server and open browser
  console.log('2. Opening browser for authorization...');
  console.log(`   URL: ${authUrl}\n`);

  const serverPromise = startCallbackServer(state, pkce, client.client_id);

  // Give server a moment to start
  await new Promise(r => setTimeout(r, 500));
  openBrowser(authUrl);

  // Step 5: Wait for callback
  console.log('3. Waiting for authorization...');
  let result;
  try {
    result = await serverPromise;
    console.log('   Authorization successful!\n');
  } catch (err) {
    console.error(`   Authorization failed: ${err.message}`);
    process.exit(1);
  }

  // Step 6: Save tokens
  const mcporterDir = path.join(process.env.HOME, '.mcporter');
  if (!fs.existsSync(mcporterDir)) {
    fs.mkdirSync(mcporterDir, { recursive: true });
  }

  const tokenData = {
    server: 'cirra',
    url: MCP_BASE,
    client_id: result.clientId,
    access_token: result.tokens.access_token,
    refresh_token: result.tokens.refresh_token,
    token_type: result.tokens.token_type,
    expires_at: result.tokens.expires_in
      ? Date.now() + (result.tokens.expires_in * 1000)
      : null,
    scope: result.tokens.scope
  };

  const tokenPath = path.join(mcporterDir, 'cirra-tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
  console.log(`4. Tokens saved to ${tokenPath}`);

  // Also save in format for CIRRA_OAUTH_CACHE env var
  console.log('\n--- Copy this for CIRRA_OAUTH_CACHE secret ---');
  console.log(JSON.stringify(tokenData));
  console.log('----------------------------------------------\n');

  console.log('Done! You can now use the Cirra AI MCP server.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
