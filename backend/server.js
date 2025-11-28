// backend/server.js
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const ModbusRTU = require("modbus-serial");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// DB pool
const db = mysql.createPool({
  host: process.env.DB_HOST || "mariadb",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "supervision",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// PLC config (single automate)
const PLC_IP = process.env.PLC_IP || "172.16.1.24";
const PLC_PORT = parseInt(process.env.PLC_PORT || "502", 10);

// global modbus client (reused)
let modbusClient = null;
let modbusLastConnect = 0;

async function getModbusClient() {
  // if client exists and seems connected, reuse
  if (modbusClient) {
    return modbusClient;
  }
  const client = new ModbusRTU();
  try {
    await client.connectTCP(PLC_IP, { port: PLC_PORT, timeout: 2000 });
    client.setID(1);
    modbusClient = client;
    modbusLastConnect = Date.now();
    console.log("Modbus connecté à", PLC_IP + ":" + PLC_PORT);
    return modbusClient;
  } catch (err) {
    modbusClient = null;
    throw new Error("Impossible de se connecter au PLC: " + err.message);
  }
}

// Parse address formats:
// digital: %Q0.6.5 or %I0.5.5  -> modbus bit index = byte*8 + bit
// analog: %IW<number> or %QW<number> -> register index
function parseAddress(raw) {
  if (!raw || typeof raw !== "string") return null;
  raw = raw.trim();

  // digital pattern: %Q0.6.5 or %I0.5.5
  const d = raw.match(/^%([QI])\d*\.(\d+)\.(\d+)$/i);
  if (d) {
    const letter = d[1].toUpperCase();
    const byte = parseInt(d[2], 10);
    const bit = parseInt(d[3], 10);
    const modbus_address = byte * 8 + bit;
    return {
      kind: "digital",
      type: letter === "Q" ? "OUTPUT" : "INPUT",
      modbus_address
    };
  }

  // analog simple: %IW100 or %QW50
  const a = raw.match(/^%(I|Q)W(\d+)$/i);
  if (a) {
    const side = a[1].toUpperCase();
    const idx = parseInt(a[2], 10);
    return {
      kind: "analog",
      type: side === "I" ? "ANALOG_INPUT" : "ANALOG_OUTPUT",
      modbus_address: idx
    };
  }

  // fallback: try to extract trailing number
  const f = raw.match(/^%([IQ]W?)\d*(?:\.(\d+))?(?:\.(\d+))?$/i);
  if (f) {
    const tag = f[1].toUpperCase();
    const last = f[3] || f[2];
    const idx = last ? parseInt(last, 10) : 0;
    if (tag.startsWith("IW")) return { kind: "analog", type: "ANALOG_INPUT", modbus_address: idx };
    if (tag.startsWith("QW")) return { kind: "analog", type: "ANALOG_OUTPUT", modbus_address: idx };
  }

  return null;
}

function applyScaling(raw, vRow) {
  // if scaling present (manual), use it
  if (vRow.raw_min != null && vRow.raw_max != null && vRow.scale_min != null && vRow.scale_max != null) {
    const rawMin = Number(vRow.raw_min);
    const rawMax = Number(vRow.raw_max);
    const sMin = Number(vRow.scale_min);
    const sMax = Number(vRow.scale_max);
    if (rawMax === rawMin) return sMin;
    const scaled = sMin + ((raw - rawMin) * (sMax - sMin)) / (rawMax - rawMin);
    return Number(scaled.toFixed(3));
  }
  return raw;
}

async function readVariableLive(vRow) {
  // vRow: row from DB (type, modbus_address, etc.)
  try {
    const client = await getModbusClient();

    if (vRow.type === "INPUT") {
      const resp = await client.readDiscreteInputs(vRow.modbus_address, 1);
      const bit = resp.data[0] ? 1 : 0;
      return { raw: bit, value: bit, kind: "digital" };
    }

    if (vRow.type === "OUTPUT") {
      const resp = await client.readCoils(vRow.modbus_address, 1);
      const bit = resp.data[0] ? 1 : 0;
      return { raw: bit, value: bit, kind: "digital" };
    }

    if (vRow.type === "ANALOG_INPUT") {
      const resp = await client.readInputRegisters(vRow.modbus_address, 1);
      const raw = resp.data[0];
      const value = applyScaling(raw, vRow);
      return { raw, value, kind: "analog" };
    }

    if (vRow.type === "ANALOG_OUTPUT") {
      const resp = await client.readHoldingRegisters(vRow.modbus_address, 1);
      const raw = resp.data[0];
      const value = applyScaling(raw, vRow);
      return { raw, value, kind: "analog" };
    }

    return { raw: null, value: null, kind: "unknown" };
  } catch (err) {
    // On any error (e.g. PLC offline) return nulls and include message for debugging
    return { raw: null, value: null, kind: "error", error: err.message };
  }
}

// --- API routes ---

// health
app.get("/api/health", (req, res) => res.json({ status: "ok", message: "Backend opérationnel" }));

// list variables metadata
app.get("/api/variables", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM variables ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// add variable
app.post("/api/variables", async (req, res) => {
  try {
    const { name, comment, address_raw, frequency, unit, raw_min, raw_max, scale_min, scale_max } = req.body;
    if (!name || !address_raw) return res.status(400).json({ error: "name & address_raw requis" });

    const parsed = parseAddress(address_raw);
    if (!parsed) return res.status(400).json({ error: "address_raw format invalide" });

    const dbType = parsed.type;
    const modbusAddr = parsed.modbus_address;

    await db.query(
      `INSERT INTO variables 
      (name, comment, address_raw, type, modbus_address, frequency, unit, raw_min, raw_max, scale_min, scale_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, comment || null, address_raw, dbType, modbusAddr, frequency || 1, unit || null, raw_min || null, raw_max || null, scale_min || null, scale_max || null]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// remove variable
app.delete("/api/variables/:id", async (req, res) => {
  try {
    const id = req.params.id;
    await db.query("DELETE FROM variables WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// read all values (live). This reads variables in DB and queries PLC.
app.get("/api/values", async (req, res) => {
  try {
    const [vars] = await db.query("SELECT * FROM variables ORDER BY id ASC");
    const promises = vars.map(async (v) => {
      const read = await readVariableLive(v);
      return {
        id: v.id,
        name: v.name,
        comment: v.comment,
        address_raw: v.address_raw,
        type: v.type,
        unit: v.unit,
        raw: read.raw,
        value: read.value,
        kind: read.kind,
        error: read.error || null
      };
    });
    const results = await Promise.all(promises);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// read single variable by id (manual read)
app.get("/api/variables/read/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query("SELECT * FROM variables WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Variable introuvable" });
    const v = rows[0];
    const r = await readVariableLive(v);
    res.json({ id: v.id, raw: r.raw, value: r.value, kind: r.kind, error: r.error || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server after ensuring DB connectivity
const PORT = parseInt(process.env.PORT || "3000", 10);
const start = async () => {
  let attempts = 0;
  while (attempts < 12) {
    try {
      await db.query("SELECT 1");
      break;
    } catch (e) {
      attempts++;
      console.log("Waiting for DB...", attempts);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log(`Backend listening on 0.0.0.0:${PORT}`);
  });
};
start();
