# Developer guide

HTS Checkout is a Scaffold-HBAR template for exact-output SAUCE invoices funded with test HBAR through SaucerSwap V2. The supported deployment target is Hedera testnet (chain ID 296). Chain ID 31337 is reserved for explicit local mock demonstrations.

## Layout and commands

- `packages/hardhat/`: Solidity contracts, isolated tests, network configuration and deployment/probe scripts.
- `packages/nextjs/`: Next.js App Router frontend and injected EVM wallet integration.
- `scripts/validate-template.cjs`: source-template shape and public-source credential checks.
- `docs/architecture.md`: transaction flow, amount units, configuration and verification boundaries.
- `template.json`: external Scaffold-HBAR manifest. The scaffolder consumes and removes this file from generated projects.

Use Node.js 22.13.0 or newer; development currently uses Node.js 24.16.0. `npm` 11.18.0 or newer is required for workspace dependency overrides. Install with the pinned command `npx --yes npm@11.20.0 ci --ignore-scripts`. Run `npm run validate:template`, `npm run lint`, `npm run test` and `npm run build` from the repository root. In a generated project, use `npm run validate:template -- --scaffolded`. The packaging validator does not replace lint, unit tests, a production build or a live network check.

Use `npm run dev` for the frontend, `npm run chain` for a local Hardhat node, `npm run testnet:probe` for read-only network prerequisites, and `npm run deploy` for an explicitly configured testnet deployment. Keep workspace names and root command forwarding consistent.

## Financial and network invariants

- Keep the default chain and all production-facing examples on testnet. Do not silently switch to mainnet or turn a local mock into claimed testnet evidence.
- An invoice specifies an exact output amount in SAUCE base units (6 decimal places). Keep amounts as integers/`bigint`; do not use floating-point arithmetic.
- Hedera EVM contract balances and payable amounts use tinybar, with 8 decimals per HBAR. Ethereum-compatible JSON-RPC transaction `value` uses 18 decimals; convert a tinybar budget by multiplying by `10^10` at the transaction boundary. Do not apply that factor twice.
- Reverse the V2 exact-output path: output token, fee, wrapped input token. Read configured addresses from the deployed checkout when quoting.
- Associate the recipient account with the output HTS token before payment. A quote alone does not prove that the recipient can receive tokens.
- Preserve the caller's maximum input, invoice expiry, swap deadline, unique invoice ID and one-payment-only checks. Update paid state atomically with successful settlement.
- Keep refunds isolated per payer. Failed immediate refunds become withdrawable credits; withdrawal failure must preserve the credit. Never let one payer consume another payer's credit.
- Treat a submitted transaction with an unknown receipt as pending. Recheck its hash before offering a second payment. Recheck wallet account and chain before signing.

## Implementation and validation

Use small typed functions, explicit errors and accessible UI controls. Keep frontend `NEXT_PUBLIC_*` variables limited to public network configuration. Never put signing keys, seed phrases, account passwords or API credentials in source files, frontend bundles, screenshots or committed environment files. Do not log credential values.

Update contract and frontend ABIs together. Add meaningful tests when changing payment state, input limits, expiry, refunds or failure behavior. Local mocks validate application behavior without exercising Hedera's HTS service or a real SaucerSwap pool. A local pass must not be described as a successful live swap.

Record live deployment or settlement claims only after obtaining successful transaction receipts and verifiable HashScan or mirror-node evidence. Distinguish a deployment proof from an end-to-end invoice payment. See `docs/architecture.md` for the remaining network prerequisites.

Preserve original source attribution and the MIT license. Keep public documentation focused on reproducible developer setup and actual behavior.
