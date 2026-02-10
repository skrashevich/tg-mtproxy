/**
 * Тарифы для Telegram Proxy
 *
 * Курс Stars для пользователя: ~1.8-2.4 руб/star через @PremiumBot
 *
 * Пересчёт:
 *   15₽  → ~8 Stars
 *   50₽  → ~25 Stars
 *   100₽ → ~50 Stars
 */

export interface Tariff {
  id: string;
  name: string;
  emoji: string;
  stars: number;
  days: number;
  maxConnections: number;
  description: string;
}

export const TARIFFS: Record<string, Tariff> = {
  day: {
    id: 'day',
    name: '1 день',
    emoji: '⚡',
    stars: 8,
    days: 1,
    maxConnections: 1,
    description: '~15 руб • 1 устройство',
  },
  week: {
    id: 'week',
    name: '7 дней',
    emoji: '🔵',
    stars: 25,
    days: 7,
    maxConnections: 1,
    description: '~50 руб • 1 устройство',
  },
  month: {
    id: 'month',
    name: '30 дней',
    emoji: '🟣',
    stars: 50,
    days: 30,
    maxConnections: 1,
    description: '~100 руб • 1 устройство',
  },
};

export function getTariffById(id: string): Tariff | undefined {
  return TARIFFS[id];
}

export function formatTariffList(): string {
  return Object.values(TARIFFS)
    .map((t) => `${t.emoji} ${t.name} — ${t.stars} ⭐ (${t.description})`)
    .join('\n');
}
