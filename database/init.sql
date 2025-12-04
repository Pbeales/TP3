CREATE DATABASE IF NOT EXISTS supervision;
USE supervision;

CREATE TABLE IF NOT EXISTS variables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  comment TEXT,
  address_raw VARCHAR(50) NOT NULL,
  type ENUM('INPUT','OUTPUT','ANALOG_INPUT','ANALOG_OUTPUT') NOT NULL,
  modbus_address INT NOT NULL,
  frequency INT NOT NULL DEFAULT 1,
  unit VARCHAR(50),
  raw_min INT,
  raw_max INT,
  scale_min DOUBLE,
  scale_max DOUBLE
);
