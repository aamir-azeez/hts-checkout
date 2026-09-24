// This script signs transactions ONLY when explicitly invoked by an operator.
// Keys are read from the process environment, never from disk, and never printed.
const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  id,
  formatUnits,
  solidityPacked,
} = require("ethers");
const settings = require("./testnet-settings.cjs");
const artifact = require("../artifacts/contracts/HTSCheckout.sol/HTSCheckout.json");
const TINYBAR_TO_WEIBAR = 10_000_000_000n;
const TOKEN_ABI = [
  "function balanceOf(address) view returns(uint256)",
  "function isAssociated() view returns(bool)",
  "function associate() returns(int64)",
];
const QUOTER_ABI = [
  "function quoteExactOutput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)",
];
const explorer = (hash) => `https://hashscan.io/testnet/transaction/${hash}`;
const toPublicTx = (receipt) => ({
  hash: receipt.hash,
  explorer: explorer(receipt.hash),
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  gasPriceWeibar: receipt.gasPrice.toString(),
  gasFeeWeibar: receipt.fee.toString(),
});
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
function walletFromEnvironment(name, provider) {
  const value = process.env[name];
  assert(
    value && /^(0x)?[0-9a-fA-F]{64}$/.test(value),
    `${name} must contain an ECDSA private key in the process environment.`,
  );
  try {
    return new Wallet(value.startsWith("0x") ? value : `0x${value}`, provider);
  } catch {
    throw new Error(`${name} is not a valid ECDSA private key.`);
  }
}
function evidencePath() {
  if (!process.env.CHECKOUT_PROOF_PATH) return null;
  assert(
    path.isAbsolute(process.env.CHECKOUT_PROOF_PATH),
    "CHECKOUT_PROOF_PATH must be an explicit absolute path outside this repository.",
  );
  const result = path.resolve(process.env.CHECKOUT_PROOF_PATH);
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const relative = path.relative(repositoryRoot, result);
  assert(
    relative !== "" &&
      (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    "Evidence must be written outside this repository.",
  );
  assert(
    !fs.existsSync(result),
    "CHECKOUT_PROOF_PATH already exists; choose a fresh evidence filename.",
  );
  assert(
    fs.existsSync(path.dirname(result)),
    "Create the external evidence directory before running this script.",
  );
  return result;
}
async function main() {
  assert(process.env.CHECKOUT_ADDRESS, "CHECKOUT_ADDRESS is required.");
  const checkoutAddress = getAddress(process.env.CHECKOUT_ADDRESS);
  const outputPath = evidencePath();
  const provider = new JsonRpcProvider(settings.rpcUrl, undefined, {
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  try {
    // Network and configuration verification precede every possible signature.
    assert(
      (await provider.getNetwork()).chainId === 296n,
      "Refusing to sign outside Hedera testnet (chain 296).",
    );
    const buyer = walletFromEnvironment("HEDERA_PRIVATE_KEY", provider);
    const merchant = process.env.HEDERA_MERCHANT_PRIVATE_KEY
      ? walletFromEnvironment("HEDERA_MERCHANT_PRIVATE_KEY", provider)
      : buyer;
    const checkout = new Contract(checkoutAddress, artifact.abi, provider);
    const [routerAddress, tokenAddress, whbarAddress, fee] = await Promise.all([
      checkout.router(),
      checkout.token(),
      checkout.whbar(),
      checkout.poolFee(),
    ]);
    assert(
      getAddress(routerAddress) === settings.router &&
        getAddress(tokenAddress) === settings.token &&
        getAddress(whbarAddress) === settings.whbar &&
        fee === BigInt(settings.poolFee),
      "Checkout configuration does not match canonical testnet contracts.",
    );
    const merchantToken = new Contract(settings.token, TOKEN_ABI, merchant);
    let associationReceipt = null;
    if (!(await merchantToken.isAssociated())) {
      const responseCode = await merchantToken.associate.staticCall();
      assert(
        responseCode === 22n,
        `Association simulation returned Hedera response ${responseCode}.`,
      );
      associationReceipt = await (
        await merchantToken.associate({ gasLimit: 1_000_000 })
      ).wait();
      assert(
        associationReceipt.status === 1 && (await merchantToken.isAssociated()),
        "Merchant SAUCE association failed.",
      );
    }
    const amountOut = 1_000_000n;
    const latest = await provider.getBlock("latest");
    const expiresAt = latest.timestamp + 3600;
    const invoiceId = id(
      `HTSCheckout testnet proof:${Date.now()}:${merchant.address}:${buyer.address}`,
    );
    const createReceipt = await (
      await checkout
        .connect(merchant)
        .createInvoice(invoiceId, merchant.address, amountOut, expiresAt)
    ).wait();
    assert(createReceipt.status === 1, "Invoice creation failed.");
    const reversePath = solidityPacked(
      ["address", "uint24", "address"],
      [settings.token, settings.poolFee, settings.whbar],
    );
    const quoter = new Contract(settings.quoter, QUOTER_ABI, provider);
    const [quotedInput] = await quoter.quoteExactOutput.staticCall(
      reversePath,
      amountOut,
    );
    const maxInputTinybar = (quotedInput * 10_100n + 9_999n) / 10_000n;
    const swapDeadline = Math.min(
      (await provider.getBlock("latest")).timestamp + 300,
      expiresAt,
    );
    const valueWeibar = maxInputTinybar * TINYBAR_TO_WEIBAR;
    const tokenBefore = await merchantToken.balanceOf(merchant.address);
    const nativeBefore = await provider.getBalance(buyer.address);
    // Simulation catches unit, association, expiry and slippage errors before signing.
    await checkout
      .connect(buyer)
      .payInvoice.staticCall(invoiceId, maxInputTinybar, swapDeadline, {
        value: valueWeibar,
      });
    const paymentReceipt = await (
      await checkout
        .connect(buyer)
        .payInvoice(invoiceId, maxInputTinybar, swapDeadline, {
          value: valueWeibar,
          gasLimit: 2_000_000,
        })
    ).wait();
    assert(paymentReceipt.status === 1, "Payment transaction failed.");
    const tokenAfter = await merchantToken.balanceOf(merchant.address);
    const nativeAfter = await provider.getBalance(buyer.address);
    const logs = paymentReceipt.logs
      .filter(
        (log) => log.address.toLowerCase() === checkoutAddress.toLowerCase(),
      )
      .flatMap((log) => {
        try {
          const parsed = checkout.interface.parseLog(log);
          return parsed ? [parsed] : [];
        } catch {
          return [];
        }
      });
    const paid = logs.find(
      (log) => log.name === "InvoicePaid" && log.args.invoiceId === invoiceId,
    );
    assert(paid, "No matching InvoicePaid event found.");
    const amountIn = paid.args.amountIn;
    const refundAmount = paid.args.refundAmount;
    const routerSurplus = logs
      .filter((log) => log.name === "RouterSurplusRefunded")
      .reduce((sum, log) => sum + log.args.amount, 0n);
    const refundCredit = await checkout.refundCredits(buyer.address);
    const invoice = await checkout.invoices(invoiceId);
    assert(
      tokenAfter - tokenBefore === amountOut,
      "Merchant's SAUCE balance delta does not equal the invoice amount.",
    );
    assert(
      invoice.paid &&
        invoice.payer.toLowerCase() === buyer.address.toLowerCase() &&
        invoice.amountIn === amountIn,
      "Stored invoice settlement does not match the event.",
    );
    assert(
      amountIn <= maxInputTinybar &&
        refundAmount === maxInputTinybar - amountIn,
      "Payment exceeded the buyer maximum or refund principal is inconsistent.",
    );
    assert(
      refundCredit === 0n,
      "EOA buyer unexpectedly has a deferred refund credit.",
    );
    let duplicateRejected = false;
    try {
      await checkout
        .connect(buyer)
        .payInvoice.staticCall(invoiceId, maxInputTinybar, swapDeadline, {
          value: valueWeibar,
        });
    } catch (error) {
      const name = error.revert?.name;
      let parsedName;
      if (typeof error.data === "string") {
        try {
          parsedName = checkout.interface.parseError(error.data)?.name;
        } catch {}
      }
      duplicateRejected =
        name === "InvoiceAlreadyPaid" || parsedName === "InvoiceAlreadyPaid";
    }
    assert(
      duplicateRejected,
      "Duplicate-payment simulation did not return InvoiceAlreadyPaid.",
    );
    const observedDebit = nativeBefore - nativeAfter;
    const expectedDebit =
      (amountIn - routerSurplus) * TINYBAR_TO_WEIBAR + paymentReceipt.fee;
    const feeResidual = observedDebit - expectedDebit;
    const evidence = {
      kind: "hts-checkout-testnet-settlement-proof-v1",
      observedAt: new Date().toISOString(),
      chainId: 296,
      participantMode:
        merchant.address === buyer.address
          ? "same operator acts as merchant and buyer"
          : "distinct merchant and buyer signers",
      checkout: checkoutAddress,
      router: settings.router,
      tokenId: settings.tokenId,
      merchant: merchant.address,
      buyer: buyer.address,
      invoiceId,
      association: associationReceipt
        ? toPublicTx(associationReceipt)
        : { alreadyAssociated: true },
      invoiceCreation: toPublicTx(createReceipt),
      payment: toPublicTx(paymentReceipt),
      amountOutSauceBaseUnits: amountOut.toString(),
      merchantTokenBalanceBefore: tokenBefore.toString(),
      merchantTokenBalanceAfter: tokenAfter.toString(),
      merchantNetTokenDelta: (tokenAfter - tokenBefore).toString(),
      quotedInputTinybar: quotedInput.toString(),
      maxInputTinybar: maxInputTinybar.toString(),
      transactionValueWeibar: valueWeibar.toString(),
      spentTinybar: amountIn.toString(),
      spentHbar: formatUnits(amountIn, 8),
      refundPrincipalTinybar: refundAmount.toString(),
      routerSurplusTinybar: routerSurplus.toString(),
      deferredRefundCreditTinybar: refundCredit.toString(),
      gasAndRefundReconciliation: {
        payerBalanceBeforeWeibar: nativeBefore.toString(),
        payerBalanceAfterWeibar: nativeAfter.toString(),
        observedDebitWeibar: observedDebit.toString(),
        expectedDebitWeibar: expectedDebit.toString(),
        residualWeibar: feeResidual.toString(),
        matches: feeResidual === 0n,
      },
      invoiceMarkedPaid: true,
      exactMerchantSettlementVerified: true,
      duplicatePaymentRejectedByReadOnlySimulation: duplicateRejected,
    };
    const serialized = JSON.stringify(evidence, null, 2);
    if (outputPath)
      fs.writeFileSync(outputPath, `${serialized}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    console.log(serialized);
    if (feeResidual !== 0n) {
      console.error(
        "Settlement succeeded, but the observed payer balance differs from receipt gas plus swap principal. Inspect public evidence before claiming full gas reconciliation.",
      );
      process.exitCode = 1;
    }
  } finally {
    provider.destroy();
  }
}
main().catch((error) => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
