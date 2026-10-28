import pRetry, { AbortError } from "p-retry";
import { logger } from "./logger.js";

export { AbortError };

/** Retries transient failures with exponential backoff. Throw AbortError to stop retrying. */
export function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  return pRetry(fn, {
    retries,
    minTimeout: 500,
    factor: 2,
    onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
      logger.warn({ label, attemptNumber, retriesLeft, err: error.message }, "retrying");
    },
  });
}

/** Maps an HTTP status to retry behaviour: 429 and 5xx retry, other 4xx stop. */
export function throwForStatus(res: Response, label: string): void {
  if (res.ok) return;
  const msg = `${label}: HTTP ${res.status} ${res.statusText}`;
  if (res.status === 429 || res.status >= 500) throw new Error(msg);
  throw new AbortError(msg);
}
