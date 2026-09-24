const { getAddress, toBeHex } = require("ethers");
const address = (id) => getAddress(toBeHex(BigInt(id.split(".")[2]), 20));
module.exports = Object.freeze({
  chainId: 296,
  rpcUrl: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
  mirrorUrl: "https://testnet.mirrornode.hedera.com/api/v1",
  routerId: "0.0.1414040",
  router: address("0.0.1414040"),
  quoterId: "0.0.1390002",
  quoter: address("0.0.1390002"),
  factoryId: "0.0.1197038",
  factory: address("0.0.1197038"),
  tokenId: "0.0.1183558",
  token: address("0.0.1183558"),
  tokenDecimals: 6,
  whbarId: "0.0.15058",
  whbar: address("0.0.15058"),
  whbarContract: address("0.0.15057"),
  poolFee: 3000,
});
