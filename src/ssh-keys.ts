import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir, access, constants } from 'fs/promises';
import path from 'path';
import https from 'https';

const execFileAsync = promisify(execFile);

const BOT_KEY_DIR = path.join(__dirname, '..', 'data', 'ssh');
const BOT_KEY_PATH = path.join(BOT_KEY_DIR, 'id_ed25519');
const BOT_KEY_PUB_PATH = `${BOT_KEY_PATH}.pub`;

/** Получает публичные SSH-ключи пользователя с GitHub */
export async function fetchGithubKeys(username: string): Promise<string[]> {
  // Валидация username — только допустимые символы GitHub
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(username)) {
    throw new Error(`Невалидный GitHub username: ${username}`);
  }

  const url = `https://github.com/${username}.keys`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode === 404) {
        reject(new Error(`GitHub пользователь "${username}" не найден`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GitHub вернул статус ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const keys = data.trim().split('\n').filter(Boolean);
        if (keys.length === 0) {
          reject(new Error(`У пользователя "${username}" нет SSH-ключей на GitHub`));
          return;
        }
        resolve(keys);
      });
    });

    req.on('error', (err) => reject(new Error(`Ошибка запроса к GitHub: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Таймаут запроса к GitHub')); });
  });
}

/** Проверяет существование SSH-ключа бота */
async function botKeyExists(): Promise<boolean> {
  try {
    await access(BOT_KEY_PUB_PATH, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Генерирует SSH-ключ бота (ed25519) если его нет */
export async function ensureBotSshKey(): Promise<string> {
  if (await botKeyExists()) {
    return (await readFile(BOT_KEY_PUB_PATH, 'utf-8')).trim();
  }

  await mkdir(BOT_KEY_DIR, { recursive: true });

  await execFileAsync('ssh-keygen', [
    '-t', 'ed25519',
    '-f', BOT_KEY_PATH,
    '-N', '',  // без пароля
    '-C', 'mtproxy-bot',
  ], { timeout: 10000 });

  return (await readFile(BOT_KEY_PUB_PATH, 'utf-8')).trim();
}

/** Возвращает публичный ключ бота */
export async function getBotPublicKey(): Promise<string | null> {
  if (!(await botKeyExists())) return null;
  return (await readFile(BOT_KEY_PUB_PATH, 'utf-8')).trim();
}

/** Возвращает путь к приватному ключу бота */
export function getBotKeyPath(): string {
  return BOT_KEY_PATH;
}

/**
 * Устанавливает SSH-ключи на удалённый сервер через ssh-copy-id
 * или напрямую добавляет в authorized_keys.
 * Требует пароль или уже настроенный SSH-доступ.
 */
export async function deployKeysToServer(
  keys: string[],
  sshHost: string,
  sshPort: number = 22,
  existingKeyPath?: string,
): Promise<void> {
  const authorizedKeysContent = keys.join('\n') + '\n';

  // Формируем SSH-команду для добавления ключей
  const remoteCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

  const sshArgs = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];
  if (existingKeyPath) {
    sshArgs.push('-i', existingKeyPath);
  }
  if (sshPort !== 22) {
    sshArgs.push('-p', String(sshPort));
  }
  sshArgs.push(sshHost, remoteCmd);

  const child = execFileAsync('ssh', sshArgs, { timeout: 15000 });
  // Передаём ключи через stdin
  child.child.stdin?.write(authorizedKeysContent);
  child.child.stdin?.end();
  await child;
}
