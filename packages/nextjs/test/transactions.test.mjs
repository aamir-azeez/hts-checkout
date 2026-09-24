import test from "node:test";
import assert from "node:assert/strict";
import {
  PendingGate,
  paymentStorageKey,
  pendingStorageKey,
  readPaymentReceipt,
  readPending,
  removeMatchingPending,
  storePaymentReceipt,
  storePending,
} from "../lib/transactions.ts";

class MemoryStorage {
  entries = new Map();
  get length() {
    return this.entries.size;
  }
  key(index) {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key) {
    return this.entries.get(key) ?? null;
  }
  setItem(key, value) {
    this.entries.set(key, value);
  }
  removeItem(key) {
    this.entries.delete(key);
  }
}
const scope = { chainId: 296, checkout: "0x1234" };
const id = (digit) => "0x" + digit.repeat(64);
const a = { hash: id("1"), invoiceId: id("a"), kind: "pay", submittedAt: 100 };
const b = { hash: id("2"), invoiceId: id("b"), kind: "pay", submittedAt: 200 };

test("restoration prioritizes the requested invoice, regardless of insertion order or age", () => {
  const storage = new MemoryStorage();
  storePending(storage, scope, b);
  storePending(storage, scope, a);
  assert.deepEqual(readPending(storage, scope, a.invoiceId.toUpperCase()), a);
  assert.deepEqual(readPending(storage, scope), b);
});
test("restoration rejects corrupt records, mismatched keys, and other contract or chain scopes", () => {
  const storage = new MemoryStorage();
  storage.setItem(pendingStorageKey(scope, a.invoiceId), "{bad json");
  storage.setItem(pendingStorageKey(scope, b.invoiceId), JSON.stringify(a));
  storePending(storage, { ...scope, chainId: 31337 }, a);
  storePending(storage, { ...scope, checkout: "0x5678" }, b);
  assert.equal(readPending(storage, scope), null);
});
test("an older completion cannot remove a newer pending transaction for the same invoice", () => {
  const storage = new MemoryStorage();
  const replacement = { ...a, hash: id("3") };
  storePending(storage, scope, replacement);
  removeMatchingPending(storage, scope, a);
  assert.deepEqual(readPending(storage, scope, a.invoiceId), replacement);
  removeMatchingPending(storage, scope, replacement);
  assert.equal(readPending(storage, scope), null);
});
test("only payment transactions can become payment receipt evidence", () => {
  const storage = new MemoryStorage();
  assert.equal(
    storePaymentReceipt(storage, scope, { ...a, kind: "create" }),
    false,
  );
  assert.equal(
    storePaymentReceipt(storage, scope, {
      ...a,
      kind: "refund",
      invoiceId: "",
    }),
    false,
  );
  storage.setItem("hts-checkout:receipt:296:0x1234:" + a.invoiceId, id("9"));
  assert.equal(readPaymentReceipt(storage, scope, a.invoiceId), null);
  assert.equal(storePaymentReceipt(storage, scope, a), true);
  assert.equal(readPaymentReceipt(storage, scope, a.invoiceId).hash, a.hash);
  assert.equal(readPaymentReceipt(storage, scope, b.invoiceId), null);
  storage.setItem(
    paymentStorageKey(scope, b.invoiceId),
    JSON.stringify({ ...a, kind: "pay" }),
  );
  assert.equal(readPaymentReceipt(storage, scope, b.invoiceId), null);
});
test("receipt polling permits only one in-flight poll for each pending revision", () => {
  const gate = new PendingGate();
  gate.remember(a);
  const ticket = gate.beginPoll();
  assert.ok(ticket);
  assert.equal(gate.beginPoll(), null);
  gate.finishPoll(ticket);
  assert.ok(gate.beginPoll());
});
test("a stale poll cannot settle or unlock a later transaction", () => {
  const gate = new PendingGate();
  gate.remember(a);
  const oldTicket = gate.beginPoll();
  assert.equal(gate.settle(oldTicket), true);
  gate.remember(b);
  const newTicket = gate.beginPoll();
  assert.equal(gate.settle(oldTicket), false);
  assert.equal(gate.unchangedSince(oldTicket), false);
  gate.finishPoll(oldTicket);
  assert.deepEqual(gate.current, b);
  assert.equal(gate.beginPoll(), null);
  assert.equal(gate.settle(newTicket), true);
  assert.equal(gate.current, null);
});
test("a confirmed transaction can settle before optional follow-up reads", () => {
  const gate = new PendingGate();
  gate.remember(a);
  const ticket = gate.beginPoll();
  assert.equal(gate.settle(ticket), true);
  assert.equal(gate.current, null);
  assert.equal(gate.unchangedSince(ticket), true);
  gate.remember(b);
  assert.equal(gate.unchangedSince(ticket), false);
});
