import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { queries } from './database';
import { ProxyManager } from './proxy-manager';
import { TARIFFS, getTariffById, formatTariffList } from './tariffs';
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

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('❌ BOT_TOKEN и ADMIN_ID обязательны в .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const proxy = new ProxyManager();

// Флаг: заблокирована ли продажа (перегрузка)
let salesBlocked = false;

function getCapacityState(userId: number): { existingUser: any; activeCount: number; canActivate: boolean } {
  const existingUser = queries.getUser.get(userId) as any;
  const activeCount = (queries.getActiveUsersCount.get() as any).count;
  const canActivate = Boolean(existingUser?.is_active) || activeCount < MAX_USERS;
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

// ═══════════════════════════════════════════════
// КОМАНДЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ
// ═══════════════════════════════════════════════

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // Обработка deeplink: /start ref_XXXXX (реферал на будущее)
  const startPayload = ctx.startPayload;

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
    const link = proxy.buildLink(user.secret);
    const webLink = proxy.buildWebLink(user.secret);
    return ctx.reply(
      `✅ У тебя есть активная подписка!\n\n` +
        `Действует до: ${formatDate(user.expires_at)}\n\n` +
        `🔗 Ссылка:\n\`${link}\`\n\n` +
        `Или нажми: [Подключить](${webLink})`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
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
      'Оплата через Telegram Stars ⭐ — безопасно и моментально.',
    buildPurchaseKeyboard()
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

  const { existingUser: existing, activeCount, canActivate } = getCapacityState(userId);

  if (existing?.is_active) {
    return ctx.reply('У тебя уже активная подписка. Используй /status или /link.');
  }

  if (existing?.trial_used) {
    return ctx.reply('🎁 Ты уже использовал бесплатный триал. Доступны платные тарифы: /tariffs');
  }

  if (existing) {
    return ctx.reply('🎁 Триал доступен только новым пользователям.');
  }

  if (!canActivate) {
    return ctx.reply('😔 Все места заняты! Попробуй позже или напиши админу.');
  }

  const secret = proxy.generateSecret();
  const expiresAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();

  queries.insertUser.run({
    telegram_id: userId,
    username: ctx.from!.username || '',
    secret,
    expires_at: expiresAt,
    max_connections: TRIAL_MAX_CONNECTIONS,
    is_active: 1,
  });
  queries.markTrialUsed.run(userId);

  let proxyRestarted = true;
  try {
    await proxy.restartWithSecrets();
  } catch (err) {
    proxyRestarted = false;
    console.error('Ошибка перезапуска proxy после триала:', err);
    await notifyAdmin(
      `⚠️ Ошибка перезапуска proxy после триала от @${ctx.from!.username || userId}.`
    );
  }

  if (!proxyRestarted) {
    await ctx.reply(
      '⚠️ Триал выдан, но сервер не смог сразу активировать доступ.\n' +
        'Админ уже уведомлён и завершит активацию вручную.'
    );
    return;
  }

  const link = proxy.buildLink(secret);
  const webLink = proxy.buildWebLink(secret);

  await ctx.reply(
    `🎁 Триал активирован!\n\n` +
      `Срок: ${TRIAL_DAYS} дн.\n` +
      `Действует до: ${formatDate(expiresAt)}\n\n` +
      `🔗 Ссылка:\n\`${link}\`\n\n` +
      `Или нажми: [Подключить](${webLink})\n\n` +
      `Команды: /link — ссылка, /status — статус`,
    { parse_mode: 'Markdown' }
  );

  await notifyAdmin(
    `🎁 Выдан триал\n` +
      `Пользователь: @${ctx.from!.username || userId}\n` +
      `Срок: ${TRIAL_DAYS} дн.\n` +
      `Активных: ${activeCount + 1}/${MAX_USERS}`
  );
}

// ─── Статус подписки ───
bot.command('status', (ctx) => showStatus(ctx));
bot.action('cmd_status', (ctx) => { ctx.answerCbQuery(); showStatus(ctx); });

async function showStatus(ctx: Context) {
  const user = queries.getUser.get(ctx.from!.id) as any;
  if (!user || !user.is_active) {
    return ctx.reply('У тебя нет активной подписки.\nИспользуй /tariffs чтобы выбрать тариф.');
  }

  const link = proxy.buildLink(user.secret);
  const daysLeft = Math.max(0, Math.ceil((new Date(user.expires_at).getTime() - Date.now()) / 86400000));

  await ctx.reply(
    `📊 Твоя подписка:\n\n` +
      `Статус: ✅ Активна\n` +
      `Осталось: ${daysLeft} дн.\n` +
      `До: ${formatDate(user.expires_at)}\n\n` +
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
  const link = proxy.buildLink(user.secret);
  const webLink = proxy.buildWebLink(user.secret);
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

    // Проверка лимитов
    if (salesBlocked) {
      return ctx.reply(
        '⏳ Сервер сейчас перегружен, продажи временно приостановлены.\n' +
          'Попробуй через час или напиши админу.'
      );
    }

    const { canActivate } = getCapacityState(userId);

    if (!canActivate) {
      return ctx.reply(
        '😔 Все места заняты! Попробуй позже или напиши админу.'
      );
    }

    // Отправляем инвойс через Telegram Stars
    try {
      await ctx.replyWithInvoice({
        title: `${tariff.emoji} ${tariff.name} — Telegram Proxy`,
        description: tariff.description,
        payload: JSON.stringify({ tariffId, userId }),
        provider_token: '', // пустой для Telegram Stars
        currency: 'XTR',
        prices: [{ label: tariff.name, amount: tariff.stars }],
      });
    } catch (err: any) {
      console.error('Ошибка создания инвойса:', err);
      await ctx.reply('Ошибка при создании платежа. Попробуй позже.');
    }
  });
}

// ─── Обработка pre_checkout_query (подтверждение оплаты) ───
bot.on('pre_checkout_query', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.preCheckoutQuery.invoice_payload);
    const tariff = getTariffById(payload.tariffId);

    if (!tariff) {
      return ctx.answerPreCheckoutQuery(false, 'Неизвестный тариф');
    }

    // Проверяем не заблокированы ли продажи
    if (salesBlocked) {
      return ctx.answerPreCheckoutQuery(false, 'Сервер перегружен, попробуйте позже');
    }

    // Инвойс должен быть оплачен тем же пользователем, для которого создан
    if (payload.userId !== ctx.from.id) {
      return ctx.answerPreCheckoutQuery(false, 'Инвойс недействителен для этого пользователя');
    }

    // Повторно проверяем лимиты, т.к. инвойс мог быть создан раньше
    const { canActivate } = getCapacityState(payload.userId);
    if (!canActivate) {
      return ctx.answerPreCheckoutQuery(false, 'Все места заняты, попробуйте позже');
    }

    // Всё ок — подтверждаем
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

  // Доп. защита от оплаты чужого/устаревшего инвойса
  if (payload.userId !== userId) {
    await ctx.reply('Ошибка: инвойс не соответствует пользователю. Напиши админу.');
    await notifyAdmin(
      `⚠️ Инвойс userId=${payload.userId} оплачен пользователем ${userId}. charge=${payment.telegram_payment_charge_id}`
    );
    return;
  }

  const { existingUser: existing, activeCount, canActivate } = getCapacityState(userId);
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

  let secret: string;
  let expiresAt: string;

  if (existing) {
    // Продление — генерируем новый секрет (или оставляем старый)
    secret = existing.is_active ? existing.secret : proxy.generateSecret();

    // Если активен — прибавляем дни к текущей дате истечения
    const baseDate = existing.is_active
      ? new Date(Math.max(new Date(existing.expires_at).getTime(), Date.now()))
      : new Date();
    expiresAt = new Date(baseDate.getTime() + tariff.days * 86400000).toISOString();

    queries.updateUserSubscription.run({
      telegram_id: userId,
      secret,
      expires_at: expiresAt,
      max_connections: Math.max(existing.max_connections, tariff.maxConnections),
    });
  } else {
    // Новый пользователь
    secret = proxy.generateSecret();
    expiresAt = new Date(Date.now() + tariff.days * 86400000).toISOString();

    queries.insertUser.run({
      telegram_id: userId,
      username: ctx.from.username || '',
      secret,
      expires_at: expiresAt,
      max_connections: tariff.maxConnections,
      is_active: 1,
    });
  }

  // Записываем платёж
  queries.insertPayment.run({
    telegram_id: userId,
    tariff_id: tariff.id,
    stars_amount: payment.total_amount,
    status: 'completed',
    tg_charge_id: payment.telegram_payment_charge_id,
  });

  // Пересоздаём контейнер
  let proxyRestarted = true;
  try {
    await proxy.restartWithSecrets();
  } catch (err) {
    proxyRestarted = false;
    console.error('Ошибка перезапуска proxy:', err);
    await notifyAdmin(
      `⚠️ Ошибка перезапуска proxy после оплаты от @${ctx.from.username || userId}.\n` +
        `Charge ID: ${payment.telegram_payment_charge_id}`
    );
  }

  if (!proxyRestarted) {
    await ctx.reply(
      '⚠️ Оплата принята, но сервер не смог сразу активировать доступ.\n' +
        'Админ уже уведомлён и завершит активацию вручную.'
    );
    return;
  }

  const link = proxy.buildLink(secret);
  const webLink = proxy.buildWebLink(secret);

  await ctx.reply(
    `✅ Оплата принята! Спасибо!\n\n` +
      `Тариф: ${tariff.emoji} ${tariff.name}\n` +
      `Действует до: ${formatDate(expiresAt)}\n\n` +
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
      `Активных: ${(queries.getActiveUsersCount.get() as any).count}`
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
      '/health — здоровье сервера\n' +
      '/block <tg_id> — деактивировать юзера\n' +
      '/unblock <tg_id> — активировать юзера\n' +
      '/restart_proxy — перезапустить прокси\n' +
      '/toggle_sales — вкл/выкл продажи'
  );
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const active = (queries.getActiveUsersCount.get() as any).count;
  const total = (queries.getTotalUsersCount.get() as any).count;
  const payStats = queries.getPaymentStats.get() as any;
  const proxyStats = await proxy.getStats();
  const ram = proxy.getRAMUsage();
  const running = proxy.isContainerRunning();

  await ctx.reply(
    `📊 Статистика:\n\n` +
      `👥 Пользователей: ${active} активных / ${total} всего\n` +
      `📦 Лимит: ${active}/${MAX_USERS}\n\n` +
      `💰 Платежи:\n` +
      `   Сегодня: ${payStats.today_payments || 0} (${payStats.today_stars || 0} ⭐)\n` +
      `   Всего: ${payStats.total_payments || 0} (${payStats.total_stars || 0} ⭐)\n\n` +
      `🖥 Сервер:\n` +
      `   RAM: ${ram}%\n` +
      `   Proxy: ${running ? '✅ работает' : '❌ остановлен'}\n` +
      `   Подключений: ${proxyStats?.connections ?? '?'}\n` +
      `   Продажи: ${salesBlocked ? '⛔ заблокированы' : '✅ открыты'}`
  );
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const users = queries.getAllActiveUsers.all() as any[];
  if (users.length === 0) {
    return ctx.reply('Нет активных пользователей.');
  }

  const lines = users.map((u, i) => {
    const days = Math.ceil((new Date(u.expires_at).getTime() - Date.now()) / 86400000);
    return `${i + 1}. @${u.username || u.telegram_id} — ${days}дн, ${u.max_connections} устр.`;
  });

  await ctx.reply(`👥 Активные пользователи (${users.length}):\n\n${lines.join('\n')}`);
});

bot.command('health', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const ram = proxy.getRAMUsage();
  const running = proxy.isContainerRunning();
  const stats = await proxy.getStats();

  let status = '✅ Всё в порядке';
  if (ram > RAM_STOP) status = '🔴 КРИТИЧЕСКАЯ НАГРУЗКА';
  else if (ram > RAM_WARN) status = '🟡 Высокая нагрузка';
  if (!running) status = '❌ Proxy не запущен!';

  await ctx.reply(
    `🏥 Здоровье сервера: ${status}\n\n` +
      `RAM: ${ram}%\n` +
      `Proxy контейнер: ${running ? 'работает' : 'ОСТАНОВЛЕН'}\n` +
      `Подключений: ${stats?.connections ?? 'н/д'} / ${stats?.maxConnections ?? 'н/д'}`
  );
});

bot.command('block', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const tgId = parseTelegramIdFromCommand(ctx.message.text);
  if (tgId === null) return ctx.reply('Использование: /block <telegram_id>');

  try {
    queries.deactivateUser.run(tgId);
    await proxy.restartWithSecrets();
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
    await proxy.restartWithSecrets();
    await ctx.reply(`✅ Пользователь ${tgId} активирован, proxy перезапущен.`);
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('restart_proxy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    await proxy.restartWithSecrets();
    await ctx.reply('✅ Proxy контейнер перезапущен.');
  } catch (err: any) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
});

bot.command('toggle_sales', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  salesBlocked = !salesBlocked;
  await ctx.reply(`Продажи: ${salesBlocked ? '⛔ ЗАБЛОКИРОВАНЫ' : '✅ ОТКРЫТЫ'}`);
});

// ═══════════════════════════════════════════════
// CRON: МОНИТОРИНГ И АВТОМАТИКА
// ═══════════════════════════════════════════════

// Каждые 30 минут — проверка истёкших подписок
cron.schedule('*/30 * * * *', async () => {
  console.log('[Cron] Проверка истёкших подписок...');
  const expired = queries.getExpiredUsers.all() as any[];

  if (expired.length === 0) return;

  for (const user of expired) {
    queries.deactivateUser.run(user.telegram_id);

    // Уведомляем юзера
    try {
      await bot.telegram.sendMessage(
        user.telegram_id,
        '⏰ Твоя подписка на прокси истекла.\n\nПродли через /tariffs чтобы продолжить пользоваться.'
      );
    } catch {
      // Юзер мог заблокировать бота
    }
  }

  // Перезапускаем proxy без удалённых секретов
  try {
    await proxy.restartWithSecrets();
  } catch (err) {
    console.error('[Cron] Ошибка перезапуска:', err);
  }

  await notifyAdmin(
    `♻️ Истекло ${expired.length} подписок.\n` +
      `Пользователи уведомлены, proxy обновлён.`
  );
});

// Каждые 5 минут — мониторинг RAM и здоровья
cron.schedule('*/5 * * * *', async () => {
  const ram = proxy.getRAMUsage();
  const running = proxy.isContainerRunning();
  const active = (queries.getActiveUsersCount.get() as any).count;

  // RAM алерты
  if (ram > RAM_STOP && !salesBlocked) {
    salesBlocked = true;
    await notifyAdmin(
      `🔴 RAM ${ram}% > ${RAM_STOP}%!\nПродажи автоматически заблокированы.`
    );
  } else if (ram > RAM_WARN) {
    await notifyAdmin(`🟡 RAM ${ram}% — приближаемся к лимиту.`);
  } else if (ram < RAM_WARN && salesBlocked) {
    // Автоматически разблокируем если RAM снизилась
    salesBlocked = false;
    await notifyAdmin(`🟢 RAM ${ram}%, продажи автоматически разблокированы.`);
  }

  // Проверка контейнера
  if (!running && active > 0) {
    await notifyAdmin('❌ Proxy контейнер упал! Пытаюсь перезапустить...');
    try {
      await proxy.restartWithSecrets();
      await notifyAdmin('✅ Proxy контейнер восстановлен.');
    } catch (err: any) {
      await notifyAdmin(`❌ Не удалось перезапустить: ${err.message}`);
    }
  }

  // Soft limit
  if (active >= SOFT_LIMIT && active < MAX_USERS) {
    // Уведомляем раз в час (не спамим)
    const minute = new Date().getMinutes();
    if (minute < 5) {
      await notifyAdmin(`⚠️ Активных юзеров: ${active}/${MAX_USERS}. Приближаемся к лимиту.`);
    }
  }
});

// Каждый день в 3:00 — перезапуск proxy (рекомендация из документации)
cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Ежедневный перезапуск proxy...');
  try {
    await proxy.restartWithSecrets();
    console.log('[Cron] Proxy перезапущен.');
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
  bot.launch();

  console.log('🤖 Бот запущен!');
  console.log(`👑 Админ: ${ADMIN_ID}`);
  console.log(`📦 Лимит: ${MAX_USERS} юзеров`);
  console.log(`🎁 Триал: ${TRIAL_ENABLED ? `${TRIAL_DAYS} дн, ${TRIAL_MAX_CONNECTIONS} устр.` : 'выключен'}`);

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
