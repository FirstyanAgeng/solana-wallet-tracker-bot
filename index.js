require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { setIntervalAsync } = require("set-interval-async");
const { DateTime } = require("luxon");
const web3 = require("@solana/web3.js");
const { PublicKey } = require("@solana/web3.js"); // Import PublicKey for better clarity
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required in .env file");
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Configuration
const CONFIG = {
  trackedWallets: [], // Removed tracked wallets
  knownDexPrograms: [
    "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Raydium
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Orca
    "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter
  ],
  rpcEndpoints: ["https://api.mainnet-beta.solana.com"],
  rateLimit: {
    requestsPerSecond: 5,
    timeWindow: 1000,
  },
  updateInterval: 120000, // 2 minutes
  cacheExpiry: 3600000, // 1 hour
  maxRetries: 3,
  batchSize: 2,
  minTokenAmount: 100, // Minimum token amount to trigger alert
};

// Rate Limiter Class
class RateLimiter {
  constructor(requestsPerSecond, timeWindow) {
    this.tokens = requestsPerSecond;
    this.maxTokens = requestsPerSecond;
    this.timeWindow = timeWindow;
    this.lastRefill = Date.now();
  }

  async getToken() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;

    // Refill tokens based on time passed
    if (timePassed > this.timeWindow) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }

    if (this.tokens <= 0) {
      const waitTime = this.timeWindow - (now - this.lastRefill);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, waitTime))
      );
      return this.getToken();
    }

    this.tokens--;
    return true;
  }
}

// Transaction Cache Class
class TransactionCache {
  constructor(expiryTime) {
    this.cache = new Map();
    this.expiryTime = expiryTime;
  }

  set(key, value) {
    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
    });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.expiryTime) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  clean() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.expiryTime) {
        this.cache.delete(key);
      }
    }
  }

  size() {
    return this.cache.size;
  }
}

// Main Tracker Class
class SolanaTokenTracker {
  constructor() {
    this.subscribers = new Set();
    this.txCache = new TransactionCache(CONFIG.cacheExpiry);
    this.rateLimiter = new RateLimiter(
      CONFIG.rateLimit.requestsPerSecond,
      CONFIG.rateLimit.timeWindow
    );
    this.currentRpcIndex = 0;
    this.initializeConnection();
  }

  initializeConnection() {
    this.connection = new web3.Connection(
      CONFIG.rpcEndpoints[this.currentRpcIndex],
      {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000,
        wsEndpoint: undefined,
      }
    );
    console.log(
      `Connected to RPC: ${CONFIG.rpcEndpoints[this.currentRpcIndex]}`
    );
  }

  rotateRpcEndpoint() {
    this.currentRpcIndex =
      (this.currentRpcIndex + 1) % CONFIG.rpcEndpoints.length;
    this.initializeConnection();
  }

  async retryOperation(operation, context = "") {
    let lastError;

    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        await this.rateLimiter.getToken();
        return await operation();
      } catch (error) {
        lastError = error;
        const isRateLimit =
          error.message.includes("429") ||
          error.message.includes("Too many requests");

        if (isRateLimit) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.log(
            `Rate limited ${context}. Retrying after ${delay}ms (${attempt}/${CONFIG.maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          this.rotateRpcEndpoint();
        } else if (!error.message.includes("fetch failed")) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async parseTokenTransfer(tx, meta) {
    async function fetchMemeCoins() {
      try {
        const response = await fetch("https://api.example.com/memecoins"); // Replace with actual API URL
        if (!response.ok) {
          throw new Error("Network response was not ok");
        }
        return await response.json();
      } catch (error) {
        console.error("Error fetching meme coins:", error);
        return {};
      }
    }
    try {
      if (
        !tx?.transaction?.message ||
        !meta?.postTokenBalances ||
        !meta?.preTokenBalances
      ) {
        return null;
      }

      const accountKeys = tx.transaction.message.accountKeys.map((key) =>
        typeof key === "string" ? key : key.toBase58()
      );

      const isDexTransaction = accountKeys.some((key) =>
        CONFIG.knownDexPrograms.includes(key)
      );

      if (!isDexTransaction) return null;

      const tokenTransfers = [];

      for (const postBalance of meta.postTokenBalances) {
        const preBalance = meta.preTokenBalances.find(
          (pre) => pre.accountIndex === postBalance.accountIndex
        );

        if (!preBalance || !postBalance?.uiTokenAmount?.amount) continue;

        const balanceChange =
          Number(postBalance.uiTokenAmount.amount) -
          Number(preBalance.uiTokenAmount.amount);

        if (balanceChange > CONFIG.minTokenAmount) {
          tokenTransfers.push({
            mint: postBalance.mint,
            amount:
              balanceChange /
              Math.pow(10, postBalance.uiTokenAmount.decimals || 0),
            receiver: accountKeys[postBalance.accountIndex],
            decimals: postBalance.uiTokenAmount.decimals || 0,
          });
        }
      }

      return tokenTransfers.length > 0 ? tokenTransfers : null;
    } catch (error) {
      console.error("Error parsing token transfer:", error);
      return null;
    }
  }

  identifyDex(tx) {
    try {
      const programIds = tx.transaction.message.accountKeys.map((key) =>
        typeof key === "string" ? key : key.toBase58()
      );

      if (programIds.includes(CONFIG.knownDexPrograms[0])) return "Raydium";
      if (programIds.includes(CONFIG.knownDexPrograms[1])) return "Orca";
      if (programIds.includes(CONFIG.knownDexPrograms[2])) return "Jupiter";
      return "Unknown DEX";
    } catch (error) {
      console.error("Error identifying DEX:", error);
      return "Unknown DEX";
    }
  }

  async getWalletTransactions() {
    const walletAddress =
      CONFIG.trackedWallets[
        Math.floor(Math.random() * CONFIG.trackedWallets.length)
      ]; // Select a random wallet address
    try {
      const publicKey = new web3.PublicKey(walletAddress);

      const signatures = await this.retryOperation(
        async () =>
          this.connection.getSignaturesForAddress(
            publicKey,
            { limit: 5 },
            "confirmed"
          ),
        `getting signatures for ${walletAddress}`
      );

      const newSignatures = signatures.filter(
        (sig) => !this.txCache.get(sig.signature)
      );

      if (newSignatures.length === 0) return [];

      const allTransactions = [];

      for (let i = 0; i < newSignatures.length; i += CONFIG.batchSize) {
        const batch = newSignatures.slice(i, i + CONFIG.batchSize);

        const batchTransactions = await Promise.all(
          batch.map(async (sig) => {
            try {
              const tx = await this.retryOperation(
                async () =>
                  this.connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                  }),
                `getting transaction ${sig.signature}`
              );

              if (!tx) return null;

              const tokenTransfers = await this.parseTokenTransfer(tx, tx.meta);
              if (!tokenTransfers) return null;

              return tokenTransfers.map((transfer) => ({
                wallet: walletAddress,
                signature: sig.signature,
                type: "TOKEN_PURCHASE",
                timestamp: tx.blockTime
                  ? DateTime.fromSeconds(tx.blockTime).toFormat(
                      "yyyy-MM-dd HH:mm:ss"
                    )
                  : DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss"),
                status: "confirmed",
                amount: transfer.amount,
                receiver: transfer.receiver,
                tokenMint: transfer.mint,
                dex: this.identifyDex(tx),
                createdAt: Date.now(),
              }));
            } catch (error) {
              console.error(
                `Error processing transaction ${sig.signature}:`,
                error
              );
              return null;
            }
          })
        );

        allTransactions.push(
          ...batchTransactions.filter((tx) => tx !== null).flat()
        );

        // Add delay between batches
        if (i + CONFIG.batchSize < newSignatures.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Cache new transactions
      allTransactions.forEach((tx) => {
        this.txCache.set(tx.signature, tx);
      });

      return allTransactions;
    } catch (error) {
      console.error(`Error fetching transactions for ${walletAddress}:`, error);
      return [];
    }
  }

  formatAlert(transactions) {
    if (transactions.length === 0) {
      return "🔍 No new token purchases detected.";
    }

    let message = "🚨 *New Token Purchases Detected* 🚨\n\n";

    transactions.forEach((tx) => {
      const walletShort = `${tx.wallet.slice(0, 6)}...${tx.wallet.slice(-4)}`;
      const tokenShort = `${tx.tokenMint.slice(0, 6)}...${tx.tokenMint.slice(
        -4
      )}`;

      message += `*Wallet:* \`${walletShort}\`\n`;
      message += `*DEX:* ${tx.dex}\n`;
      message += `*Time:* ${tx.timestamp}\n`;
      message += `*Token:* \`${tokenShort}\`\n`;
      message += `*Amount:* ${tx.amount.toLocaleString()} tokens\n`;
      message += `[View Transaction](https://solscan.io/tx/${tx.signature})\n`;
      message += `[View Token](https://solscan.io/token/${tx.tokenMint})\n`;
      message += "➖➖➖➖➖➖➖➖➖➖\n";
    });

    return message;
  }

  async start() {
    console.log("🚀 Starting Solana Token Tracker...");

    await setIntervalAsync(async () => {
      try {
        this.txCache.clean();

        const transactions = [];
        for (const wallet of CONFIG.trackedWallets) {
          const walletTxs = await this.getWalletTransactions(wallet);
          transactions.push(...walletTxs);
        }

        if (transactions.length > 0) {
          const message = this.formatAlert(transactions);

          const sendPromises = Array.from(this.subscribers).map((chatId) =>
            bot
              .sendMessage(chatId, message, {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
              })
              .catch((err) => {
                console.error(`Failed to send message to ${chatId}:`, err);
                if (err.response?.statusCode === 403) {
                  this.subscribers.delete(chatId);
                }
              })
          );

          await Promise.all(sendPromises);
        }
      } catch (error) {
        console.error("Error in tracker loop:", error);
      }
    }, CONFIG.updateInterval);
  }

  addSubscriber(chatId) {
    this.subscribers.add(chatId);
  }

  removeSubscriber(chatId) {
    return this.subscribers.delete(chatId);
  }

  getStatus() {
    return {
      activeSubscribers: this.subscribers.size,
      trackedWallets: CONFIG.trackedWallets.length,
      cachedTransactions: this.txCache.size(),
      updateInterval: CONFIG.updateInterval / 1000,
      currentRpc: CONFIG.rpcEndpoints[this.currentRpcIndex],
    };
  }
}

// Initialize tracker
const tokenTracker = new SolanaTokenTracker();

// Bot Commands
bot.onText(/\/start/, (msg) => {
  tokenTracker.addSubscriber(msg.chat.id);
  const welcomeText = `
🎉 *Welcome to Solana Token Tracker* 🎉

You will receive transaction updates every ${
    CONFIG.updateInterval / 1000
  } seconds.

Available commands:
/stop - Stop receiving alerts
/status - Check bot status
/wallets - View tracked wallets

Happy tracking! 🐋
`;
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: "Markdown" });
});
bot.onText(/\/stop/, (msg) => {
  const wasSubscribed = tokenTracker.removeSubscriber(msg.chat.id);
  const message = wasSubscribed
    ? "✅ You have unsubscribed from token alerts."
    : "❌ You were not subscribed to alerts.";

  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/\/status/, (msg) => {
  const status = tokenTracker.getStatus();
  const statusMessage = `
📊 *Bot Status* 📊

• Active Subscribers: ${status.activeSubscribers}
• Tracked Wallets: ${status.trackedWallets}
• Cached Transactions: ${status.cachedTransactions}
• Update Interval: ${status.updateInterval} seconds
• Current RPC: ${status.currentRpc}
  `;

  bot.sendMessage(msg.chat.id, statusMessage, { parse_mode: "Markdown" });
});

bot.onText(/\/wallets/, (msg) => {
  const walletsMessage = `
🔍 *Tracked Wallets* 🔍

${CONFIG.trackedWallets
  .map((wallet, index) => `${index + 1}. \`${wallet}\``)
  .join("\n")}
  `;

  bot.sendMessage(msg.chat.id, walletsMessage, { parse_mode: "Markdown" });
});

// Start the token tracker
tokenTracker.start();

console.log("🤖 Telegram Bot is running...");
