import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { writeFile } from 'fs/promises';
import { queries } from './database';
import { ServerRecord } from './server-config';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function validateContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/** Экранирует строку для безопасного использования в одинарных кавычках shell */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * ProxyManager управляет несколькими MTProto proxy серверами.
 *
 * Поддерживает два типа серверов:
 * - local: Docker на той же машине (команды напрямую)
 * - remote: Docker на удалённом сервере (команды через SSH)
 */
// ─── Дебаунс рестарта по серверам ───
const restartTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
const restartResolvers = new Map<number, Array<() => void>>();

export class ProxyManager {

  /**
   * Дебаунсированный рестарт: если несколько вызовов за 3 секунды —
   * перезапуск произойдёт один раз, все вызовы получат resolve.
   */
  debouncedRestart(serverId: number): Promise<void> {
    return new Promise((resolve) => {
      const resolvers = restartResolvers.get(serverId) || [];
      resolvers.push(resolve);
      restartResolvers.set(serverId, resolvers);

      const existing = restartTimeouts.get(serverId);
      if (existing) clearTimeout(existing);

      restartTimeouts.set(serverId, setTimeout(async () => {
        restartTimeouts.delete(serverId);
        const currentResolvers = restartResolvers.get(serverId) || [];
        restartResolvers.set(serverId, []);

        try {
          await this.restartWithSecrets(serverId);
        } catch (err) {
          console.error(`[ProxyManager] Ошибка дебаунс-рестарта сервера ${serverId}:`, err);
        }
        currentResolvers.forEach(r => r());
      }, 3000));
    });
  }

  /** Генерирует 16-байтный hex secret (32 символа) */
  generateSecret(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Формирует полный секрет с префиксом для ссылок и Docker.
   * - Без FakeTLS: dd + secret (random padding)
   * - С FakeTLS: ee + secret + hex(domain)
   */
  formatSecret(secret: string, server: ServerRecord): string {
    if (server.fake_tls_domain) {
      const domainHex = Buffer.from(server.fake_tls_domain, 'utf-8').toString('hex');
      return `ee${secret}${domainHex}`;
    }
    return `dd${secret}`;
  }

  /** Формирует tg:// ссылку для подключения */
  buildLink(secret: string, server: ServerRecord): string {
    const fullSecret = this.formatSecret(secret, server);
    return `tg://proxy?server=${server.host}&port=${server.port}&secret=${fullSecret}`;
  }

  /** Формирует t.me ссылку */
  buildWebLink(secret: string, server: ServerRecord): string {
    const fullSecret = this.formatSecret(secret, server);
    return `https://t.me/proxy?server=${server.host}&port=${server.port}&secret=${fullSecret}`;
  }

  /** Выбирает наименее загруженный активный сервер */
  selectBestServer(): ServerRecord | null {
    return queries.getServerLoad.get() as ServerRecord | null;
  }

  /** Получает сервер по ID */
  getServer(serverId: number): ServerRecord | null {
    return queries.getServer.get(serverId) as ServerRecord | null;
  }

  /** Получает все серверы с нагрузкой */
  getAllServerLoads(): ServerRecord[] {
    return queries.getAllServerLoads.all() as ServerRecord[];
  }

  // ─── Выполнение Docker-команд ───

  private buildSshArgs(server: ServerRecord): string[] {
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
    ];
    if (server.ssh_key_path) {
      args.push('-i', server.ssh_key_path);
    }
    if (server.ssh_port && server.ssh_port !== 22) {
      args.push('-p', String(server.ssh_port));
    }
    args.push(server.ssh_host!);
    return args;
  }

  private async execDocker(server: ServerRecord, args: string[], timeout = 15000): Promise<string> {
    validateContainerName(server.container_name);

    if (server.type === 'local') {
      const { stdout } = await execFileAsync('docker', args, { timeout });
      return stdout.trim();
    }

    // remote: выполняем через SSH
    const sshArgs = this.buildSshArgs(server);
    const dockerCmd = ['docker', ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    sshArgs.push(dockerCmd);

    const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: timeout + 10000 });
    return stdout.trim();
  }

  private async execRemoteShell(server: ServerRecord, command: string, timeout = 15000): Promise<string> {
    if (server.type === 'local') {
      const { stdout } = await execAsync(command, { timeout });
      return stdout.trim();
    }

    const sshArgs = this.buildSshArgs(server);
    sshArgs.push(command);
    const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: timeout + 10000 });
    return stdout.trim();
  }

  // ─── Управление контейнерами ───

  /**
   * Обновляет секреты и перезапускает контейнер конкретного сервера.
   */
  async restartWithSecrets(serverId: number): Promise<void> {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Сервер ${serverId} не найден`);

    const activeUsers = queries.getActiveUsersByServer.all(serverId) as any[];
    const rawSecrets = activeUsers.map((u: any) => u.secret).filter(Boolean);

    if (rawSecrets.length === 0) {
      console.log(`[ProxyManager] Сервер "${server.name}": нет активных секретов`);
      return;
    }

    const secrets = rawSecrets.map(s => this.formatSecret(s, server));
    const secretsStr = secrets.join(',');
    const container = server.container_name;

    // Записываем секреты в файл volume
    try {
      const volumePath = await this.execDocker(
        server,
        ['inspect', '-f', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', container],
        5000
      );

      if (volumePath) {
        if (server.type === 'local') {
          await writeFile(`${volumePath}/secret`, secretsStr);
        } else {
          await this.execRemoteShell(
            server,
            `echo '${shellEscape(secretsStr)}' > '${shellEscape(volumePath)}/secret'`,
            5000
          );
        }
      } else {
        console.warn(`[ProxyManager] Сервер "${server.name}": volume path пуст`);
      }
    } catch (err: any) {
      console.error(`[ProxyManager] Сервер "${server.name}": ошибка записи секретов:`, err.message);
    }

    // Быстрый restart
    try {
      await this.execDocker(server, ['restart', '-t', '1', container]);
      console.log(`[ProxyManager] Сервер "${server.name}": рестарт с ${secrets.length} секретами`);
    } catch (err: any) {
      console.error(`[ProxyManager] Сервер "${server.name}": ошибка рестарта:`, err.message);
      throw err;
    }
  }

  /** Перезапускает все активные серверы */
  async restartAllServers(): Promise<void> {
    const servers = queries.getActiveServers.all() as ServerRecord[];
    await Promise.allSettled(
      servers.map(s => this.restartWithSecrets(s.id))
    );
  }

  /**
   * Обновляет образ и пересоздаёт контейнер на конкретном сервере.
   */
  async updateAndRestart(serverId: number): Promise<{ updated: boolean; image: string }> {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Сервер ${serverId} не найден`);

    const container = server.container_name;

    // Определяем образ
    let image: string;
    try {
      image = await this.execDocker(server, ['inspect', '-f', '{{.Config.Image}}', container], 5000);
    } catch {
      image = process.env.PROXY_IMAGE || 'ghcr.io/skrashevich/mtproxy:latest';
    }

    const digestBefore = await this.getImageId(server, image);

    console.log(`[ProxyManager] Сервер "${server.name}": docker pull ${image}...`);
    await this.execDocker(server, ['pull', image], 120000);

    const digestAfter = await this.getImageId(server, image);
    const updated = digestBefore !== digestAfter;

    const activeUsers = queries.getActiveUsersByServer.all(serverId) as any[];
    const rawSecrets = activeUsers.map((u: any) => u.secret).filter(Boolean);

    // Останавливаем и удаляем старый контейнер
    try { await this.execDocker(server, ['stop', '-t', '5', container]); } catch { /* ok */ }
    try { await this.execDocker(server, ['rm', container], 5000); } catch { /* ok */ }

    if (rawSecrets.length === 0) {
      console.log(`[ProxyManager] Сервер "${server.name}": нет активных секретов — контейнер не запущен`);
      return { updated, image };
    }

    const tag = process.env.PROXY_TAG || '';
    const args = [
      'run', '-d',
      `--name=${container}`,
      '--restart=always',
      '-p', `${server.port}:443`,
      '-v', `${container}-config:/data`,
      ...(tag ? ['-e', `TAG=${tag}`] : []),
      image,
    ];

    await this.execDocker(server, args, 30000);

    // Записываем секреты
    try {
      const volumePath = await this.execDocker(
        server,
        ['inspect', '-f', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', container],
        5000
      );

      if (volumePath) {
        const secrets = rawSecrets.map(s => this.formatSecret(s, server));
        const secretsStr = secrets.join(',');
        if (server.type === 'local') {
          await writeFile(`${volumePath}/secret`, secretsStr);
        } else {
          await this.execRemoteShell(
            server,
            `echo '${shellEscape(secretsStr)}' > '${shellEscape(volumePath)}/secret'`,
            5000
          );
        }
        await this.execDocker(server, ['restart', '-t', '1', container]);
      }
    } catch (err: any) {
      console.error(`[ProxyManager] Сервер "${server.name}": ошибка записи секретов при обновлении:`, err.message);
    }

    console.log(`[ProxyManager] Сервер "${server.name}": контейнер запущен: ${image} (${rawSecrets.length} секретов)`);
    return { updated, image };
  }

  private async getImageId(server: ServerRecord, image: string): Promise<string> {
    try {
      return await this.execDocker(server, ['image', 'inspect', '-f', '{{.Id}}', image], 5000);
    } catch {
      return '';
    }
  }

  // ─── Автонастройка удалённого сервера ───

  /**
   * Настраивает удалённый сервер: устанавливает Docker, запускает MTProxy контейнер.
   * Для local-серверов проверяет наличие Docker.
   * Возвращает лог выполнения построчно через callback.
   */
  async setupServer(serverId: number, onLog: (msg: string) => void): Promise<void> {
    const server = this.getServer(serverId);
    if (!server) throw new Error(`Сервер ${serverId} не найден`);

    const image = process.env.PROXY_IMAGE || 'ghcr.io/skrashevich/mtproxy:latest';
    const tag = process.env.PROXY_TAG || '';

    // 1. Проверяем SSH-доступ (для remote)
    if (server.type === 'remote') {
      onLog('🔌 Проверяю SSH-доступ...');
      try {
        await this.execRemoteShell(server, 'echo ok', 10000);
        onLog('✅ SSH-доступ работает');
      } catch (err: any) {
        throw new Error(`SSH-доступ не работает: ${err.message}`);
      }
    }

    // 2. Проверяем/устанавливаем Docker
    onLog('🐳 Проверяю Docker...');
    let dockerInstalled = false;
    try {
      await this.execRemoteShell(server, 'docker --version', 5000);
      dockerInstalled = true;
      onLog('✅ Docker уже установлен');
    } catch {
      onLog('📦 Docker не найден, устанавливаю...');
    }

    if (!dockerInstalled) {
      if (server.type === 'local') {
        throw new Error('Docker не установлен на локальном сервере. Установите вручную.');
      }

      // Устанавливаем Docker через официальный скрипт
      onLog('⏳ Скачиваю и устанавливаю Docker (это может занять пару минут)...');
      try {
        await this.execRemoteShell(
          server,
          'curl -fsSL https://get.docker.com | sh',
          300000  // 5 минут таймаут
        );
        onLog('✅ Docker установлен');
      } catch (err: any) {
        throw new Error(`Ошибка установки Docker: ${err.message}`);
      }

      // Запускаем Docker daemon
      onLog('🔧 Запускаю Docker daemon...');
      try {
        await this.execRemoteShell(server, 'systemctl enable docker && systemctl start docker', 15000);
        onLog('✅ Docker daemon запущен');
      } catch (err: any) {
        throw new Error(`Ошибка запуска Docker: ${err.message}`);
      }
    }

    // 3. Скачиваем образ MTProxy
    onLog(`📥 Скачиваю образ ${image}...`);
    try {
      await this.execDocker(server, ['pull', image], 120000);
      onLog('✅ Образ скачан');
    } catch (err: any) {
      throw new Error(`Ошибка загрузки образа: ${err.message}`);
    }

    // 4. Проверяем, не запущен ли уже контейнер
    const running = await this.isContainerRunning(serverId);
    if (running) {
      onLog('✅ Контейнер уже запущен');
      return;
    }

    // 5. Запускаем контейнер (пока без секретов — они добавятся при активации пользователя)
    onLog('🚀 Запускаю контейнер MTProxy...');
    const container = server.container_name;
    validateContainerName(container);

    // Удаляем старый контейнер если есть
    try { await this.execDocker(server, ['rm', '-f', container], 5000); } catch { /* ok */ }

    const args = [
      'run', '-d',
      `--name=${container}`,
      '--restart=always',
      '-p', `${server.port}:443`,
      '-v', `${container}-config:/data`,
      ...(tag ? ['-e', `TAG=${tag}`] : []),
      image,
    ];

    try {
      await this.execDocker(server, args, 30000);
      onLog('✅ Контейнер запущен');
    } catch (err: any) {
      throw new Error(`Ошибка запуска контейнера: ${err.message}`);
    }

    // 6. Проверяем что всё работает
    const isRunning = await this.isContainerRunning(serverId);
    if (isRunning) {
      onLog('🎉 Сервер настроен и готов к работе!');
    } else {
      throw new Error('Контейнер запущен, но не отвечает. Проверьте логи вручную.');
    }
  }

  // ─── Мониторинг ───

  /** Получает статистику подключений с конкретного сервера */
  async getStats(serverId: number): Promise<{
    connections: number;
    maxConnections: number;
    secretConnections: Record<number, number>;
  } | null> {
    const server = this.getServer(serverId);
    if (!server) return null;

    try {
      const stdout = await this.execDocker(
        server,
        ['exec', server.container_name, 'curl', '-s', 'http://localhost:2398/stats'],
        5000
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
  async isContainerRunning(serverId: number): Promise<boolean> {
    const server = this.getServer(serverId);
    if (!server) return false;

    try {
      const result = await this.execDocker(
        server,
        ['inspect', '-f', '{{.State.Running}}', server.container_name],
        5000
      );
      return result === 'true';
    } catch {
      return false;
    }
  }

  /** Получает использование RAM (только для local серверов, для remote — через SSH) */
  async getRAMUsage(serverId: number): Promise<number> {
    const server = this.getServer(serverId);
    if (!server) return 0;

    try {
      const stdout = await this.execRemoteShell(
        server,
        "free | awk '/Mem:/ {printf \"%.0f\", $3/$2 * 100}'",
        3000
      );
      return parseInt(stdout) || 0;
    } catch {
      return 0;
    }
  }
}
