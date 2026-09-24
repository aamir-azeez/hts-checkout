import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  formatUnits,
  getAddress,
  isHexString,
  parseUnits,
  solidityPacked,
  type Eip1193Provider,
} from "ethers";
import { copy } from "./copy";
import { contractErrorName } from "./errors";
import { isLoopbackRpc, withSlippage } from "./units";
export { tinybarToWeibar, transactionValue, withSlippage } from "./units";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "296");
export const IS_LOCAL = CHAIN_ID === 31337;
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ||
  (IS_LOCAL ? "http://127.0.0.1:8545" : "https://testnet.hashio.io/api");
export const LOCAL_WALLET_ENABLED = IS_LOCAL && isLoopbackRpc(RPC_URL);
export const NATIVE_SYMBOL = IS_LOCAL ? "demo HBAR" : "HBAR";
export const TOKEN_SYMBOL = IS_LOCAL ? "demo SAUCE" : "SAUCE";
export const CHECKOUT_ADDRESS = process.env.NEXT_PUBLIC_CHECKOUT_ADDRESS || "";
export const QUOTER_ADDRESS =
  process.env.NEXT_PUBLIC_QUOTER_ADDRESS ||
  (IS_LOCAL ? "" : "0x00000000000000000000000000000000001535b2");
export const NETWORK_LABEL = IS_LOCAL ? copy.networkLocal : copy.networkTest;
export const ALLOWED_CHAIN = CHAIN_ID === 296 || IS_LOCAL;
export const ABI = [
  "error ReentrantCall()",
  "error InvalidConfiguration()",
  "error InvalidInvoiceId()",
  "error InvoiceAlreadyExists()",
  "error InvoiceNotFound()",
  "error InvoiceAlreadyPaid()",
  "error InvalidRecipient()",
  "error InvalidAmount()",
  "error InvalidExpiry()",
  "error InvoiceExpired()",
  "error InvalidSwapDeadline()",
  "error IncorrectValue()",
  "error ExcessiveInput()",
  "error IncorrectSettlement()",
  "error MissingRouterRefund()",
  "error UnauthorizedNativeSender()",
  "error NoRefundCredit()",
  "error RefundWithdrawalFailed()",
  "function createInvoice(bytes32 invoiceId,address recipient,uint256 amountOut,uint64 expiresAt)",
  "function invoices(bytes32) view returns(address merchant,address recipient,uint256 amountOut,uint64 expiresAt,bool paid,address payer,uint256 amountIn)",
  "function payInvoice(bytes32 invoiceId,uint256 maxInputTinybar,uint256 swapDeadline) payable",
  "function refundCredits(address) view returns(uint256)",
  "function withdrawRefund()",
  "function token() view returns(address)",
  "function router() view returns(address)",
  "function whbar() view returns(address)",
  "function poolFee() view returns(uint24)",
];
const QUOTER_ABI = [
  "function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
];
export type Configuration = {
  token: string;
  router: string;
  whbar: string;
  poolFee: number;
};
export type Invoice = {
  id: string;
  merchant: string;
  recipient: string;
  amountOut: bigint;
  expiresAt: number;
  paid: boolean;
  payer: string;
  amountIn: bigint;
};
export type Wallet = {
  address: string;
  chainId: number;
  provider: BrowserProvider | JsonRpcProvider;
};
export type Quote = {
  amountIn: bigint;
  maximum: bigint;
  createdAt: number;
  invoiceId: string;
};
export type InjectedWindow = Window & {
  ethereum?: Eip1193Provider & {
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (
      event: string,
      listener: (...args: unknown[]) => void,
    ) => void;
  };
};

export function readProvider() {
  if (!ALLOWED_CHAIN) throw new Error(copy.unsupportedChain);
  return new JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
}
export function checkout(provider: JsonRpcProvider | BrowserProvider) {
  return new Contract(getAddress(CHECKOUT_ADDRESS), ABI, provider);
}
export function parseSauce(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim()))
    throw new Error(copy.invalidAmount);
  const amount = parseUnits(value.trim(), 6);
  if (amount <= 0n || amount > 9223372036854775807n)
    throw new Error(copy.invalidAmount);
  return amount;
}
export function recipientAddress(value: string): string {
  try {
    const result = getAddress(value.trim());
    if (result === ZeroAddress) throw new Error();
    return result;
  } catch {
    throw new Error(copy.invalidAddress);
  }
}
export function invoiceId(value: string): string {
  let candidate = value.trim();
  try {
    const url = new URL(candidate);
    candidate = url.searchParams.get("invoice") || "";
  } catch {
    /* An ID can be provided directly. */
  }
  if (!isHexString(candidate, 32)) throw new Error(copy.invalidInvoice);
  return candidate.toLowerCase();
}

export function sauce(value: bigint) {
  return formatUnits(value, 6);
}
export function hbar(value: bigint) {
  return formatUnits(value, 8);
}
export function short(value: string) {
  return value.length > 14 ? value.slice(0, 8) + "…" + value.slice(-6) : value;
}
export function explorer(
  type: "transaction" | "contract" | "account",
  value: string,
) {
  return IS_LOCAL ? null : "https://hashscan.io/testnet/" + type + "/" + value;
}

export async function getConfiguration(
  provider: JsonRpcProvider,
): Promise<Configuration> {
  if (!ALLOWED_CHAIN) throw new Error(copy.unsupportedChain);
  if (!CHECKOUT_ADDRESS) throw new Error(copy.unconfiguredBody);
  try {
    getAddress(CHECKOUT_ADDRESS);
    if (QUOTER_ADDRESS) getAddress(QUOTER_ADDRESS);
  } catch {
    throw new Error(copy.invalidConfiguration);
  }
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID)
    throw new Error(copy.configurationMismatch);
  if ((await provider.getCode(CHECKOUT_ADDRESS)) === "0x")
    throw new Error(copy.contractMismatch);
  const contract = checkout(provider);
  const [token, router, whbar, poolFee] = await Promise.all([
    contract.token(),
    contract.router(),
    contract.whbar(),
    contract.poolFee(),
  ]);
  return {
    token: String(token),
    router: String(router),
    whbar: String(whbar),
    poolFee: Number(poolFee),
  };
}
export async function getInvoice(
  provider: JsonRpcProvider,
  id: string,
): Promise<Invoice> {
  const result = await checkout(provider).invoices(id);
  if (result.merchant === ZeroAddress) throw new Error(copy.notFound);
  return {
    id,
    merchant: result.merchant,
    recipient: result.recipient,
    amountOut: BigInt(result.amountOut),
    expiresAt: Number(result.expiresAt),
    paid: Boolean(result.paid),
    payer: result.payer,
    amountIn: BigInt(result.amountIn),
  };
}
export async function getQuote(
  provider: JsonRpcProvider,
  config: Configuration,
  invoice: Invoice,
): Promise<Quote> {
  if (IS_LOCAL) {
    if (!LOCAL_WALLET_ENABLED) throw new Error(copy.localRpcRequired);
    const mockRouter = new Contract(
      config.router,
      ["function cost() view returns(uint256)"],
      provider,
    );
    const amountIn = BigInt(await mockRouter.cost());
    if (amountIn <= 0n) throw new Error(copy.noQuote);
    return {
      amountIn,
      maximum: withSlippage(amountIn),
      createdAt: Date.now(),
      invoiceId: invoice.id,
    };
  }
  if (!QUOTER_ADDRESS) throw new Error(copy.unconfiguredBody);
  const quoter = new Contract(getAddress(QUOTER_ADDRESS), QUOTER_ABI, provider);
  const path = solidityPacked(
    ["address", "uint24", "address"],
    [config.token, config.poolFee, config.whbar],
  );
  const result = await quoter.quoteExactOutput.staticCall(
    path,
    invoice.amountOut,
  );
  const amountIn = BigInt(result.amountIn);
  if (amountIn <= 0n) throw new Error(copy.noQuote);
  return {
    amountIn,
    maximum: withSlippage(amountIn),
    createdAt: Date.now(),
    invoiceId: invoice.id,
  };
}
export async function walletSigner(wallet: Wallet) {
  const network = await wallet.provider.getNetwork();
  if (!ALLOWED_CHAIN || Number(network.chainId) !== CHAIN_ID)
    throw new Error(copy.wrongNetwork);
  const signer = await wallet.provider.getSigner();
  if (
    (await signer.getAddress()).toLowerCase() !== wallet.address.toLowerCase()
  )
    throw new Error(copy.walletChanged);
  return signer;
}
export function errorMessage(error: unknown) {
  if (typeof error === "object" && error) {
    const e = error as {
      code?: string | number;
      shortMessage?: string;
      reason?: string;
      message?: string;
      revert?: { name?: string };
    };
    if (e.code === "ACTION_REJECTED" || e.code === 4001) return copy.rejected;
    if (e.code === "INSUFFICIENT_FUNDS") return copy.insufficient;
    const known: Record<string, string> = {
      InvoiceExpired: copy.expiredBody,
      InvoiceAlreadyPaid: "Invoice already paid.",
      InvoiceNotFound: copy.notFound,
      InvalidRecipient: copy.invalidAddress,
      InvalidAmount: copy.invalidAmount,
      InvalidExpiry: "Invalid invoice expiry.",
      InvalidSwapDeadline: copy.quoteStale,
      IncorrectValue: "Payment value mismatch.",
      ExcessiveInput: "Maximum input exceeded.",
      IncorrectSettlement: "Token settlement failed.",
      MissingRouterRefund: "Router refund missing.",
      NoRefundCredit: copy.refundEmpty,
      RefundWithdrawalFailed: "Refund withdrawal failed.",
      InvoiceAlreadyExists: "Invoice ID already exists.",
      InvalidInvoiceId: copy.invalidInvoice,
      InvalidConfiguration: copy.invalidConfiguration,
    };
    const contractError = contractErrorName(error, ABI);
    if (contractError && known[contractError]) return known[contractError];
    const detail = e.reason || e.shortMessage || e.message || copy.unexpected;
    const concise = detail
      .split(/\r?\n/)[0]
      .replace(/0x[0-9a-f]{24,}/gi, "0x…");
    return concise.length > 200 ? concise.slice(0, 197) + "…" : concise;
  }
  return copy.unexpected;
}
