import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { queries } from './database';
import { ProxyManager } from './proxy-manager';
import { TARIFFS, getTariffById, formatTariffList } from './tariffs';
import { formatTimeLeft } from './helpers';
import { syncServers, ServerRecord } from './server-config';
import cron from 'node-cron';

// ─── Конфиг ───
const BOT_TOKEN = process.env.BOT_TOKEN!;
const ADMIN_ID = parseInt(process.env.ADMIN_ID!);
const MAX_USERS = parseInt(process.env.MAX_USERS || '50');
const SOFT_LIMIT = parseInt(process.env.SOFT_LIMIT || '40');
const RAM_WARN = parseInt(process.env.RAM_WARN_PERCENT || '80');
const RAM_STOP = parseInt(process.env.RAM_STOP_PERCENT || '90');
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '0');
const TRIAL_MAX_CONNECTIONS = parseInt(process.env.TRIAL_MAX_CONNECTIONS || '1');
const TRIAL_ENABLED = TRIAL_DAYS > 0;
const TRIAL_NOTIFY_ADMIN_DEFAULT = process.env.TRIAL_NOTIFY_ADMIN !== '0';

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('❌ BOT_TOKEN и ADMIN_ID обязательны в .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const proxy = new ProxyManager();

// Флаг: заблокирована ли продажа (перегрузка)
let salesBlocked = false;
let salesBlockReason: 'manual' | 'ram' | null = null;
const lastRamWarnNotified = new Map<number, number>();

function formatSalesState() {
  if (!salesBlocked) return '✅ открыты';
  if (salesBlockReason === 'manual') return '⛔ заблокированы (вручную)';
  return '⛔ заблокированы (RAM)';
}

function loadTrialNotifySetting(): boolean {
  const row = queries.getSetting.get('trial_notify_enabled') as any;
  if (!row) return TRIAL_NOTIFY_ADMIN_DEFAULT;
  return row.value === '1';
}

let trialNotifyEnabled = loadTrialNotifySetting();

function getTotalActiveCount(): number {
  return (queries.getActiveUsersCount.get() as any).count;
}

function getCapacityState(userId: number): { existingUser: any; activeCount: number; canActivate: boolean } {
  const existingUser = queries.getUser.get(userId) as any;
  const activeCount = getTotalActiveCount();
  // Если пользователь уже активен — место занято, canActivate=true
  // Иначе проверяем наличие свободного сервера (единая точка правды)
  const canActivate = Boolean(existingUser?.is_active) || proxy.selectBestServer() !== null;
  return { existingUser, activeCount, canActivate };
}

function parseTelegramIdFromCommand(text: string): number | null {
  const id = Number.parseInt((text || '').split(' ')[1], 10);
  return Number.isNaN(id) ? null : id;
}

function buildTariffButtons() {
  return Object.values(TARIFFS).map((tariff) => [
    Markup.button.callback(`${tariff.emoji} ${tariff.name} — ${tariff.stars} ⭐`, `buy_${tariff.id}`),
  ]);
}

function buildPurchaseKeyboard() {
  const rows = buildTariffButtons();

  if (TRIAL_ENABLED) {
    rows.unshift([Markup.button.callback(`🎁 Бесплатный триал — ${TRIAL_DAYS} дн.`, 'start_trial')]);
  }

  return Markup.inlineKeyboard(rows);
}

function getUserServer(user: any): ServerRecord | null {
  if (!user?.server_id) return null;
  return queries.getServer.get(user.server_id) as ServerRecord | null;
}

// ═══════════════════════════════════════════════
// КОМАНДЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ
// ═══════════════════════════════════════════════

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  if (userId === ADMIN_ID) {
    return ctx.reply(
      '👑 Ты — админ.\n\n' +
        '/admin — управление\n' +
        '/stats — статистика\n' +
        '/users — список пользователей\n\n' +
        'Бот также работает как обычный для покупки.'
    );
  }

  const user = queries.getUser.get(userId) as any;
  if (user?.is_active) {
    const server = getUserServer(user);
    if (!server) {
      return ctx.reply('⚠️ Ошибка конфигурации сервера. Напиши админу.');
    }
    const link = proxy.buildLink(user.secret, server);
    const webLink = proxy.buildWebLink(user.secret, server);
    return ctx.reply(
      `✅ У тебя есть активная подписка!\n\n` +
        `Осталось: ${formatTimeLeft(user.expires_at)}\n\n` +
        `🔗 Ссылка:\n\`${link}\`\n\n` +
        `Или нажми: [Подключить](${webLink})`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Продлить', 'cmd_tariffs')],
        [Markup.button.callback('📊 Мой статус', 'cmd_status')],
      ])}
    );
  }

  return ctx.reply(
    '👋 Привет! Это бот для доступа к Telegram через прокси.\n\n' +
      'Если Telegram не работает — прокси решит проблему.\n\n' +
      `${formatTariffList()}\n\n` +
      (TRIAL_ENABLED ? `🎁 Бесплатный триал: ${TRIAL_DAYS} дн.\n\n` : '') +
      'Оплата через Telegram Stars ⭐ — безопасно и моментально.' +
      '\n\nЭто некоммерческий проект, деньги в лучшем случае окупят аренду серверов.\n' +
      'Полный исходный код бота и сопутствующих систем доступен на https://github.com/skrashevich',
    { ...buildPurchaseKeyboard(), link_preview_options: { is_disabled: true } }
  );
});

bot.command('tariffs', (ctx) => showTariffs(ctx));
bot.action('cmd_tariffs', (ctx) => { ctx.answerCbQuery(); showTariffs(ctx); });
bot.command('trial', (ctx) => startTrial(ctx));
bot.action('start_trial', async (ctx) => { await ctx.answerCbQuery(); await startTrial(ctx); });

async function showTariffs(ctx: Context) {
  await ctx.reply(
    `📋 Тарифы:\n\n${formatTariffList()}\n\n` +
      (TRIAL_ENABLED ? `🎁 Бесплатный триал: ${TRIAL_DAYS} дн. (/trial)\n\n` : '') +
      '1 Star ≈ 1.8-2.4 руб через @PremiumBot.',
    buildPurchaseKeyboard()
  );
}

async function activateUser(
  ctx: Context,
  userId: number,
  days: number,
  maxConnections: number,
  serverId?: number,
): Promise<{ secret: string; expiresAt: string; server: ServerRecord } | null> {
  const existing = queries.getUser.get(userId) as any;

  // Выбираем сервер
  let server: ServerRecord | null = null;
  if (existing?.is_active && existing.server_id) {
    server = queries.getServer.get(existing.server_id) as ServerRecord | null;
  }
  if (serverId) {
    server = queries.getServer.get(serverId) as ServerRecord | null;
  }
  if (!server) {
    server = proxy.selectBestServer();
  }
  if (!server) {
    await ctx.reply('😔 Все серверы заполнены! Попробуй позже или напиши админу.');
    return null;
  }

  let secret: string;
  let expiresAt: string;

  if (existing) {
    secret = existing.is_active ? existing.secret : proxy.generateSecret();

    const baseDate = existing.is_active
      ? new Date(Math.max(new Date(existing.expires_at).getTime(), Date.now()))
      : new Date();
    expiresAt = new Date(baseDate.getTime() + days * 86400000).toISOString();

    queries.updateUserSubscription.run({
      telegram_id: userId,
      secret,
      expires_at: expiresAt,
      max_connections: Math.max(existing.max_connections || 0, maxConnections),
      server_id: server.id,
    });
  } else {
    secret = proxy.generateSecret();
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();

    queries.insertUser.run({
      telegram_id: userId,
      username: ctx.from!.username || '',
      secret,
      expires_at: expiresAt,
      max_connections: maxConnections,
      is_active: 1,
      server_id: server.id,
    });
  }

  try {
    await proxy.restartWithSecrets(server.id);
  } catch (err) {
    console.error(`Ошибка перезапуска сервера "${server.name}":`, err);
    await notifyAdmin(
      `⚠️ Ошибка перезапуска сервера "${server.name}" после активации @${ctx.from!.username || userId}.`
    );
    await ctx.reply(
      '⚠️ Подписка активирована, но сервер не смог сразу применить изменения.\n' +
        'Админ уже уведомлён и завершит активацию вручную.'
    );
    return null;
  }

  return { secret, expiresAt, server };
}

async function startTrial(ctx: Context) {
  if (!TRIAL_ENABLED) {
    return ctx.reply('🎁 Бесплатный триал сейчас отключён.');
  }

  const userId = ctx.from!.id;

  if (salesBlocked) {
    return ctx.reply(
      '⏳ Сервер сейчас перегружен, выдача триала временно приостановлена.\n' +
        'Попробуй позже.'
    );
  }

  const { existingUser: existing, canActivate } = getCapacityState(userId);

  if (existing?.is_active) {
    return ctx.reply('У тебя уже активная подписка. Используй /status или /link.');
  }

  if (existing?.trial_used) {
    return ctx.reply('🎁 Ты уже использовал бесплатный триал. Доступны платные тарифы: /tariffs');
  }

  if (!canActivate) {
    return ctx.reply('😔 Все места заняты! Попробуй позже или напиши админу.');
  }

  const result = await activateUser(ctx, userId, TRIAL_DAYS, TRIAL_MAX_CONNECTIONS);
  if (!result) return;

  queries.markTrialUsed.run(userId);

  const link = proxy.buildLink(result.secret, result.server);
  const webLink = proxy.buildWebLink(result.secret, result.server);

  await ctx.reply(
    `🎁 Триал активирован!\n\n` +
      `Срок: ${TRIAL_DAYS} дн.\n` +
      `Действует до: ${formatDate(result.expiresAt)}\n\n` +
      `🔗 Ссылка:\n\`${link}\`\n\n` +
      `Или нажми: [Подключить](${webLink})\n\n` +
      `Команды: /link — ссылка, /status — статус`,
    { parse_mode: 'Markdown' }
  );

  if (trialNotifyEnabled) {
    const activeCount = getTotalActiveCount();
    await notifyAdmin(
      `🎁 Выдан триал\n` +
        `Пользователь: @${ctx.from!.username || userId}\n` +
        `Сервер: ${result.server.name}\n` +
        `Срок: ${TRIAL_DAYS} дн.\n` +
        `Активных: ${activeCount}/${MAX_USERS}`
    );
  }
}

// ─── Статус подписки ───
bot.command('status', (ctx) => showStatus(ctx));
bot.action('cmd_status', (ctx) => { ctx.answerCbQuery(); showStatus(ctx); });

async function showStatus(ctx: Context) {
  const user = queries.getUser.get(ctx.from!.id) as any;
  if (!user || !user.is_active) {
    return ctx.reply('У тебя нет активной подписки.\nИспользуй /tariffs чтобы выбрать тариф.');
  }

  const server = getUserServer(user);
  if (!server) {
    return ctx.reply('⚠️ Ошибка конфигурации сервера. Напиши админу.');
  }

  const link = proxy.buildLink(user.secret, server);

  await ctx.reply(
    `📊 Твоя подписка:\n\n` +
      `Статус: ✅ Активна\n` +
      `Осталось: ${formatTimeLeft(user.expires_at)}\n` +
      `До: ${formatDate(user.expires_at)}\n` +
      `Сервер: ${server.name}\n\n` +
      `🔗 Ссылка:\n\`${link}\``,
    { parse_mode: 'Markdown' }
  );
}

// ─── Получить ссылку ───
bot.command('link', (ctx) => showLink(ctx));

async function showLink(ctx: Context) {
  const user = queries.getUser.get(ctx.from!.id) as any;
  if (!user || !user.is_active) {
    return ctx.reply('Нет активной подписки. /tariffs');
  }
  const server = getUserServer(user);
  if (!server) {
    return ctx.reply('⚠️ Ошибка конфигурации сервера. Напиши админу.');
  }
  const link = proxy.buildLink(user.secret, server);
  const webLink = proxy.buildWebLink(user.secret, server);
  await ctx.reply(
    `🔗 Твоя ссылка для подключения:\n\n` +
      `\`${link}\`\n\n` +
      `Или нажми: [Подключить прокси](${webLink})\n\n` +
      `⚠️ Не передавай ссылку — она привязана к твоему аккаунту.`,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════════════
// ПОКУПКА И ОПЛАТА
// ═══════════════════════════════════════════════

// Обработка кнопки "Купить тариф"
for (const tariffId of Object.keys(TARIFFS)) {
  bot.action(`buy_${tariffId}`, async (ctx) => {
    await ctx.answerCbQuery();
    const tariff = getTariffById(tariffId)!;
    const userId = ctx.from!.id;

    if (salesBlocked) {
      return ctx.reply(
        '⏳ Сервер сейчас перегружен, продажи временно приостановлены.\n' +
          'Попробуй через час или напиши админу.'
      );
    }

    const { canActivate } = getCapacityState(userId);
    if (!canActivate) {
      return ctx.reply('😔 Все места заняты! Попробуй позже или напиши админу.');
    }

    try {
      await ctx.replyWithInvoice({
        title: `${tariff.emoji} ${tariff.name} — Telegram Proxy`,
        description: tariff.description,
        payload: JSON.stringify({ tariffId, userId }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: tariff.name, amount: tariff.stars }],
      });
    } catch (err: any) {
      console.error('Ошибка создания инвойса:', err);
      await ctx.reply('Ошибка при создании платежа. Попробуй позже.');
    }
  });
}

// ─── Обработка pre_checkout_query ───
bot.on('pre_checkout_query', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.preCheckoutQuery.invoice_payload);
    const tariff = getTariffById(payload.tariffId);

    if (!tariff) {
      return ctx.answerPreCheckoutQuery(false, 'Неизвестный тариф');
    }

    if (salesBlocked) {
      return ctx.answerPreCheckoutQuery(false, 'Сервер перегружен, попробуйте позже');
    }

    if (payload.userId !== ctx.from.id) {
      return ctx.answerPreCheckoutQuery(false, 'Инвойс недействителен для этого пользователя');
    }

    const { canActivate } = getCapacityState(payload.userId);
    if (!canActivate) {
      return ctx.answerPreCheckoutQuery(false, 'Все места заняты, попробуйте позже');
    }

    await ctx.answerPreCheckoutQuery(true);
  } catch (err) {
    console.error('pre_checkout_query error:', err);
    await ctx.answerPreCheckoutQuery(false, 'Ошибка обработки платежа');
  }
});

// ─── Успешный платёж ───
bot.on(message('successful_payment'), async (ctx) => {
  const payment = ctx.message.successful_payment;
  const userId = ctx.from.id;

  let payload: { tariffId: string; userId: number };
  try {
    payload = JSON.parse(payment.invoice_payload);
  } catch {
    console.error('Невалидный payload:', payment.invoice_payload);
    return;
  }

  const tariff = getTariffById(payload.tariffId);
  if (!tariff) {
    await ctx.reply('Ошибка: тариф не найден. Напиши админу.');
    return;
  }

  if (payload.userId !== userId) {
    await ctx.reply('Ошибка: инвойс не соответствует пользователю. Напиши админу.');
    await notifyAdmin(
      `⚠️ Инвойс userId=${payload.userId} оплачен пользователем ${userId}. charge=${payment.telegram_payment_charge_id}`
    );
    return;
  }

  const { activeCount, canActivate } = getCapacityState(userId);
  if (!canActivate) {
    queries.insertPayment.run({
      telegram_id: userId,
      tariff_id: tariff.id,
      stars_amount: payment.total_amount,
      status: 'pending',
      tg_charge_id: payment.telegram_payment_charge_id,
    });

    await ctx.reply(
      '⚠️ Оплата получена, но свободные места закончились.\n' +
        'Платёж отмечен и передан админу для ручной обработки.'
    );
    await notifyAdmin(
      `🚨 Оплата при полном лимите!\n` +
        `От: @${ctx.from.username || userId}\n` +
        `Тариф: ${tariff.name} (${payment.total_amount} ⭐)\n` +
        `Активных: ${activeCount}/${MAX_USERS}\n` +
        `Charge ID: ${payment.telegram_payment_charge_id}`
    );
    return;
  }

  const result = await activateUser(ctx, userId, tariff.days, tariff.maxConnections);
  if (!result) {
    // Активация не удалась — записываем платёж как pending для ручной обработки
    queries.insertPayment.run({
      telegram_id: userId,
      tariff_id: tariff.id,
      stars_amount: payment.total_amount,
      status: 'pending',
      tg_charge_id: payment.telegram_payment_charge_id,
    });
    await notifyAdmin(
      `🚨 Оплата без активации!\n` +
        `От: @${ctx.from.username || userId}\n` +
        `Тариф: ${tariff.name} (${payment.total_amount} ⭐)\n` +
        `Charge ID: ${payment.telegram_payment_charge_id}\n` +
        `Причина: не удалось активировать (нет свободных серверов или ошибка)`
    );
    return;
  }

  // Записываем платёж как завершённый
  queries.insertPayment.run({
    telegram_id: userId,
    tariff_id: tariff.id,
    stars_amount: payment.total_amount,
    status: 'completed',
    tg_charge_id: payment.telegram_payment_charge_id,
  });

  const link = proxy.buildLink(result.secret, result.server);
  const webLink = proxy.buildWebLink(result.secret, result.server);

  await ctx.reply(
    `✅ Оплата принята! Спасибо!\n\n` +
      `Тариф: ${tariff.emoji} ${tariff.name}\n` +
      `Действует до: ${formatDate(result.expiresAt)}\n\n` +
      `🔗 Ссылка:\n\`${link}\`\n\n` +
      `Или нажми: [Подключить](${webLink})\n\n` +
      `⚠️ Ссылка только для тебя — не передавай!\n` +
      `Команды: /link — ссылка, /status — статус`,
    { parse_mode: 'Markdown' }
  );

  await notifyAdmin(
    `💰 Оплата!\n` +
      `От: @${ctx.from.username || userId}\n` +
      `Тариф: ${tariff.name} (${payment.total_amount} ⭐)\n` +
      `Сервер: ${result.server.name}\n` +
      `Активных: ${getTotalActiveCount()}`
  );
});

// ═══════════════════════════════════════════════
// АДМИНСКИЕ КОМАНДЫ
// ═══════════════════════════════════════════════

bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply(
    '👑 Админ-панель:\n\n' +
      '/stats — статистика\n' +
      '/users — активные пользователи\n' +
      '/servers — список серверов\n' +
      '/server_status — статус серверов\n' +
      '/health — здоровье сервера\n' +
      '/block <tg_id> — деактивировать юзера\n' +
      '/unblock <tg_id> — активировать юзера\n' +
      '/extend <tg_id> <дней> — продлить подписку\n' +
      '/restart_proxy — перезапустить все прокси\n' +
      '/update_proxy [server_id] — обновить образ\n' +
      '/toggle_sales — вкл/выкл продажи\n' +
      '/toggle_trial_notify — вкл/выкл уведомления о триале\n' +
      '/enable_server <id> — включить сервер\n' +
      '/disable_server <id> — отключить сервер\n' +
      '/reload_servers — перечитать servers.json'
  );
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const active = getTotalActiveCount();
  const total = (queries.getTotalUsersCount.get() as any).count;
  const payStats = queries.getPaymentStats.get() as any;

  const serverLoads = proxy.getAllServerLoads();
  const serverLines = await Promise.all(serverLoads.map(async (s: any) => {
    const running = await proxy.isContainerRunning(s.id);
    const ram = await proxy.getRAMUsage(s.id);
    const stats = await proxy.getStats(s.id);
    return `   ${s.name} (${s.type}): ${s.active_users}/${s.max_users} юзеров, ` +
      `${running ? '✅' : '❌'}, RAM ${ram}%, подкл: ${stats?.connections ?? '?'}`;
  }));

  await ctx.reply(
    `📊 Статистика:\n\n` +
      `👥 Пользователей: ${active} активных / ${total} всего\n\n` +
      `💰 Платежи:\n` +
      `   Сегодня: ${payStats.today_payments || 0} (${payStats.today_stars || 0} ⭐)\n` +
      `   Всего: ${payStats.total_payments || 0} (${payStats.total_stars || 0} ⭐)\n\n` +
      `🖥 Серверы:\n${serverLines.join('\n')}\n\n` +
      `   Продажи: ${formatSalesState()}`
  );
});

bot.command('servers', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const serverLoads = proxy.getAllServerLoads();
  if (serverLoads.length === 0) {
    return ctx.reply('Нет настроенных серверов.');
  }

  const lines = serverLoads.map((s: any) =>
    `${s.id}. ${s.name} [${s.type}] ${s.is_active ? '✅' : '⛔'}\n` +
    `   ${s.host}:${s.port} (${s.container_name})\n` +
    `   Юзеров: ${s.active_users}/${s.max_users}` +
    (s.ssh_host ? `\n   SSH: ${s.ssh_host}:${s.ssh_port || 22}` : '')
  );

  await ctx.reply(`🖥 Серверы (${serverLoads.length}):\n\n${lines.join('\n\n')}`);
});

bot.command('server_status', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const serverLoads = proxy.getAllServerLoads();
  const lines = await Promise.all(serverLoads.map(async (s: any) => {
    const running = await proxy.isContainerRunning(s.id);
    const ram = await proxy.getRAMUsage(s.id);
    const stats = await proxy.getStats(s.id);

    let status = '✅';
    if (!running) status = '❌ ОСТАНОВЛЕН';
    else if (ram > RAM_STOP) status = '🔴 КРИТИЧЕСКАЯ';
    else if (ram > RAM_WARN) status = '🟡 Высокая';

    return `${s.name} [${s.type}] ${status}\n` +
      `   RAM: ${ram}%, контейнер: ${running ? 'работает' : 'СТОП'}\n` +
      `   Юзеров: ${s.active_users}/${s.max_users}\n` +
      `   Подключений: ${stats?.connections ?? 'н/д'}`;
  }));

  await ctx.reply(`🏥 Статус серверов:\n\n${lines.join('\n\n')}`);
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const users = queries.getAllActiveUsers.all() as any[];
  if (users.length === 0) {
    return ctx.reply('Нет активных пользователей.');
  }

  // Группируем по серверам
  const byServer = new Map<number, any[]>();
  for (const u of users) {
    const sid = u.server_id || 0;
    if (!byServer.has(sid)) byServer.set(sid, []);
    byServer.get(sid)!.push(u);
  }

  const lines: string[] = [];
  for (const [serverId, serverUsers] of byServer) {
    const server = serverId ? queries.getServer.get(serverId) as any : null;
    const serverName = server?.name || 'неизвестный';
    const proxyStats = serverId ? await proxy.getStats(serverId) : null;
    const secretOrder = serverUsers.map((u: any) => u.secret).filter(Boolean);

    lines.push(`\n📡 Сервер: ${serverName}`);
    for (let i = 0; i < serverUsers.length; i++) {
      const u = serverUsers[i];
      const days = Math.ceil((new Date(u.expires_at).getTime() - Date.now()) / 86400000);
      const secretIndex = secretOrder.indexOf(u.secret);
      const sessions = proxyStats && secretIndex >= 0 ? (proxyStats.secretConnections[secretIndex + 1] ?? 0) : 'н/д';
      lines.push(`${i + 1}. @${u.username || u.telegram_id} — ${days}дн, ${u.max_connections} устр., сессий: ${sessions}`);
    }
  }

  const header = `👥 Активные пользователи (${users.length}):`;
  const fullText = header + lines.join('\n');

  const MAX_LEN = 4096;
  const chunks: string[] = [];
  let current = '';

  for (const line of fullText.split('\n')) {
    if (current.length + line.length + 1 > MAX_LEN) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
});

bot.command('health', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const serverLoads = proxy.getAllServerLoads();
  const lines = await Promise.all(serverLoads.map(async (s: any) => {
    const ram = await proxy.getRAMUsage(s.id);
    const running = await proxy.isContainerRunning(s.id);
    const stats = await proxy.getStats(s.id);

    let status = '✅ Всё в порядке';
    if (ram > RAM_STOP) status = '🔴 КРИТИЧЕСКАЯ НАГРУЗКА';
    else if (ram > RAM_WARN) status = '🟡 Высокая нагрузка';
    if (!running) status = '❌ Proxy не запущен!';

    return `${s.name}: ${status}\n` +
      `   RAM: ${ram}%\n` +
      `   Контейнер: ${running ? 'работает' : 'ОСТАНОВЛЕН'}\n` +
      `   Подключений: ${stats?.connections ?? 'н/д'} / ${stats?.maxConnections ?? 'н/д'}`;
  }));

  await ctx.reply(`🏥 Здоровье серверов:\n\n${lines.join('\n\n')}`);
});

bot.command('block', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tgId = parseTelegramIdFromCommand(ctx.message.text);
  if (tgId === null) return ctx.reply('Использование: /block <telegram_id>');

  const user = queries.getUser.get(tgId) as any;
  if (!user) return ctx.reply(`Пользователь ${tgId} не найден.`);
  if (!user.is_active) return ctx.reply(`Пользователь ${tgId} уже деактивирован.`);

  try {
    queries.deactivateUser.run(tgId);
    if (user.server_id) {
      await proxy.restartWithSecrets(user.server_id);
    }
    await ctx.reply(`✅ Пользователь ${tgId} деактивирован, proxy перезапущен.`);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('unblock', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tgId = parseTelegramIdFromCommand(ctx.message.text);
  if (tgId === null) return ctx.reply('Использование: /unblock <telegram_id>');

  const user = queries.getUser.get(tgId) as any;
  if (!user) return ctx.reply(`Пользователь ${tgId} не найден.`);

  if (!user.expires_at || new Date(user.expires_at).getTime() < Date.now()) {
    return ctx.reply('Нельзя активировать истёкшую подписку. Попроси пользователя оплатить новый тариф.');
  }

  const { canActivate } = getCapacityState(tgId);
  if (!canActivate) {
    return ctx.reply(`😔 Все места заняты (${MAX_USERS}/${MAX_USERS}).`);
  }

  try {
    queries.activateUser.run(tgId);
    if (user.server_id) {
      await proxy.restartWithSecrets(user.server_id);
    }
    await ctx.reply(`✅ Пользователь ${tgId} активирован, proxy перезапущен.`);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('extend', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tgId = parseTelegramIdFromCommand(ctx.message.text);
  const days = Number.parseInt((ctx.message.text || '').split(/\s+/)[2], 10);
  if (tgId === null || Number.isNaN(days) || days <= 0 || days > 3650) {
    return ctx.reply('Использование: /extend <telegram_id> <дней> (1–3650)');
  }

  const user = queries.getUser.get(tgId) as any;
  if (!user) return ctx.reply(`Пользователь ${tgId} не найден.`);

  if (!user.is_active) {
    const { canActivate } = getCapacityState(tgId);
    if (!canActivate) {
      return ctx.reply(`😔 Все места заняты (${MAX_USERS}/${MAX_USERS}). Сначала освободите место.`);
    }
  }

  const baseDate = user.is_active
    ? new Date(Math.max(new Date(user.expires_at).getTime(), Date.now()))
    : new Date();
  const expiresAt = new Date(baseDate.getTime() + days * 86400000).toISOString();

  try {
    queries.extendSubscription.run({ telegram_id: tgId, expires_at: expiresAt });

    if (!user.is_active) {
      // Назначаем сервер если его нет
      let serverId = user.server_id;
      if (!serverId) {
        const bestServer = proxy.selectBestServer();
        if (bestServer) {
          serverId = bestServer.id;
          queries.updateUserServerId.run({ server_id: serverId, telegram_id: tgId });
        }
      }
      if (serverId) {
        await proxy.restartWithSecrets(serverId);
      }
    }

    await ctx.reply(
      `✅ Подписка пользователя ${tgId} продлена на ${days} дн.\n` +
        `Действует до: ${formatDate(expiresAt)}`
    );

    try {
      await bot.telegram.sendMessage(
        tgId,
        `🎉 Твоя подписка продлена на ${days} дн. (админом)\n` +
          `Действует до: ${formatDate(expiresAt)}\n\n` +
          `Ссылка: /link`
      );
    } catch {
      // Пользователь мог заблокировать бота
    }
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('restart_proxy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    await proxy.restartAllServers();
    await ctx.reply('✅ Все proxy серверы перезапущены.');
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('update_proxy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const serverIdStr = (ctx.message.text || '').split(/\s+/)[1];
  const servers = serverIdStr
    ? [queries.getServer.get(parseInt(serverIdStr)) as ServerRecord].filter(Boolean)
    : queries.getActiveServers.all() as ServerRecord[];

  if (servers.length === 0) {
    return ctx.reply('Серверы не найдены.');
  }

  await ctx.reply(`⏳ Обновляю ${servers.length} серверов...`);

  for (const server of servers) {
    try {
      const { updated, image } = await proxy.updateAndRestart(server.id);
      const status = updated ? '✅ Образ обновлён' : '✅ Образ актуален';
      await ctx.reply(`${server.name}: ${status}\n\`${image}\``, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ ${server.name}: ${err.message}`);
    }
  }
});

bot.command('enable_server', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseTelegramIdFromCommand(ctx.message.text);
  if (id === null) return ctx.reply('Использование: /enable_server <id>');

  const server = queries.getServer.get(id) as any;
  if (!server) return ctx.reply(`Сервер ${id} не найден.`);

  queries.setServerActive.run({ id, is_active: 1 });
  await ctx.reply(`✅ Сервер "${server.name}" включён.`);
});

bot.command('disable_server', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseTelegramIdFromCommand(ctx.message.text);
  if (id === null) return ctx.reply('Использование: /disable_server <id>');

  const server = queries.getServer.get(id) as any;
  if (!server) return ctx.reply(`Сервер ${id} не найден.`);

  queries.setServerActive.run({ id, is_active: 0 });
  await ctx.reply(`⛔ Сервер "${server.name}" отключён (новые пользователи не будут назначаться).`);
});

bot.command('reload_servers', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    syncServers();
    const servers = queries.getAllServers.all() as ServerRecord[];
    await ctx.reply(`✅ Конфигурация серверов перезагружена. Серверов: ${servers.length}`);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('toggle_sales', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  if (salesBlocked) {
    salesBlocked = false;
    salesBlockReason = null;
  } else {
    salesBlocked = true;
    salesBlockReason = 'manual';
  }

  await ctx.reply(`Продажи: ${formatSalesState().toUpperCase()}`);
});

bot.command('toggle_trial_notify', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  trialNotifyEnabled = !trialNotifyEnabled;
  queries.upsertSetting.run({
    key: 'trial_notify_enabled',
    value: trialNotifyEnabled ? '1' : '0',
  });
  await ctx.reply(
    `Уведомления о выдаче триала: ${trialNotifyEnabled ? '✅ ВКЛЮЧЕНЫ' : '⛔ ОТКЛЮЧЕНЫ'}`
  );
});

// ═══════════════════════════════════════════════
// CRON: МОНИТОРИНГ И АВТОМАТИКА
// ═══════════════════════════════════════════════

// Каждые 30 минут — проверка истёкших подписок
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Проверка истёкших подписок...');
  const servers = queries.getActiveServers.all() as ServerRecord[];
  const affectedServerIds = new Set<number>();

  for (const server of servers) {
    const expired = queries.getExpiredUsersByServer.all(server.id) as any[];
    if (expired.length === 0) continue;

    for (const user of expired) {
      queries.deactivateUser.run(user.telegram_id);
      try {
        await bot.telegram.sendMessage(
          user.telegram_id,
          '⏰ Твоя подписка на прокси истекла.\n\nПродли через /tariffs чтобы продолжить пользоваться.'
        );
      } catch {
        // Юзер мог заблокировать бота
      }
    }

    affectedServerIds.add(server.id);
    await notifyAdmin(
      `♻️ Сервер "${server.name}": истекло ${expired.length} подписок.`
    );
  }

  // Перезапускаем только затронутые серверы
  for (const serverId of affectedServerIds) {
    try {
      await proxy.restartWithSecrets(serverId);
    } catch (err) {
      console.error(`[Cron] Ошибка перезапуска сервера ${serverId}:`, err);
    }
  }
});

// Каждые 5 минут — мониторинг RAM и здоровья
cron.schedule('*/5 * * * *', async () => {
  const servers = queries.getActiveServers.all() as ServerRecord[];

  for (const server of servers) {
    const ram = await proxy.getRAMUsage(server.id);
    const running = await proxy.isContainerRunning(server.id);
    const activeOnServer = (queries.getActiveUsersCountByServer.get(server.id) as any).count;

    // RAM алерты (блокировка продаж при любом критическом сервере)
    if (ram > RAM_STOP && !salesBlocked) {
      salesBlocked = true;
      salesBlockReason = 'ram';
      await notifyAdmin(
        `🔴 Сервер "${server.name}": RAM ${ram}% > ${RAM_STOP}%!\nПродажи заблокированы.`
      );
    } else if (ram > RAM_WARN) {
      const lastWarn = lastRamWarnNotified.get(server.id) || 0;
      if (Date.now() - lastWarn > 3600000) {
        lastRamWarnNotified.set(server.id, Date.now());
        await notifyAdmin(`🟡 Сервер "${server.name}": RAM ${ram}%.`);
      }
    }

    // Проверка контейнера
    if (!running && activeOnServer > 0) {
      await notifyAdmin(`❌ Сервер "${server.name}": контейнер упал! Перезапускаю...`);
      try {
        await proxy.restartWithSecrets(server.id);
        await notifyAdmin(`✅ Сервер "${server.name}": контейнер восстановлен.`);
      } catch (err: any) {
        await notifyAdmin(`❌ Сервер "${server.name}": не удалось перезапустить: ${err.message}`);
      }
    }
  }

  // Автоматическое разблокирование продаж, если все серверы в норме
  if (salesBlocked && salesBlockReason === 'ram') {
    const allOk = await Promise.all(
      servers.map(async s => (await proxy.getRAMUsage(s.id)) < RAM_WARN)
    );
    if (allOk.every(Boolean)) {
      salesBlocked = false;
      salesBlockReason = null;
      await notifyAdmin(`🟢 Все серверы в норме, продажи разблокированы.`);
    }
  }

  // Soft limit
  const totalActive = getTotalActiveCount();
  if (totalActive >= SOFT_LIMIT && totalActive < MAX_USERS) {
    const minute = new Date().getMinutes();
    if (minute < 5) {
      await notifyAdmin(`⚠️ Активных юзеров: ${totalActive}/${MAX_USERS}. Приближаемся к лимиту.`);
    }
  }
});

// Каждый день в 3:00 — перезапуск всех proxy
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Ежедневный перезапуск всех proxy...');
  try {
    await proxy.restartAllServers();
    console.log('[Cron] Все proxy перезапущены.');
  } catch (err) {
    console.error('[Cron] Ошибка ежедневного перезапуска:', err);
    await notifyAdmin('❌ Ошибка ежедневного перезапуска proxy!');
  }
});

// ═══════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════

async function notifyAdmin(text: string) {
  try {
    await bot.telegram.sendMessage(ADMIN_ID, text);
  } catch (err) {
    console.error('Не удалось уведомить админа:', err);
  }
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

bot.telegram.setMyCommands([
  { command: 'start', description: 'Начало' },
  { command: 'tariffs', description: 'Тарифы' },
  ...(TRIAL_ENABLED ? [{ command: 'trial', description: 'Бесплатный триал' }] : []),
  { command: 'link', description: 'Моя ссылка' },
  { command: 'status', description: 'Статус подписки' },
  { command: 'help', description: 'Справка' },
]);

// ─── Помощь ───
bot.help((ctx) => {
  ctx.reply(
    '📖 Команды:\n\n' +
      '/tariffs — тарифы и покупка\n' +
      (TRIAL_ENABLED ? '/trial — активировать бесплатный период\n' : '') +
      '/link — получить ссылку\n' +
      '/status — статус подписки\n' +
      '/help — эта справка'
  );
});

// ═══════════════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════════════

export function startBot() {
  // Синхронизируем серверы из конфигурации
  syncServers();

  const servers = queries.getAllServers.all() as ServerRecord[];

  bot.launch();

  console.log('🤖 Бот запущен!');
  console.log(`👑 Админ: ${ADMIN_ID}`);
  console.log(`📦 Глобальный лимит: ${MAX_USERS} юзеров`);
  console.log(`🖥 Серверов: ${servers.length}`);
  for (const s of servers) {
    console.log(`   ${s.name} [${s.type}] ${s.host}:${s.port} (макс: ${s.max_users})`);
  }
  console.log(`🎁 Триал: ${TRIAL_ENABLED ? `${TRIAL_DAYS} дн, ${TRIAL_MAX_CONNECTIONS} устр.` : 'выключен'}`);
  console.log(`🔔 Уведомления о триале: ${trialNotifyEnabled ? 'включены' : 'отключены'}`);

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
