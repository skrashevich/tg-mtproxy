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

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
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

// ─── Миграции ───
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id              TEXT PRIMARY KEY,
    applied_at      TEXT DEFAULT (datetime('now'))
  );
`);

const hasMigration = db.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`);
const insertMigration = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);

type Migration = {
  id: string;
  up: () => void;
};

const migrations: Migration[] = [
  {
    id: '20260211_add_users_trial_used',
    up: () => {
      if (!hasColumn('users', 'trial_used')) {
        db.exec(`ALTER TABLE users ADD COLUMN trial_used INTEGER DEFAULT 0`);
      }
    },
  },
  {
    id: '20260211_create_settings_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key             TEXT PRIMARY KEY,
          value           TEXT NOT NULL,
          updated_at      TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
];

for (const migration of migrations) {
  if (hasMigration.get(migration.id)) continue;

  db.transaction(() => {
    migration.up();
    insertMigration.run(migration.id);
  })();
}

// ─── Подготовленные запросы ───

export const queries: Record<string, any> = {
  // Пользователи
  getUser: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),
  getUserBySecret: db.prepare(`SELECT * FROM users WHERE secret = ?`),
  getAllActiveUsers: db.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY id ASC`),
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

  // Настройки
  getSetting: db.prepare(`
    SELECT value FROM settings WHERE key = ?
  `),

  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (@key, @value, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `),
};

export default db;
