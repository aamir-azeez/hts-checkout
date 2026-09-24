// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../HTSCheckout.sol";

contract MockCheckoutToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
}

contract MockSaucerRouter is ISaucerSwapRouter {
    MockCheckoutToken public immutable outputToken;
    uint256 public cost = 60;
    uint256 public deliveryShortfall;
    bool public omitRefund;
    bytes public lastPath;
    constructor(MockCheckoutToken token_) { outputToken = token_; }
    function configure(uint256 cost_, uint256 shortfall_, bool omitRefund_) external {
        cost = cost_; deliveryShortfall = shortfall_; omitRefund = omitRefund_;
    }
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256) {
        require(block.timestamp <= params.deadline, "expired");
        require(cost <= params.amountInMaximum, "Too much requested");
        require(cost <= msg.value, "insufficient native input");
        lastPath = params.path;
        outputToken.mint(params.recipient, params.amountOut - deliveryShortfall);
        // An address with no code models native HBAR already wrapped and spent.
        (bool sent,) = payable(address(0xBEEF)).call{value: cost}("");
        require(sent);
        return cost;
    }
    function refundETH() external payable {
        if (!omitRefund) {
            (bool sent,) = payable(msg.sender).call{value: address(this).balance}("");
            require(sent);
        }
    }
    receive() external payable {}
}

contract RefundReceiver {
    HTSCheckout public immutable checkout;
    bool public rejectRefund = true;
    bool public attemptReentry;
    bool public reentrySucceeded;
    constructor(HTSCheckout checkout_) { checkout = checkout_; }
    function setBehavior(bool reject_, bool reenter_) external { rejectRefund = reject_; attemptReentry = reenter_; }
    function pay(bytes32 invoiceId, uint256 maximum, uint256 deadline) external payable {
        checkout.payInvoice{value: msg.value}(invoiceId, maximum, deadline);
    }
    function withdraw() external { checkout.withdrawRefund(); }
    receive() external payable {
        require(!rejectRefund, "reject native transfer");
        if (attemptReentry) {
            (bool success,) = address(checkout).call(abi.encodeCall(checkout.withdrawRefund, ()));
            reentrySucceeded = success;
        }
    }
}

contract ForceNative {
    constructor(address payable recipient) payable { selfdestruct(recipient); }
}
