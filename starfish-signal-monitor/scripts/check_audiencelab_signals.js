/**
 * scripts/check_audiencelab_signals.js
 * Quick count of Website Visitor and Brand Strategy Intent signals in Airtable.
 * Run: node --env-file=.env scripts/check_audiencelab_signals.js
 */

import 'dotenv/config';
import Airtable from 'airtable';

const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

async function countByType(signalType) {
  const records = await getBase()(TABLE)
    .select({
      filterByFormula: `{Signal Type} = "${signalType}"`,
      fields: ['HubSpot Pushed'],
    })
    .all();

  const pushed   = records.filter(r => r.fields['HubSpot Pushed'] === true).length;
  const unpushed = records.length - pushed;
  return { total: records.length, pushed, unpushed };
}

async function run() {
  console.log('Checking AudienceLab signal counts in Airtable...\n');

  const [wv, bsi] = await Promise.all([
    countByType('Website Visitor'),
    countByType('Brand Strategy Intent'),
  ]);

  console.log('══════════════════════════════════════════════════════');
  console.log('AUDIENCELAB SIGNAL COUNTS');
  console.log('══════════════════════════════════════════════════════');
  console.log(`\n🌐 Website Visitor (Pixel)`);
  console.log(`   Total in Airtable  : ${wv.total}`);
  console.log(`   Pushed to HubSpot  : ${wv.pushed}`);
  console.log(`   Unpushed           : ${wv.unpushed}`);

  console.log(`\n🎯 Brand Strategy Intent`);
  console.log(`   Total in Airtable  : ${bsi.total}`);
  console.log(`   Pushed to HubSpot  : ${bsi.pushed}`);
  console.log(`   Unpushed           : ${bsi.unpushed}`);
  console.log('\n══════════════════════════════════════════════════════');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
