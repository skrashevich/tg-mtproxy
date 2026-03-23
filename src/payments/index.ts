import { Telegraf } from 'telegraf';
import { PaymentProvider, PaymentMethod, PAYMENT_METHOD_NAMES, ALL_METHODS } from './types';
import { CryptoBotProvider } from './cryptobot';
import { CryptoCloudProvider } from './cryptocloud';
import { queries } from '../database';

// ─── Провайдеры ───

const cryptobot = new CryptoBotProvider();
const cryptocloud = new CryptoCloudProvider();

const providers: Partial<Record<PaymentMethod, PaymentProvider>> = {
  cryptobot,
  cryptocloud,
};

// ─── Управление включёнными методами оплаты ───

/** Проверяет, включён ли конкретный метод */
export function isMethodEnabled(method: PaymentMethod): boolean {
  const row = queries.getSetting.get(`payment_${method}_enabled`) as any;
  if (!row) {
    // По умолчанию: stars включены, остальные выключены
    return method === 'stars';
  }
  return row.value === '1';
}

/** Включает/выключает метод оплаты */
export function setMethodEnabled(method: PaymentMethod, enabled: boolean): void {
  queries.upsertSetting.run({ key: `payment_${method}_enabled`, value: enabled ? '1' : '0' });
  console.log(`[Payments] ${PAYMENT_METHOD_NAMES[method]}: ${enabled ? 'включён' : 'выключён'}`);
}

/** Метод доступен = включён + настроен (токены заполнены) */
function isMethodAvailable(method: PaymentMethod): boolean {
  if (!isMethodEnabled(method)) return false;
  if (method === 'stars') return true;
  const provider = providers[method];
  return !!provider?.isConfigured();
}

/** Список доступных (включённых + настроенных) методов */
export function getEnabledMethods(): PaymentMethod[] {
  return ALL_METHODS.filter(m => isMethodAvailable(m));
}

/** Получить провайдер по методу */
export function getProvider(method: PaymentMethod): PaymentProvider | null {
  return providers[method] ?? null;
}

/** Статус всех методов для отображения в админке */
export function getAllMethodsStatus(): Array<{
  method: PaymentMethod;
  name: string;
  enabled: boolean;
  configured: boolean;
}> {
  return ALL_METHODS.map(m => ({
    method: m,
    name: PAYMENT_METHOD_NAMES[m],
    enabled: isMethodEnabled(m),
    configured: m === 'stars' ? true : !!providers[m]?.isConfigured(),
  }));
}

// ─── Поллинг ожидающих платежей ───

const PAYMENT_EXPIRE_MS = 30 * 60 * 1000; // 30 минут

export function startPaymentPolling(
  bot: Telegraf,
  onPaid: (pending: any) => Promise<void>,
): void {
  setInterval(async () => {
    const pendings = queries.getAllPendingPayments.all() as any[];
    if (pendings.length === 0) return;

    const now = Date.now();

    for (const p of pendings) {
      // Определяем провайдер по method из pending payment
      const provider = providers[p.payment_method as PaymentMethod];
      if (!provider) continue;

      try {
        // Истёк срок ожидания
        if (now - new Date(p.created_at).getTime() > PAYMENT_EXPIRE_MS) {
          // Последняя проверка перед закрытием
          try {
            const paid = await provider.checkPayment(p.label);
            if (paid) {
              queries.claimPendingPayment.run(p.label);
              await onPaid(p);
              continue;
            }
          } catch { /* ignore */ }

          queries.expirePendingPayment.run(p.label);

          try {
            await bot.telegram.sendMessage(p.chat_id,
              '⏰ Время на оплату истекло (30 мин).\n\n' +
              'Если ты уже оплатил, напиши админу.\n' +
              'Или выбери тариф заново: /tariffs'
            );
          } catch { /* ignore */ }
          continue;
        }

        // Проверяем оплату
        const paid = await provider.checkPayment(p.label);
        if (paid) {
          queries.claimPendingPayment.run(p.label);
          await onPaid(p);
        }
      } catch (err) {
        console.error(`[Payments] Ошибка поллинга label=${p.label}:`, err);
      }
    }
  }, 15_000);
}

export { PAYMENT_METHOD_NAMES, ALL_METHODS } from './types';
export type { PaymentMethod, PaymentResult } from './types';
