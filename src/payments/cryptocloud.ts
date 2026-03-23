import { PaymentProvider, PaymentMethod, PaymentResult } from './types';

const API_URL = 'https://api.cryptocloud.plus/v2';
const CRYPTOCLOUD_API_KEY = process.env.CRYPTOCLOUD_API_KEY || '';
const CRYPTOCLOUD_SHOP_ID = process.env.CRYPTOCLOUD_SHOP_ID || '';
const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class CryptoCloudProvider implements PaymentProvider {
  readonly method: PaymentMethod = 'cryptocloud';

  isConfigured(): boolean {
    return !!(CRYPTOCLOUD_API_KEY && CRYPTOCLOUD_SHOP_ID);
  }

  async createPayment(amount: number, label: string, description: string): Promise<PaymentResult> {
    if (!this.isConfigured()) throw new Error('CryptoCloud не настроен');

    const res = await fetchWithTimeout(`${API_URL}/invoice/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${CRYPTOCLOUD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shop_id: CRYPTOCLOUD_SHOP_ID,
        amount,
        currency: 'RUB',
        order_id: label,
        description,
      }),
    });

    const data = await res.json() as any;

    if (data.status !== 'success' || !data.result?.link) {
      throw new Error(`CryptoCloud: ${data.status || 'ошибка создания инвойса'}`);
    }

    return { payUrl: data.result.link, label };
  }

  async checkPayment(label: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const res = await fetchWithTimeout(`${API_URL}/invoice/info`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${CRYPTOCLOUD_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uuids: [label] }),
      });

      const data = await res.json() as any;

      if (data.status === 'success' && data.result?.length > 0) {
        return data.result[0].status === 'paid';
      }
    } catch (err) {
      console.error('[CryptoCloud] Ошибка проверки платежа:', err);
    }
    return false;
  }
}
