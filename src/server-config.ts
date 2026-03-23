import fs from 'fs';
import path from 'path';
import { queries } from './database';

export interface ServerConfig {
  name: string;
  type: 'local' | 'remote';
  host: string;
  port: number;
  container_name: string;
  ssh_host?: string;
  ssh_port?: number;
  ssh_key_path?: string;
  max_users: number;
  is_active: boolean;
}

export interface ServerRecord extends ServerConfig {
  id: number;
  created_at: string;
  active_users?: number;
}

const SERVERS_JSON_PATH = path.join(__dirname, '..', 'data', 'servers.json');

function buildDefaultConfig(): ServerConfig[] {
  return [
    {
      name: 'local',
      type: 'local',
      host: process.env.SERVER_IP || '127.0.0.1',
      port: parseInt(process.env.PROXY_PORT || '443'),
      container_name: process.env.PROXY_CONTAINER || 'mtproxy',
      max_users: parseInt(process.env.MAX_USERS || '50'),
      is_active: true,
    },
  ];
}

function validateServerConfig(cfg: any, index: number): void {
  if (!cfg.name || typeof cfg.name !== 'string') {
    throw new Error(`servers.json[${index}]: "name" обязателен`);
  }
  if (cfg.type !== 'local' && cfg.type !== 'remote') {
    throw new Error(`servers.json[${index}]: "type" должен быть "local" или "remote"`);
  }
  if (!cfg.host || typeof cfg.host !== 'string') {
    throw new Error(`servers.json[${index}]: "host" обязателен`);
  }
  if (cfg.type === 'remote' && (!cfg.ssh_host || typeof cfg.ssh_host !== 'string')) {
    throw new Error(`servers.json[${index}]: "ssh_host" обязателен для remote-серверов`);
  }
  if (cfg.port !== undefined && (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535)) {
    throw new Error(`servers.json[${index}]: "port" должен быть числом 1-65535`);
  }
  if (cfg.ssh_port !== undefined && (typeof cfg.ssh_port !== 'number' || cfg.ssh_port < 1 || cfg.ssh_port > 65535)) {
    throw new Error(`servers.json[${index}]: "ssh_port" должен быть числом 1-65535`);
  }
}

function loadFromFile(): ServerConfig[] | null {
  if (!fs.existsSync(SERVERS_JSON_PATH)) return null;
  const raw = fs.readFileSync(SERVERS_JSON_PATH, 'utf-8');
  let configs: ServerConfig[];
  try {
    configs = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Ошибка парсинга servers.json: ${err.message}`);
  }
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error('servers.json должен быть непустым массивом');
  }
  configs.forEach((cfg, i) => validateServerConfig(cfg, i));
  return configs;
}

function saveToFile(configs: ServerConfig[]): void {
  fs.mkdirSync(path.dirname(SERVERS_JSON_PATH), { recursive: true });
  fs.writeFileSync(SERVERS_JSON_PATH, JSON.stringify(configs, null, 2), 'utf-8');
}

/**
 * Загружает конфигурацию серверов и синхронизирует с БД.
 * Если servers.json не существует — создаёт из .env переменных.
 * Привязывает существующих пользователей без server_id к первому серверу.
 */
export function syncServers(): void {
  let configs = loadFromFile();

  if (!configs) {
    configs = buildDefaultConfig();
    saveToFile(configs);
    console.log('[ServerConfig] Создан data/servers.json из .env');
  }

  for (const cfg of configs) {
    queries.upsertServer.run({
      name: cfg.name,
      type: cfg.type,
      host: cfg.host,
      port: cfg.port ?? 443,
      container_name: cfg.container_name ?? 'mtproxy',
      ssh_host: cfg.ssh_host ?? null,
      ssh_port: cfg.ssh_port ?? 22,
      ssh_key_path: cfg.ssh_key_path ?? null,
      max_users: cfg.max_users ?? 50,
      is_active: cfg.is_active !== false ? 1 : 0,
    });
  }

  // Привязать пользователей без server_id к первому серверу
  const servers = queries.getAllServers.all() as ServerRecord[];
  if (servers.length > 0) {
    const result = queries.assignOrphansToServer.run(servers[0].id);
    if (result.changes > 0) {
      console.log(`[ServerConfig] Привязано ${result.changes} пользователей к серверу "${servers[0].name}"`);
    }
  }

  console.log(`[ServerConfig] Синхронизировано ${configs.length} серверов`);
}

export function getServersJsonPath(): string {
  return SERVERS_JSON_PATH;
}
