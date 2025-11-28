CREATE DATABASE IF NOT EXISTS supervision;
USE supervision;

CREATE TABLE IF NOT EXISTS automates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  ip VARCHAR(50) NOT NULL,
  port INT NOT NULL DEFAULT 502
);

CREATE TABLE IF NOT EXISTS variables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  automate_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  address_raw VARCHAR(50) NOT NULL, -- ex: %Q0.6.5
  type ENUM('INPUT','OUTPUT') NOT NULL, -- INPUT = %I, OUTPUT = %Q
  modbus_address INT NOT NULL, -- computed numeric address for Modbus (bit index)
  frequency INT NOT NULL DEFAULT 5,
  FOREIGN KEY (automate_id) REFERENCES automates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  variable_id INT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  value FLOAT NOT NULL,
  FOREIGN KEY (variable_id) REFERENCES variables(id) ON DELETE CASCADE
);

-- Seed: automate + 4 variables demandées
INSERT INTO automates (name, ip, port)
SELECT 'Automate 172.16.1.24', '172.16.1.24', 502
WHERE NOT EXISTS (SELECT 1 FROM automates WHERE ip='172.16.1.24');

SET @aid = (SELECT id FROM automates WHERE ip='172.16.1.24' LIMIT 1);

-- helper to insert if not exists
INSERT INTO variables (automate_id, name, address_raw, type, modbus_address, frequency)
SELECT @aid, 'Voyant marche lampes', '%Q0.6.5', 'OUTPUT', (6*8+5), 5
WHERE NOT EXISTS (
  SELECT 1 FROM variables WHERE automate_id=@aid AND address_raw='%Q0.6.5'
);

INSERT INTO variables (automate_id, name, address_raw, type, modbus_address, frequency)
SELECT @aid, 'Voyant marche convoyeur secheur', '%Q0.6.7', 'OUTPUT', (6*8+7), 5
WHERE NOT EXISTS (
  SELECT 1 FROM variables WHERE automate_id=@aid AND address_raw='%Q0.6.7'
);

INSERT INTO variables (automate_id, name, address_raw, type, modbus_address, frequency)
SELECT @aid, 'Voyant marche convoyeur transfert', '%Q0.6.9', 'OUTPUT', (6*8+9), 5
WHERE NOT EXISTS (
  SELECT 1 FROM variables WHERE automate_id=@aid AND address_raw='%Q0.6.9'
);

INSERT INTO variables (automate_id, name, address_raw, type, modbus_address, frequency)
SELECT @aid, 'Bouton poussoir test lampe', '%I0.5.5', 'INPUT', (5*8+5), 2
WHERE NOT EXISTS (
  SELECT 1 FROM variables WHERE automate_id=@aid AND address_raw='%I0.5.5'
);
