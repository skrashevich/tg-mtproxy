import { execSync, exec } from 'child_process';
import crypto from 'crypto';
import { queries } from './database';

const CONTAINER = process.env.PROXY_CONTAINER || 'mtproxy';

/**
 * ProxyManager управляет MTProto proxy контейнером.
 *
 * Стратегия: один контейнер telegrammessenger/proxy на одном порту,
 * все секреты передаются через переменную SECRET (через запятую).
 * При добавлении/удалении секрета — контейнер пересоздаётся.
 *
 * Это самый экономичный подход для 1 ГБ RAM.
 */
export class ProxyManager {
  private serverIp: string;
  private proxyPort: number;

  constructor() {
    this.serverIp = process.env.SERVER_IP || '127.0.0.1';
    this.proxyPort = parseInt(process.env.PROXY_PORT || '443');
  }

  /** Генерирует 16-байтный hex secret (32 символа) */
  generateSecret(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /** Формирует tg:// ссылку для подключения */
  buildLink(secret: string): string {
    // dd-prefix для fake-TLS (обход DPI)
    const ddSecret = `dd${secret}`;
    return `tg://proxy?server=${this.serverIp}&port=${this.proxyPort}&secret=${ddSecret}`;
  }

  /** Формирует t.me ссылку */
  buildWebLink(secret: string): string {
    const ddSecret = `dd${secret}`;
    return `https://t.me/proxy?server=${this.serverIp}&port=${this.proxyPort}&secret=${ddSecret}`;
  }

  /**
   * Пересоздаёт контейнер со всеми активными секретами.
   * Вызывается после добавления/удаления пользователя.
   */
  async restartWithSecrets(): Promise<void> {
    const activeUsers = queries.getAllActiveUsers.all() as any[];
    const secrets = activeUsers.map((u) => u.secret).filter(Boolean);

    if (secrets.length === 0) {
      console.log('[ProxyManager] Нет активных секретов, останавливаем контейнер');
      this.stopContainer();
      return;
    }

    const secretsStr = secrets.join(',');
    const tag = process.env.PROXY_TAG || '';
    const tagArg = tag ? `-e TAG=${tag}` : '';

    // Останавливаем старый контейнер
    this.stopContainer();

    // Запускаем новый
    const cmd = [
      'docker run -d',
      `--name=${CONTAINER}`,
      '--restart=always',
      `-p ${this.proxyPort}:443`,
      `-v ${CONTAINER}-config:/data`,
      `-e SECRET=${secretsStr}`,
      tagArg,
      'telegrammessenger/proxy:latest',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      execSync(cmd, { timeout: 30000 });
      console.log(`[ProxyManager] Контейнер запущен с ${secrets.length} секретами`);
    } catch (err: any) {
      console.error('[ProxyManager] Ошибка запуска:', err.message);
      throw err;
    }
  }

  /** Останавливает и удаляет контейнер */
  private stopContainer(): void {
    try {
      execSync(`docker stop ${CONTAINER} 2>/dev/null; docker rm ${CONTAINER} 2>/dev/null`, {
        timeout: 15000,
      });
    } catch {
      // Контейнер мог не существовать — ок
    }
  }

  /** Получает статистику подключений из контейнера */
  async getStats(): Promise<{ connections: number; maxConnections: number } | null> {
    try {
      const result = execSync(
        `docker exec ${CONTAINER} curl -s http://localhost:2398/stats 2>/dev/null`,
        { timeout: 5000 }
      ).toString();

      const lines = result.split('\n');
      let connections = 0;
      let maxConnections = 0;

      for (const line of lines) {
        const [key, value] = line.split('\t');
        if (key === 'total_special_connections') connections = parseInt(value) || 0;
        if (key === 'total_max_special_connections') maxConnections = parseInt(value) || 0;
      }

      return { connections, maxConnections };
    } catch {
      return null;
    }
  }

  /** Проверяет здоровье контейнера */
  isContainerRunning(): boolean {
    try {
      const result = execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER} 2>/dev/null`, {
        timeout: 5000,
      }).toString().trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  /** Получает использование RAM в процентах */
  getRAMUsage(): number {
    try {
      const result = execSync(
        "free | awk '/Mem:/ {printf \"%.0f\", $3/$2 * 100}'",
        { timeout: 3000 }
      ).toString().trim();
      return parseInt(result) || 0;
    } catch {
      return 0;
    }
  }
}
