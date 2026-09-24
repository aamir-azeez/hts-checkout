const hre = require("hardhat");
const settings = require("./testnet-settings.cjs");

async function main() {
  if (hre.network.name !== "hederaTestnet")
    throw new Error("Deploy script is restricted to Hedera testnet.");
  if (!process.env.HEDERA_PRIVATE_KEY)
    throw new Error(
      "Set HEDERA_PRIVATE_KEY in the process environment; no secrets file is read.",
    );
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 296n)
    throw new Error("Refusing deployment outside Hedera testnet (chain 296).");
  const [signer] = await hre.ethers.getSigners();
  const router = new hre.ethers.Contract(
    settings.router,
    [
      "function factory() view returns(address)",
      "function whbar() view returns(address)",
    ],
    signer,
  );
  if (
    (await router.factory()).toLowerCase() !== settings.factory.toLowerCase() ||
    (await router.whbar()).toLowerCase() !== settings.whbar.toLowerCase()
  ) {
    throw new Error(
      "Canonical router configuration does not match expected testnet contracts.",
    );
  }
  const factory = await hre.ethers.getContractFactory("HTSCheckout", signer);
  const checkout = await factory.deploy(
    settings.router,
    settings.token,
    settings.whbar,
    settings.poolFee,
  );
  await checkout.waitForDeployment();
  const receipt = await checkout.deploymentTransaction().wait();
  console.log(
    JSON.stringify(
      {
        chainId: 296,
        address: await checkout.getAddress(),
        transactionHash: receipt.hash,
        deployer: signer.address,
        router: settings.router,
        token: settings.token,
        whbar: settings.whbar,
        poolFee: settings.poolFee,
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
