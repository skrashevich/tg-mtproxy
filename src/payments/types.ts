export type PaymentMethod = 'stars' | 'cryptobot' | 'cryptocloud';

export interface PaymentResult {
  payUrl?: string;       // URL для перенаправления (cryptobot, cryptocloud)
  invoiceId?: string;    // ID инвойса (для Stars — отправляется inline)
  label: string;         // внутренний идентификатор платежа
}

export interface PaymentProvider {
  readonly method: PaymentMethod;
  isConfigured(): boolean;
  createPayment(amount: number, label: string, description: string, chatId?: number): Promise<PaymentResult>;
  checkPayment(label: string): Promise<boolean>;
}

export const ALL_METHODS: PaymentMethod[] = ['stars', 'cryptobot', 'cryptocloud'];

export const PAYMENT_METHOD_NAMES: Record<PaymentMethod, string> = {
  stars: '⭐ Telegram Stars',
  cryptobot: '🪙 CryptoBot',
  cryptocloud: '💎 CryptoCloud',
};
