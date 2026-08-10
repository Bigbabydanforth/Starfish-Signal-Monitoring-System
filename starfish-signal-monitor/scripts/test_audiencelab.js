/**
 * scripts/test_audiencelab.js
 * Quick check — confirms the AudienceLab API key is valid and both segments are reachable.
 * Run: node --env-file=.env scripts/test_audiencelab.js
 */

import 'dotenv/config';
import axios from 'axios';

const API_KEY       = process.env.AUDIENCELAB_API_KEY;
const SEGMENT_PIXEL = process.env.AUDIENCELAB_SEGMENT_PIXEL;
const SEGMENT_LEADS = process.env.AUDIENCELAB_SEGMENT_LEADS;
const BASE_URL      = 'https://api.audiencelab.io';

async function testSegment(name, segmentId) {
  if (!segmentId) {
    console.log(`  [${name}] ⚠️  Segment ID not set in .env — skipping`);
    return;
  }
  try {
    const res = await axios.get(`${BASE_URL}/segments/${segmentId}`, {
      params:  { page: 1, page_size: 1 },
      headers: { 'X-Api-Key': API_KEY },
      timeout: 15000
    });
    const total      = res.data?.total_records ?? res.data?.total ?? res.data?.count ?? '?';
    const totalPages = res.data?.total_pages ?? '?';
    console.log(`  [${name}] ✅ OK — ${total} records across ${totalPages} pages`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      console.log(`  [${name}] ❌ 401 Unauthorized — API key is invalid or expired`);
    } else if (status === 403) {
      console.log(`  [${name}] ❌ 403 Forbidden — API key doesn't have access to this segment`);
    } else if (status === 404) {
      console.log(`  [${name}] ❌ 404 Not Found — segment ID may be wrong`);
    } else {
      console.log(`  [${name}] ❌ Error ${status ?? 'unknown'}: ${err.message}`);
    }
  }
}

async function run() {
  console.log('Testing AudienceLab API...');
  console.log(`  API Key : ${API_KEY ? API_KEY.slice(0, 6) + '...' + API_KEY.slice(-4) : '❌ NOT SET'}`);
  console.log('');

  if (!API_KEY) {
    console.log('❌ AUDIENCELAB_API_KEY is not set in .env — cannot test.');
    process.exit(1);
  }

  await testSegment('Pixel / Website Visitors', SEGMENT_PIXEL);
  await testSegment('Brand Strategy Intent',    SEGMENT_LEADS);

  console.log('\nDone.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
