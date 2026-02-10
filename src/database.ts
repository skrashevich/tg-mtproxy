import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'data', 'proxy.db');

// Убедимся что папка data существует
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db: InstanceType<typeof Database> = new Database(DB_PATH);

// WAL mode — быстрее для чтения, безопаснее
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ─── Инициализация таблиц ───
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER UNIQUE NOT NULL,
    username        TEXT DEFAULT '',
    secret          TEXT UNIQUE NOT NULL,
    expires_at      TEXT,  -- ISO datetime
    max_connections  INTEGER DEFAULT 1,
    trial_used      INTEGER DEFAULT 0,
    is_active       INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER NOT NULL,
    tariff_id       TEXT NOT NULL,
    stars_amount    INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',  -- pending | completed | refunded
    tg_charge_id    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,  -- overload | expired | error
    message         TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );
`);

// Миграция для существующих БД
ensureColumn('users', 'trial_used', 'INTEGER DEFAULT 0');

// ─── Подготовленные запросы ───

export const queries: Record<string, any> = {
  // Пользователи
  getUser: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),
  getUserBySecret: db.prepare(`SELECT * FROM users WHERE secret = ?`),
  getAllActiveUsers: db.prepare(`SELECT * FROM users WHERE is_active = 1`),
  getActiveUsersCount: db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_active = 1`),
  getTotalUsersCount: db.prepare(`SELECT COUNT(*) as count FROM users`),

  insertUser: db.prepare(`
    INSERT INTO users (telegram_id, username, secret, expires_at, max_connections, is_active)
    VALUES (@telegram_id, @username, @secret, @expires_at, @max_connections, @is_active)
  `),

  updateUserSubscription: db.prepare(`
    UPDATE users SET
      secret = @secret,
      expires_at = @expires_at,
      max_connections = @max_connections,
      is_active = 1,
      updated_at = datetime('now')
    WHERE telegram_id = @telegram_id
  `),

  deactivateUser: db.prepare(`
    UPDATE users SET is_active = 0, updated_at = datetime('now')
    WHERE telegram_id = ?
  `),

  activateUser: db.prepare(`
    UPDATE users SET is_active = 1, updated_at = datetime('now')
    WHERE telegram_id = ?
  `),

  markTrialUsed: db.prepare(`
    UPDATE users SET trial_used = 1, updated_at = datetime('now')
    WHERE telegram_id = ?
  `),

  getExpiredUsers: db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1 AND julianday(expires_at) < julianday('now')
  `),

  // Платежи
  insertPayment: db.prepare(`
    INSERT INTO payments (telegram_id, tariff_id, stars_amount, status, tg_charge_id)
    VALUES (@telegram_id, @tariff_id, @stars_amount, @status, @tg_charge_id)
  `),

  getPaymentStats: db.prepare(`
    SELECT
      COUNT(*) as total_payments,
      SUM(stars_amount) as total_stars,
      COUNT(CASE WHEN date(created_at) = date('now') THEN 1 END) as today_payments,
      SUM(CASE WHEN date(created_at) = date('now') THEN stars_amount ELSE 0 END) as today_stars
    FROM payments WHERE status = 'completed'
  `),

  // Алерты
  insertAlert: db.prepare(`
    INSERT INTO alerts (type, message) VALUES (?, ?)
  `),
};

export default db;
