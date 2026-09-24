# Testnet settlement evidence

The signed verification script completed on 2026-09-24T00:30:09.239Z on Hedera testnet (chain ID 296). It created and paid a one-SAUCE invoice through the live SaucerSwap V2 router using distinct merchant and buyer accounts. The recorded deployment and payment are separate transactions.

Both testnet accounts were operated for this verification. The run verifies cross-account token association, invoice creation, exact token delivery, immediate principal refund and stored settlement state. It does not establish independently operated merchant/customer participants or browser-wallet signing.

## Public transactions

| Operation                  | Public transaction                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Checkout deployment        | [Deployment receipt](https://hashscan.io/testnet/transaction/0xf15e3dc22672fc893be4c6184dd595b3b081cad989aafb45cd4eacf71afeb1a1)  |
| Merchant SAUCE association | [Association receipt](https://hashscan.io/testnet/transaction/0x70ac1b4ad9d995abef899f4e5475d1b6832765dcb31b15cf71a6ec07a1dd1eda) |
| Invoice creation           | [Invoice receipt](https://hashscan.io/testnet/transaction/0xce9d9d67c9c77e71124f3ef8470d2d0345bc14c5a5491bf0537d0ac41af6ed65)     |
| Invoice payment            | [Payment receipt](https://hashscan.io/testnet/transaction/0xc660ca77f60a8d9e464f9b3a11d0b270b2dcd2db4dc0cd4dc2dc1e3843acb4a0)     |

- Checkout: [`0x9B180de74a3a0F81a3D6C8316447C6EF04474092`](https://hashscan.io/testnet/contract/0x9B180de74a3a0F81a3D6C8316447C6EF04474092).
- Merchant/recipient account: `0x9bF0FC4c7D117939c1d1276cA09c9266c8331235`.
- Buyer/payer account: `0x9CE0F78335CAB965Ad0EE9d386f28Ce5253d6a2c`.
- Invoice ID: `0xa5c5add27960fe2e329be5d22e8e832680a3440807b4dd60973663defc8a7472`.
- Output token: testnet SAUCE `0.0.1183558`; 6 decimals.
- Router: `0x0000000000000000000000000000000000159398`; WHBAR/SAUCE pool fee `3000` (0.3%).

The public [Mirror transaction response](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7314364-1790209801-032432221) and [contract actions](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xc660ca77f60a8d9e464f9b3a11d0b270b2dcd2db4dc0cd4dc2dc1e3843acb4a0/actions?limit=100) provide transaction and internal-transfer records for this payment.

## Recorded amounts

| Measurement                    | Exact recorded value        | Interpretation                                 |
| ------------------------------ | --------------------------- | ---------------------------------------------- |
| Invoice output                 | `1000000` SAUCE base units  | 1 SAUCE                                        |
| Recipient net token increase   | `1000000` SAUCE base units  | Exactly the invoice amount                     |
| Quoted input                   | `2155446` tinybar           | 0.02155446 HBAR                                |
| Maximum input                  | `2177001` tinybar           | 0.02177001 HBAR; quote plus 1%, rounded upward |
| JSON-RPC transaction value     | `21770010000000000` weibar  | Maximum tinybar input multiplied by `10^10`    |
| Swap principal spent           | `2155446` tinybar           | 0.02155446 HBAR                                |
| Principal returned immediately | `21555` tinybar             | 0.00021555 HBAR                                |
| Router surplus                 | `0` tinybar                 | No additional surplus in this payment          |
| Deferred refund credit         | `0` tinybar                 | Immediate refund succeeded                     |
| Payment receipt fee            | `280727320000000000` weibar | 0.28072732 HBAR; additional to swap principal  |

Tinybar has 8 decimal places per HBAR; the Ethereum-compatible JSON-RPC value has 18. Token units use the SAUCE token's separate 6-decimal scale.

## Verified checks and scope

- The signed payment receipt succeeded and emitted the matching `InvoicePaid` event.
- The recipient's net token increase equaled the invoice output exactly.
- The stored invoice was marked paid with the expected payer and input amount.
- Spent principal stayed within the maximum. Returned principal equaled maximum input minus spent input.
- The verifier reconciled swap principal, router surplus and the payment receipt fee with a zero-weibar residual.
- A later read-only payment simulation returned `InvoiceAlreadyPaid`. No second signed payment was sent.

The live run exercised one invoice and the immediate refund path. Rejected refunds, deferred-credit withdrawals, expiry, slippage rollback and adversarial callbacks are covered by local contract tests; this evidence does not claim those paths were exercised on testnet. The template remains testnet-only.

## Earlier same-account run

An earlier [same-account payment](https://hashscan.io/testnet/transaction/0x81943bf372e66f04cac771b17b59b5ed5da9475ffd4073baf6c7f35cf3d11877) completed on 2026-09-24T00:16:56.267Z. The same operator account acted as merchant and buyer, received 1 SAUCE, spent 2155441 tinybar and received 21555 tinybar of unused principal. That run established live DEX/HTS settlement for a same-account configuration. The main transaction table and amounts above describe the later separate-account run.

The [sanitized public evidence JSON](testnet-evidence.json) records both runs' transaction identifiers, units and scope. It omits account balances and private operational records. To reproduce the signed check against a configured deployment, follow [the testnet setup instructions](../README.md#testnet-deployment-and-payment-verification) and run `node packages/hardhat/scripts/live-e2e.cjs` with process-only testnet credentials.
