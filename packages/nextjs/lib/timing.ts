const SWAP_WINDOW_SECONDS = 120;
const MAX_INVOICE_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export function transactionTimestamp(
  latestBlockTimestamp: number,
  nowMilliseconds = Date.now(),
): number {
  const wallClock = Math.floor(nowMilliseconds / 1000);
  if (
    !Number.isSafeInteger(latestBlockTimestamp) ||
    latestBlockTimestamp < 0 ||
    !Number.isSafeInteger(wallClock) ||
    wallClock < 0
  ) {
    throw new RangeError("Invalid transaction clock.");
  }
  // An idle local chain's next block advances to wall-clock time.
  // A chain deliberately advanced into the future must remain authoritative.
  return Math.max(latestBlockTimestamp, wallClock);
}

export function invoiceExpiry(
  latestBlockTimestamp: number,
  lifetimeSeconds: number,
  nowMilliseconds = Date.now(),
): number {
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > MAX_INVOICE_LIFETIME_SECONDS
  ) {
    throw new RangeError("Invalid invoice lifetime.");
  }
  return (
    transactionTimestamp(latestBlockTimestamp, nowMilliseconds) +
    lifetimeSeconds
  );
}

export function paymentDeadline(
  latestBlockTimestamp: number,
  expiresAt: number,
  nowMilliseconds = Date.now(),
): number {
  const current = transactionTimestamp(latestBlockTimestamp, nowMilliseconds);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= current) {
    throw new RangeError("Invoice expired.");
  }
  return Math.min(current + SWAP_WINDOW_SECONDS, expiresAt);
}
