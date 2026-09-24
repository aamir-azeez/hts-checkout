// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ICheckoutToken {
    function balanceOf(address account) external view returns (uint256);
}

interface ISaucerSwapRouter {
    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
    function refundETH() external payable;
}

/// @notice Invoices settled in an immutable HTS token through SaucerSwap V2.
/// @dev Hedera Solidity native values use TINYBARS. Only external Ethereum
///      transaction value fields use weibars (tinybars * 10^10).
contract HTSCheckout {
    struct Invoice {
        address merchant;
        address recipient;
        uint256 amountOut;
        uint64 expiresAt;
        bool paid;
        address payer;
        uint256 amountIn;
    }

    ISaucerSwapRouter public immutable router;
    ICheckoutToken public immutable token;
    address public immutable whbar;
    uint24 public immutable poolFee;
    uint256 public constant MAX_INVOICE_LIFETIME = 365 days;
    uint256 private constant MAX_HTS_AMOUNT = uint256(uint64(type(int64).max));
    mapping(bytes32 => Invoice) public invoices;
    mapping(address => uint256) public refundCredits;
    uint256 private lockState = 1;

    error ReentrantCall();
    error InvalidConfiguration();
    error InvalidInvoiceId();
    error InvoiceAlreadyExists();
    error InvoiceNotFound();
    error InvoiceAlreadyPaid();
    error InvalidRecipient();
    error InvalidAmount();
    error InvalidExpiry();
    error InvoiceExpired();
    error InvalidSwapDeadline();
    error IncorrectValue();
    error ExcessiveInput();
    error IncorrectSettlement();
    error MissingRouterRefund();
    error UnauthorizedNativeSender();
    error NoRefundCredit();
    error RefundWithdrawalFailed();

    event InvoiceCreated(bytes32 indexed invoiceId, address indexed merchant, address indexed recipient, uint256 amountOut, uint64 expiresAt);
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed recipient, uint256 amountOut, uint256 amountIn, uint256 refundAmount);
    event RefundCredited(address indexed payer, uint256 amount);
    event RefundWithdrawn(address indexed payer, uint256 amount);
    event RouterSurplusRefunded(address indexed payer, uint256 amount);

    modifier nonReentrant() {
        if (lockState != 1) revert ReentrantCall();
        lockState = 2;
        _;
        lockState = 1;
    }

    constructor(address router_, address token_, address whbar_, uint24 poolFee_) {
        if (router_ == address(0) || token_ == address(0) || whbar_ == address(0)
            || token_ == whbar_ || poolFee_ == 0 || poolFee_ >= 1_000_000) revert InvalidConfiguration();
        router = ISaucerSwapRouter(router_);
        token = ICheckoutToken(token_);
        whbar = whbar_;
        poolFee = poolFee_;
    }

    function createInvoice(bytes32 invoiceId, address recipient, uint256 amountOut, uint64 expiresAt) external nonReentrant {
        if (invoiceId == bytes32(0)) revert InvalidInvoiceId();
        if (invoices[invoiceId].merchant != address(0)) revert InvoiceAlreadyExists();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountOut == 0 || amountOut > MAX_HTS_AMOUNT) revert InvalidAmount();
        if (expiresAt <= block.timestamp || uint256(expiresAt) > block.timestamp + MAX_INVOICE_LIFETIME) revert InvalidExpiry();
        invoices[invoiceId] = Invoice(msg.sender, recipient, amountOut, expiresAt, false, address(0), 0);
        emit InvoiceCreated(invoiceId, msg.sender, recipient, amountOut, expiresAt);
    }

    /// @param maxInputTinybar Maximum HBAR principal, excluding network gas fees.
    function payInvoice(bytes32 invoiceId, uint256 maxInputTinybar, uint256 swapDeadline) external payable nonReentrant {
        Invoice storage invoice = invoices[invoiceId];
        if (invoice.merchant == address(0)) revert InvoiceNotFound();
        if (invoice.paid) revert InvoiceAlreadyPaid();
        if (block.timestamp > invoice.expiresAt) revert InvoiceExpired();
        if (swapDeadline < block.timestamp || swapDeadline > invoice.expiresAt) revert InvalidSwapDeadline();
        if (maxInputTinybar == 0 || maxInputTinybar > MAX_HTS_AMOUNT) revert InvalidAmount();
        if (msg.value != maxInputTinybar) revert IncorrectValue();

        uint256 nativeBalanceBefore = address(this).balance - msg.value;
        uint256 recipientBalanceBefore = token.balanceOf(invoice.recipient);
        // Effects precede external calls. Every failure reverts this state too.
        invoice.paid = true;
        invoice.payer = msg.sender;

        uint256 amountIn = router.exactOutput{value: msg.value}(ISaucerSwapRouter.ExactOutputParams({
            path: abi.encodePacked(address(token), poolFee, whbar),
            recipient: invoice.recipient,
            deadline: swapDeadline,
            amountOut: invoice.amountOut,
            amountInMaximum: maxInputTinybar
        }));
        if (amountIn > maxInputTinybar) revert ExcessiveInput();
        router.refundETH();

        uint256 recipientBalanceAfter = token.balanceOf(invoice.recipient);
        if (recipientBalanceAfter < recipientBalanceBefore || recipientBalanceAfter - recipientBalanceBefore != invoice.amountOut) revert IncorrectSettlement();
        uint256 refundAmount = maxInputTinybar - amountIn;
        uint256 nativeBalanceAfter = address(this).balance;
        if (nativeBalanceAfter < nativeBalanceBefore + refundAmount) revert MissingRouterRefund();
        // Router refundETH returns its entire balance, potentially including public
        // router dust. Return only this call's delta; never spend older refund credits.
        uint256 routerSurplus = nativeBalanceAfter - nativeBalanceBefore - refundAmount;
        invoice.amountIn = amountIn;
        emit InvoicePaid(invoiceId, msg.sender, invoice.recipient, invoice.amountOut, amountIn, refundAmount);
        if (routerSurplus != 0) emit RouterSurplusRefunded(msg.sender, routerSurplus);
        uint256 payout = refundAmount + routerSurplus;
        if (payout != 0) {
            // Bound recipient execution so a rejecting receiver can still get credit.
            (bool refunded,) = payable(msg.sender).call{value: payout, gas: 50_000}("");
            if (!refunded) {
                refundCredits[msg.sender] += payout;
                emit RefundCredited(msg.sender, payout);
            }
        }
    }

    function withdrawRefund() external nonReentrant {
        uint256 amount = refundCredits[msg.sender];
        if (amount == 0) revert NoRefundCredit();
        refundCredits[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert RefundWithdrawalFailed();
        emit RefundWithdrawn(msg.sender, amount);
    }

    receive() external payable {
        if (msg.sender != address(router)) revert UnauthorizedNativeSender();
    }
}
