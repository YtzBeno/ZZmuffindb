require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { ethers } = require("ethers");
const uploadRoutes = require("./uploadRoutes");

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

// EVM provider for Sepolia
const sepoliaProvider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);

app.get("/", (req, res) => {
  res.send("Hello from the Pool API!");
});

// -----------------------------------------------------------------------
// Helper: Verify EVM tx on Sepolia
// -----------------------------------------------------------------------
async function verifyOnSepolia(txHash) {
  try {
    const receipt = await sepoliaProvider.getTransactionReceipt(txHash);
    // If receipt exists and status == 1 => success
    return receipt && receipt.status === 1;
  } catch (err) {
    console.error("Error verifying EVM tx:", err);
    return false;
  }
}

// -----------------------------------------------------------------------
// POST /api/transactions => insert a new transaction
// -----------------------------------------------------------------------
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

    // Normalize txType to lowercase
    const txTypeLower = txType.toLowerCase();

    // Verify transaction on-chain
    let verified = false;
    if (chain === "Sepolia") {
      verified = await verifyOnSepolia(txHashOrSig);
    }

    if (!verified) {
      return res
        .status(400)
        .json({ error: "Could not verify transaction on-chain" });
    }

    // Start DB transaction
    await db.query("BEGIN");

    // Insert transaction
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

    // Update pools table safely (handles NULL cases)
    const poolUpdateQuery = `
      UPDATE pools
      SET current_pool_balance = COALESCE(current_pool_balance, 0) ${
        txTypeLower === "deposit" ? "+" : "-"
      } $1,
          active_entries = GREATEST(COALESCE(active_entries, 0) ${
            txTypeLower === "deposit" ? "+" : "-"
          } 1, 0)
      WHERE id = $2;
    `;
    await db.query(poolUpdateQuery, [amountNumber, poolId]);

    // Participant updates
    if (txTypeLower === "deposit") {
      const participantInsertQuery = `
        INSERT INTO pool_participants (pool_id, user_address, amount, deposit_timestamp)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (pool_id, user_address)
        DO UPDATE SET 
          amount = pool_participants.amount + $3,
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

    // Commit DB transaction
    await db.query("COMMIT");

    res.json({ success: true, transaction: transactionResult.rows[0] });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Error in /api/transactions:", error);
    res.status(500).json({ error: "Server error" });
  }
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
      rate_per_second,
      max_deposit_percentage,
      pool_fee_percentage,
      seconds_wait,
      pool_website,
      pool_telegram,
      pool_x,
      contract_address,
      pool_token_account || null,
      parseFloat(current_pool_balance), // <-- parse to float for numeric column
      parseFloat(yield_value),
      yield_unit, // text
      parseFloat(deposit_limit),
      parseFloat(withdraw_fee),
      parseFloat(withdraw_lock),
      withdraw_lock_unit, // text
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
        p.rate_per_second,
        pp.amount AS deposited_amount,
        pp.deposit_timestamp,
        p.withdraw_lock,
        p.withdraw_lock_unit
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
