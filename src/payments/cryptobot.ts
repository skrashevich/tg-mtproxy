import { PaymentProvider, PaymentMethod, PaymentResult } from './types';

const API_URL = 'https://pay.crypt.bot/api';
const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_TOKEN || '';
const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function apiRequest(method: string, params: Record<string, any> = {}): Promise<any> {
  const res = await fetchWithTimeout(`${API_URL}/${method}`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const data = await res.json() as any;
  if (!data.ok) {
    throw new Error(`CryptoBot API: ${data.error?.name || 'unknown'}`);
  }
  return data.result;
}

export class CryptoBotProvider implements PaymentProvider {
  readonly method: PaymentMethod = 'cryptobot';

  isConfigured(): boolean {
    return !!CRYPTOBOT_TOKEN;
  }

  async createPayment(amount: number, label: string, description: string): Promise<PaymentResult> {
    if (!this.isConfigured()) throw new Error('CryptoBot не настроен');

    const result = await apiRequest('createInvoice', {
      currency_type: 'fiat',
      fiat: 'RUB',
      amount: amount.toFixed(2),
      description,
      payload: label,
      expires_in: 1800,
      paid_btn_name: 'callback',
      paid_btn_url: 'https://t.me',
    });

    return { payUrl: result.bot_invoice_url, label };
  }

  async checkPayment(label: string): Promise<boolean> {
    try {
      const result = await apiRequest('getInvoices', { status: 'paid' });
      if (result.items) {
        return result.items.some((inv: any) => inv.payload === label);
      }
    } catch (err) {
      console.error('[CryptoBot] Ошибка проверки платежа:', err);
    }
    return false;
  }
}
