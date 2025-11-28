// backend/server.js
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const ModbusRTU = require("modbus-serial");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const DB_HOST = process.env.DB_HOST || "mariadb";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "root";
const DB_NAME = process.env.DB_NAME || "supervision";
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const PORT = parseInt(process.env.PORT, 10) || 3000;

console.log("DB config:", { DB_HOST, DB_USER, DB_NAME, DB_PORT });

// MySQL pool
const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Cache des clients Modbus par automate.id
const modbusClients = {}; // { [automateId]: { client, lastConnect } }

function addressFromRaw(raw) {
  // attendu: "%Q0.6.5" ou "%I0.5.5"
  // extraction simple
  const m = raw.match(/^%([QI])\d*\.(\d+)\.(\d+)$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const byte = parseInt(m[2], 10);
  const bit = parseInt(m[3], 10);
  const addr = byte * 8 + bit;
  return { type: type === "Q" ? "OUTPUT" : "INPUT", modbus_address: addr };
}

async function getModbusClient(automate) {
  // automate: { id, ip, port }
  if (!automate) throw new Error("automate requis");
  const key = automate.id;
  if (modbusClients[key] && modbusClients[key].client) {
    // vérifier connectivité simple
    try {
      // ping: readCoils 0,1 - cheap
      return modbusClients[key].client;
    } catch (e) {
      // fallthrough reconnect
    }
  }
  // create and connect
  const client = new ModbusRTU();
  try {
    await client.connectTCP(automate.ip, { port: automate.port, timeout: 2000 });
    client.setID(1);
    modbusClients[key] = { client, lastConnect: Date.now() };
    console.log(`Modbus connecté à ${automate.ip}:${automate.port} (id=${key})`);
    return client;
  } catch (err) {
    console.error(`Impossible de connecter Modbus ${automate.ip}:${automate.port} -> ${err.message}`);
    throw err;
  }
}

// saver: insert history
async function saveHistory(variable_id, value) {
  try {
    await db.query("INSERT INTO history (variable_id, value) VALUES (?, ?)", [variable_id, value]);
  } catch (err) {
    console.error("Erreur saveHistory:", err.message);
  }
}

// read a single variable live from automate
async function readVariableLive(variable) {
  try {
    const [automates] = await db.query("SELECT * FROM automates WHERE id = ?", [variable.automate_id]);
    if (automates.length === 0) throw new Error("Automate introuvable");
    const automate = automates[0];
    const client = await getModbusClient(automate);
    const addr = variable.modbus_address;
    if (variable.type === "OUTPUT") {
      // coils
      const resp = await client.readCoils(addr, 1);
      return resp.data[0] ? 1 : 0;
    } else {
      // INPUT -> discrete inputs
      const resp = await client.readDiscreteInputs(addr, 1);
      return resp.data[0] ? 1 : 0;
    }
  } catch (err) {
    console.error(`readVariableLive id=${variable.id} (${variable.address_raw}):`, err.message);
    throw err;
  }
}

// write single coil (for OUTPUT variables)
async function writeVariable(variable_id, value) {
  try {
    const [vars] = await db.query("SELECT v.*, a.ip, a.port FROM variables v JOIN automates a ON v.automate_id=a.id WHERE v.id = ?", [variable_id]);
    if (vars.length === 0) throw new Error("Variable introuvable");
    const v = vars[0];
    if (v.type !== "OUTPUT") throw new Error("Variable non écrivable (pas une sortie)");
    const client = await getModbusClient({ id: v.automate_id, ip: v.ip, port: v.port });
    const addr = v.modbus_address;
    // write single coil (true/false)
    await client.writeCoil(addr, !!value);
    // save to history the written state
    await saveHistory(variable_id, value ? 1 : 0);
    return { ok: true };
  } catch (err) {
    console.error("Erreur writeVariable:", err.message);
    throw err;
  }
}

// Cron scheduler - load variables and schedule reads
let cronJobs = {};
async function refreshSchedules() {
  try {
    // stop all jobs
    Object.values(cronJobs).forEach((j) => { try { j.stop(); } catch (e) {} });
  } catch (e) {}
  cronJobs = {};

  try {
    const [vars] = await db.query("SELECT v.*, a.ip, a.port FROM variables v JOIN automates a ON v.automate_id=a.id");
    vars.forEach((v) => {
      let freq = parseInt(v.frequency, 10);
      if (!Number.isFinite(freq) || freq <= 0) freq = 5;
      const interval = `*/${freq} * * * * *`; // every freq seconds
      try {
        const job = cron.schedule(interval, async () => {
          try {
            const liveVal = await readVariableLive(v).catch(() => null);
            if (liveVal !== null) {
              await saveHistory(v.id, liveVal);
            }
          } catch (e) {
            console.error("Erreur lecture cron variable:", e.message);
          }
        });
        cronJobs[v.id] = job;
      } catch (e) {
        console.error("Erreur création cron:", e.message);
      }
    });
    console.log("Tâches cron rafraîchies:", Object.keys(cronJobs).length);
  } catch (err) {
    console.error("Erreur refreshSchedules:", err.message);
  }
}

// --- Routes ---

app.get("/api/health", (req, res) => res.json({ status: "ok", message: "Backend opérationnel" }));

// Automates
app.get("/api/automates", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM automates");
  res.json(rows);
});
app.post("/api/automates", async (req, res) => {
  const { name, ip, port } = req.body;
  if (!name || !ip) return res.status(400).json({ error: "name & ip requis" });
  await db.query("INSERT INTO automates (name, ip, port) VALUES (?, ?, ?)", [name, ip, port || 502]);
  res.json({ ok: true });
});

// Variables - list
app.get("/api/variables", async (req, res) => {
  const [rows] = await db.query("SELECT v.*, a.name as automate_name, a.ip as automate_ip FROM variables v JOIN automates a ON v.automate_id=a.id ORDER BY v.id ASC");
  res.json(rows);
});

// Get single variable history
app.get("/api/history/:id", async (req, res) => {
  const id = req.params.id;
  const [rows] = await db.query("SELECT timestamp, value FROM history WHERE variable_id = ? ORDER BY timestamp ASC", [id]);
  res.json(rows);
});

// Add variable (client provides address_raw and type; server computes modbus_address)
app.post("/api/variables", async (req, res) => {
  try {
    const { automate_id, name, address_raw, type, frequency } = req.body;
    if (!automate_id || !name || !address_raw || !type) return res.status(400).json({ error: "automate_id,name,address_raw,type requis" });
    const parsed = addressFromRaw(address_raw);
    if (!parsed) return res.status(400).json({ error: "address_raw format invalide (ex %Q0.6.5)" });
    const modbus_address = parsed.modbus_address;
    await db.query("INSERT INTO variables (automate_id, name, address_raw, type, modbus_address, frequency) VALUES (?, ?, ?, ?, ?, ?)",
      [automate_id, name.trim(), address_raw.trim(), type === "INPUT" ? "INPUT" : "OUTPUT", modbus_address, frequency || 5]);
    await refreshSchedules();
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/variables:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete variable
app.delete("/api/variables/:id", async (req, res) => {
  const id = req.params.id;
  await db.query("DELETE FROM variables WHERE id = ?", [id]);
  await refreshSchedules();
  res.json({ ok: true });
});

// Read a variable live (one-shot)
app.get("/api/variables/read/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query("SELECT v.*, a.ip, a.port FROM variables v JOIN automates a ON v.automate_id=a.id WHERE v.id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Variable introuvable" });
    const val = await readVariableLive(rows[0]);
    res.json({ value: val });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write a variable (only OUTPUT)
app.post("/api/variables/write", async (req, res) => {
  try {
    const { id, value } = req.body;
    if (id == null || value == null) return res.status(400).json({ error: "id & value requis" });
    await writeVariable(id, value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// manual refresh
app.post("/api/refresh", async (req, res) => {
  try {
    await refreshSchedules();
    res.json({ message: "Cron mis à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start: wait DB ready then run
const startServer = async () => {
  let attempts = 0;
  while (attempts < 10) {
    try {
      await db.query("SELECT 1");
      break;
    } catch (e) {
      attempts++;
      console.log("DB non prête, attente...");
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  app.listen(PORT, async () => {
    console.log(`Backend lancé sur 0.0.0.0:${PORT}`);
    await refreshSchedules();
  });
};
startServer();
