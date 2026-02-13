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
   * Пересоздаёт контейнер с обновлённым образом.
   * Делает docker pull, stop, rm, run — секреты берёт из БД.
   * Возвращает { updated: true } если образ изменился.
   */
  async updateAndRestart(): Promise<{ updated: boolean; image: string }> {
    // Определяем образ: из запущенного контейнера или из env/дефолта
    let image: string;
    try {
      image = execSync(
        `docker inspect -f '{{.Config.Image}}' ${CONTAINER}`,
        { timeout: 5000 }
      ).toString().trim();
    } catch {
      image = process.env.PROXY_IMAGE || 'ghcr.io/skrashevich/mtproxy:latest';
    }

    // Запоминаем текущий digest до pull
    const digestBefore = this.getImageId(image);

    // Тянем новый образ (может занять время)
    console.log(`[ProxyManager] docker pull ${image}...`);
    execSync(`docker pull ${image}`, { timeout: 120000, stdio: 'pipe' });

    const digestAfter = this.getImageId(image);
    const updated = digestBefore !== digestAfter;

    // Берём активные секреты
    const activeUsers = queries.getAllActiveUsers.all() as any[];
    const secrets = activeUsers.map((u) => u.secret).filter(Boolean);

    // Останавливаем и удаляем старый контейнер
    try {
      execSync(`docker stop -t 5 ${CONTAINER} 2>/dev/null; docker rm ${CONTAINER} 2>/dev/null`, {
        timeout: 20000,
      });
    } catch { /* контейнер мог не существовать */ }

    if (secrets.length === 0) {
      console.log('[ProxyManager] Нет активных секретов — контейнер не запущен');
      return { updated, image };
    }

    // Секреты уже записаны в volume (/data/secret) предыдущими вызовами restartWithSecrets.
    // Именованный volume переживает rm+run, поэтому SECRET env не нужен.
    const tag = process.env.PROXY_TAG || '';
    const tagArg = tag ? `-e TAG=${tag}` : '';
    const cmd = [
      'docker run -d',
      `--name=${CONTAINER}`,
      '--restart=always',
      `-p ${this.proxyPort}:443`,
      `-v ${CONTAINER}-config:/data`,
      tagArg,
      image,
    ].filter(Boolean).join(' ');

    execSync(cmd, { timeout: 30000 });
    console.log(`[ProxyManager] Контейнер запущен: ${image} (${secrets.length} секретов)`);

    return { updated, image };
  }

  private getImageId(image: string): string {
    try {
      return execSync(`docker image inspect -f '{{.Id}}' ${image} 2>/dev/null`, {
        timeout: 5000,
      }).toString().trim();
    } catch {
      return '';
    }
  }

  /**
   * Обновляет секреты и перезапускает контейнер.
   * Записывает секреты в файл volume, затем быстрый restart (~1-2 сек).
   */
  async restartWithSecrets(): Promise<void> {
    const activeUsers = queries.getAllActiveUsers.all() as any[];
    const secrets = activeUsers.map((u) => u.secret).filter(Boolean);

    if (secrets.length === 0) {
      console.log('[ProxyManager] Нет активных секретов');
      return;
    }

    const secretsStr = secrets.join(',');

    // Пишем секреты в файл volume
    try {
      const volumePath = execSync(
        `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' ${CONTAINER}`,
        { timeout: 5000 }
      ).toString().trim();

      if (volumePath) {
        execSync(`printf '%s' '${secretsStr}' > ${volumePath}/secret`, { timeout: 3000 });
      }
    } catch (err: any) {
      console.error('[ProxyManager] Ошибка записи секретов:', err.message);
    }

    // Быстрый restart (1-2 сек)
    try {
      execSync(`docker restart -t 1 ${CONTAINER}`, { timeout: 15000 });
      console.log(`[ProxyManager] Рестарт с ${secrets.length} секретами`);
    } catch (err: any) {
      console.error('[ProxyManager] Ошибка рестарта:', err.message);
      throw err;
    }
  }

  /** Получает статистику подключений из контейнера */
  async getStats(): Promise<{
    connections: number;
    maxConnections: number;
    secretConnections: Record<number, number>;
  } | null> {
    try {
      const result = execSync(
        `docker exec ${CONTAINER} curl -s http://localhost:2398/stats 2>/dev/null`,
        { timeout: 5000 }
      ).toString();

      const lines = result.split('\n');
      let totalConnections = 0;
      let maxConnections = 0;
      const secretConnections: Record<number, number> = {};
      let hasSecretConnections = false;

      for (const line of lines) {
        const [key, value] = line.split('\t');
        if (!key || value === undefined) continue;

        if (key === 'total_special_connections') totalConnections = parseInt(value) || 0;
        if (key === 'total_max_special_connections') maxConnections = parseInt(value) || 0;

        const match = key.match(/^secret_(\d+)_active_connections$/);
        if (match) {
          const index = parseInt(match[1], 10);
          const connections = parseInt(value) || 0;
          secretConnections[index] = connections;
          hasSecretConnections = true;
        }
      }

      const connections = hasSecretConnections
        ? Object.values(secretConnections).reduce((sum, count) => sum + count, 0)
        : totalConnections;

      return { connections, maxConnections, secretConnections };
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
