// backend/server.js
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");

const app = express();

// --- Middlewares ---
app.use(cors());
app.use(bodyParser.json());

// --- Config DB & Serveur ---
const DB_HOST = process.env.DB_HOST || "mariadb";
const DB_USER = process.env.DB_USER || "root";
const DB_PASSWORD = process.env.DB_PASSWORD || "root";
const DB_NAME = process.env.DB_NAME || "supervision";
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const PORT = parseInt(process.env.PORT, 10) || 3000;

console.log("📦 Config DB :", { DB_HOST, DB_USER, DB_NAME, DB_PORT });

// --- Pool MySQL ---
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

// Stockage des tâches cron par id de variable
let cronJobs = {};

// --- Simulation de lecture (Modbus plus tard) ---
async function readValueFake() {
  return Number((Math.random() * 100).toFixed(2));
}

// --- (Re)chargement des tâches cron depuis la BDD ---
async function refreshSchedules() {
  console.log("🔄 Rechargement des tâches de supervision...");

  // Stop et vide les anciennes tâches
  try {
    Object.values(cronJobs).forEach((job) => {
      try {
        job.stop();
      } catch (e) {}
    });
  } catch (e) {
    console.error("Erreur lors de l'arrêt des anciens cron :", e.message);
  }

  cronJobs = {};

  try {
    const [vars] = await db.query("SELECT * FROM variables");
    console.log(`📊 ${vars.length} variables trouvées en BDD.`);

    vars.forEach((v) => {
      let freq = parseInt(v.frequency, 10);
      if (!Number.isFinite(freq) || freq <= 0) freq = 5;

      // cron en secondes : */freq * * * * *
      const interval = `*/${freq} * * * * *`;

      try {
        const job = cron.schedule(interval, async () => {
          try {
            const value = await readValueFake();
            await db.query(
              "INSERT INTO history (variable_id, value) VALUES (?, ?)",
              [v.id, value]
            );
          } catch (err) {
            console.error(
              `Erreur insertion history pour variable ${v.id}:`,
              err.message
            );
          }
        });

        cronJobs[v.id] = job;
      } catch (err) {
        console.error(
          `Erreur création cron pour variable ${v.id}:`,
          err.message
        );
      }
    });

    console.log("✔ Tâches actives :", Object.keys(cronJobs).length);
  } catch (err) {
    console.error("Erreur lors du refreshSchedules:", err.message);
  }
}

// --- Routes ---
// Healthcheck simple
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend opérationnel" });
});

// Liste des variables
app.get("/api/variables", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM variables ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error("GET /api/variables:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Ajout d'une variable
app.post("/api/variables", async (req, res) => {
  try {
    let { name, ip, register_address, frequency } = req.body;

    if (!name || !ip || register_address == null || frequency == null) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    register_address = parseInt(register_address, 10);
    frequency = parseInt(frequency, 10);

    if (!Number.isFinite(register_address) || register_address < 0) {
      return res
        .status(400)
        .json({ error: "Adresse de registre invalide (nombre positif)" });
    }
    if (!Number.isFinite(frequency) || frequency <= 0) {
      return res
        .status(400)
        .json({ error: "Fréquence invalide (nombre > 0)" });
    }

    const [result] = await db.query(
      "INSERT INTO variables (name, ip, register_address, frequency) VALUES (?, ?, ?, ?)",
      [name.trim(), ip.trim(), register_address, frequency]
    );

    // Rechargement des tâches après ajout
    await refreshSchedules();

    res.json({ message: "Variable ajoutée", id: result.insertId });
  } catch (err) {
    console.error("POST /api/variables:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Suppression d'une variable
app.delete("/api/variables/:id", async (req, res) => {
  try {
    const id = req.params.id;

    await db.query("DELETE FROM variables WHERE id = ?", [id]);

    // Arrêt du cron spécifique si encore présent
    if (cronJobs[id]) {
      try {
        cronJobs[id].stop();
      } catch (e) {}
      delete cronJobs[id];
    }

    // Rechargement global pour être sûr d'être synchro avec la BDD
    await refreshSchedules();

    res.json({ message: "Variable supprimée" });
  } catch (err) {
    console.error("DELETE /api/variables/:id:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Historique d'une variable
app.get("/api/history/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await db.query(
      "SELECT timestamp, value FROM history WHERE variable_id = ? ORDER BY timestamp ASC",
      [id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/history/:id:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Export CSV
app.get("/api/export", async (req, res) => {
  try {
    const id = req.query.id;
    const start = req.query.start;
    const end = req.query.end;

    if (!id) return res.status(400).json({ error: "id requis" });

    let sql = "SELECT timestamp, value FROM history WHERE variable_id = ?";
    const params = [id];

    if (start) {
      sql += " AND timestamp >= ?";
      params.push(start + " 00:00:00");
    }
    if (end) {
      sql += " AND timestamp <= ?";
      params.push(end + " 23:59:59");
    }
    sql += " ORDER BY timestamp ASC";

    const [rows] = await db.query(sql, params);

    let csv = "timestamp,value\r\n";
    rows.forEach((r) => {
      const ts =
        r.timestamp instanceof Date
          ? r.timestamp.toISOString()
          : new Date(r.timestamp).toISOString();
      csv += `${ts},${r.value}\r\n`;
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=export_variable_${id}.csv`
    );
    res.send(csv);
  } catch (err) {
    console.error("GET /api/export:", err.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Rechargement manuel des cron
app.post("/api/refresh", async (req, res) => {
  try {
    await refreshSchedules();
    res.json({ message: "Cron mis à jour" });
  } catch (err) {
    console.error("POST /api/refresh:", err.message);
    res.status(500).json({ error: "Erreur" });
  }
});

// --- Démarrage du serveur ---
app.listen(PORT, async () => {
  console.log(`🚀 Backend lancé sur http://localhost:${PORT}`);
  await refreshSchedules();
});
