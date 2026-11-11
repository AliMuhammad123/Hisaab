-- CreditFlow database schema (MySQL 8 / MariaDB 10.4+)
-- Every data table carries user_id; the API never reads or writes a row
-- without filtering on the signed-in user's id.

CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(80)  NOT NULL DEFAULT '',
  app_mode        ENUM('personal','business','both') NULL,
  country         CHAR(2)  NULL,
  currency        CHAR(3)  NULL,
  strict_stop     TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only a SHA-256 hash of the session token is stored, so a leaked
-- database dump cannot be used to sign in as anyone.
CREATE TABLE IF NOT EXISTS sessions (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  csrf_token  CHAR(64) NOT NULL,
  user_agent  VARCHAR(255) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL,
  ip            VARCHAR(45)  NOT NULL,
  attempted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_attempts_email (email, attempted_at),
  KEY ix_attempts_ip (ip, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Business portal ----------

CREATE TABLE IF NOT EXISTS clients (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(40)  NOT NULL DEFAULT '',
  email         VARCHAR(190) NOT NULL DEFAULT '',
  notes         VARCHAR(1000) NOT NULL DEFAULT '',
  credit_limit  DECIMAL(14,2) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_clients_user (user_id, name),
  CONSTRAINT fk_clients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  client_id     BIGINT UNSIGNED NOT NULL,
  number        VARCHAR(40)  NOT NULL DEFAULT '',
  description   VARCHAR(500) NOT NULL DEFAULT '',
  amount        DECIMAL(14,2) NOT NULL,
  invoice_date  DATE NOT NULL,
  due_date      DATE NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_invoices_user (user_id, invoice_date),
  KEY ix_invoices_client (client_id),
  CONSTRAINT fk_invoices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_invoices_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  invoice_id    BIGINT UNSIGNED NOT NULL,
  amount        DECIMAL(14,2) NOT NULL,
  method        ENUM('cash','bank','other') NOT NULL DEFAULT 'cash',
  payment_date  DATE NOT NULL,
  reference     VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_payments_user (user_id, payment_date),
  KEY ix_payments_invoice (invoice_id),
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Personal portal ----------

-- One plan per user per month. `income` is the salary; the other columns
-- are the limits the user sets for each kind of spending.
CREATE TABLE IF NOT EXISTS budgets (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT UNSIGNED NOT NULL,
  month          CHAR(7) NOT NULL,              -- YYYY-MM
  income         DECIMAL(14,2) NOT NULL DEFAULT 0,
  mandatory      DECIMAL(14,2) NOT NULL DEFAULT 0,
  savings        DECIMAL(14,2) NOT NULL DEFAULT 0,
  investment     DECIMAL(14,2) NOT NULL DEFAULT 0,
  entertainment  DECIMAL(14,2) NOT NULL DEFAULT 0,
  other          DECIMAL(14,2) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_budget_month (user_id, month),
  CONSTRAINT fk_budgets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- category 'return' is money coming back from investments (counts as income).
-- `overridden` marks an entry the user saved after being stopped by a red line.
CREATE TABLE IF NOT EXISTS entries (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  category    ENUM('mandatory','savings','investment','entertainment','other','return') NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  entry_date  DATE NOT NULL,
  note        VARCHAR(200) NOT NULL DEFAULT '',
  overridden  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_entries_user (user_id, entry_date),
  CONSTRAINT fk_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
