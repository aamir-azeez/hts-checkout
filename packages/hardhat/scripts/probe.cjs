// Read-only contract simulations and public metadata. Never loads a signer.
const {
  Interface,
  JsonRpcProvider,
  getAddress,
  solidityPacked,
  parseUnits,
  formatUnits,
} = require("ethers");
const settings = require("./testnet-settings.cjs");
const quoter = new Interface([
  "function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const factory = new Interface([
  "function getPool(address,address,uint24) view returns(address)",
]);
const pool = new Interface([
  "function liquidity() view returns(uint128)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function fee() view returns(uint24)",
]);
const router = new Interface([
  "function factory() view returns(address)",
  "function WHBAR() view returns(address)",
  "function whbar() view returns(address)",
]);

async function request(path, body) {
  const response = await fetch(`${settings.mirrorUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`Mirror ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
async function call(to, iface, name, args = []) {
  const { result } = await request("/contracts/call", {
    block: "latest",
    to,
    data: iface.encodeFunctionData(name, args),
    gas: 15_000_000,
  });
  return iface.decodeFunctionResult(name, result);
}
async function main() {
  const provider = new JsonRpcProvider(settings.rpcUrl, undefined, {
    batchMaxCount: 1,
  });
  let chainId;
  try {
    chainId = (await provider.getNetwork()).chainId;
  } finally {
    provider.destroy();
  }
  if (chainId !== 296n) throw new Error("RPC is not Hedera testnet (296).");
  const [token, whbar, routerMetadata, factoryAddress, whbarAddress] =
    await Promise.all([
      request(`/tokens/${settings.tokenId}`),
      request(`/tokens/${settings.whbarId}`),
      request(`/contracts/${settings.routerId}`),
      call(settings.router, router, "factory"),
      call(settings.router, router, "whbar"),
    ]);
  if (
    token.deleted ||
    whbar.deleted ||
    routerMetadata.deleted ||
    Number(token.decimals) !== 6 ||
    Number(whbar.decimals) !== 8
  )
    throw new Error("Token/router metadata mismatch.");
  if (
    getAddress(factoryAddress[0]) !== settings.factory ||
    getAddress(whbarAddress[0]) !== settings.whbar
  )
    throw new Error("Router configuration mismatch.");
  const [poolAddress] = await call(settings.factory, factory, "getPool", [
    settings.whbar,
    settings.token,
    settings.poolFee,
  ]);
  if (poolAddress === "0x0000000000000000000000000000000000000000")
    throw new Error("No direct WHBAR/SAUCE pool at fee 3000.");
  const [[liquidity], [token0], [token1], [fee]] = await Promise.all(
    ["liquidity", "token0", "token1", "fee"].map((name) =>
      call(poolAddress, pool, name),
    ),
  );
  if (liquidity === 0n) throw new Error("Pool has zero active liquidity.");
  const path = solidityPacked(
    ["address", "uint24", "address"],
    [settings.token, settings.poolFee, settings.whbar],
  );
  const quotes = [];
  for (const amount of ["1", "100", "1000"]) {
    const [amountIn, , , gasEstimate] = await call(
      settings.quoter,
      quoter,
      "quoteExactOutput",
      [path, parseUnits(amount, settings.tokenDecimals)],
    );
    quotes.push({
      amountOutSauce: amount,
      amountInTinybar: amountIn.toString(),
      amountInHbar: formatUnits(amountIn, 8),
      quoterGasEstimate: gasEstimate.toString(),
    });
  }
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        chainId: Number(chainId),
        source: settings.mirrorUrl,
        router: settings.router,
        quoter: settings.quoter,
        token: {
          id: settings.tokenId,
          decimals: token.decimals,
          customFees: token.custom_fees,
        },
        pool: {
          address: poolAddress,
          token0,
          token1,
          fee: Number(fee),
          liquidity: liquidity.toString(),
        },
        reversePath: path,
        quotes,
        settlementVerified: false,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
