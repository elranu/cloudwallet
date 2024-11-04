const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Gasless Transactions", function() {
    let owner, relayer, user, recipient;
    let mockUSDT, tokenPaymentForwarder, mockRecipient;

    const INITIAL_BALANCE = ethers.utils.parseUnits("1000", 6);  // 1000 USDT
    const TRANSFER_AMOUNT = ethers.utils.parseUnits("10", 6);    // 10 USDT
    const PAYMENT_AMOUNT = ethers.utils.parseUnits("1", 6);      // 1 USDT for gas
    const RELAYER_ETH = ethers.utils.parseEther("10.0");        // 10 ETH for relayer
    const USER_ETH = ethers.utils.parseEther("0.1");            // Increased ETH for approvals
    const CHAIN_ID = 31337;  // Hardhat's default chainId

    beforeEach(async function() {
        // Get signers
        [owner, relayer, user, recipient] = await ethers.getSigners();

        // Deploy MockUSDT
        const MockUSDT = await ethers.getContractFactory("MockUSDT");
        mockUSDT = await MockUSDT.deploy();
        await mockUSDT.deployed();
        console.log("MockUSDT deployed to:", mockUSDT.address);

        // Deploy TokenPaymentForwarder
        const TokenPaymentForwarder = await ethers.getContractFactory("TokenPaymentForwarder");
        tokenPaymentForwarder = await TokenPaymentForwarder.deploy(mockUSDT.address, PAYMENT_AMOUNT);
        await tokenPaymentForwarder.deployed();
        console.log("TokenPaymentForwarder deployed to:", tokenPaymentForwarder.address);

        // Deploy MockRecipient
        const MockRecipient = await ethers.getContractFactory("MockRecipient");
        mockRecipient = await MockRecipient.deploy(tokenPaymentForwarder.address, mockUSDT.address);
        await mockRecipient.deployed();
        console.log("MockRecipient deployed to:", mockRecipient.address);

        // Setup initial balances
        await mockUSDT.mint(user.address, INITIAL_BALANCE);
        await mockUSDT.connect(user).approve(tokenPaymentForwarder.address, ethers.constants.MaxUint256);
        await mockUSDT.connect(user).approve(mockRecipient.address, ethers.constants.MaxUint256);
        console.log("Initial USDT balance:", ethers.utils.formatUnits(await mockUSDT.balanceOf(user.address), 6));

        // Fund relayer with ETH
        await owner.sendTransaction({
            to: relayer.address,
            value: RELAYER_ETH
        });
        console.log("Relayer ETH balance:", ethers.utils.formatEther(await ethers.provider.getBalance(relayer.address)));

        // Set user's ETH balance to small amount
        await network.provider.send("hardhat_setBalance", [
            user.address,
            ethers.utils.hexValue(USER_ETH)
        ]);
        console.log("User ETH balance:", ethers.utils.formatEther(await ethers.provider.getBalance(user.address)));
    });

    it("should allow user with USDT but no ETH to transfer tokens", async function() {
        // Verify initial conditions
        const userEthBalance = await ethers.provider.getBalance(user.address);
        const initialUserUsdtBalance = await mockUSDT.balanceOf(user.address);
        const initialRelayerUsdtBalance = await mockUSDT.balanceOf(tokenPaymentForwarder.address);
        const initialRecipientUsdtBalance = await mockUSDT.balanceOf(mockRecipient.address);

        console.log("\nInitial Balances:");
        console.log("User ETH:", ethers.utils.formatEther(userEthBalance));
        console.log("User USDT:", ethers.utils.formatUnits(initialUserUsdtBalance, 6));
        console.log("Forwarder USDT:", ethers.utils.formatUnits(initialRelayerUsdtBalance, 6));
        console.log("Recipient USDT:", ethers.utils.formatUnits(initialRecipientUsdtBalance, 6));

        expect(userEthBalance).to.be.lt(ethers.utils.parseEther("0.2"));
        expect(initialUserUsdtBalance).to.equal(INITIAL_BALANCE);
        expect(initialRelayerUsdtBalance).to.equal(0);
        expect(initialRecipientUsdtBalance).to.equal(0);

        // Create forward request for token transfer through recipient contract
        const forwardRequest = {
            from: user.address,
            to: mockRecipient.address,
            value: 0,
            gas: 500000,
            nonce: await tokenPaymentForwarder.getNonce(user.address),
            data: mockRecipient.interface.encodeFunctionData("receiveTokens", [TRANSFER_AMOUNT])
        };

        console.log("\nForward Request:");
        console.log("From:", forwardRequest.from);
        console.log("To:", forwardRequest.to);
        console.log("Value:", forwardRequest.value.toString());
        console.log("Gas:", forwardRequest.gas.toString());
        console.log("Nonce:", forwardRequest.nonce.toString());
        console.log("Data:", forwardRequest.data);

        // Create payment info
        const paymentInfo = {
            payment: PAYMENT_AMOUNT,
            paymentSignature: "0x" // Not used in current implementation
        };

        // Sign the forward request using EIP-712
        const domain = {
            name: "MinimalForwarder",
            version: "0.0.1",
            chainId: CHAIN_ID,
            verifyingContract: tokenPaymentForwarder.address
        };

        const types = {
            ForwardRequest: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "gas", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "data", type: "bytes" }
            ]
        };

        const signature = await user._signTypedData(domain, types, forwardRequest);
        console.log("\nSignature:", signature);

        // Execute meta-transaction through relayer
        console.log("\nExecuting meta-transaction...");
        await tokenPaymentForwarder.connect(relayer).executeWithPayment(
            forwardRequest,
            signature,
            paymentInfo
        );

        // Verify final balances
        const finalUserUsdtBalance = await mockUSDT.balanceOf(user.address);
        const finalRelayerUsdtBalance = await mockUSDT.balanceOf(tokenPaymentForwarder.address);
        const finalRecipientUsdtBalance = await mockUSDT.balanceOf(mockRecipient.address);

        expect(finalUserUsdtBalance).to.equal(INITIAL_BALANCE.sub(TRANSFER_AMOUNT).sub(PAYMENT_AMOUNT));
        expect(finalRelayerUsdtBalance).to.equal(PAYMENT_AMOUNT);
        expect(finalRecipientUsdtBalance).to.equal(TRANSFER_AMOUNT);
    });

    it("should properly recover msg.sender in recipient contract", async function() {
        console.log("\nTesting msg.sender recovery...");

        // First verify direct call returns correct sender
        console.log("\nTesting direct call...");
        const directTx = await mockRecipient.connect(user).checkSender();
        const directReceipt = await directTx.wait();

        // Get all events from direct call
        console.log("\nDirect call events:");
        for (const event of directReceipt.events) {
            console.log("Event:", {
                address: event.address,
                event: event.event,
                args: event.args ? event.args.toString() : "No args",
                topics: event.topics,
                data: event.data
            });
        }

        // Verify trusted forwarder is properly set
        const isForwarderTrusted = await mockRecipient.isTrustedForwarderSet(tokenPaymentForwarder.address);
        expect(isForwarderTrusted).to.be.true;
        console.log("Trusted forwarder verified:", tokenPaymentForwarder.address);

        // Create forward request for checking sender
        const forwardRequest = {
            from: user.address,
            to: mockRecipient.address,
            value: 0,
            gas: 500000,
            nonce: await tokenPaymentForwarder.getNonce(user.address),
            data: mockRecipient.interface.encodeFunctionData("checkSender")
        };

        console.log("\nForward Request for Sender Check:");
        console.log("From:", forwardRequest.from);
        console.log("To:", forwardRequest.to);
        console.log("Data:", forwardRequest.data);

        // Create payment info
        const paymentInfo = {
            payment: PAYMENT_AMOUNT,
            paymentSignature: "0x"
        };

        // Sign the forward request using EIP-712
        const domain = {
            name: "MinimalForwarder",
            version: "0.0.1",
            chainId: CHAIN_ID,
            verifyingContract: tokenPaymentForwarder.address
        };

        const types = {
            ForwardRequest: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "gas", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "data", type: "bytes" }
            ]
        };

        const signature = await user._signTypedData(domain, types, forwardRequest);

        // Execute through relayer and verify msg.sender recovery
        const tx = await tokenPaymentForwarder.connect(relayer).executeWithPayment(
            forwardRequest,
            signature,
            paymentInfo
        );
        const receipt = await tx.wait();

        // Find and verify the SenderChecked event
        const senderCheckedEvent = receipt.events.find(e => {
            return e.topics[0] === '0x51403d670645dd8a249fd0b8489c7b68a02c74052579e085801be0c5c12f7633';
        });

        expect(senderCheckedEvent).to.not.be.undefined;

        // The sender address is in the last 20 bytes of the event data
        const senderAddress = '0x' + senderCheckedEvent.data.slice(-40);
        expect(ethers.utils.getAddress(senderAddress)).to.equal(ethers.utils.getAddress(user.address));
    });
});
