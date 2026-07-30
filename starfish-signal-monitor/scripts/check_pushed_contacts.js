/**
 * check_pushed_contacts.js
 *
 * Lists all Airtable signal records where HubSpot Pushed = true.
 * Highlights duplicate emails, placeholder emails, and gives a clean summary.
 *
 * Run with:
 *   node --env-file=.env scripts/check_pushed_contacts.js
 *
 * Filter by date range (optional):
 *   node --env-file=.env scripts/check_pushed_contacts.js --days=7
 */

import { query } from '../execution/utils/airtable_client.js';

const PLACEHOLDER_EMAIL = 'email_not_unlocked@domain.com';

const daysArg = process.argv.find(a => a.startsWith('--days='));
const days    = daysArg ? parseInt(daysArg.split('=')[1], 10) : null;

const cutoffStr = days
  ? (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split('T')[0]; })()
  : null;

console.log('────────────────────────────────────────────────────────────');
console.log('PUSHED CONTACTS — HubSpot Pushed = true');
console.log(cutoffStr ? `Date range: last ${days} day(s) (from ${cutoffStr})` : 'Date range: all time');
console.log('────────────────────────────────────────────────────────────\n');

function extractEmail(contactInfo) {
  if (!contactInfo) return null;
  const m = contactInfo.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

async function run() {
  const filter = cutoffStr
    ? `AND({HubSpot Pushed}=TRUE(), IS_AFTER({Date Detected}, '${cutoffStr}'))`
    : `{HubSpot Pushed}=TRUE()`;

  let records;
  try {
    records = await query({
      filterByFormula: filter,
      fields: ['Company Name', 'Signal Type', 'Contact Info', 'Date Detected', 'AB Test Group', 'Send Day', 'Bespoke'],
      sort: [{ field: 'Date Detected', direction: 'desc' }],
    });
  } catch (err) {
    console.error('Failed to query Airtable:', err.message);
    process.exit(1);
  }

  if (records.length === 0) {
    console.log('No pushed contacts found.');
    return;
  }

  // Build per-email frequency map
  const emailCount = {};
  for (const r of records) {
    const email = extractEmail(r.fields['Contact Info']);
    if (email) emailCount[email] = (emailCount[email] || 0) + 1;
  }

  // Collect stats
  let placeholderCount = 0;
  let noEmailCount     = 0;
  const duplicateEmails = new Set(
    Object.entries(emailCount).filter(([, n]) => n > 1).map(([e]) => e)
  );

  // Group by Signal Type
  const grouped = {};

  for (const r of records) {
    const type    = r.fields['Signal Type'] || 'Unknown';
    const email   = extractEmail(r.fields['Contact Info']);
    const company = r.fields['Company Name'] || '(no name)';
    const date    = (r.fields['Date Detected'] || '').slice(0, 10);
    const abGroup = r.fields['AB Test Group'] || '';
    const sendDay = r.fields['Send Day'] || '';
    const bespoke = r.fields['Bespoke'] ? ' [bespoke]' : '';

    let flag = '';
    if (!email)                        { noEmailCount++;     flag = ' ⚠️  NO EMAIL'; }
    else if (email === PLACEHOLDER_EMAIL) { placeholderCount++; flag = ' 🚫 PLACEHOLDER'; }
    else if (duplicateEmails.has(email))  { flag = ' ♻️  DUPLICATE'; }

    if (!grouped[type]) grouped[type] = [];
    grouped[type].push({ company, email: email || '—', date, abGroup, sendDay, bespoke, flag });
  }

  // Print grouped results
  for (const [type, items] of Object.entries(grouped)) {
    console.log(`${type} (${items.length})`);
    for (const item of items) {
      const meta = [item.abGroup, item.sendDay ? `day ${item.sendDay}` : ''].filter(Boolean).join(', ');
      console.log(`  • ${item.company.padEnd(38)} ${item.email.padEnd(42)} ${item.date}  [${meta}]${item.bespoke}${item.flag}`);
    }
    console.log();
  }

  // Summary
  const uniqueEmails = new Set(
    records.map(r => extractEmail(r.fields['Contact Info'])).filter(e => e && e !== PLACEHOLDER_EMAIL)
  );

  console.log('────────────────────────────────────────────────────────────');
  console.log(`Total records pushed : ${records.length}`);
  console.log(`Unique real emails   : ${uniqueEmails.size}`);
  if (duplicateEmails.size > 0)
    console.log(`♻️  Duplicate emails  : ${duplicateEmails.size} email(s) pushed more than once`);
  if (placeholderCount > 0)
    console.log(`🚫 Placeholders      : ${placeholderCount} record(s) with email_not_unlocked@domain.com`);
  if (noEmailCount > 0)
    console.log(`⚠️  No email          : ${noEmailCount} record(s) with no email at all`);
  console.log('────────────────────────────────────────────────────────────');

  if (duplicateEmails.size > 0) {
    console.log('\nDuplicate emails (pushed more than once):');
    for (const [email, count] of Object.entries(emailCount).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${email.padEnd(50)} × ${count}`);
    }
  }
}

run();
