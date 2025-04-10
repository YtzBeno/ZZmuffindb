require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ethers } = require("ethers");
const uploadRoutes = require("./uploadRoutes");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", uploadRoutes);

// Postgres pool
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// EVM providers mapped by chain
const providers = {
  Sepolia: new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL),
  BSC: new ethers.JsonRpcProvider(process.env.BSC_RPC_URL),
  // Add other chains as needed
};

app.get("/", (req, res) => {
  res.send("Hello from the Pool API!");
});

async function verifyEvmTx(chain, txHash) {
  try {
    const provider = providers[chain];
    if (!provider) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const receipt = await provider.getTransactionReceipt(txHash);
    return receipt && receipt.status === 1;
  } catch (err) {
    console.error(`Error verifying EVM tx on ${chain}:`, err);
    return false;
  }
}

// -----------------------------------------------------------------------
// POST /api/transactions => insert a new transaction
// -----------------------------------------------------------------------
// POST /api/transactions
app.post("/api/transactions", async (req, res) => {
  try {
    const { chain, txHashOrSig, poolId, userAddress, amount, txType } =
      req.body;

    if (
      !chain ||
      !txHashOrSig ||
      !poolId ||
      !userAddress ||
      !txType ||
      amount === undefined
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const txTypeLower = txType.toLowerCase();

    // Verify transaction
    let verified = false;
    const supportedChains = Object.keys(providers);
    if (supportedChains.includes(chain)) {
      verified = await verifyEvmTx(chain, txHashOrSig);
    }
    if (!verified) {
      return res
        .status(400)
        .json({ error: "Could not verify transaction on-chain" });
    }

    await db.query("BEGIN");

    // 1) Insert transaction row
    const insertTransactionQuery = `
      INSERT INTO transactions (pool_id, transaction_type, amount, user_address, tx_hash_or_sig)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const transactionResult = await db.query(insertTransactionQuery, [
      poolId,
      txTypeLower,
      amount,
      userAddress,
      txHashOrSig,
    ]);

    const amountNumber = parseFloat(amount);

    // 2) Update the pools table
    const poolUpdateQuery = `
      UPDATE pools
      SET current_pool_balance = COALESCE(current_pool_balance, 0) ${
        txTypeLower === "deposit" ? "+" : "-"
      } $1,
          active_entries = GREATEST(COALESCE(active_entries, 0) ${
            txTypeLower === "deposit" ? "+" : "-"
          } 1, 0)
      WHERE id = $2
      RETURNING current_pool_balance, active_entries;
    `;
    const poolUpdateResult = await db.query(poolUpdateQuery, [
      amountNumber,
      poolId,
    ]);
    const updatedBalance = poolUpdateResult.rows[0].current_pool_balance;
    const updatedActiveEntries = poolUpdateResult.rows[0].active_entries;

    // 3) Update or remove participant
    if (txTypeLower === "deposit") {
      const participantInsertQuery = `
        INSERT INTO pool_participants (pool_id, user_address, amount, deposit_timestamp)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (pool_id, user_address)
        DO UPDATE SET 
          amount = pool_participants.amount + EXCLUDED.amount,
          deposit_timestamp = NOW();
      `;
      await db.query(participantInsertQuery, [
        poolId,
        userAddress,
        amountNumber,
      ]);
    } else if (txTypeLower === "withdraw") {
      await db.query(
        `DELETE FROM pool_participants WHERE pool_id = $1 AND user_address = $2;`,
        [poolId, userAddress]
      );
    }

    // 4) Insert into pool_history using updated values
    const historyInsertQuery = `
      INSERT INTO pool_history (pool_id, balance, active_entries)
      VALUES ($1, $2, $3);
    `;
    await db.query(historyInsertQuery, [
      poolId,
      updatedBalance,
      updatedActiveEntries,
    ]);

    await db.query("COMMIT");

    res.json({ success: true, transaction: transactionResult.rows[0] });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error in /api/transactions:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------------------------------------------------
// [NEW] api/api/pools/:poolId/history => get pool history information
// -----------------------------------------------------------------------
app.get("/api/pools/:poolId/history", async (req, res) => {
  const { poolId } = req.params;
  const sql = `
    SELECT balance, active_entries, snapshot_date
    FROM pool_history
    WHERE pool_id = $1
    ORDER BY snapshot_date ASC
  `;
  const { rows } = await db.query(sql, [poolId]);
  res.json({ success: true, data: rows });
});

// -----------------------------------------------------------------------
// [NEW] GET /api/pools/:poolId/transactions => list transactions for that pool
// -----------------------------------------------------------------------
app.get("/api/pools/:poolId/transactions", async (req, res) => {
  try {
    const { poolId } = req.params;

    // Query the transactions table for this pool, order by newest first
    // Make sure your 'transactions' table has a 'created_on' or similar timestamp
    const sql = `
      SELECT 
        id,
        pool_id,
        transaction_type,
        amount,
        user_address,
        tx_hash_or_sig,
        created_on
      FROM transactions
      WHERE pool_id = $1
      ORDER BY created_on DESC
      LIMIT 50;
    `;
    const result = await db.query(sql, [poolId]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Error listing transactions:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------------------------------------------------
// Start the server
// -----------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Pool API listening on port ${PORT}`);
});

// -----------------------------------------------------------------------
// POOL ROUTES
// -----------------------------------------------------------------------
app.post("/api/pools", async (req, res) => {
  try {
    const {
      pool_name,
      pool_image_gif,
      pool_description,
      chain,
      is_native_coin,
      token_address,
      operator_address,
      owner_address,
      rate_per_second,
      max_deposit_percentage,
      pool_fee_percentage,
      seconds_wait,
      pool_website,
      pool_telegram,
      pool_x,
      contract_address,
      pool_token_account,
      current_pool_balance,

      // NEW:
      yield_value,
      yield_unit,
      deposit_limit,
      withdraw_fee,
      withdraw_lock,
      withdraw_lock_unit,
    } = req.body;

    if (!pool_name || !chain) {
      return res
        .status(400)
        .json({ error: "Missing required fields (pool_name, chain)." });
    }

    const insertPoolQuery = `
      INSERT INTO pools (
        pool_name,
        pool_image_gif,
        pool_description,
        chain,
        is_native_coin,
        token_address,
        operator_address,
        owner_address,
        rate_per_second,
        max_deposit_percentage,
        pool_fee_percentage,
        seconds_wait,
        pool_website,
        pool_telegram,
        pool_x,
        contract_address,
        pool_token_account,
        current_pool_balance,
        yield_value,
        yield_unit,
        deposit_limit,
        withdraw_fee,
        withdraw_lock,
        withdraw_lock_unit,
        active_entries
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
              $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 1)
      RETURNING *;
    `;

    const result = await db.query(insertPoolQuery, [
      pool_name,
      pool_image_gif,
      pool_description,
      chain,
      is_native_coin,
      token_address,
      operator_address,
      owner_address,

      rate_per_second.toString(),
      parseFloat(max_deposit_percentage),
      parseFloat(pool_fee_percentage),
      parseFloat(seconds_wait),

      pool_website,
      pool_telegram,
      pool_x,
      contract_address,
      pool_token_account || null,

      current_pool_balance.toString(),
      parseFloat(yield_value),
      yield_unit,
      parseFloat(deposit_limit),
      parseFloat(withdraw_fee),
      parseFloat(withdraw_lock),
      withdraw_lock_unit,
    ]);

    return res.json({ success: true, pool: result.rows[0] });
  } catch (error) {
    console.error("Error in POST /api/pools:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/pools", async (req, res) => {
  try {
    const allPools = await db.query("SELECT * FROM pools ORDER BY id DESC");
    res.json(allPools.rows);
  } catch (error) {
    console.error("Error in GET /api/pools:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/pools/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const poolResult = await db.query("SELECT * FROM pools WHERE id = $1", [
      id,
    ]);

    if (poolResult.rows.length === 0) {
      return res.status(404).json({ error: "Pool not found" });
    }

    res.json(poolResult.rows[0]);
  } catch (error) {
    console.error("Error in GET /api/pools/:id:", error);
    res.status(500).json({ error: "Server error" });
  }
});

function convertLockToSeconds(lockValue, lockUnit) {
  const units = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400,
    weeks: 604800,
    months: 2592000,
  };
  return lockValue * (units[lockUnit] || 1);
}

app.get("/api/dashboard/:walletAddress", async (req, res) => {
  try {
    const { walletAddress } = req.params;

    const poolsCreatedQuery = `
      SELECT 
        id,
        pool_name,
        chain,
        current_pool_balance,
        created_on
      FROM pools
      WHERE owner_address = $1
    `;

    const poolsDepositedQuery = `
      SELECT DISTINCT ON (p.id)
        p.id,
        p.pool_name,
        p.chain,
        p.current_pool_balance,
        pp.amount AS deposited_amount,
        pp.deposit_timestamp,
        p.withdraw_lock,
        p.withdraw_lock_unit,
        p.rate_per_second
      FROM pools p
      JOIN pool_participants pp ON pp.pool_id = p.id
      WHERE pp.user_address = $1
      ORDER BY p.id, pp.deposit_timestamp DESC
    `;

    const [createdResult, depositedResult] = await Promise.all([
      db.query(poolsCreatedQuery, [walletAddress]),
      db.query(poolsDepositedQuery, [walletAddress]),
    ]);

    const createdPools = createdResult.rows.map((pool) => ({
      type: "Pool Created",
      ...pool,
    }));

    const depositedPools = depositedResult.rows.map((pool) => ({
      type: "Deposit",
      id: pool.id,
      pool_name: pool.pool_name,
      chain: pool.chain,
      current_pool_balance: pool.current_pool_balance,
      deposited_amount: pool.deposited_amount,
      deposit_timestamp: pool.deposit_timestamp,
      withdraw_lock_seconds: convertLockToSeconds(
        pool.withdraw_lock,
        pool.withdraw_lock_unit
      ),
      rate_per_second: pool.rate_per_second,
    }));

    const combinedPools = [...createdPools, ...depositedPools].sort(
      (a, b) =>
        new Date(b.created_on || b.deposit_timestamp) -
        new Date(a.created_on || a.deposit_timestamp)
    );

    res.json({ success: true, pools: combinedPools });
  } catch (err) {
    console.error("Error fetching dashboard data:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------------------------------------------------
// 1Inch
// -----------------------------------------------------------------------

const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY;

// Example route: GET /oneinch/tokens/:chainId
app.get("/oneinch/tokens/:chainId", async (req, res) => {
  try {
    const chainId = req.params.chainId; // e.g. 56 for BSC
    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/tokens`;

    const config = {
      headers: {
        Authorization: `Bearer ${ONEINCH_API_KEY}`, // Add your API key
      },
    };

    // Forward the request to 1inch:
    const response = await axios.get(url, config);
    // response.data should contain the JSON from 1inch

    // Return the JSON back to the caller (your React app):
    return res.json(response.data);
  } catch (err) {
    console.error("1inch tokens error:", err.message);
    // Send some error response to front-end
    return res.status(500).json({ error: err.message });
  }
});

// Example route #2: Get quote
app.get("/oneinch/quote", async (req, res) => {
  try {
    // The front-end can pass query params: chainId, fromToken, toToken, amount, fee, etc.
    const { chainId, fromTokenAddress, toTokenAddress, amount, fee } =
      req.query;

    const url = `https://api.1inch.dev/swap/v6.0/${chainId}/quote`;

    // 1inch expects certain params (the exact param names differ from v5).
    // For v6 aggregator, see their docs for "swap/v6.0/{chain}/quote"
    // Typically fromTokenAddress => 'src', toTokenAddress => 'dst', etc. or usage of new param names.
    // For example, if the docs say "dst" is the name for the 'toTokenAddress', do that:
    // This is just an example. Adjust based on the official doc for v6 aggregator.

    const config = {
      headers: {
        Authorization: `Bearer ${ONEINCH_API_KEY}`,
      },
      params: {
        src: fromTokenAddress, // or fromTokenAddress if v6 supports that param
        dst: toTokenAddress, // or toTokenAddress if v6 supports that param
        amount: amount,
        // fee is optional, if your aggregator usage supports it
        fee: fee || "0",
      },
      paramsSerializer: {
        indexes: null, // so axios doesn't do array indexes in query strings
      },
    };

    const response = await axios.get(url, config);
    res.json(response.data);
  } catch (err) {
    console.error("Quote Error:", err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/oneinch/swap", async (req, res) => {
  try {
    const {
      chainId,
      src,
      dst,
      amount,
      from,
      origin,
      fee,
      referrer,
      slippage, // <-- explicitly add this param
    } = req.query;

    const swapUrl = `https://api.1inch.dev/swap/v6.0/${chainId}/swap`;

    const config = {
      headers: {
        Authorization: `Bearer ${ONEINCH_API_KEY}`,
      },
      params: {
        src,
        dst,
        amount,
        from,
        origin,
        slippage: slippage || "0.5", // <-- Set a sensible default slippage (e.g., 0.5%)
        fee,
        referrer,
      },
      paramsSerializer: {
        indexes: null,
      },
    };

    const response = await axios.get(swapUrl, config);
    return res.json(response.data);
  } catch (err) {
    console.error("Swap error:", err?.response?.data || err.message);
    return res.status(500).json({ error: err.message });
  }
});
