import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { writeFile } from 'fs/promises';
import { queries } from './database';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const CONTAINER = process.env.PROXY_CONTAINER || 'mtproxy';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(CONTAINER)) {
  throw new Error(`Invalid PROXY_CONTAINER name: ${CONTAINER}`);
}

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
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '-f', '{{.Config.Image}}', CONTAINER],
        { timeout: 5000 }
      );
      image = stdout.trim();
    } catch {
      image = process.env.PROXY_IMAGE || 'ghcr.io/skrashevich/mtproxy:latest';
    }

    // Запоминаем текущий digest до pull
    const digestBefore = await this.getImageId(image);

    // Тянем новый образ (может занять время)
    console.log(`[ProxyManager] docker pull ${image}...`);
    await execFileAsync('docker', ['pull', image], { timeout: 120000 });

    const digestAfter = await this.getImageId(image);
    const updated = digestBefore !== digestAfter;

    // Берём активные секреты
    const activeUsers = queries.getAllActiveUsers.all() as any[];
    const secrets = activeUsers.map((u) => u.secret).filter(Boolean);

    // Останавливаем и удаляем старый контейнер
    try {
      await execFileAsync('docker', ['stop', '-t', '5', CONTAINER], { timeout: 15000 });
    } catch { /* контейнер мог не существовать */ }
    try {
      await execFileAsync('docker', ['rm', CONTAINER], { timeout: 5000 });
    } catch { /* контейнер мог не существовать */ }

    if (secrets.length === 0) {
      console.log('[ProxyManager] Нет активных секретов — контейнер не запущен');
      return { updated, image };
    }

    const tag = process.env.PROXY_TAG || '';
    const args = [
      'run', '-d',
      `--name=${CONTAINER}`,
      '--restart=always',
      '-p', `${this.proxyPort}:443`,
      '-v', `${CONTAINER}-config:/data`,
      ...(tag ? ['-e', `TAG=${tag}`] : []),
      image,
    ];

    await execFileAsync('docker', args, { timeout: 30000 });

    // Записываем актуальные секреты в volume после запуска контейнера
    try {
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '-f', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', CONTAINER],
        { timeout: 5000 }
      );
      const volumePath = stdout.trim();

      if (volumePath) {
        await writeFile(`${volumePath}/secret`, secrets.join(','));
        await execFileAsync('docker', ['restart', '-t', '1', CONTAINER], { timeout: 15000 });
      }
    } catch (err: any) {
      console.error('[ProxyManager] Ошибка записи секретов при обновлении:', err.message);
    }

    console.log(`[ProxyManager] Контейнер запущен: ${image} (${secrets.length} секретов)`);

    return { updated, image };
  }

  private async getImageId(image: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'docker', ['image', 'inspect', '-f', '{{.Id}}', image],
        { timeout: 5000 }
      );
      return stdout.trim();
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
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '-f', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', CONTAINER],
        { timeout: 5000 }
      );
      const volumePath = stdout.trim();

      if (volumePath) {
        await writeFile(`${volumePath}/secret`, secretsStr);
      } else {
        console.warn('[ProxyManager] Volume path пуст — секреты не записаны');
      }
    } catch (err: any) {
      console.error('[ProxyManager] Ошибка записи секретов:', err.message);
    }

    // Быстрый restart (1-2 сек)
    try {
      await execFileAsync('docker', ['restart', '-t', '1', CONTAINER], { timeout: 15000 });
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
      const { stdout } = await execFileAsync(
        'docker', ['exec', CONTAINER, 'curl', '-s', 'http://localhost:2398/stats'],
        { timeout: 5000 }
      );

      const lines = stdout.split('\n');
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
  async isContainerRunning(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER],
        { timeout: 5000 }
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Получает использование RAM в процентах */
  async getRAMUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        "free | awk '/Mem:/ {printf \"%.0f\", $3/$2 * 100}'",
        { timeout: 3000 }
      );
      return parseInt(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }
}
