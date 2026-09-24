import test from "node:test";
import assert from "node:assert/strict";
import {
  isLoopbackRpc,
  tinybarToWeibar,
  transactionValue,
  withSlippage,
} from "../lib/units.ts";

test("one HBAR in tinybars is one HBAR in external JSON-RPC weibars", () => {
  assert.equal(tinybarToWeibar(100_000_000n), 1_000_000_000_000_000_000n);
  assert.equal(tinybarToWeibar(1n), 10_000_000_000n);
});
test("Hedera payment value preserves exact tinybar precision", () => {
  assert.equal(transactionValue(2_155_441n, 296), 21_554_410_000_000_000n);
});
test("local mocks receive raw native units without Hedera relay conversion", () => {
  assert.equal(transactionValue(2_155_441n, 31337), 2_155_441n);
});
test("mainnet and other networks never produce an allowed transaction value", () => {
  for (const chain of [1, 295, 297, 0, NaN])
    assert.throws(() => transactionValue(1n, chain));
});
test("slippage rounds upward at the smallest tinybar unit", () => {
  assert.equal(withSlippage(1n), 2n);
  assert.equal(withSlippage(2_155_441n), 2_166_219n);
  assert.equal(withSlippage(100_000_000n), 100_500_000n);
  assert.equal(withSlippage(7n, 0), 7n);
});
test("large values retain precision without floating point", () => {
  const value = 9_223_372_036_854_775_000n;
  assert.equal(tinybarToWeibar(value), 92_233_720_368_547_750_000_000_000_000n);
  assert.equal(withSlippage(value), value + (value * 50n + 9999n) / 10000n);
});
test("invalid signed amounts and slippage inputs are rejected", () => {
  assert.throws(() => tinybarToWeibar(-1n));
  assert.throws(() => transactionValue(-1n, 31337));
  assert.throws(() => withSlippage(-1n));
  for (const bps of [-1, 0.5, NaN, Infinity, 10001])
    assert.throws(() => withSlippage(1n, bps));
});

test("unlocked demo accounts are limited to explicit loopback RPC hosts", () => {
  for (const url of [
    "http://localhost:8545",
    "http://127.0.0.1:8545",
    "https://localhost:8545/",
  ])
    assert.equal(isLoopbackRpc(url), true);
  for (const url of [
    "https://testnet.hashio.io/api",
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
    "file://localhost",
    "http://user:pass@localhost",
    "not a URL",
  ])
    assert.equal(isLoopbackRpc(url), false);
});
