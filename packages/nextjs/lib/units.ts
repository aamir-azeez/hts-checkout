export function tinybarToWeibar(value: bigint): bigint {
  if (value < 0n) throw new RangeError("Negative native amount");
  return value * 10n ** 10n;
}

export function transactionValue(tinybars: bigint, chainId: number): bigint {
  if (tinybars < 0n) throw new RangeError("Negative native amount");
  if (chainId === 296) return tinybarToWeibar(tinybars);
  // The local EVM has no Hedera JSON-RPC relay conversion.
  if (chainId === 31337) return tinybars;
  throw new RangeError("Unsupported payment chain");
}

export function withSlippage(value: bigint, basisPoints = 50): bigint {
  if (
    value < 0n ||
    !Number.isSafeInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000
  ) {
    throw new RangeError("Invalid slippage input");
  }
  return value + (value * BigInt(basisPoints) + 9999n) / 10000n;
}

export function isLoopbackRpc(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
