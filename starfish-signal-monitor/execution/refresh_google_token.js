/**
 * refresh_google_token.js
 *
 * Starts a local server to capture the Google OAuth callback automatically.
 * No copy-pasting required — the browser redirects here after approval.
 *
 * Steps:
 *   1. Run: node execution/refresh_google_token.js
 *   2. Your browser will open (or copy the URL printed)
 *   3. Sign in with the Google account that owns the sheet
 *   4. After approving, the terminal will print your new GOOGLE_REFRESH_TOKEN
 *   5. Copy it into your .env file
 *
 * Requires in .env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * IMPORTANT — one-time Google Cloud Console step (if not already done):
 *   Go to your OAuth credential → Add "http://localhost:3000" as an
 *   Authorized Redirect URI, then save.
 */

import 'dotenv/config';
import http from 'http';
import { google } from 'googleapis';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT          = 3000;
const REDIRECT_URI  = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[Auth] GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt:      'consent',
  scope: ['https://www.googleapis.com/auth/spreadsheets']
});

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Google Sheets — Re-Authorization');
console.log('══════════════════════════════════════════════════════════════\n');
console.log('Opening authorization URL...\n');
console.log(authUrl);
console.log('\nIf the browser did not open, paste the URL above manually.\n');
console.log(`Waiting for Google to redirect to http://localhost:${PORT} ...\n`);

// Try to open browser automatically (best effort)
try {
  const { exec } = await import('child_process');
  const cmd = process.platform === 'win32'
    ? `start "" "${authUrl}"`
    : process.platform === 'darwin'
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
  exec(cmd);
} catch (_) { /* ignore — user can open manually */ }

// Local server to capture the auth code from Google's redirect
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const code   = url.searchParams.get('code');
  const error  = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
    server.close();
    console.error(`\n[Auth] Authorization denied: ${error}`);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Waiting for authorization code...</h2>');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <h2 style="color:green">✅ Authorization successful!</h2>
    <p>You can close this tab and check your terminal for the refresh token.</p>
  `);
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);

    console.log('\n✅ Authorization successful!\n');

    if (tokens.refresh_token) {
      console.log('══════════════════════════════════════════════════════════════');
      console.log('  Copy this into your .env file:');
      console.log('══════════════════════════════════════════════════════════════\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n══════════════════════════════════════════════════════════════');
      console.log('  Then run:');
      console.log('  node execution/workflow_4b_sync_sheets.js --date 2026-06-05');
      console.log('══════════════════════════════════════════════════════════════\n');
    } else {
      console.log('\n⚠️  Google did not return a new refresh token.');
      console.log('   This means an active token already exists for this account.');
      console.log('   Try revoking existing access first:');
      console.log('   https://myaccount.google.com/permissions');
      console.log('   Find "Starfish Signal Monitor" (or your app name), revoke it,');
      console.log('   then run this script again.\n');
    }
  } catch (err) {
    console.error('\n[Auth] Token exchange failed:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  // Server is ready — browser will redirect here after auth
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[Auth] Port ${PORT} is already in use. Close whatever is running on port ${PORT} and try again.`);
  } else {
    console.error('\n[Auth] Server error:', err.message);
  }
  process.exit(1);
});
