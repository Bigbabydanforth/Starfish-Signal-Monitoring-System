// scripts/get_refresh_token.js
// Run this locally to generate a new Google OAuth refresh token.
// Usage: node scripts/get_refresh_token.js
//
// After running:
// 1. Copy the printed refresh token
// 2. Update GOOGLE_REFRESH_TOKEN in your .env file
// 3. Update GOOGLE_REFRESH_TOKEN in Railway Variables tab

import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000';
const SCOPES        = ['https://www.googleapis.com/auth/spreadsheets'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in your .env file');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force consent screen so a refresh token is always returned
});

console.log('\n==================================================');
console.log('Open this URL in your browser and log in:');
console.log('\n' + authUrl + '\n');
console.log('==================================================\n');
console.log('Waiting for Google to redirect back to localhost:3000...\n');

// Start a local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Error: ' + error + '</h2><p>Check your terminal.</p>');
    console.error('OAuth error:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>No code received.</h2><p>Try again.</p>');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success! You can close this tab and go back to your terminal.</h2>');

    console.log('==================================================');
    console.log('SUCCESS — New refresh token generated:');
    console.log('==================================================\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\n==================================================');
    console.log('Copy the token above and:');
    console.log('  1. Update GOOGLE_REFRESH_TOKEN in your .env file');
    console.log('  2. Update GOOGLE_REFRESH_TOKEN in Railway Variables tab');
    console.log('==================================================\n');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h2>Token exchange failed.</h2><p>' + err.message + '</p>');
    console.error('Token exchange failed:', err.message);
  }

  server.close();
});

server.listen(3000, () => {
  console.log('Local server listening on http://localhost:3000');
});
