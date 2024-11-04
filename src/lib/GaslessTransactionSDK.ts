import { ethers } from 'ethers';
import { TypedDataField } from '@ethersproject/abstract-signer';

/**
 * ABI for ERC20 token (USDT) interactions
 */
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address recipient, uint256 amount) returns (bool)'
];

/**
 * ABI for TokenPaymentForwarder contract
 */
const FORWARDER_ABI = [
  'function executeWithTokenPayment((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data, uint256 payment) request, bytes signature) returns (bool, bytes)',
  'function getNonce(address from) view returns (uint256)',
  'function minPayment() view returns (uint256)'
];

export interface ForwardRequest {
  from: string;
  to: string;
  value: string;
  gas: string;
  nonce: string;
  data: string;
  payment: string;
}

export class GaslessTransactionSDK {
  private provider: ethers.providers.Provider;
  private signer: ethers.Signer;
  private usdtContract: ethers.Contract;
  private forwarderContract: ethers.Contract;
  private relayerUrl: string;

  constructor(
    provider: ethers.providers.Provider,
    signer: ethers.Signer,
    usdtAddress: string,
    forwarderAddress: string,
    relayerUrl: string
  ) {
    this.provider = provider;
    this.signer = signer;
    this.usdtContract = new ethers.Contract(usdtAddress, ERC20_ABI, signer);
    this.forwarderContract = new ethers.Contract(forwarderAddress, FORWARDER_ABI, signer);
    this.relayerUrl = relayerUrl;
  }

  /**
   * Check if user has sufficient USDT balance
   */
  async hasUSDTBalance(amount: string): Promise<boolean> {
    const userAddress = await this.signer.getAddress();
    const balance = await this.usdtContract.balanceOf(userAddress);
    const requiredAmount = ethers.utils.parseUnits(amount, 6); // USDT has 6 decimals
    return balance.gte(requiredAmount);
  }

  /**
   * Approve USDT spending by forwarder contract
   */
  async approveUSDT(amount: string): Promise<ethers.ContractTransaction> {
    const parsedAmount = ethers.utils.parseUnits(amount, 6);
    return await this.usdtContract.approve(this.forwarderContract.address, parsedAmount);
  }

  /**
   * Get the domain separator for EIP-712 signing
   */
  private async getDomainData() {
    const chainId = (await this.provider.getNetwork()).chainId;
    return {
      name: 'TokenPaymentForwarder',
      version: '0.0.1',
      chainId,
      verifyingContract: this.forwarderContract.address
    };
  }

  /**
   * Sign a forward request using EIP-712
   */
  private async signRequest(request: ForwardRequest): Promise<string> {
    const domain = await this.getDomainData();
    const types = {
      ForwardRequest: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'gas', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'payment', type: 'uint256' }
      ]
    };

    return await this.signer._signTypedData(domain, types, request);
  }

  /**
   * Create a forward request for USDT transfer
   */
  private async createForwardRequest(
    recipient: string,
    amount: string,
    payment: string
  ): Promise<ForwardRequest> {
    const from = await this.signer.getAddress();
    const nonce = await this.forwarderContract.getNonce(from);
    const transferData = this.usdtContract.interface.encodeFunctionData('transfer', [
      recipient,
      ethers.utils.parseUnits(amount, 6)
    ]);

    return {
      from,
      to: this.usdtContract.address,
      value: '0',
      gas: '300000', // Estimated gas limit
      nonce: nonce.toString(),
      data: transferData,
      payment: ethers.utils.parseUnits(payment, 6).toString()
    };
  }

  /**
   * Submit transaction to relayer
   */
  private async submitToRelayer(
    request: ForwardRequest,
    signature: string
  ): Promise<{ transactionHash: string }> {
    const response = await fetch(this.relayerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        request,
        signature
      })
    });

    if (!response.ok) {
      throw new Error(`Relayer error: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * Transfer USDT without requiring ETH
   * @param recipient Address to receive USDT
   * @param amount Amount of USDT to transfer
   * @param payment Amount of USDT to pay relayer
   */
  async transferUSDT(
    recipient: string,
    amount: string,
    payment: string
  ): Promise<{ transactionHash: string }> {
    // Check USDT balance
    const totalAmount = ethers.utils.parseUnits(amount, 6)
      .add(ethers.utils.parseUnits(payment, 6));

    if (!(await this.hasUSDTBalance(ethers.utils.formatUnits(totalAmount, 6)))) {
      throw new Error('Insufficient USDT balance');
    }

    // Check and approve USDT allowance if needed
    const userAddress = await this.signer.getAddress();
    const allowance = await this.usdtContract.allowance(
      userAddress,
      this.forwarderContract.address
    );

    if (allowance.lt(totalAmount)) {
      const approveTx = await this.approveUSDT(
        ethers.utils.formatUnits(totalAmount, 6)
      );
      await approveTx.wait();
    }

    // Create and sign forward request
    const request = await this.createForwardRequest(recipient, amount, payment);
    const signature = await this.signRequest(request);

    // Submit to relayer
    return await this.submitToRelayer(request, signature);
  }

  /**
   * Get minimum required payment amount
   */
  async getMinimumPayment(): Promise<string> {
    const minPayment = await this.forwarderContract.minPayment();
    return ethers.utils.formatUnits(minPayment, 6);
  }

  /**
   * Example usage:
   *
   * const sdk = new GaslessTransactionSDK(
   *   provider,
   *   signer,
   *   "0xUSDT_ADDRESS",
   *   "0xFORWARDER_ADDRESS",
   *   "https://relayer-api.example.com"
   * );
   *
   * // Transfer 10 USDT with 1 USDT payment to relayer
   * const result = await sdk.transferUSDT(
   *   "0xRECIPIENT",
   *   "10.0",
   *   "1.0"
   * );
   *
   * console.log("Transaction hash:", result.transactionHash);
   */
}
