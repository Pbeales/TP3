// seed.js
require("dotenv").config();
const mysql = require("mysql2/promise");

(async () => {
  try {
    const db = await mysql.createConnection({
      host: process.env.DB_HOST || "mariadb",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "root",
      database: process.env.DB_NAME || "supervision",
      port: parseInt(process.env.DB_PORT || "3306", 10)
    });

    console.log("Connexion DB OK ✔");

    // Vérifie s'il existe déjà des variables
    const [check] = await db.query("SELECT COUNT(*) AS c FROM variables");
    if (check[0].c > 0) {
      console.log("Des variables existent déjà → seed ignoré.");
      await db.end();
      return;
    }

    console.log("Insertion des variables initiales...");

    // DIGITAL OUTPUT — %Q0.6.5
    await db.query(`
      INSERT INTO variables
      (name, comment, address_raw, type, modbus_address, frequency)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      "Voyant Marche Lampes",
      "Sortie automate",
      "%Q0.6.5",
      "OUTPUT",
      (6 * 8) + 5, // byte*8 + bit
      1
    ]);

    // DIGITAL OUTPUT — %Q0.6.7
    await db.query(`
      INSERT INTO variables 
      (name, comment, address_raw, type, modbus_address, frequency)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      "Voyant Marche Conv. Sécheur",
      "Sortie automate",
      "%Q0.6.7",
      "OUTPUT",
      (6 * 8) + 7,
      1
    ]);

    // DIGITAL OUTPUT — %Q0.6.9
    await db.query(`
      INSERT INTO variables 
      (name, comment, address_raw, type, modbus_address, frequency)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      "Voyant Marche Conv. Transfert",
      "Sortie automate",
      "%Q0.6.9",
      "OUTPUT",
      (6 * 8) + 9,
      1
    ]);

    // DIGITAL INPUT — %I0.5.5
    await db.query(`
      INSERT INTO variables 
      (name, comment, address_raw, type, modbus_address, frequency)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      "Bouton Test Lampe",
      "Entrée automate",
      "%I0.5.5",
      "INPUT",
      (5 * 8) + 5,
      1
    ]);

    // ANALOG INPUT — exemple %IW0.3.2 → converti en %IW100 si tu veux
    // Ici on utilise un registre 100 comme exemple
    await db.query(`
      INSERT INTO variables 
      (name, comment, address_raw, type, modbus_address, frequency, raw_min, raw_max, scale_min, scale_max, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      "Température Process",
      "Entrée 4-20mA",
      "%IW100",
      "ANALOG_INPUT",
      100,  // registre 100 Modbus
      1,
      8000,   // raw_min example
      20000,  // raw_max example
      0,      // °C min
      120,    // °C max
      "°C"
    ]);

    console.log("✔ Seed terminé — 5 variables insérées.");
    await db.end();

  } catch (err) {
    console.error("❌ Erreur seed:", err);
    process.exit(1);
  }
})();
