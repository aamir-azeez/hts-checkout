"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  hexlify,
  randomBytes,
  type Eip1193Provider,
} from "ethers";
import Link from "next/link";
import {
  invoiceExpiry,
  paymentDeadline,
  transactionTimestamp,
} from "@/lib/timing";
import { copy as c } from "@/lib/copy";
import {
  ABI,
  ALLOWED_CHAIN,
  CHAIN_ID,
  CHECKOUT_ADDRESS,
  IS_LOCAL,
  LOCAL_WALLET_ENABLED,
  NATIVE_SYMBOL,
  TOKEN_SYMBOL,
  NETWORK_LABEL,
  QUOTER_ADDRESS,
  RPC_URL,
  checkout,
  errorMessage,
  explorer,
  getConfiguration,
  getInvoice,
  getQuote,
  hbar,
  invoiceId,
  parseSauce,
  readProvider,
  recipientAddress,
  sauce,
  short,
  transactionValue,
  walletSigner,
  type Configuration,
  type InjectedWindow,
  type Invoice,
  type Quote,
  type Wallet,
} from "@/lib/chain";

import {
  PendingGate,
  readPaymentReceipt,
  readPending,
  removeMatchingPending,
  samePending,
  storePaymentReceipt,
  storePending,
  type Pending,
} from "@/lib/transactions";
const STORAGE_SCOPE = { chainId: CHAIN_ID, checkout: CHECKOUT_ADDRESS };

type Panel = "create" | "pay" | "receipt" | "setup";
type Notice = { message: string; tone: "error" | "success" };
function Arrow({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={className}>
      ↗
    </span>
  );
}
function ExternalLink({
  type,
  value,
  children,
}: {
  type: "transaction" | "contract" | "account";
  value: string;
  children: React.ReactNode;
}) {
  const url = explorer(type, value);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {children} <Arrow />
    </a>
  ) : (
    <span>{children}</span>
  );
}
function Address({ value }: { value: string }) {
  return (
    <span className="mono" title={value}>
      {short(value)}
    </span>
  );
}

export default function Home() {
  const provider = useMemo(() => (ALLOWED_CHAIN ? readProvider() : null), []);
  const [panel, setPanel] = useState<Panel>("create");
  const [config, setConfig] = useState<Configuration | null>(null);
  const [configLoading, setConfigLoading] = useState(Boolean(CHECKOUT_ADDRESS));
  const [configError, setConfigError] = useState("");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [expiry, setExpiry] = useState("86400");
  const [lookup, setLookup] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loadingInvoice, setLoadingInvoice] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lastTransaction, setLastTransaction] = useState("");
  const [refund, setRefund] = useState<bigint | null>(null);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const submitted = useRef(false);
  const pendingGate = useRef(new PendingGate());
  const invoiceReadVersion = useRef(0);
  const paymentProofs = useRef(new Map<string, string>());
  const noticeRef = useRef<HTMLDivElement>(null);
  const connected = Boolean(
    wallet && wallet.chainId === CHAIN_ID && ALLOWED_CHAIN,
  );
  const working = Boolean(busy || pending);
  const expired = Boolean(
    invoice && !invoice.paid && invoice.expiresAt * 1000 <= now,
  );
  const quoteFresh = Boolean(
    quote &&
    invoice &&
    quote.invoiceId === invoice.id &&
    now - quote.createdAt < 30000,
  );
  const shareUrl = invoice && origin ? origin + "/?invoice=" + invoice.id : "";

  const showError = useCallback((error: unknown) => {
    setNotice({ message: errorMessage(error), tone: "error" });
  }, []);
  const refreshInvoice = useCallback(
    async (id: string, stillRelevant: () => boolean = () => true) => {
      if (!provider) return;
      const requestVersion = ++invoiceReadVersion.current;
      const result = await getInvoice(provider, id);
      if (requestVersion !== invoiceReadVersion.current || !stillRelevant())
        return;
      setInvoice(result);
      setLookup(id);
      let paymentHash = paymentProofs.current.get(id.toLowerCase()) || "";
      try {
        paymentHash ||=
          readPaymentReceipt(localStorage, STORAGE_SCOPE, id)?.hash || "";
      } catch {
        /* Confirmed in-memory evidence still works without browser storage. */
      }
      setLastTransaction(result.paid ? paymentHash : "");
      return result;
    },
    [provider],
  );
  const refreshRefund = useCallback(async () => {
    if (!provider || !wallet || !config) return;
    const value = await checkout(provider).refundCredits(wallet.address);
    setRefund(BigInt(value));
  }, [provider, wallet, config]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    Promise.resolve().then(() => {
      setOrigin(window.location.origin);
      const requested = new URL(window.location.href).searchParams.get(
        "invoice",
      );
      if (requested) {
        setLookup(requested);
        setPanel("pay");
      }
      try {
        const saved = readPending(localStorage, STORAGE_SCOPE, requested);
        if (saved) {
          pendingGate.current.remember(saved);
          submitted.current = true;
          setPending(saved);
          if (!requested && saved.invoiceId) {
            setLookup(saved.invoiceId);
            setPanel("pay");
          }
        }
      } catch {
        /* A corrupt or unavailable storage record must not prevent read-only use. */
      }
    });
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    if (!provider || !CHECKOUT_ADDRESS) {
      Promise.resolve().then(() => {
        if (live) {
          setConfigLoading(false);
          if (!ALLOWED_CHAIN) setConfigError(c.unsupportedChain);
        }
      });
      return () => {
        live = false;
      };
    }
    getConfiguration(provider)
      .then(async (result) => {
        if (!live) return;
        setConfig(result);
        const requested = new URL(window.location.href).searchParams.get(
          "invoice",
        );
        if (requested) {
          setLoadingInvoice(true);
          try {
            await refreshInvoice(invoiceId(requested), () => live);
          } catch (error) {
            if (live) showError(error);
          } finally {
            if (live) setLoadingInvoice(false);
          }
        }
      })
      .catch((error) => {
        if (live) setConfigError(errorMessage(error));
      })
      .finally(() => {
        if (live) setConfigLoading(false);
      });
    return () => {
      live = false;
    };
  }, [provider, showError, refreshInvoice]);

  useEffect(() => {
    if (!provider || !wallet || !config) return;
    let live = true;
    checkout(provider)
      .refundCredits(wallet.address)
      .then((value: bigint) => {
        if (live) setRefund(BigInt(value));
      })
      .catch(() => {
        if (live) setRefund(null);
      });
    return () => {
      live = false;
    };
  }, [provider, wallet, config]);

  useEffect(() => {
    const injected = IS_LOCAL ? undefined : (window as InjectedWindow).ethereum;
    if (!injected?.on) return;
    const changed = () => {
      setWallet(null);
      setRefund(null);
      setQuote(null);
      setNotice({ message: c.walletChanged, tone: "error" });
    };
    injected.on("accountsChanged", changed);
    injected.on("chainChanged", changed);
    return () => {
      injected.removeListener?.("accountsChanged", changed);
      injected.removeListener?.("chainChanged", changed);
    };
  }, []);

  const checkPending = useCallback(
    async (silent = false) => {
      if (!provider) return;
      const gate = pendingGate.current;
      const ticket = gate.beginPoll();
      if (!ticket) return;
      const transaction = ticket.pending;
      try {
        const receipt = await provider.getTransactionReceipt(transaction.hash);
        if (!receipt || !gate.isCurrent(ticket)) return;

        if (receipt.status === 1 && transaction.kind === "pay") {
          paymentProofs.current.set(
            transaction.invoiceId.toLowerCase(),
            transaction.hash,
          );
          try {
            storePaymentReceipt(localStorage, STORAGE_SCOPE, transaction);
          } catch {
            /* Preserve confirmed payment evidence in memory if storage is unavailable. */
          }
        }
        try {
          removeMatchingPending(localStorage, STORAGE_SCOPE, transaction);
        } catch {
          /* A confirmed receipt remains authoritative without writable storage. */
        }
        if (!gate.settle(ticket)) return;
        setPending((current) =>
          samePending(current, transaction) ? null : current,
        );
        submitted.current = false;

        if (receipt.status !== 1) {
          setNotice({ message: c.txFailed, tone: "error" });
          return;
        }
        setNotice({
          message:
            transaction.kind === "create"
              ? c.invoiceCreated
              : transaction.kind === "pay"
                ? c.paymentComplete
                : c.refundConfirmed,
          tone: "success",
        });
        // Confirmation is complete before optional reads. Their failures cannot revive a pending payment.
        if (transaction.invoiceId) {
          void refreshInvoice(transaction.invoiceId, () =>
            gate.unchangedSince(ticket),
          )
            .then((updated) => {
              if (updated && gate.unchangedSince(ticket))
                setPanel(transaction.kind === "pay" ? "receipt" : "pay");
            })
            .catch(() => {
              /* The confirmed hash is retained; invoice status can be refreshed later. */
            });
        }
        void refreshRefund().catch(() => {
          /* A refund balance read cannot invalidate confirmation. */
        });
      } catch {
        if (!silent && gate.isCurrent(ticket))
          setNotice({ message: c.pendingUnavailable, tone: "error" });
      } finally {
        gate.finishPoll(ticket);
      }
    },
    [provider, refreshInvoice, refreshRefund],
  );

  useEffect(() => {
    if (!pending || !config) return;
    void checkPending(true);
    const timer = window.setInterval(() => {
      void checkPending(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, config, checkPending]);

  async function connectWallet() {
    setConnecting(true);
    setNotice(null);
    if (IS_LOCAL) {
      try {
        if (!LOCAL_WALLET_ENABLED || !provider)
          throw new Error(c.localRpcRequired);
        const network = await provider.getNetwork();
        if (Number(network.chainId) !== 31337)
          throw new Error(c.configurationMismatch);
        const signer = await provider.getSigner(0);
        const address = await signer.getAddress();
        setWallet({ address, chainId: 31337, provider });
        if (!recipient) setRecipient(address);
      } catch (error) {
        showError(error);
      } finally {
        setConnecting(false);
      }
      return;
    }
    try {
      const injected = (window as InjectedWindow).ethereum;
      if (!injected) throw new Error(c.noWallet);
      const browser = new BrowserProvider(injected as Eip1193Provider);
      await browser.send("eth_requestAccounts", []);
      const signer = await browser.getSigner();
      const address = await signer.getAddress();
      const network = await browser.getNetwork();
      setWallet({
        address,
        chainId: Number(network.chainId),
        provider: browser,
      });
      if (!recipient) setRecipient(address);
    } catch (error) {
      showError(error);
    } finally {
      setConnecting(false);
    }
  }

  async function switchNetwork() {
    setConnecting(true);
    try {
      if (!ALLOWED_CHAIN) throw new Error(c.unsupportedChain);
      const injected = (window as InjectedWindow).ethereum;
      if (!injected) throw new Error(c.noWallet);
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + CHAIN_ID.toString(16) }],
        });
      } catch (error) {
        if ((error as { code?: number }).code !== 4902) throw error;
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x" + CHAIN_ID.toString(16),
              chainName: NETWORK_LABEL,
              nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
              rpcUrls: [RPC_URL],
              ...(IS_LOCAL
                ? {}
                : { blockExplorerUrls: ["https://hashscan.io/testnet"] }),
            },
          ],
        });
      }
      await connectWallet();
    } catch (error) {
      showError(error);
    } finally {
      setConnecting(false);
    }
  }

  function remember(transaction: Pending) {
    const saved = { ...transaction, submittedAt: Date.now() };
    pendingGate.current.remember(saved);
    setPending(saved);
    try {
      storePending(localStorage, STORAGE_SCOPE, saved);
    } catch {
      setNotice({ message: c.pendingStorage, tone: "error" });
    }
  }

  async function createInvoice(event: React.FormEvent) {
    event.preventDefault();
    if (submitted.current || working) return;
    setBusy("create");
    setNotice(null);
    try {
      if (!wallet || !connected || !config || !provider)
        throw new Error(c.connectFirst);
      const output = parseSauce(amount);
      const to = recipientAddress(recipient);
      const signer = await walletSigner(wallet);
      const block = await provider.getBlock("latest");
      if (!block) throw new Error(c.unexpected);
      const id = hexlify(randomBytes(32));
      submitted.current = true;
      const tx = await new Contract(
        CHECKOUT_ADDRESS,
        ABI,
        signer,
      ).createInvoice(
        id,
        to,
        output,
        invoiceExpiry(block.timestamp, Number(expiry)),
      );
      remember({ hash: tx.hash, invoiceId: id, kind: "create" });
      setLookup(id);
      window.history.replaceState(null, "", "/?invoice=" + id);
    } catch (error) {
      submitted.current = false;
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function openInvoice(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setLoadingInvoice(true);
    setNotice(null);
    setQuote(null);
    setInvoice(null);
    setLastTransaction("");
    try {
      if (!config) throw new Error(c.unconfiguredBody);
      const id = invoiceId(lookup);
      await refreshInvoice(id);
      window.history.replaceState(null, "", "/?invoice=" + id);
    } catch (error) {
      showError(error);
    } finally {
      setLoadingInvoice(false);
    }
  }

  async function quoteInvoice() {
    setBusy("quote");
    setNotice(null);
    setQuote(null);
    try {
      if (!provider || !config || !invoice) return;
      const fresh = await refreshInvoice(invoice.id);
      if (!fresh || fresh.paid) return;
      if (fresh.expiresAt * 1000 <= Date.now()) throw new Error(c.expiredBody);
      setQuote(await getQuote(provider, config, fresh));
      setNow(Date.now());
    } catch (error) {
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function payInvoice() {
    if (submitted.current || working) return;
    setBusy("pay");
    setNotice(null);
    try {
      if (!wallet || !connected || !invoice || !provider || !config)
        throw new Error(c.connectFirst);
      if (
        !quote ||
        quote.invoiceId !== invoice.id ||
        Date.now() - quote.createdAt >= 30000
      )
        throw new Error(c.noQuote);
      const fresh = await refreshInvoice(invoice.id);
      if (!fresh || fresh.paid) return;
      const signer = await walletSigner(wallet);
      const block = await provider.getBlock("latest");
      if (!block) throw new Error(c.unexpected);
      if (fresh.expiresAt <= transactionTimestamp(block.timestamp))
        throw new Error(c.expiredBody);
      if (Date.now() - quote.createdAt >= 30000) throw new Error(c.noQuote);
      submitted.current = true;
      const tx = await new Contract(CHECKOUT_ADDRESS, ABI, signer).payInvoice(
        invoice.id,
        quote.maximum,
        paymentDeadline(block.timestamp, fresh.expiresAt),
        { value: transactionValue(quote.maximum, CHAIN_ID) },
      );
      remember({ hash: tx.hash, invoiceId: invoice.id, kind: "pay" });
      setQuote(null);
    } catch (error) {
      submitted.current = false;
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function withdrawRefund() {
    if (submitted.current || working) return;
    setBusy("refund");
    setNotice(null);
    try {
      if (!wallet || !connected || !config) throw new Error(c.connectFirst);
      const signer = await walletSigner(wallet);
      submitted.current = true;
      const tx = await new Contract(
        CHECKOUT_ADDRESS,
        ABI,
        signer,
      ).withdrawRefund();
      remember({ hash: tx.hash, invoiceId: "", kind: "refund" });
    } catch (error) {
      submitted.current = false;
      showError(error);
    } finally {
      setBusy("");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(new Error(c.copyFailed));
    }
  }

  const invoiceDetails = invoice && (
    <div className="invoice-details">
      <div className="invoice-top">
        <span className="overline">{c.invoice}</span>
        <span
          className={
            "pill " + (invoice.paid ? "green" : expired ? "red" : "amber")
          }
        >
          <span className="dot" />
          {invoice.paid ? c.paid : expired ? c.expired : c.active}
        </span>
      </div>
      <div className="invoice-amount">
        <span>{sauce(invoice.amountOut)}</span>
        <span className="currency">{TOKEN_SYMBOL}</span>
      </div>
      <p className="muted small">{c.requested}</p>
      <dl className="detail-list">
        <div>
          <dt>{c.invoice}</dt>
          <dd>
            <Address value={invoice.id} />
          </dd>
        </div>
        <div>
          <dt>{c.merchant}</dt>
          <dd>
            <ExternalLink type="account" value={invoice.merchant}>
              <Address value={invoice.merchant} />
            </ExternalLink>
          </dd>
        </div>
        <div>
          <dt>{c.recipientLabel}</dt>
          <dd>
            <ExternalLink type="account" value={invoice.recipient}>
              <Address value={invoice.recipient} />
            </ExternalLink>
          </dd>
        </div>
        <div>
          <dt>{c.expiresLabel}</dt>
          <dd>{new Date(invoice.expiresAt * 1000).toLocaleString()}</dd>
        </div>
        {invoice.paid && (
          <>
            <div>
              <dt>{c.paidBy}</dt>
              <dd>
                <ExternalLink type="account" value={invoice.payer}>
                  <Address value={invoice.payer} />
                </ExternalLink>
              </dd>
            </div>
            <div>
              <dt>{c.actualInput}</dt>
              <dd>
                {hbar(invoice.amountIn)} {NATIVE_SYMBOL}
              </dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>
          <span>
            {c.brand}
            <small>{c.brandLine}</small>
          </span>
        </Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Checkout navigation">
          {(
            [
              ["create", "＋", c.receive],
              ["pay", "↗", c.pay],
              ["receipt", "▤", c.receipt],
            ] as const
          ).map(([key, icon, label]) => (
            <button
              key={key}
              className={"nav-item " + (panel === key ? "selected" : "")}
              aria-current={panel === key ? "page" : undefined}
              onClick={() => setPanel(key)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
              {panel === key && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={"nav-item " + (panel === "setup" ? "selected" : "")}
            onClick={() => setPanel("setup")}
          >
            <span aria-hidden="true">⚙</span>
            {c.setup}
          </button>
          <div className="network-card">
            <span className="network-logo" aria-hidden="true">
              ℏ
            </span>
            <div>
              <strong>{NETWORK_LABEL}</strong>
              <small>Chain {CHAIN_ID}</small>
            </div>
            <span className="dot" />
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            {c.brand}
            <span>/</span>
            {panel === "create"
              ? c.receive
              : panel === "pay"
                ? c.pay
                : panel === "receipt"
                  ? c.receipt
                  : c.setup}
          </span>
          <div className="topbar-actions">
            <span className="testnet-tag">
              <span className="dot" />
              {NETWORK_LABEL}
            </span>
            <button
              className="wallet-button"
              onClick={connectWallet}
              disabled={connecting || Boolean(busy)}
            >
              <span className="wallet-icon" aria-hidden="true">
                ▱
              </span>
              {connecting
                ? c.connecting
                : wallet
                  ? short(wallet.address)
                  : IS_LOCAL
                    ? c.connectDemo
                    : c.connect}
            </button>
          </div>
        </header>
        <main>
          <div className="hero">
            <div>
              <p className="overline">{c.heroEyebrow}</p>
              <h1>{c.heroTitle}</h1>
              <p>{c.heroBody}</p>
            </div>
            <span className="hero-symbol" aria-hidden="true">
              ↗
            </span>
          </div>
          <div className="notice-strip">
            <span aria-hidden="true">ⓘ</span>
            {IS_LOCAL ? c.localNotice : c.demoNotice}
            <span className="strip-divider" />
            <button onClick={() => setPanel("setup")}>
              {configLoading
                ? c.loadingContract
                : config
                  ? c.ready
                  : c.unconfigured}
              <Arrow />
            </button>
          </div>
          {notice && (
            <div
              ref={noticeRef}
              role={notice.tone === "error" ? "alert" : "status"}
              className={"alert " + notice.tone}
            >
              <span>{notice.message}</span>
              <button aria-label={c.dismiss} onClick={() => setNotice(null)}>
                ×
              </button>
            </div>
          )}
          {wallet && !connected && (
            <div className="alert error">
              <span>{c.wrongNetwork}</span>
              <button
                className="text-button"
                disabled={connecting || !ALLOWED_CHAIN}
                onClick={switchNetwork}
              >
                {c.switchNetwork}
              </button>
            </div>
          )}
          {pending && (
            <section className="pending-banner" aria-live="polite">
              <span className="spinner" />
              <div>
                <strong>{c.pendingHeading}</strong>
                <p>{c.pendingBody}</p>
                <ExternalLink type="transaction" value={pending.hash}>
                  <span className="mono">{short(pending.hash)}</span>
                </ExternalLink>
              </div>
              <button
                className="secondary compact"
                onClick={() => {
                  void checkPending();
                }}
              >
                {c.retryReceipt}
              </button>
            </section>
          )}

          {panel === "create" && (
            <div className="content-grid">
              <section className="card form-card">
                <div className="card-heading">
                  <span className="step-number">01</span>
                  <div>
                    <h2>{c.createHeading}</h2>
                    <p>{c.createBody}</p>
                  </div>
                </div>
                <form onSubmit={createInvoice}>
                  <label htmlFor="amount">{c.amount}</label>
                  <div className="amount-input">
                    <input
                      id="amount"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                      aria-describedby="amount-help"
                    />
                    <span className="token-chip">
                      <span className="sauce-icon" aria-hidden="true">
                        S
                      </span>
                      {TOKEN_SYMBOL}
                    </span>
                  </div>
                  <p className="field-hint" id="amount-help">
                    {c.amountHint}
                  </p>
                  <div className="label-row">
                    <label htmlFor="recipient">{c.recipient}</label>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!wallet}
                      onClick={() => wallet && setRecipient(wallet.address)}
                    >
                      {c.useWallet}
                    </button>
                  </div>
                  <input
                    id="recipient"
                    className="text-input mono"
                    placeholder="0x…"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    required
                    aria-describedby="recipient-help"
                  />
                  <p id="recipient-help" className="field-hint">
                    {c.recipientHint}
                  </p>
                  <label htmlFor="expiry">{c.expires}</label>
                  <select
                    id="expiry"
                    className="text-input"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  >
                    <option value="3600">{c.hour}</option>
                    <option value="86400">{c.day}</option>
                    <option value="604800">{c.week}</option>
                  </select>
                  {!config && !configLoading && (
                    <p className="setup-inline">
                      {configError || c.unconfiguredBody}{" "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPanel("setup")}
                      >
                        {c.setup} <Arrow />
                      </button>
                    </p>
                  )}
                  <button
                    className="primary full"
                    type="submit"
                    disabled={!connected || !config || working}
                  >
                    {busy === "create" ? c.createPending : c.createAction}
                    <Arrow />
                  </button>
                  {!wallet && (
                    <p className="field-hint centered">
                      {IS_LOCAL ? c.connectDemo : c.connectHint}
                    </p>
                  )}
                  {!IS_LOCAL && <p className="fine-print">{c.createFooter}</p>}
                </form>
              </section>
              <aside className="info-column">
                <section className="route-card">
                  <div className="route-graphic" aria-hidden="true">
                    <span className="hbar-coin">ℏ</span>
                    <span className="route-line">→</span>
                    <span className="sauce-coin">S</span>
                  </div>
                  <h2>{c.pathHeading}</h2>
                  <p>{c.pathBody}</p>
                  <div className="route-labels">
                    <span>
                      {c.pathFrom}
                      <strong>{NATIVE_SYMBOL}</strong>
                    </span>
                    <span>
                      {c.pathTo}
                      <strong>{TOKEN_SYMBOL}</strong>
                    </span>
                  </div>
                </section>
                <section className="safety-card">
                  <h3>{c.safetyHeading}</h3>
                  {c.safetyItems.map((item) => (
                    <p key={item}>
                      <span aria-hidden="true">✓</span>
                      {item}
                    </p>
                  ))}
                </section>
                <div className="mini-stats">
                  <div>
                    <span>{c.activityLabel}</span>
                    <strong>{IS_LOCAL ? "Local mock" : c.activityValue}</strong>
                  </div>
                  <div>
                    <span>{c.quoteLabel}</span>
                    <strong>{c.quoteValue}</strong>
                  </div>
                </div>
              </aside>
            </div>
          )}

          {panel === "pay" && (
            <div className="content-grid">
              <section className="card">
                <div className="card-heading">
                  <span className="step-number">02</span>
                  <div>
                    <h2>{c.payHeading}</h2>
                    <p>{c.payBody}</p>
                  </div>
                </div>
                <form className="lookup-form" onSubmit={openInvoice}>
                  <label className="sr-only" htmlFor="lookup">
                    {c.invoiceInput}
                  </label>
                  <input
                    id="lookup"
                    className="text-input mono"
                    placeholder={c.invoicePlaceholder}
                    value={lookup}
                    disabled={working}
                    onChange={(e) => setLookup(e.target.value)}
                    required
                  />
                  <button
                    className="secondary"
                    type="submit"
                    disabled={loadingInvoice || !config || working}
                  >
                    {loadingInvoice ? c.loadingInvoice : c.openInvoice}
                  </button>
                </form>
                {!config && (
                  <p className="setup-inline">
                    {configError || c.unconfiguredBody}{" "}
                    <button
                      className="text-button"
                      onClick={() => setPanel("setup")}
                    >
                      {c.setup} <Arrow />
                    </button>
                  </p>
                )}
                {invoiceDetails}
                {invoice && !invoice.paid && !expired && (
                  <section className="share-card">
                    <strong>{c.shareHeading}</strong>
                    <p>{c.shareBody}</p>
                    <input
                      className="text-input mono"
                      readOnly
                      value={shareUrl}
                      aria-label="Shareable invoice link"
                      onFocus={(e) => e.target.select()}
                    />
                    <button className="text-button" onClick={copyLink}>
                      {copied ? c.copied : c.copyLink} <Arrow />
                    </button>
                  </section>
                )}
              </section>
              <section className="card payment-card">
                <span className="payment-icon" aria-hidden="true">
                  ℏ
                </span>
                <h2>{invoice?.paid ? c.paymentComplete : c.quoteHeading}</h2>
                <p className="muted">
                  {invoice?.paid
                    ? c.paidBody
                    : expired
                      ? c.expiredBody
                      : IS_LOCAL
                        ? c.localQuoteBody
                        : c.quoteBody}
                </p>
                {invoice?.paid ? (
                  <>
                    <div className="success-seal" aria-hidden="true">
                      ✓
                    </div>
                    <button
                      className="primary full"
                      onClick={() => setPanel("receipt")}
                    >
                      {c.receipt}
                      <Arrow />
                    </button>
                  </>
                ) : (
                  <>
                    <dl className="quote-list">
                      <div>
                        <dt>{c.estimated}</dt>
                        <dd>
                          {quote ? hbar(quote.amountIn) : "—"}{" "}
                          <span>{NATIVE_SYMBOL}</span>
                        </dd>
                      </div>
                      <div className="quote-max">
                        <dt>{c.maximum}</dt>
                        <dd>
                          {quote ? hbar(quote.maximum) : "—"}{" "}
                          <span>{NATIVE_SYMBOL}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>{c.slippage}</dt>
                        <dd>0.5%</dd>
                      </div>
                    </dl>
                    <p className="field-hint">{c.slippageHint}</p>
                    <button
                      className="secondary full"
                      onClick={quoteInvoice}
                      disabled={!invoice || !config || expired || working}
                    >
                      {busy === "quote"
                        ? c.quoting
                        : quote
                          ? c.refreshQuote
                          : c.quoteButton}
                    </button>
                    {quote && (
                      <p
                        className={
                          "field-hint " + (!quoteFresh ? "error-text" : "")
                        }
                      >
                        {quoteFresh ? c.quoteExpires : c.quoteStale}
                      </p>
                    )}
                    <button
                      className="primary full"
                      disabled={
                        !invoice ||
                        !connected ||
                        !config ||
                        expired ||
                        working ||
                        !quoteFresh
                      }
                      onClick={payInvoice}
                    >
                      {busy === "pay" || pending?.kind === "pay"
                        ? c.payPending
                        : c.payAction}
                      <Arrow />
                    </button>
                    {!wallet && (
                      <p className="field-hint centered">
                        {IS_LOCAL ? c.connectDemo : c.connectHint}
                      </p>
                    )}
                  </>
                )}
              </section>
            </div>
          )}

          {panel === "receipt" && (
            <section className="card receipt-card">
              <div className="card-heading">
                <span className="step-number">03</span>
                <div>
                  <h2>{invoice?.paid ? c.paymentComplete : c.receipt}</h2>
                  <p>{invoice?.paid ? c.paidBody : c.receiptEmpty}</p>
                </div>
              </div>
              {invoiceDetails}
              {invoice && (
                <button
                  className="secondary full"
                  disabled={working}
                  onClick={() => {
                    void refreshInvoice(invoice.id).catch(showError);
                  }}
                >
                  {c.refreshing}
                </button>
              )}
              {invoice?.paid && lastTransaction && (
                <p className="receipt-link">
                  {IS_LOCAL ? (
                    <>
                      Local transaction · <Address value={lastTransaction} />
                    </>
                  ) : (
                    <ExternalLink type="transaction" value={lastTransaction}>
                      {c.chainExplorer}
                    </ExternalLink>
                  )}
                </p>
              )}
            </section>
          )}

          {panel === "setup" && (
            <section className="card setup-card">
              <div className="card-heading">
                <span className="step-number" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <h2>{c.setupHeading}</h2>
                  <p>{c.setupBody}</p>
                </div>
              </div>
              {configError && <div className="alert error">{configError}</div>}
              <p>{c.setupInstruction}</p>
              <pre>
                <code>NEXT_PUBLIC_CHECKOUT_ADDRESS=0x…</code>
              </pre>
              <details>
                <summary>{c.setupOptional}</summary>
                <pre>
                  <code>
                    {
                      "NEXT_PUBLIC_CHAIN_ID=296\nNEXT_PUBLIC_RPC_URL=https://testnet.hashio.io/api\nNEXT_PUBLIC_QUOTER_ADDRESS=0x00000000000000000000000000000000001535b2"
                    }
                  </code>
                </pre>
              </details>
              <dl className="detail-list setup-details">
                <div>
                  <dt>{c.setupNetwork}</dt>
                  <dd>
                    {NETWORK_LABEL} · {CHAIN_ID}
                  </dd>
                </div>
                {[
                  [c.setupContract, CHECKOUT_ADDRESS],
                  [c.setupToken, config?.token],
                  [c.setupRouter, config?.router],
                  [c.setupQuoter, QUOTER_ADDRESS],
                  [c.setupWrapped, config?.whbar],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {value ? (
                        <ExternalLink type="contract" value={value}>
                          <Address value={value} />
                        </ExternalLink>
                      ) : (
                        c.notSet
                      )}
                    </dd>
                  </div>
                ))}
                {config && (
                  <div>
                    <dt>{c.setupPoolFee}</dt>
                    <dd>{config.poolFee / 10000}%</dd>
                  </div>
                )}
              </dl>
              <div className="association-note">
                <p>{c.setupWalletHint}</p>
                <a
                  href="https://docs.hedera.com/native/tokens/associate"
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.associationLink} <Arrow />
                </a>
              </div>
            </section>
          )}

          {wallet && config && (
            <section className="refund-panel">
              <div>
                <strong>{c.refundTitle}</strong>
                <p>
                  {refund === null
                    ? c.refundBody
                    : refund > 0n
                      ? hbar(refund) +
                        " " +
                        NATIVE_SYMBOL +
                        " · " +
                        c.refundBody
                      : c.refundEmpty}
                </p>
              </div>
              {refund !== null && refund > 0n && (
                <button
                  className="secondary compact"
                  disabled={!connected || working}
                  onClick={withdrawRefund}
                >
                  {c.refundAction}
                  <Arrow />
                </button>
              )}
            </section>
          )}
          <footer>
            <span>{c.footer}</span>
            <span className="footer-mark" aria-hidden="true">
              ℏ
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
