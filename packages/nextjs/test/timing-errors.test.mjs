import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { contractErrorName } from "../lib/errors.ts";
import {
  invoiceExpiry,
  paymentDeadline,
  transactionTimestamp,
} from "../lib/timing.ts";

test("an idle local block cannot produce an already-expired payment deadline", () => {
  const latest = 1_790_202_132;
  const now = 1_790_209_326;
  const expires = 1_790_287_995;
  assert.ok(latest + 120 < now);
  assert.equal(paymentDeadline(latest, expires, now * 1000), now + 120);
});
test("a new invoice receives its full lifetime after an idle local chain", () => {
  const latest = 1_790_202_132;
  const now = latest + 7200;
  assert.ok(latest + 3600 < now);
  assert.equal(invoiceExpiry(latest, 3600, now * 1000), now + 3600);
});
test("a future chain timestamp takes precedence over a behind client clock", () => {
  assert.equal(transactionTimestamp(2000, 1000 * 1000), 2000);
  assert.equal(paymentDeadline(2000, 3000, 1000 * 1000), 2120);
});
test("payment deadlines never exceed the invoice expiry", () => {
  assert.equal(paymentDeadline(2000, 2050, 2010 * 1000), 2050);
  assert.throws(() => paymentDeadline(1000, 2000, 2000 * 1000), /expired/);
  assert.throws(() => paymentDeadline(3000, 2000, 1000 * 1000), /expired/);
});
test("invalid clock and lifetime inputs fail closed", () => {
  assert.throws(() => transactionTimestamp(NaN, 1000));
  assert.throws(() => transactionTimestamp(1000, Infinity));
  assert.throws(() => invoiceExpiry(1000, 0, 1000));
  assert.throws(() => invoiceExpiry(1000, 365 * 86400 + 1, 1000));
});
const abi = ["error InvalidSwapDeadline()", "error NoRefundCredit()"];
const encoded = new Interface(abi).encodeErrorResult("InvalidSwapDeadline");
test("estimateGas errors decode their selector even when ethers revert is null", () => {
  assert.equal(encoded, "0x7a58c192");
  assert.equal(
    contractErrorName(
      { code: "CALL_EXCEPTION", data: encoded, revert: null },
      abi,
    ),
    "InvalidSwapDeadline",
  );
});
test("nested provider revert payloads and already-decoded errors are recognized", () => {
  assert.equal(
    contractErrorName(
      { info: { error: { data: { message: "reverted", data: encoded } } } },
      abi,
    ),
    "InvalidSwapDeadline",
  );
  assert.equal(
    contractErrorName({ revert: { name: "NoRefundCredit" } }, abi),
    "NoRefundCredit",
  );
});
test("malformed or unknown revert payloads preserve fallback handling", () => {
  for (const error of [
    null,
    "failed",
    { data: "not hex" },
    { data: "0xffffffff" },
    { data: {} },
  ]) {
    assert.equal(contractErrorName(error, abi), undefined);
  }
});
