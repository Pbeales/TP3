require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// CONFIG DB
const db = mysql.createPool({
    host: process.env.DB_HOST || "mariadb",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "supervision",
    port: process.env.DB_PORT || 3306
});

// Stockage des tâches cron
let cronJobs = {};

// ROUTE : liste variables
app.get("/api/variables", async (req, res) => {
    const [rows] = await db.query("SELECT * FROM variables");
    res.json(rows);
});

// ROUTE : ajout variable
app.post("/api/variables", async (req, res) => {
    const { name, ip, register_address, frequency } = req.body;

    await db.query(
        "INSERT INTO variables (name, ip, register_address, frequency) VALUES (?, ?, ?, ?)",
        [name, ip, register_address, frequency]
    );

    res.json({ message: "Variable ajoutée" });
});

// ROUTE : suppression variable
app.delete("/api/variables/:id", async (req, res) => {
    const id = req.params.id;

    await db.query("DELETE FROM variables WHERE id = ?", [id]);

    if (cronJobs[id]) {
        cronJobs[id].stop();
        delete cronJobs[id];
    }

    res.json({ message: "Variable supprimée" });
});

// ROUTE : historique
app.get("/api/history/:id", async (req, res) => {
    const id = req.params.id;

    const [rows] = await db.query(
        "SELECT timestamp, value FROM history WHERE variable_id = ? ORDER BY timestamp ASC",
        [id]
    );

    res.json(rows);
});

// fake value generator
async function readValueFake() {
    return Number((Math.random() * 100).toFixed(2));
}

// création / reload des tâches cron
async function refreshSchedules() {
    console.log("🔄 Rafraîchissement des tâches...");

    Object.values(cronJobs).forEach(job => job.stop());
    cronJobs = {};

    const [vars] = await db.query("SELECT * FROM variables");

    vars.forEach(v => {
        const interval = `*/${v.frequency} * * * * *`;

        const job = cron.schedule(interval, async () => {
            const value = await readValueFake();

            await db.query(
                "INSERT INTO history (variable_id, value) VALUES (?, ?)",
                [v.id, value]
            );
        });

        cronJobs[v.id] = job;
    });

    console.log("✔ Cron mis à jour");
}

app.post("/api/refresh", async (_, res) => {
    await refreshSchedules();
    res.json({ message: "Cron reloaded" });
});

app.listen(3000, () => {
    console.log("🚀 Backend fonctionnement sur : http://localhost:3000");
    refreshSchedules();
});
