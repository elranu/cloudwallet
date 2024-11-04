// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockRecipient is ERC2771Context {
    event ReceivedFrom(address sender, uint256 amount);
    event TokensReceived(address token, address from, uint256 amount);
    event SenderChecked(address sender);

    IERC20 public immutable token;

    constructor(address trustedForwarder, address _token) ERC2771Context(trustedForwarder) {
        token = IERC20(_token);
    }

    function testMsgSender() public {
        emit ReceivedFrom(_msgSender(), 0);
    }

    function receiveTokens(uint256 amount) public {
        address sender = _msgSender();

        // Record the transfer
        emit TokensReceived(address(token), sender, amount);
        emit ReceivedFrom(sender, amount);

        // Actually transfer the tokens
        require(token.transferFrom(sender, address(this), amount), "Token transfer failed");
    }

    function checkSender() public returns (address) {
        address sender = _msgSender();
        emit SenderChecked(sender);
        return sender;
    }

    function isTrustedForwarderSet(address forwarder) public view returns (bool) {
        return isTrustedForwarder(forwarder);
    }
}
