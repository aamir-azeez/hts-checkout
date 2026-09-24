const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// The local EVM treats native units as wei, while Hedera Solidity treats them
// as tinybars. Small integer values deliberately model the Solidity side only.
describe("HTSCheckout", function () {
  let merchant, buyer, other, token, router, checkout, receiver, whbar, expiry;
  const id = (name) => ethers.id(name);
  beforeEach(async function () {
    [merchant, buyer, other] = await ethers.getSigners();
    token = await (
      await ethers.getContractFactory("MockCheckoutToken")
    ).deploy();
    router = await (
      await ethers.getContractFactory("MockSaucerRouter")
    ).deploy(token);
    whbar = other.address;
    checkout = await (
      await ethers.getContractFactory("HTSCheckout")
    ).deploy(router, token, whbar, 3000);
    receiver = await (
      await ethers.getContractFactory("RefundReceiver")
    ).deploy(checkout);
    expiry = (await ethers.provider.getBlock("latest")).timestamp + 3600;
  });
  const create = async (
    name = "invoice",
    amount = 500n,
    recipient = merchant.address,
  ) => {
    await checkout.createInvoice(id(name), recipient, amount, expiry);
    return id(name);
  };
  const assertUnpaid = async (invoiceId) => {
    const invoice = await checkout.invoices(invoiceId);
    expect(invoice.paid).to.equal(false);
    expect(invoice.payer).to.equal(ethers.ZeroAddress);
    expect(invoice.amountIn).to.equal(0n);
  };

  it("stores invoice terms and protects the ID against another creator", async function () {
    await expect(
      checkout.createInvoice(id("invoice"), other.address, 500n, expiry),
    )
      .to.emit(checkout, "InvoiceCreated")
      .withArgs(id("invoice"), merchant.address, other.address, 500n, expiry);
    const invoice = await checkout.invoices(id("invoice"));
    expect(invoice.merchant).to.equal(merchant.address);
    expect(invoice.recipient).to.equal(other.address);
    await expect(
      checkout
        .connect(buyer)
        .createInvoice(id("invoice"), buyer.address, 1n, expiry),
    ).to.be.revertedWithCustomError(checkout, "InvoiceAlreadyExists");
    expect((await checkout.invoices(id("invoice"))).recipient).to.equal(
      other.address,
    );
  });

  it("rejects invalid identifiers, recipients, amounts and unbounded expiries", async function () {
    await expect(
      checkout.createInvoice(ethers.ZeroHash, merchant.address, 1, expiry),
    ).to.be.revertedWithCustomError(checkout, "InvalidInvoiceId");
    await expect(
      checkout.createInvoice(
        id("zero-recipient"),
        ethers.ZeroAddress,
        1,
        expiry,
      ),
    ).to.be.revertedWithCustomError(checkout, "InvalidRecipient");
    await expect(
      checkout.createInvoice(id("self-recipient"), checkout, 1, expiry),
    ).to.be.revertedWithCustomError(checkout, "InvalidRecipient");
    await expect(
      checkout.createInvoice(id("zero-amount"), merchant.address, 0, expiry),
    ).to.be.revertedWithCustomError(checkout, "InvalidAmount");
    await expect(
      checkout.createInvoice(
        id("large-amount"),
        merchant.address,
        2n ** 63n,
        expiry,
      ),
    ).to.be.revertedWithCustomError(checkout, "InvalidAmount");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(
      checkout.createInvoice(id("past-expiry"), merchant.address, 1, now),
    ).to.be.revertedWithCustomError(checkout, "InvalidExpiry");
    await expect(
      checkout.createInvoice(
        id("long-expiry"),
        merchant.address,
        1,
        now + 366 * 86400,
      ),
    ).to.be.revertedWithCustomError(checkout, "InvalidExpiry");
  });

  it("pays exact token units, spends only required native principal, and reverses the route", async function () {
    const invoiceId = await create();
    await token.mint(merchant.address, 17n);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.changeEtherBalance(buyer, -60n);
    const invoice = await checkout.invoices(invoiceId);
    expect(invoice.paid).to.equal(true);
    expect(invoice.payer).to.equal(buyer.address);
    expect(invoice.amountIn).to.equal(60n);
    expect(await token.balanceOf(merchant.address)).to.equal(517n);
    expect(await router.lastPath()).to.equal(
      ethers.solidityPacked(
        ["address", "uint24", "address"],
        [await token.getAddress(), 3000, whbar],
      ),
    );
    expect(await ethers.provider.getBalance(checkout)).to.equal(0n);
    expect(await ethers.provider.getBalance(router)).to.equal(0n);
  });

  it("emits principal-only refund accounting", async function () {
    const invoiceId = await create();
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    )
      .to.emit(checkout, "InvoicePaid")
      .withArgs(invoiceId, buyer.address, merchant.address, 500n, 60n, 40n);
  });

  it("does not refund when the full maximum is required", async function () {
    const invoiceId = await create();
    await router.configure(100n, 0n, false);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.changeEtherBalance(buyer, -100n);
    expect(await checkout.refundCredits(buyer.address)).to.equal(0n);
  });

  it("rejects missing invoices, double payments, and mismatched native units", async function () {
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(id("unknown"), 100n, expiry, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "InvoiceNotFound");
    const invoiceId = await create();
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 99n }),
    ).to.be.revertedWithCustomError(checkout, "IncorrectValue");
    // Multiplying inside Solidity would be a 10^10 error; the adapter rejects it.
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n * 10n ** 10n }),
    ).to.be.revertedWithCustomError(checkout, "IncorrectValue");
    await assertUnpaid(invoiceId);
    await checkout
      .connect(buyer)
      .payInvoice(invoiceId, 100n, expiry, { value: 100n });
    await expect(
      checkout
        .connect(other)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "InvoiceAlreadyPaid");
    expect(await token.balanceOf(merchant.address)).to.equal(500n);
  });

  it("rejects stale or overlong swap deadlines and expired invoices", async function () {
    const invoiceId = await create();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, now - 1, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "InvalidSwapDeadline");
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry + 1, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "InvalidSwapDeadline");
    await network.provider.send("evm_setNextBlockTimestamp", [expiry + 1]);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "InvoiceExpired");
    await assertUnpaid(invoiceId);
  });

  it("slippage failure restores invoice, balances and payer state", async function () {
    const invoiceId = await create();
    await router.configure(101n, 0n, false);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.be.revertedWith("Too much requested");
    await assertUnpaid(invoiceId);
    expect(await token.balanceOf(merchant.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(0n);
    expect(await ethers.provider.getBalance(router)).to.equal(0n);
  });

  it("rejects nominal output when the recipient's net token delta is short", async function () {
    const invoiceId = await create();
    await token.mint(merchant.address, 700n);
    await router.configure(60n, 1n, false);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "IncorrectSettlement");
    await assertUnpaid(invoiceId);
    expect(await token.balanceOf(merchant.address)).to.equal(700n);
    expect(await ethers.provider.getBalance(router)).to.equal(0n);
  });

  it("does not subsidize a missing router refund with preexisting native funds", async function () {
    const invoiceId = await create();
    await (
      await ethers.getContractFactory("ForceNative")
    ).deploy(checkout, { value: 100n });
    await router.configure(60n, 0n, true);
    await expect(
      checkout
        .connect(buyer)
        .payInvoice(invoiceId, 100n, expiry, { value: 100n }),
    ).to.be.revertedWithCustomError(checkout, "MissingRouterRefund");
    await assertUnpaid(invoiceId);
    expect(await token.balanceOf(merchant.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(100n);
  });

  it("records rejected refunds as credit and only lets that payer withdraw", async function () {
    const invoiceId = await create();
    await expect(receiver.pay(invoiceId, 100n, expiry, { value: 100n }))
      .to.emit(checkout, "RefundCredited")
      .withArgs(await receiver.getAddress(), 40n);
    expect((await checkout.invoices(invoiceId)).paid).to.equal(true);
    expect(await checkout.refundCredits(receiver)).to.equal(40n);
    await expect(
      checkout.connect(buyer).withdrawRefund(),
    ).to.be.revertedWithCustomError(checkout, "NoRefundCredit");
    await expect(receiver.withdraw()).to.be.revertedWithCustomError(
      checkout,
      "RefundWithdrawalFailed",
    );
    expect(await checkout.refundCredits(receiver)).to.equal(40n);
    await receiver.setBehavior(false, false);
    await expect(receiver.withdraw()).to.changeEtherBalance(receiver, 40n);
    expect(await checkout.refundCredits(receiver)).to.equal(0n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(0n);
  });

  it("preserves older refund credits and forced donations while returning current router dust", async function () {
    const first = await create("first");
    await receiver.pay(first, 100n, expiry, { value: 100n });
    await (
      await ethers.getContractFactory("ForceNative")
    ).deploy(checkout, { value: 7n });
    await merchant.sendTransaction({ to: router, value: 11n });
    const second = await create("second");
    const payment = await checkout
      .connect(buyer)
      .payInvoice(second, 100n, expiry, { value: 100n });
    await expect(payment)
      .to.emit(checkout, "RouterSurplusRefunded")
      .withArgs(buyer.address, 11n);
    await expect(payment).to.changeEtherBalance(buyer, -49n);
    expect(await checkout.refundCredits(receiver)).to.equal(40n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(47n);
    await receiver.setBehavior(false, false);
    await receiver.withdraw();
    expect(await ethers.provider.getBalance(checkout)).to.equal(7n);
  });

  it("accumulates rejecting payer credit including separately accounted router surplus", async function () {
    await receiver.pay(await create("first"), 100n, expiry, { value: 100n });
    await merchant.sendTransaction({ to: router, value: 11n });
    await receiver.pay(await create("second"), 100n, expiry, { value: 100n });
    expect(await checkout.refundCredits(receiver)).to.equal(91n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(91n);
  });

  it("blocks reentrant refund withdrawals from both payout and credit callbacks", async function () {
    await receiver.setBehavior(false, true);
    await receiver.pay(await create("first"), 100n, expiry, { value: 100n });
    expect(await receiver.reentrySucceeded()).to.equal(false);
    expect(await checkout.refundCredits(receiver)).to.equal(0n);
    await receiver.setBehavior(true, false);
    await receiver.pay(await create("second"), 100n, expiry, { value: 100n });
    await receiver.setBehavior(false, true);
    await receiver.withdraw();
    expect(await receiver.reentrySucceeded()).to.equal(false);
    expect(await checkout.refundCredits(receiver)).to.equal(0n);
    expect(await ethers.provider.getBalance(checkout)).to.equal(0n);
  });

  it("rejects unsolicited native transfers through receive", async function () {
    await expect(
      merchant.sendTransaction({ to: checkout, value: 1n }),
    ).to.be.revertedWithCustomError(checkout, "UnauthorizedNativeSender");
  });
});
