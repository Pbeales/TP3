// backend/seed.js
require("dotenv").config();
const mysql = require("mysql2/promise");

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "root",
      port: parseInt(process.env.DB_PORT, 10) || 3306
    });

    await conn.query("CREATE DATABASE IF NOT EXISTS supervision");
    await conn.query("USE supervision");

    await conn.query(`CREATE TABLE IF NOT EXISTS variables (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      ip VARCHAR(50) NOT NULL,
      register_address INT NOT NULL,
      frequency INT NOT NULL
    )`);

    await conn.query(`CREATE TABLE IF NOT EXISTS history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      variable_id INT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      value FLOAT NOT NULL,
      FOREIGN KEY (variable_id) REFERENCES variables(id) ON DELETE CASCADE
    )`);

    const [rows] = await conn.query("SELECT COUNT(*) as c FROM variables");
    if (rows[0].c === 0) {
      await conn.query("INSERT INTO variables (name, ip, register_address, frequency) VALUES (?, ?, ?, ?)",
        ["Température Ligne 1", "192.168.1.10", 40001, 5]);
      await conn.query("INSERT INTO variables (name, ip, register_address, frequency) VALUES (?, ?, ?, ?)",
        ["Pression Réservoir", "192.168.1.11", 40002, 10]);
      console.log("Seed inséré : 2 variables");
    } else {
      console.log("Variables déjà présentes, seed ignoré.");
    }
    await conn.end();
  } catch (err) {
    console.error("Erreur seed:", err.message);
    process.exit(1);
  }
})();
