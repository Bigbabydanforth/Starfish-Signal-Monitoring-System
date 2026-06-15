import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

const REDIRECT_URI = 'http://localhost:3000';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/spreadsheets'],
  prompt: 'consent'
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for Google to redirect back...\n');

// Spin up a temporary local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const params = new URL(req.url, REDIRECT_URI).searchParams;
  const code   = params.get('code');
  const error  = params.get('error');

  if (error) {
    res.end('❌ Access denied. You can close this tab.');
    console.error('\n❌ Error:', error);
    server.close();
    return;
  }

  if (!code) {
    res.end('Waiting...');
    return;
  }

  res.end('✅ Authorized! You can close this tab and check your terminal.');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ New refresh token:\n');
    console.log(tokens.refresh_token);
    console.log('\nCopy that value into GOOGLE_REFRESH_TOKEN in your .env file.\n');
  } catch (err) {
    console.error('\n❌ Failed to get token:', err.message);
  }

  server.close();
});

server.listen(3000, () => {
  console.log('Listening on http://localhost:3000 ...\n');
});
