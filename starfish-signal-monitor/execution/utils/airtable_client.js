import 'dotenv/config';
import Airtable from 'airtable';

const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

// Query records from the Signals table.
// options: { filterByFormula, fields, maxRecords, sort }
// Returns: array of Airtable record objects
// Enforces a 30-second timeout — Airtable SDK has no built-in timeout and can hang indefinitely.
async function query(options = {}, timeoutMs = 30000) {
  const queryPromise = getBase()(TABLE).select(options).all();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Airtable query timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([queryPromise, timeoutPromise]);
}

// Create multiple records in the Signals table.
// records: array of { fields: { ... } } objects (max 10 per call)
// Returns: array of created Airtable record objects
// Enforces a 30-second timeout — same as query() — to prevent the pipeline hanging
// indefinitely if Airtable drops the connection mid-write.
async function createRecords(records, timeoutMs = 30000) {
  const writePromise   = getBase()(TABLE).create(records);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Airtable create timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([writePromise, timeoutPromise]);
}

// Create records in a specific base + table (used for AudienceLab separate base).
// baseId: Airtable base ID (e.g. process.env.AUDIENCELAB_AIRTABLE_BASE_ID)
// tableName: table name or ID string
// records: array of { fields: { ... } } objects (max 10 per call)
async function createRecordsInBase(baseId, tableName, records, timeoutMs = 30000) {
  const base           = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);
  const writePromise   = base(tableName).create(records);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Airtable createInBase timed out after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([writePromise, timeoutPromise]);
}

// Update existing records in the Signals table.
// updates: array of { id: 'recXXX', fields: { ... } } objects (max 10 per call)
// Returns: array of updated Airtable record objects
async function updateRecords(updates, timeoutMs = 30000) {
  const results = [];
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    // M-NEW-1: timeout guard — matches query() and createRecords() for consistency
    const writePromise   = getBase()(TABLE).update(batch);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable update timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    const updated = await Promise.race([writePromise, timeoutPromise]);
    results.push(...updated);
    if (i + 10 < updates.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

// Delete records from the Signals table.
// ids: array of record ID strings (max 10 per call)
// Returns: array of deleted record IDs
async function deleteRecords(ids, timeoutMs = 30000) {
  const results = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    // M-NEW-1: timeout guard — matches query() and createRecords() for consistency
    const writePromise   = getBase()(TABLE).destroy(batch);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable delete timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    const deleted = await Promise.race([writePromise, timeoutPromise]);
    results.push(...deleted);
    if (i + 10 < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

export { query, createRecords, createRecordsInBase, updateRecords, deleteRecords };
