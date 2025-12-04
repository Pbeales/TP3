require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const ModbusRTU = require("modbus-serial");
const mysql = require("mysql2/promise");

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ CONFIG PLC ------------------
const PLC_IP = process.env.PLC_IP || "172.16.1.24";
const PLC_PORT = parseInt(process.env.PLC_PORT || "502");
const MODBUS_ID = parseInt(process.env.MODBUS_ID || "1");

const networkErrors = ["ESOCKETTIMEDOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH"];

// ------------------ DATABASE ------------------
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "rootpassword",
  database: process.env.DB_NAME || "supervision",
  port: parseInt(process.env.DB_PORT || "3306")
});

// ------------------ MODBUS CLIENT ------------------
const client = new ModbusRTU();
let connected = false;

async function connectModbus() {
  try {
    await client.connectTCP(PLC_IP, { port: PLC_PORT });
    client.setID(MODBUS_ID);
    client.setTimeout(2000);
    connected = true;
    console.log(`✔ Modbus connecté à ${PLC_IP}:${PLC_PORT}`);
  } catch (e) {
    connected = false;
    console.error("❌ Erreur Modbus:", e.message);
    if (e.errno && networkErrors.includes(e.errno)) {
      console.log("Reconnexion dans 5s...");
      setTimeout(connectModbus, 5000);
    }
  }
}

client.on("error", (err) => {
  console.error("Modbus client error:", err.message);
  connected = false;
  setTimeout(connectModbus, 5000);
});

connectModbus();

// ------------------ PARSEUR ADRESSES SCHNEIDER ------------------
function parseAddress(raw) {
  raw = raw.trim().toUpperCase();

  let m = raw.match(/^%([IQ])(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const X = parseInt(m[2], 10);
    const Y = parseInt(m[3], 10);
    const Z = parseInt(m[4], 10);
    return { kind: "digital", type: m[1] === "I" ? "INPUT" : "OUTPUT", modbus_address: X * 64 + Y * 8 + Z };
  }

  m = raw.match(/^%([IQ])W(\d+)$/);
  if (m) return { kind: "analog", type: m[1] === "I" ? "ANALOG_INPUT" : "ANALOG_OUTPUT", modbus_address: parseInt(m[2], 10) };

  return null;
}

// ------------------ LECTURE VARIABLE ------------------
async function readVariable(v) {
  if (!connected) return { raw: null, value: null, kind: "error", error: "Modbus non connecté" };
  try {
    if (v.kind === "digital" && v.type === "INPUT") {
      const r = await client.readDiscreteInputs(v.modbus_address, 1);
      console.log(`Lecture digital INPUT coil ${v.modbus_address}:`, r.data[0]);
      return { raw: r.data[0], value: r.data[0] ? 1 : 0, kind: "digital" };
    }
    if (v.kind === "digital" && v.type === "OUTPUT") {
      const r = await client.readCoils(v.modbus_address, 1);
      console.log(`Lecture digital OUTPUT coil ${v.modbus_address}:`, r.data[0]);
      return { raw: r.data[0], value: r.data[0] ? 1 : 0, kind: "digital" };
    }
    if (v.kind === "analog" && v.type === "ANALOG_INPUT") {
      const r = await client.readInputRegisters(v.modbus_address, 1);
      console.log(`Lecture analog INPUT reg ${v.modbus_address}:`, r.data[0]);
      return { raw: r.data[0], value: r.data[0], kind: "analog" };
    }
    if (v.kind === "analog" && v.type === "ANALOG_OUTPUT") {
      const r = await client.readHoldingRegisters(v.modbus_address, 1);
      console.log(`Lecture analog OUTPUT reg ${v.modbus_address}:`, r.data[0]);
      return { raw: r.data[0], value: r.data[0], kind: "analog" };
    }
    return { raw: null, value: null, kind: "unknown" };
  } catch (err) {
    console.error("Erreur lecture Modbus:", err.message);
    return { raw: null, value: null, kind: "error", error: err.message };
  }
}

// ------------------ FRONTEND ------------------
app.use(express.static(path.join(__dirname, "./frontend")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "./frontend/index.html")));

// ------------------ ROUTES API ------------------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: connected ? "Modbus connecté" : "Modbus non connecté" });
});

app.get("/api/values", async (req, res) => {
  const [vars] = await db.query("SELECT * FROM variables ORDER BY id ASC");
  const out = await Promise.all(vars.map(async v => ({ ...v, ...await readVariable(parseAddress(v.address_raw)) })));
  res.json(out);
});

app.post("/api/variables", async (req, res) => {
  const { name, comment, address_raw } = req.body;
  const parsed = parseAddress(address_raw);
  if (!parsed) return res.status(400).json({ error: "Adresse Schneider invalide" });

  await db.query(
    "INSERT INTO variables (name, comment, address_raw, type, modbus_address) VALUES (?,?,?,?,?)",
    [name, comment || null, address_raw, parsed.type, parsed.modbus_address]
  );
  res.json({ ok: true });
});

app.delete("/api/variables/:id", async (req, res) => {
  await db.query("DELETE FROM variables WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/variables/:id/write", async (req, res) => {
  const { id } = req.params;
  const { value } = req.body;
  const [rows] = await db.query("SELECT * FROM variables WHERE id = ?", [id]);
  if (!rows.length) return res.status(404).json({ error: "Variable non trouvée" });

  const variable = rows[0];
  const v = parseAddress(variable.address_raw);
  if (!v) return res.status(400).json({ error: "Adresse Schneider invalide" });

  if (!connected) return res.status(500).json({ error: "Modbus non connecté" });

  try {
    if (v.kind === "digital" && v.type === "OUTPUT") {
      await client.writeCoil(v.modbus_address, value ? true : false);
      console.log(`Écriture coil ${v.modbus_address}:`, value);
    } else if (v.kind === "analog" && v.type === "ANALOG_OUTPUT") {
      await client.writeRegister(v.modbus_address, Number(value));
      console.log(`Écriture reg ${v.modbus_address}:`, value);
    } else return res.status(400).json({ error: "Impossible d’écrire sur cette variable" });

    res.json({ ok: true });
  } catch (err) { 
    console.error("Erreur écriture Modbus:", err.message);
    res.status(500).json({ error: err.message }); 
  }
});

// ------------------ SERVEUR ------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✔ Backend prêt sur port ${port}`));
