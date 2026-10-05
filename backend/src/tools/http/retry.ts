export interface RetryPolicy {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 2, baseDelayMs: 200, maxDelayMs: 2000 };

/** Only transient failures are worth repeating. 4xx (other than 429) means "your request is wrong". */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff with "equal jitter": half fixed, half random, so clients do not retry in sync. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + (random() * exp) / 2);
}
