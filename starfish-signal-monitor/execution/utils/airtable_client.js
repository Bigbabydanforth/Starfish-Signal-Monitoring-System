import 'dotenv/config';
import Airtable from 'airtable';

const TABLE = process.env.AIRTABLE_TABLE_NAME || 'Signals';

function getBase() {
  return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID);
}

// Exponential backoff retry for transient Airtable errors (429, 503, timeouts).
// Attempts: up to maxAttempts, with delay doubling each time + ±20% jitter.
// Throws on the final attempt so the caller's error handling still fires.
async function withBackoff(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status ?? err.status;
      const isTransient = status === 429 || status === 503 || /timeout/i.test(err.message);
      if (!isTransient || attempt === maxAttempts) throw err;
      const baseDelay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      const jitter    = baseDelay * 0.2 * (Math.random() * 2 - 1);
      const delay     = Math.round(baseDelay + jitter);
      console.warn(`[Airtable] ${label} — transient error (${status ?? err.message}), retry ${attempt}/${maxAttempts - 1} in ${(delay / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Query records from the Signals table.
// options: { filterByFormula, fields, maxRecords, sort }
// Returns: array of Airtable record objects
// Enforces a 30-second timeout — Airtable SDK has no built-in timeout and can hang indefinitely.
async function query(options = {}, timeoutMs = 30000) {
  return withBackoff(async () => {
    const queryPromise   = getBase()(TABLE).select(options).all();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable query timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    return Promise.race([queryPromise, timeoutPromise]);
  }, 'query');
}

// Create multiple records in the Signals table.
// records: array of { fields: { ... } } objects (max 10 per call)
// Returns: array of created Airtable record objects
// Enforces a 30-second timeout — same as query() — to prevent the pipeline hanging
// indefinitely if Airtable drops the connection mid-write.
async function createRecords(records, timeoutMs = 30000) {
  return withBackoff(async () => {
    const writePromise   = getBase()(TABLE).create(records);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable create timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    return Promise.race([writePromise, timeoutPromise]);
  }, 'createRecords');
}

// Create records in a specific base + table (used for AudienceLab separate base).
// baseId: Airtable base ID (e.g. process.env.AUDIENCELAB_AIRTABLE_BASE_ID)
// tableName: table name or ID string
// records: array of { fields: { ... } } objects (max 10 per call)
// Wrapped in withBackoff() — same retry/timeout behaviour as createRecords().
async function createRecordsInBase(baseId, tableName, records, timeoutMs = 30000) {
  return withBackoff(async () => {
    const base           = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);
    const writePromise   = base(tableName).create(records);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable createInBase timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    return Promise.race([writePromise, timeoutPromise]);
  }, 'createRecordsInBase');
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

// Query records from a specific base + table (used for AudienceLab separate base dedup).
// Same timeout + backoff behaviour as query().
async function queryInBase(baseId, tableName, options = {}, timeoutMs = 30000) {
  return withBackoff(async () => {
    const base           = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId);
    const queryPromise   = base(tableName).select(options).all();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Airtable queryInBase timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    return Promise.race([queryPromise, timeoutPromise]);
  }, 'queryInBase');
}

export { query, queryInBase, createRecords, createRecordsInBase, updateRecords, deleteRecords };
