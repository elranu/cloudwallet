const ethers = require('ethers');
const AWS = require('aws-sdk');
const sqs = new AWS.SQS();
const kms = new AWS.KMS();

// USDT Contract ABI (only the methods we need)
const USDT_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transferFrom(address sender, address recipient, uint256 amount) returns (bool)"
];

// ERC2771 Forwarder ABI
const FORWARDER_ABI = [
  "function verify(tuple(address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)",
  "function execute(tuple(address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool, bytes)"
];

// Configuration
const config = {
  usdtAddress: process.env.USDT_ADDRESS,
  forwarderAddress: process.env.FORWARDER_ADDRESS,
  minPayment: ethers.utils.parseUnits("1", 6), // 1 USDT minimum (6 decimals)
  gasBuffer: 1.1, // 10% buffer for gas price fluctuations
  rpcUrl: process.env.RPC_URL
};

// Initialize provider
const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);

// Get relayer's private key from KMS
async function getRelayerKey() {
  const { Plaintext } = await kms.decrypt({
    KeyId: process.env.KMS_KEY_ID,
    CiphertextBlob: Buffer.from(process.env.ENCRYPTED_PRIVATE_KEY, 'base64')
  }).promise();
  return new ethers.Wallet(Plaintext.toString(), provider);
}

// Initialize contracts
async function getContracts(signer) {
  const usdtContract = new ethers.Contract(config.usdtAddress, USDT_ABI, signer);
  const forwarderContract = new ethers.Contract(config.forwarderAddress, FORWARDER_ABI, signer);
  return { usdtContract, forwarderContract };
}

// Verify USDT allowance
async function verifyAllowance(userAddress, amount) {
  const relayer = await getRelayerKey();
  const { usdtContract } = await getContracts(relayer);
  const allowance = await usdtContract.allowance(userAddress, relayer.address);
  return allowance.gte(amount);
}

// Calculate required USDT payment based on gas cost
async function calculatePayment(gasLimit, gasPrice) {
  // Get ETH/USD price from an oracle (simplified version)
  const ethToUsdRate = 3000; // Example fixed rate: 1 ETH = 3000 USD
  const gasCost = gasLimit.mul(gasPrice);
  const ethCost = ethers.utils.formatEther(gasCost);
  const usdCost = parseFloat(ethCost) * ethToUsdRate;

  // Add profit margin (e.g., 10%)
  const totalUsdCost = usdCost * 1.1;

  // Convert to USDT (6 decimals)
  return ethers.utils.parseUnits(totalUsdCost.toFixed(6), 6);
}

// Process meta-transaction
async function processMetaTransaction(metaTx) {
  const relayer = await getRelayerKey();
  const { usdtContract, forwarderContract } = await getContracts(relayer);

  // Verify signature
  const valid = await forwarderContract.verify(
    [metaTx.from, metaTx.to, metaTx.value, metaTx.gas, metaTx.nonce, metaTx.data],
    metaTx.signature
  );

  if (!valid) {
    throw new Error('Invalid signature');
  }

  // Calculate required USDT payment
  const gasPrice = await provider.getGasPrice();
  const requiredPayment = await calculatePayment(
    ethers.BigNumber.from(metaTx.gas),
    gasPrice
  );

  // Verify USDT allowance
  const hasAllowance = await verifyAllowance(metaTx.from, requiredPayment);
  if (!hasAllowance) {
    throw new Error('Insufficient USDT allowance');
  }

  // Execute meta-transaction
  const tx = await forwarderContract.execute(
    [metaTx.from, metaTx.to, metaTx.value, metaTx.gas, metaTx.nonce, metaTx.data],
    metaTx.signature,
    {
      gasLimit: metaTx.gas,
      gasPrice: gasPrice.mul(config.gasBuffer)
    }
  );

  // Wait for transaction confirmation
  const receipt = await tx.wait();

  // Collect USDT payment
  const paymentTx = await usdtContract.transferFrom(
    metaTx.from,
    relayer.address,
    requiredPayment
  );
  await paymentTx.wait();

  return {
    metaTxHash: receipt.transactionHash,
    paymentTxHash: paymentTx.hash,
    usdtAmount: requiredPayment.toString()
  };
}

// Lambda handler
exports.handler = async (event) => {
  try {
    const messages = event.Records;
    const results = [];

    for (const message of messages) {
      const metaTx = JSON.parse(message.body);

      try {
        const result = await processMetaTransaction(metaTx);
        console.log('Transaction processed successfully:', result);
        results.push(result);

        // Delete processed message from queue
        await sqs.deleteMessage({
          QueueUrl: process.env.QUEUE_URL,
          ReceiptHandle: message.receiptHandle
        }).promise();

      } catch (error) {
        console.error('Failed to process transaction:', error);
        // Message will return to queue after visibility timeout
        results.push({ error: error.message });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ results })
    };

  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
