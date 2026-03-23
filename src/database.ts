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
  const allowed = ['users', 'payments', 'alerts', 'settings', 'schema_migrations'];
  if (!allowed.includes(table)) throw new Error(`hasColumn: unknown table "${table}"`);
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

// ─── Инициализация таблиц ───
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL CHECK(type IN ('local', 'remote')),
    host            TEXT NOT NULL,
    port            INTEGER DEFAULT 443,
    container_name  TEXT DEFAULT 'mtproxy',
    ssh_host        TEXT,
    ssh_port        INTEGER DEFAULT 22,
    ssh_key_path    TEXT,
    max_users       INTEGER DEFAULT 50,
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id     INTEGER UNIQUE NOT NULL,
    username        TEXT DEFAULT '',
    secret          TEXT UNIQUE NOT NULL,
    expires_at      TEXT,  -- ISO datetime
    max_connections  INTEGER DEFAULT 1,
    is_active       INTEGER DEFAULT 0,
    server_id       INTEGER REFERENCES servers(id),
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
  {
    id: '20260323_add_users_server_id',
    up: () => {
      if (!hasColumn('users', 'server_id')) {
        db.exec(`ALTER TABLE users ADD COLUMN server_id INTEGER REFERENCES servers(id)`);
      }
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
  // Серверы
  getAllServers: db.prepare(`SELECT * FROM servers ORDER BY id ASC`),
  getActiveServers: db.prepare(`SELECT * FROM servers WHERE is_active = 1 ORDER BY id ASC`),
  getServer: db.prepare(`SELECT * FROM servers WHERE id = ?`),
  getServerByName: db.prepare(`SELECT * FROM servers WHERE name = ?`),
  upsertServer: db.prepare(`
    INSERT INTO servers (name, type, host, port, container_name, ssh_host, ssh_port, ssh_key_path, max_users, is_active)
    VALUES (@name, @type, @host, @port, @container_name, @ssh_host, @ssh_port, @ssh_key_path, @max_users, @is_active)
    ON CONFLICT(name) DO UPDATE SET
      type = excluded.type,
      host = excluded.host,
      port = excluded.port,
      container_name = excluded.container_name,
      ssh_host = excluded.ssh_host,
      ssh_port = excluded.ssh_port,
      ssh_key_path = excluded.ssh_key_path,
      max_users = excluded.max_users,
      is_active = excluded.is_active
  `),
  setServerActive: db.prepare(`UPDATE servers SET is_active = @is_active WHERE id = @id`),
  getActiveUsersCountByServer: db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND server_id = ?`),
  getActiveUsersByServer: db.prepare(`SELECT * FROM users WHERE is_active = 1 AND server_id = ? ORDER BY id ASC`),
  getExpiredUsersByServer: db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1 AND server_id = ? AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
  getServerLoad: db.prepare(`
    SELECT s.*, COUNT(u.id) as active_users
    FROM servers s
    LEFT JOIN users u ON u.server_id = s.id AND u.is_active = 1
    WHERE s.is_active = 1
    GROUP BY s.id
    HAVING active_users < s.max_users
    ORDER BY active_users ASC
    LIMIT 1
  `),
  getAllServerLoads: db.prepare(`
    SELECT s.*, COUNT(u.id) as active_users
    FROM servers s
    LEFT JOIN users u ON u.server_id = s.id AND u.is_active = 1
    GROUP BY s.id
    ORDER BY s.id ASC
  `),

  // Пользователи
  getUser: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),
  getUserBySecret: db.prepare(`SELECT * FROM users WHERE secret = ?`),
  getAllActiveUsers: db.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY id ASC`),
  getActiveUsersCount: db.prepare(`SELECT COUNT(*) as count FROM users WHERE is_active = 1`),
  getTotalUsersCount: db.prepare(`SELECT COUNT(*) as count FROM users`),

  insertUser: db.prepare(`
    INSERT INTO users (telegram_id, username, secret, expires_at, max_connections, is_active, server_id)
    VALUES (@telegram_id, @username, @secret, @expires_at, @max_connections, @is_active, @server_id)
  `),

  updateUserSubscription: db.prepare(`
    UPDATE users SET
      secret = @secret,
      expires_at = @expires_at,
      max_connections = @max_connections,
      is_active = 1,
      server_id = @server_id,
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

  extendSubscription: db.prepare(`
    UPDATE users SET
      expires_at = @expires_at,
      is_active = 1,
      updated_at = datetime('now')
    WHERE telegram_id = @telegram_id
  `),

  updateUserServerId: db.prepare(`
    UPDATE users SET server_id = @server_id, updated_at = datetime('now')
    WHERE telegram_id = @telegram_id
  `),

  assignOrphansToServer: db.prepare(`
    UPDATE users SET server_id = ?, updated_at = datetime('now')
    WHERE server_id IS NULL
  `),

  markTrialUsed: db.prepare(`
    UPDATE users SET trial_used = 1, updated_at = datetime('now')
    WHERE telegram_id = ?
  `),

  getExpiredUsers: db.prepare(`
    SELECT * FROM users
    WHERE is_active = 1 AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
