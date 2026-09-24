export type Pending = {
  hash: string;
  invoiceId: string;
  kind: "create" | "pay" | "refund";
  submittedAt?: number;
};
export type TransactionScope = { chainId: number; checkout: string };
export type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
export type PaymentReceipt = { hash: string; invoiceId: string; kind: "pay" };

function prefix(scope: TransactionScope) {
  return scope.chainId + ":" + scope.checkout.toLowerCase() + ":";
}
export function pendingStorageKey(scope: TransactionScope, id = "") {
  return "hts-checkout:pending:" + prefix(scope) + id.toLowerCase();
}
export function paymentStorageKey(scope: TransactionScope, id: string) {
  return "hts-checkout:payment:" + prefix(scope) + id.toLowerCase();
}
function validPending(value: unknown): value is Pending {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<Pending>;
  return (
    typeof pending.hash === "string" &&
    /^0x[0-9a-f]{64}$/i.test(pending.hash) &&
    ((pending.kind === "refund" && pending.invoiceId === "") ||
      ((pending.kind === "pay" || pending.kind === "create") &&
        typeof pending.invoiceId === "string" &&
        /^0x[0-9a-f]{64}$/i.test(pending.invoiceId)))
  );
}
export function samePending(left: Pending | null, right: Pending) {
  return Boolean(
    left &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.invoiceId.toLowerCase() === right.invoiceId.toLowerCase() &&
    left.kind === right.kind,
  );
}
function parse(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
export function readPending(
  storage: StorageLike,
  scope: TransactionScope,
  requestedInvoice?: string | null,
): Pending | null {
  const candidates: Pending[] = [];
  const storagePrefix = pendingStorageKey(scope);
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(storagePrefix)) continue;
    const value = parse(storage.getItem(key));
    if (
      validPending(value) &&
      key === pendingStorageKey(scope, value.invoiceId)
    )
      candidates.push(value);
  }
  candidates.sort((left, right) => {
    const leftRequested =
      requestedInvoice &&
      left.invoiceId.toLowerCase() === requestedInvoice.toLowerCase();
    const rightRequested =
      requestedInvoice &&
      right.invoiceId.toLowerCase() === requestedInvoice.toLowerCase();
    if (leftRequested !== rightRequested) return leftRequested ? -1 : 1;
    const leftTime = Number.isFinite(left.submittedAt) ? left.submittedAt! : 0;
    const rightTime = Number.isFinite(right.submittedAt)
      ? right.submittedAt!
      : 0;
    return rightTime - leftTime || left.hash.localeCompare(right.hash);
  });
  return candidates[0] || null;
}
export function storePending(
  storage: StorageLike,
  scope: TransactionScope,
  pending: Pending,
) {
  storage.setItem(
    pendingStorageKey(scope, pending.invoiceId),
    JSON.stringify(pending),
  );
}
export function removeMatchingPending(
  storage: StorageLike,
  scope: TransactionScope,
  pending: Pending,
) {
  const key = pendingStorageKey(scope, pending.invoiceId);
  const stored = parse(storage.getItem(key));
  if (validPending(stored) && samePending(stored, pending))
    storage.removeItem(key);
}
export function storePaymentReceipt(
  storage: StorageLike,
  scope: TransactionScope,
  pending: Pending,
): boolean {
  if (pending.kind !== "pay" || !validPending(pending)) return false;
  const receipt: PaymentReceipt = {
    hash: pending.hash,
    invoiceId: pending.invoiceId,
    kind: "pay",
  };
  storage.setItem(
    paymentStorageKey(scope, pending.invoiceId),
    JSON.stringify(receipt),
  );
  return true;
}
export function readPaymentReceipt(
  storage: StorageLike,
  scope: TransactionScope,
  invoice: string,
): PaymentReceipt | null {
  const value = parse(storage.getItem(paymentStorageKey(scope, invoice)));
  if (
    !validPending(value) ||
    value.kind !== "pay" ||
    value.invoiceId.toLowerCase() !== invoice.toLowerCase()
  )
    return null;
  return { hash: value.hash, invoiceId: value.invoiceId, kind: "pay" };
}

export type PollTicket = { pending: Pending; revision: number };
export class PendingGate {
  private revision = 0;
  private inFlight = new Set<number>();
  current: Pending | null = null;
  remember(pending: Pending) {
    this.revision += 1;
    this.current = pending;
  }
  beginPoll(): PollTicket | null {
    if (!this.current || this.inFlight.has(this.revision)) return null;
    this.inFlight.add(this.revision);
    return { pending: this.current, revision: this.revision };
  }
  isCurrent(ticket: PollTicket) {
    return (
      this.unchangedSince(ticket) && samePending(this.current, ticket.pending)
    );
  }
  unchangedSince(ticket: PollTicket) {
    return this.revision === ticket.revision;
  }
  settle(ticket: PollTicket) {
    if (!this.isCurrent(ticket)) return false;
    this.current = null;
    return true;
  }
  finishPoll(ticket: PollTicket) {
    this.inFlight.delete(ticket.revision);
  }
}
