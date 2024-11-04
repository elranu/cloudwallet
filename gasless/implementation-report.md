# Gasless Transactions Implementation Plan Using ERC-2771 and AWS

## Overview
This report outlines how users with USDT but no ETH can perform token transfers using ERC-2771 meta-transactions, with relayers receiving USDT as payment for covering gas fees.

## How It Works

### 1. User Perspective
A user with 10 USDT but no ETH can:
1. Sign a meta-transaction authorizing:
   - The transfer of 10 USDT to the recipient
   - Payment of 1 USDT to the relayer
2. Submit the signed transaction to the relayer service
3. Transaction executes without requiring ETH

### 2. Relayer Perspective
The relayer:
1. Receives the signed meta-transaction
2. Verifies signature and USDT allowance
3. Executes the transaction using their ETH
4. Receives USDT payment for the service

## Key Components

### 1. Smart Contracts

#### TokenPaymentForwarder Contract
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/metatx/MinimalForwarder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TokenPaymentForwarder is MinimalForwarder, ReentrancyGuard {
    IERC20 public immutable paymentToken;
    uint256 public immutable minPayment;

    constructor(address _paymentToken, uint256 _minPayment) {
        paymentToken = IERC20(_paymentToken);
        minPayment = _minPayment;
    }

    function executeWithPayment(
        ForwardRequest calldata req,
        bytes calldata signature,
        PaymentInfo calldata paymentInfo
    ) public nonReentrant returns (bool, bytes memory) {
        require(verify(req, signature), "Invalid signature");
        require(paymentInfo.payment >= minPayment, "Payment too low");

        require(
            paymentToken.transferFrom(req.from, address(this), paymentInfo.payment),
            "Payment failed"
        );

        return execute(req, signature);
    }
}
```

#### Recipient Contract
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TokenRecipient is ERC2771Context {
    IERC20 public immutable token;

    constructor(address trustedForwarder, address _token)
        ERC2771Context(trustedForwarder)
    {
        token = IERC20(_token);
    }

    function receiveTokens(uint256 amount) external {
        // _msgSender() returns the original sender, not the forwarder
        require(
            token.transferFrom(_msgSender(), address(this), amount),
            "Transfer failed"
        );
    }
}
```

### 2. AWS Infrastructure

#### Message Queue (SQS)
```yaml
Resources:
  MetaTxQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 300
      MessageRetentionPeriod: 3600
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt DeadLetterQueue.Arn
        maxReceiveCount: 3
```

#### Relayer Lambda Function
```javascript
// AWS Lambda function
const { ethers } = require('ethers');
const AWS = require('aws-sdk');
const kms = new AWS.KMS();

exports.handler = async (event) => {
    const { request, signature, payment } = JSON.parse(event.Records[0].body);

    // Verify request
    const forwarder = new ethers.Contract(
        process.env.FORWARDER_ADDRESS,
        forwarderABI,
        provider
    );

    const isValid = await forwarder.verify(request, signature);
    if (!isValid) throw new Error('Invalid signature');

    // Execute transaction
    const signer = new ethers.Wallet(await getKMSKey());
    const tx = await forwarder.connect(signer).executeWithPayment(
        request,
        signature,
        payment
    );

    return tx.hash;
};
```

### 3. Client SDK
```typescript
export class GaslessTransactionSDK {
    private forwarder: Contract;
    private token: Contract;
    private signer: Signer;

    constructor(
        forwarderAddress: string,
        tokenAddress: string,
        signer: Signer
    ) {
        this.forwarder = new Contract(forwarderAddress, forwarderABI, signer);
        this.token = new Contract(tokenAddress, tokenABI, signer);
        this.signer = signer;
    }

    async transferTokens(
        to: string,
        amount: BigNumber,
        payment: BigNumber
    ): Promise<string> {
        // Approve forwarder to spend tokens
        await this.token.approve(this.forwarder.address, amount.add(payment));

        // Create and sign request
        const request = {
            from: await this.signer.getAddress(),
            to,
            value: 0,
            gas: 500000,
            nonce: await this.forwarder.getNonce(this.signer.getAddress()),
            data: this.token.interface.encodeFunctionData(
                "transfer",
                [to, amount]
            )
        };

        const signature = await this._signRequest(request);

        // Submit to relayer API
        const response = await fetch(RELAYER_API, {
            method: 'POST',
            body: JSON.stringify({ request, signature, payment })
        });

        return response.json().transactionHash;
    }
}
```

## Implementation Steps

1. **Deploy AWS Infrastructure**
   ```bash
   # Deploy CloudFormation stack
   aws cloudformation deploy \
       --template-file infrastructure.yaml \
       --stack-name gasless-relayer
   ```

2. **Deploy Smart Contracts**
   ```bash
   # Deploy contracts
   npx hardhat run scripts/deploy.js --network mainnet
   ```

3. **Configure Relayer**
   ```bash
   # Set environment variables
   aws lambda update-function-configuration \
       --function-name relayer \
       --environment Variables="{
           FORWARDER_ADDRESS=0x...,
           PAYMENT_TOKEN=0x...,
           MIN_PAYMENT=1000000
       }"
   ```

## Example Usage

```javascript
// Client-side code
const sdk = new GaslessTransactionSDK(
    forwarderAddress,
    usdtAddress,
    signer
);

// Transfer 10 USDT with 1 USDT payment
const tx = await sdk.transferTokens(
    recipientAddress,
    ethers.utils.parseUnits("10", 6),
    ethers.utils.parseUnits("1", 6)
);
```

## Security Considerations

1. **Signature Security**
   - EIP-712 typed data signing
   - Nonce-based replay protection
   - Trusted forwarder validation

2. **Payment Security**
   - Minimum payment requirements
   - Safe ERC20 operations
   - Reentrancy protection

3. **AWS Security**
   - KMS for key management
   - IAM roles with least privilege
   - VPC isolation

## Cost Analysis

1. **User Costs**
   - No ETH required
   - Small USDT fee (e.g., 1 USDT per transaction)

2. **Relayer Costs**
   - ETH for gas (~21,000 * gas price)
   - AWS infrastructure costs
   - Offset by USDT payments

## Conclusion
This implementation enables USDT holders to transact without ETH, using AWS infrastructure for secure and scalable relaying. The relayer receives USDT payments to cover gas costs, creating a sustainable gasless transaction system.
