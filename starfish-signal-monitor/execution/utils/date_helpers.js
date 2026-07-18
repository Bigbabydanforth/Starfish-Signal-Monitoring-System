function getTodayString() {
  // Use Eastern Time to match cron schedule (America/New_York)
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function getTodayStamp() {
  return getTodayString().replace(/-/g, ''); // YYYYMMDD
}

function getYesterdayString() {
  return getDateDaysAgo(1);
}

function getDateDaysAgo(days) {
  // Always anchor to "today in Eastern time" before subtracting days.
  // Using d.getDate() on a plain `new Date()` reads the SERVER's local timezone (often UTC).
  // Between midnight UTC and ~5 AM UTC the server is already on the next calendar day while
  // Eastern is still on the previous day — so getDate() - n would be off by 1.
  // Fix: parse the Eastern "today" string into UTC midnight, then subtract with setUTCDate()
  // so there is zero timezone ambiguity in the arithmetic.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [year, month, day] = todayET.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day)); // midnight UTC on the Eastern calendar date
  d.setUTCDate(d.getUTCDate() - days);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatDisplayDate(dateOrString) {
  return new Date(dateOrString).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatShortDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', // match cron timezone — prevents off-by-one on UTC servers
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export {
  getTodayString,
  getTodayStamp,
  getYesterdayString,
  getDateDaysAgo,
  formatDisplayDate,
  formatShortDate
};
