// Local mock fixture only. Never uses the canonical testnet deployment script.
const hre = require("hardhat");
async function main() {
  if (
    !["localhost", "hardhat"].includes(hre.network.name) ||
    (await hre.ethers.provider.getNetwork()).chainId !== 31337n
  ) {
    throw new Error("Local mock deployment is restricted to chain 31337.");
  }
  const [merchant] = await hre.ethers.getSigners();
  const token = await (
    await hre.ethers.getContractFactory("MockCheckoutToken")
  ).deploy();
  const whbar = await (
    await hre.ethers.getContractFactory("MockCheckoutToken")
  ).deploy();
  const router = await (
    await hre.ethers.getContractFactory("MockSaucerRouter")
  ).deploy(token);
  await (await router.configure(2_155_441n, 0n, false)).wait();
  const checkout = await (
    await hre.ethers.getContractFactory("HTSCheckout")
  ).deploy(router, token, whbar, 3000);
  await checkout.waitForDeployment();
  const latest = await hre.ethers.provider.getBlock("latest");
  const invoiceId = hre.ethers.id("HTSCheckout local demonstration: 1 SAUCE");
  const expiresAt = latest.timestamp + 86400;
  await (
    await checkout.createInvoice(
      invoiceId,
      merchant.address,
      1_000_000n,
      expiresAt,
    )
  ).wait();
  console.log(
    JSON.stringify(
      {
        mode: "local-mock",
        chainId: 31337,
        checkout: await checkout.getAddress(),
        router: await router.getAddress(),
        token: await token.getAddress(),
        whbar: await whbar.getAddress(),
        merchant: merchant.address,
        invoiceId,
        amountOut: "1000000",
        expiresAt,
        quoteInputTinybar: "2155441",
        nativeValueRule:
          "On local chain 31337 only, send raw maximum tinybar integers as EVM wei; no 10^10 conversion.",
        realLiquidity: false,
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
