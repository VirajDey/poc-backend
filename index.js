import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromB64 } from "@mysten/sui/utils";

dotenv.config();

const app = express();
app.use(cors({ origin: /http:\/\/localhost:3\d{2,4}/, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Sui Setup ---
const NETWORK = process.env.SUI_NETWORK || "testnet";
const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

let keypair;
try {
  if (process.env.SUI_MNEMONIC) {
    keypair = Ed25519Keypair.deriveKeypair(process.env.SUI_MNEMONIC);
  } else if (process.env.SUI_PRIVATE_KEY) {
    const raw = fromB64(process.env.SUI_PRIVATE_KEY.trim());
    let secretBytes;
    if (raw.length === 65) secretBytes = raw.slice(1);
    else if (raw.length === 64) secretBytes = raw;
    else if (raw.length === 32) secretBytes = raw;
    else throw new Error(`Unexpected private key length ${raw.length}`);
    keypair = Ed25519Keypair.fromSecretKey(secretBytes);
  } else {
    throw new Error("Provide either SUI_MNEMONIC or SUI_PRIVATE_KEY in .env");
  }
  console.log("🔐 Using address:", keypair.getPublicKey().toSuiAddress());
} catch (e) {
  console.error("❌ Failed to initialize keypair:", e.message);
  process.exit(1);
}

const signer = keypair;
if (!process.env.PACKAGE_ID) {
  console.error("❌ Missing PACKAGE_ID in .env");
  process.exit(1);
}

// --- Helper: Extract TxStatus events (preserve ALL fields) ---
function extractTxStatus(events) {
  if (!Array.isArray(events)) return [];
  const txStatus = events.filter((e) => {
    if (!e?.type) return false;
    // Accept any module path; just match final struct name case-insensitively
    const leaf = e.type.split('::').pop();
    return leaf && leaf.toLowerCase() === 'txstatus';
  });
  if (txStatus.length === 0) {
    // Fallback heuristic: look for events with action & status fields (vector<u8>) and sender
    for (const e of events) {
      const pj = e?.parsedJson;
      if (pj && 'action' in pj && 'status' in pj && 'sender' in pj) {
        txStatus.push(e);
      }
    }
  }

  const decode = (val) => {
    try {
      if (val == null) return null;
      if (Array.isArray(val)) {
        // assume array of byte values
        return Buffer.from(val).toString();
      }
      if (typeof val === 'string') {
        // try base64 first, fallback to utf8
        try {
          const b = Buffer.from(val, 'base64');
          // heuristic: if decoded has many replacement chars, fallback
          const txt = b.toString();
          if (txt.replace(/\uFFFD/g, '').length / txt.length < 0.8) return val; // keep original
          return txt;
        } catch {
          return Buffer.from(val).toString();
        }
      }
      return val;
    } catch {
      return null;
    }
  };

  return txStatus.map((e) => {
    const pj = e.parsedJson || {};
    const actionDecoded = decode(pj.action);
    const statusDecoded = decode(pj.status);
    return {
      // Keep original event reference minimal (avoid circular)
      raw_type: e.type,
      id: e.id || null,
      timestampMs: e.timestampMs || null,
      // Flatten parsedJson fields
      ...pj,
      action_decoded: actionDecoded !== pj.action ? actionDecoded : null,
      status_decoded: statusDecoded !== pj.status ? statusDecoded : null,
      // Provide entire raw event for completeness (without risking huge size)
      _raw: {
        type: e.type,
        id: e.id,
        packageId: e.packageId,
        transactionModule: e.transactionModule,
        sender: e.sender,
        bcs: e.bcs,
      },
    };
  });
}

// --- Helper: Execute and wait for tx ---
async function executeTx(tx, opts = {}) {
  console.log("⏳ Submitting transaction...");
  // Apply gas budget / price overrides if provided
  const envBudget = process.env.SUI_GAS_BUDGET && Number(process.env.SUI_GAS_BUDGET);
  const budget = opts.gasBudget || (envBudget && !isNaN(envBudget) ? envBudget : undefined);
  if (budget) {
    try { tx.setGasBudget(Number(budget)); console.log('⛽ Using gas budget', budget); } catch (e) { console.warn('Could not set gas budget', budget, e.message); }
  }
  if (opts.gasPrice) {
    try { tx.setGasPrice(Number(opts.gasPrice)); console.log('🔧 Overriding gas price', opts.gasPrice); } catch (e) { console.warn('Gas price override failed', e.message); }
  }
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEvents: true, showEffects: true, showObjectChanges: true },
  });

  console.log("✅ Digest:", result.digest);

  const status = await client.waitForTransaction({
    digest: result.digest,
    options: { showEvents: true, showEffects: true, showObjectChanges: true },
  });

  if (Array.isArray(status.events) && status.events.length) {
    console.log('📦 Event types:', status.events.map(e => e.type));
  } else {
    console.log('ℹ️ No events returned for this tx');
  }

  const txStatusEvents = extractTxStatus(status.events);
  if (txStatusEvents.length > 0) {
    console.log("📡 TxStatus events (extracted):", txStatusEvents);
  } else {
    console.log("ℹ️ No TxStatus events found (looked for struct named TxStatus)");
  }
app.get("/health", (_req, res) => res.json({ ok: true }));

// Diagnostic: fetch a transaction by digest and expose events + extracted status
app.get('/tx/:digest', async (req, res) => {
  try {
    const digest = req.params.digest;
    const tx = await client.getTransactionBlock({
      digest,
      options: { showEvents: true, showEffects: true, showObjectChanges: true },
    });
    res.json({
      digest,
      effectsStatus: tx.effects?.status?.status,
      effectsError: tx.effects?.status?.error || null,
      eventTypes: (tx.events || []).map(e => e.type),
      events: tx.events || [],
      extractedTxStatus: extractTxStatus(tx.events || []),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: list struct & function names in the counter module
app.get('/debug/module', async (_req, res) => {
  try {
    const pkg = process.env.PACKAGE_ID;
    const moduleName = 'counter';
    if (!pkg) throw new Error('Missing PACKAGE_ID');
    const mod = await client.getNormalizedMoveModule({ package: pkg, module: moduleName });
    res.json({
      package: pkg,
      module: moduleName,
      structs: Object.keys(mod.structs || {}),
      functions: Object.keys(mod.functions || {}),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

  if (status.effects?.status.status === "success") {
    console.log("🎉 SUCCESS");
  } else {
    console.error("❌ FAILURE:", status.effects?.status.error);
  }

  return { ...status, txStatusEvents };
}

// Helper to extract gasBudget from request
function extractGas(req) {
  const gb = (req.body && (req.body.gasBudget ?? req.body.gas_budget)) || req.query.gasBudget || req.query.gas_budget || process.env.SUI_GAS_BUDGET;
  const gp = (req.body && (req.body.gasPrice ?? req.body.gas_price)) || req.query.gasPrice || req.query.gas_price || process.env.SUI_GAS_PRICE;
  const gasBudget = gb && !isNaN(Number(gb)) ? Number(gb) : undefined;
  const gasPrice = gp && !isNaN(Number(gp)) ? Number(gp) : undefined;
  return { gasBudget, gasPrice };
}

// --- API: Create Counter ---
app.post("/create", async (req, res) => {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${process.env.PACKAGE_ID}::counter::create`,
      arguments: [],
    });
    const { gasBudget, gasPrice } = extractGas(req);
    const status = await executeTx(tx, { gasBudget, gasPrice });

    const created = status.objectChanges?.find(
      (c) =>
        c.type === "created" &&
        (c.objectType || "").endsWith("::counter::Counter")
    );
    let counterId = created?.objectId;

    if (!counterId) {
      const anyCreated =
        status.objectChanges?.filter((c) => c.type === "created") || [];
      for (const c of anyCreated) {
        if (!c.objectId) continue;
        try {
          const obj = await client.getObject({
            id: c.objectId,
            options: { showType: true },
          });
          const objType = obj.data?.type || c.objectType || "";
          if (objType.endsWith("::counter::Counter")) {
            counterId = c.objectId;
            break;
          }
        } catch {}
      }
    }

    if (counterId) {
      console.log("🆕 Counter created:", counterId);
      res.json({
        success: true,
        counterId,
        digest: status.digest,
        gasBudget,
        gasPrice,
        txStatusEvents: status.txStatusEvents,
        events: status.events || [],
      });
    } else {
      res.json({
        success: false,
        message: "No counter created",
        digest: status.digest,
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- API: Increment Counter ---
app.post("/increment", async (req, res) => {
  try {
    const counterId = process.env.COUNTER_ID || req.body.counterId;
    if (!counterId) throw new Error("Missing COUNTER_ID");

    const tx = new Transaction();
    tx.moveCall({
      target: `${process.env.PACKAGE_ID}::counter::increment`,
      arguments: [tx.object(counterId)],
    });

  const { gasBudget, gasPrice } = extractGas(req);
  const status = await executeTx(tx, { gasBudget, gasPrice });
    let value = null;
    try {
      const obj = await client.getObject({
        id: counterId,
        options: { showContent: true },
      });
      value = obj.data?.content?.fields?.value ?? null;
    } catch {}
    res.json({
      success: true,
      digest: status.digest,
      value,
      counterId,
      gasBudget,
      gasPrice,
      txStatusEvents: status.txStatusEvents,
      events: status.events || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: Reset Counter ---
app.post("/reset", async (req, res) => {
  try {
    const counterId = process.env.COUNTER_ID || req.body.counterId;
    if (!counterId) throw new Error("Missing COUNTER_ID");

    const tx = new Transaction();
    tx.moveCall({
      target: `${process.env.PACKAGE_ID}::counter::reset`,
      arguments: [tx.object(counterId)],
    });

  const { gasBudget, gasPrice } = extractGas(req);
  const status = await executeTx(tx, { gasBudget, gasPrice });
    let value = null;
    try {
      const obj = await client.getObject({
        id: counterId,
        options: { showContent: true },
      });
      value = obj.data?.content?.fields?.value ?? null;
    } catch {}
    res.json({
      success: true,
      digest: status.digest,
      value,
      counterId,
      gasBudget,
      gasPrice,
      txStatusEvents: status.txStatusEvents,
      events: status.events || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: Get Counter Value ---
app.get("/value", async (req, res) => {
  try {
    const counterId = process.env.COUNTER_ID || req.query.counterId;
    if (!counterId) throw new Error("Missing COUNTER_ID");

    const object = await client.getObject({
      id: counterId,
      options: { showContent: true },
    });
    const fields = object.data?.content?.fields;
    res.json({ value: fields?.value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
