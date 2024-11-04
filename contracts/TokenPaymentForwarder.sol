// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/metatx/MinimalForwarder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TokenPaymentForwarder
 * @dev Extension of MinimalForwarder that accepts token payments for gas fees
 * Implements ERC-2771 trusted forwarder interface with USDT payment functionality
 */
contract TokenPaymentForwarder is MinimalForwarder, ReentrancyGuard, Ownable {
    IERC20 public paymentToken;
    uint256 public minPayment;

    event PaymentReceived(address indexed from, uint256 amount);
    event MinPaymentUpdated(uint256 newAmount);
    event PaymentTokenUpdated(address newToken);

    // Payment information to accompany the forward request
    struct PaymentInfo {
        uint256 payment;
        bytes paymentSignature;
    }

    constructor(address _paymentToken, uint256 _minPayment) {
        require(_paymentToken != address(0), "Invalid token address");
        paymentToken = IERC20(_paymentToken);
        minPayment = _minPayment;
    }

    /**
     * @dev Returns the domain separator used in the encoding of the signature for payment requests
     */
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @dev Verifies the token payment conditions
     */
    function verifyPayment(
        ForwardRequest calldata req,
        PaymentInfo calldata paymentInfo
    ) public view returns (bool) {
        // Verify payment meets minimum requirement
        if (paymentInfo.payment < minPayment) {
            return false;
        }

        // Verify token allowance
        if (paymentToken.allowance(req.from, address(this)) < paymentInfo.payment) {
            return false;
        }

        return true;
    }

    /**
     * @dev Executes a meta-transaction after collecting token payment
     * @param req The forward request
     * @param signature The signature for the forward request
     * @param paymentInfo The payment information
     */
    function executeWithPayment(
        ForwardRequest calldata req,
        bytes calldata signature,
        PaymentInfo calldata paymentInfo
    ) public nonReentrant returns (bool, bytes memory) {
        // Verify the forward request signature first
        require(verify(req, signature), "TokenPaymentForwarder: invalid signature");

        // Verify payment conditions
        require(verifyPayment(req, paymentInfo), "TokenPaymentForwarder: invalid payment");

        // Transfer tokens first (checks-effects-interactions pattern)
        require(
            paymentToken.transferFrom(req.from, address(this), paymentInfo.payment),
            "TokenPaymentForwarder: payment failed"
        );

        emit PaymentReceived(req.from, paymentInfo.payment);

        // Execute the forward request using parent implementation
        (bool success, bytes memory returndata) = execute(req, signature);
        require(success, "TokenPaymentForwarder: forward request failed");

        return (success, returndata);
    }

    /**
     * @dev Returns true if the forwarder is trusted for meta-transactions
     * Required by ERC-2771 recipient contracts
     */
    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder == address(this);
    }

    /**
     * @dev Updates the minimum payment amount
     * Only callable by contract owner
     */
    function setMinPayment(uint256 _minPayment) external onlyOwner {
        minPayment = _minPayment;
        emit MinPaymentUpdated(_minPayment);
    }

    /**
     * @dev Updates the payment token address
     * Only callable by contract owner
     */
    function setPaymentToken(address _paymentToken) external onlyOwner {
        require(_paymentToken != address(0), "Invalid token address");
        paymentToken = IERC20(_paymentToken);
        emit PaymentTokenUpdated(_paymentToken);
    }

    /**
     * @dev Withdraws collected token payments
     * Only callable by contract owner
     */
    function withdrawPayments(address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Invalid recipient");
        require(
            paymentToken.transfer(recipient, amount),
            "TokenPaymentForwarder: withdrawal failed"
        );
    }

    /**
     * @dev Returns the next nonce for an address
     * Required for meta-transaction support
     */
    // We use MinimalForwarder's getNonce implementation directly
}
