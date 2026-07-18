/**
 * Circuit breaker for external API calls.
 *
 * States:
 *   CLOSED   — normal operation, all calls go through
 *   OPEN     — API is failing, all calls are skipped until reset timeout
 *   HALF_OPEN — one probe call is allowed; success → CLOSED, failure → OPEN again
 *
 * Only trips on network errors and HTTP 5xx responses.
 * 401 (config issue) and 429 (rate limit) do NOT trip the circuit — they are
 * transient/billing issues, not outages.
 *
 * Failure threshold : 3 consecutive failures
 * Reset timeout     : 5 minutes
 */

const FAILURE_THRESHOLD = 3;
const RESET_TIMEOUT_MS  = 5 * 60 * 1000; // 5 minutes

class CircuitBreaker {
  constructor(name) {
    this.name          = name;
    this.state         = 'CLOSED';
    this.failures      = 0;
    this.nextAttemptAt = 0;
  }

  /**
   * Returns true when the circuit is OPEN (caller should skip the API call).
   * Automatically transitions OPEN → HALF_OPEN after the reset timeout to allow
   * one probe call through.
   */
  isOpen() {
    if (this.state === 'CLOSED') return false;

    if (this.state === 'OPEN') {
      if (Date.now() >= this.nextAttemptAt) {
        this.state = 'HALF_OPEN';
        console.log(`[Circuit/${this.name}] → HALF_OPEN — probing after 5-min cooldown`);
        return false; // let one call through as a probe
      }
      return true; // still cooling down — skip this call
    }

    // HALF_OPEN — allow the probe call through
    return false;
  }

  /** Call after a successful API response. Resets the breaker to CLOSED. */
  recordSuccess() {
    if (this.state !== 'CLOSED') {
      console.log(`[Circuit/${this.name}] → CLOSED — API recovered after ${this.failures} failure(s)`);
    }
    this.state         = 'CLOSED';
    this.failures      = 0;
    this.nextAttemptAt = 0;
  }

  /**
   * Call after a failure that indicates the API may be down.
   * Do NOT call for 401 (config) or 429 (rate limit) — only for network errors and 5xx.
   * @param {string} reason  Short error description, logged when the circuit trips.
   */
  recordFailure(reason) {
    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= FAILURE_THRESHOLD) {
      this.state         = 'OPEN';
      this.nextAttemptAt = Date.now() + RESET_TIMEOUT_MS;
      console.warn(
        `[Circuit/${this.name}] → OPEN after ${this.failures} failure(s) — ` +
        `calls blocked for 5 min. Last error: ${reason}`
      );
    }
  }
}

// Module-level registry — one breaker per named API, shared across the whole run.
const _breakers = {};

/** Get (or lazily create) the named circuit breaker. */
export function getBreaker(name) {
  if (!_breakers[name]) _breakers[name] = new CircuitBreaker(name);
  return _breakers[name];
}

/**
 * Reset all circuit breakers to CLOSED at the start of each pipeline run.
 *
 * Without this, a breaker tripped during one cron run (e.g. 5AM Monday) stays
 * OPEN until its 5-minute cooldown — but since the process persists between
 * daily cron runs, that tripped state is still visible at 5AM Tuesday.
 * Resetting at run start ensures each daily run gets a clean slate.
 *
 * Called by main.js at the top of runAllWorkflows().
 */
export function resetAllBreakers() {
  for (const name of Object.keys(_breakers)) {
    const b = _breakers[name];
    if (b.state !== 'CLOSED') {
      console.log(`[Circuit/${name}] Reset to CLOSED at pipeline start`);
    }
    b.state         = 'CLOSED';
    b.failures      = 0;
    b.nextAttemptAt = 0;
  }
}
