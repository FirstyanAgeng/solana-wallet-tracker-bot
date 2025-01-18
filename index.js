require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { setIntervalAsync } = require("set-interval-async");
const { DateTime } = require("luxon");

// Telegram Bot Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Configuration
const CONFIG = {
  trackedWallets: [
    "5GbECLdJkC9MQwEvPjeT8qPKt7VbWeyWqPLw2BtqVMR",
    "5gn3uxhsZ7TtLDZwxKXPJuUTB9dEMgnb3oFJ6rKDjoX4",
    "CRVidEDtEUTYZisCxBZkpELzhQc9eauMLR3FWg74tReL",
    "GpaxwRPnFsygJaw1d9uf78Tzt7yDoZr5hBhfWEk7gyRT",
  ],
  requestLimit: 5,
  minAlertAmount: 1000, // Minimum amount for "Alpha Alert" in SOL
  updateInterval: 30000, // Update interval in milliseconds
  cacheExpiry: 3600000, // Cache expiry time in milliseconds (1 hour)
};

// Transaction class with improved structure
class Transaction {
  constructor(data) {
    this.wallet = data.wallet;
    this.signature = data.signature;
    this.type = data.type;
    this.timestamp = data.timestamp;
    this.status = data.status;
    this.amount = data.amount;
    this.sender = data.sender;
    this.receiver = data.receiver;
    this.createdAt = Date.now(); // For cache management
  }

  isExpired() {
    return Date.now() - this.createdAt > CONFIG.cacheExpiry;
  }
}

class RateLimiter {
  constructor(limit, interval) {
    this.limit = limit;
    this.interval = interval;
    this.requests = [];
  }
  async throttle() {
    const now = Date.now();
    this.requests = this.requests.filter((time) => now - time < this.interval);

    if (this.requests.length >= this.limit) {
      const oldestRequest = this.requests[0];
      const waitTime = this.interval - (now - oldestRequest);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.requests.push(now);
  }
}

// Solana Whale Tracker with improved error handling and API alternatives
class SolanaWhaleTracker {
  constructor() {
    this.subscribers = new Set();
    this.txCache = new Map(); // Changed to Map for better cache management
    this.rateLimiter = new RateLimiter(30, 60000); // 30 requests per minute

    this.apiEndpoints = {
      helius: {
        url: `https://api.helius.xyz/v0/addresses/{wallet}/transactions`,
        params: { "api-key": process.env.HELIUS_API_KEY },
      },
      solscan: {
        url: "https://public-api.solscan.io/transaction/last",
        params: { limit: 50 },
      },
      solanafm: {
        url: "https://api.solana.fm/v0/transactions/search",
        method: "POST",
      },
    };
  }

  // Clean expired transactions from cache
  cleanCache() {
    for (const [signature, tx] of this.txCache.entries()) {
      if (tx.isExpired()) {
        this.txCache.delete(signature);
      }
    }
  }

  async fetchHeliusTransactions(walletAddress) {
    await this.rateLimiter.throttle();
    const url = this.apiEndpoints.helius.url.replace("{wallet}", walletAddress);
    try {
      const response = await axios.get(url, {
        params: this.apiEndpoints.helius.params,
        timeout: 5000,
      });
      return response.data.map((tx) =>
        this.parseHeliusTransaction(tx, walletAddress)
      );
    } catch (error) {
      if (error.response?.status === 429) {
        // Wait longer on rate limit
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      throw error;
    }
  }

  async fetchSolscanTransactions(walletAddress) {
    await this.rateLimiter.throttle();
    try {
      const response = await axios.get(this.apiEndpoints.solscan.url, {
        params: {
          ...this.apiEndpoints.solscan.params,
          account: walletAddress,
        },
        headers: {
          accept: "application/json",
        },
        timeout: 5000,
      });
      return response.data.map((tx) =>
        this.parseSolscanTransaction(tx, walletAddress)
      );
    } catch (error) {
      if (error.response?.status === 404) {
        // Log specific error for debugging
        console.warn(`Solscan API returned 404 for wallet: ${walletAddress}`);
      }
      throw error;
    }
  }

  async fetchSolanaFMTransactions(walletAddress) {
    await this.rateLimiter.throttle();
    try {
      const response = await axios({
        method: this.apiEndpoints.solanafm.method,
        url: this.apiEndpoints.solanafm.url,
        data: {
          address: walletAddress,
          limit: 50,
        },
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 5000,
      });
      return response.data.map((tx) =>
        this.parseSolanaFMTransaction(tx, walletAddress)
      );
    } catch (error) {
      if (error.response?.status === 405) {
        console.warn(
          "SolanaFM API method not allowed, check API documentation for updates"
        );
      }
      throw error;
    }
  }

  async getWalletTransactions(walletAddress) {
    let errors = [];
    const attempts = [
      { name: "Helius", fn: this.fetchHeliusTransactions },
      { name: "Solscan", fn: this.fetchSolscanTransactions },
      { name: "SolanaFM", fn: this.fetchSolanaFMTransactions },
    ];

    for (const { name, fn } of attempts) {
      try {
        const transactions = await fn.call(this, walletAddress);
        if (transactions && transactions.length > 0) {
          return transactions.filter(
            (tx) => tx && !this.txCache.has(tx.signature)
          );
        }
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
        continue;
      }
    }

    if (errors.length === attempts.length) {
      console.error("All API attempts failed:", errors.join(", "));
    }
    return [];
  }

  parseHeliusTransaction(tx, walletAddress) {
    return new Transaction({
      wallet: walletAddress,
      signature: tx.signature,
      type: tx.type,
      timestamp: DateTime.fromMillis(tx.timestamp).toFormat(
        "yyyy-MM-dd HH:mm:ss"
      ),
      status: tx.status,
      amount: tx.amount ? parseFloat(tx.amount) : null,
      sender: tx.sourceAddress,
      receiver: tx.destinationAddress,
    });
  }

  parseSolscanTransaction(tx, walletAddress) {
    return new Transaction({
      wallet: walletAddress,
      signature: tx.txHash,
      type: tx.txType,
      timestamp: DateTime.fromMillis(tx.blockTime * 1000).toFormat(
        "yyyy-MM-dd HH:mm:ss"
      ),
      status: tx.status,
      amount: tx.lamport ? tx.lamport / 1e9 : null, // Convert lamports to SOL
      sender: tx.src,
      receiver: tx.dst,
    });
  }

  parseSolanaFMTransaction(tx, walletAddress) {
    return new Transaction({
      wallet: walletAddress,
      signature: tx.signatures[0],
      type: this.determineTransactionType(tx),
      timestamp: DateTime.fromISO(tx.blockTime).toFormat("yyyy-MM-dd HH:mm:ss"),
      status: tx.success ? "confirmed" : "failed",
      amount: this.extractSolanaFMAmount(tx),
      sender: tx.from,
      receiver: tx.to,
    });
  }

  determineTransactionType(tx) {
    // Add logic to determine transaction type based on instruction data
    if (tx.instructions?.some((inst) => inst.program === "system")) {
      return "SOL_TRANSFER";
    }
    return "UNKNOWN";
  }

  extractSolanaFMAmount(tx) {
    // Add logic to extract amount from SolanaFM transaction format
    const transferInst = tx.instructions?.find(
      (inst) => inst.program === "system" && inst.type === "transfer"
    );
    return transferInst ? parseFloat(transferInst.amount) / 1e9 : null;
  }

  formatWalletAlert(transactions) {
    if (transactions.length === 0) {
      return "🔍 No new transactions detected.";
    }

    let alertMessage = "🚨 *Wallet Transaction Update* 🚨\n\n";
    transactions.forEach((tx) => {
      const walletShort = `${tx.wallet.slice(0, 6)}...${tx.wallet.slice(-4)}`;
      alertMessage += `*Wallet:* \`${walletShort}\`\n`;
      alertMessage += `*Type:* ${tx.type}\n`;
      alertMessage += `*Time:* ${tx.timestamp}\n`;

      if (tx.amount !== null) {
        const alertLevel =
          tx.amount > CONFIG.minAlertAmount
            ? "🔴 Alpha Alert"
            : "🟢 Normal Alert";
        const senderShort = `${tx.sender.slice(0, 6)}...${tx.sender.slice(-4)}`;
        const receiverShort = `${tx.receiver.slice(0, 6)}...${tx.receiver.slice(
          -4
        )}`;

        alertMessage += `${alertLevel}\n`;
        alertMessage += `💰 *Transfer Details:*\n`;
        alertMessage += `From: \`${senderShort}\`\n`;
        alertMessage += `To: \`${receiverShort}\`\n`;
        alertMessage += `Amount: ${tx.amount.toFixed(2)} SOL\n`;
      }

      alertMessage += `[View Transaction](https://solscan.io/tx/${tx.signature})\n`;
      alertMessage += "➖➖➖➖➖➖➖➖➖➖\n";
    });

    return alertMessage;
  }

  async sendWalletAlerts() {
    await setIntervalAsync(async () => {
      try {
        this.cleanCache(); // Clean expired transactions
        const transactions = await this.fetchAllTransactions();

        if (transactions.length > 0) {
          const alertMessage = this.formatWalletAlert(transactions);

          // Store new transactions in cache
          transactions.forEach((tx) => {
            this.txCache.set(tx.signature, tx);
          });

          // Send alerts to all subscribers
          const sendPromises = Array.from(this.subscribers).map((chatId) =>
            bot
              .sendMessage(chatId, alertMessage, {
                parse_mode: "Markdown",
                disable_web_page_preview: true,
              })
              .catch((err) => {
                console.error(
                  `Failed to send message to ${chatId}:`,
                  err.message
                );
                if (err.response?.statusCode === 403) {
                  this.subscribers.delete(chatId);
                }
              })
          );

          await Promise.all(sendPromises);
        }
      } catch (error) {
        console.error("Error in sendWalletAlerts:", error);
      }
    }, CONFIG.updateInterval);
  }

  async fetchAllTransactions() {
    const tasks = CONFIG.trackedWallets.map((wallet) =>
      this.getWalletTransactions(wallet)
    );
    const results = await Promise.allSettled(tasks);
    return results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value)
      .flat();
  }
}

// Telegram Bot Handlers
const solanaTracker = new SolanaWhaleTracker();

bot.onText(/\/start/, (msg) => {
  solanaTracker.subscribers.add(msg.chat.id);
  const welcomeText = `
🎉 *Welcome to Solana Whale Tracker* 🎉

You will receive transaction updates every ${
    CONFIG.updateInterval / 1000
  } seconds!

Available commands:
/stop - Stop receiving alerts
/status - Check bot status
/wallets - View tracked wallets

Happy tracking! 🐋
`;
  bot.sendMessage(msg.chat.id, welcomeText, { parse_mode: "Markdown" });
});

bot.onText(/\/stop/, (msg) => {
  const wasSubscribed = solanaTracker.subscribers.delete(msg.chat.id);
  const message = wasSubscribed
    ? "✅ You have unsubscribed from alerts."
    : "❌ You are not subscribed to alerts.";
  bot.sendMessage(msg.chat.id, message);
});

bot.onText(/\/status/, (msg) => {
  const statusText = `
📊 *Bot Status*
Active Subscribers: ${solanaTracker.subscribers.size}
Tracked Wallets: ${CONFIG.trackedWallets.length}
Cached Transactions: ${solanaTracker.txCache.size}
Update Interval: ${CONFIG.updateInterval / 1000}s
Minimum Alert Amount: ${CONFIG.minAlertAmount} SOL
`;
  bot.sendMessage(msg.chat.id, statusText, { parse_mode: "Markdown" });
});

bot.onText(/\/wallets/, (msg) => {
  const walletsText = `
🔍 *Tracked Wallets*

${CONFIG.trackedWallets
  .map(
    (wallet, index) =>
      `${index + 1}. \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\``
  )
  .join("\n")}
`;
  bot.sendMessage(msg.chat.id, walletsText, { parse_mode: "Markdown" });
});

// Start the alert sending process
solanaTracker.sendWalletAlerts();
console.log("🚀 Solana Whale Tracker Bot is running...");
