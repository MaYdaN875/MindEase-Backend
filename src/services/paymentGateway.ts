import crypto from 'crypto';
import { AppError } from '../middlewares/errorMiddleware';

export interface CardDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  holderName: string;
}

export interface CustomerDetails {
  id: string;
  email: string;
  name: string;
}

export interface PaymentGatewayChargeParams {
  amount: number;
  currency: string;
  card: CardDetails;
  customer: CustomerDetails;
  description?: string;
  idempotencyKey?: string;
}

export interface PaymentGatewayChargeResult {
  success: boolean;
  transactionId: string;
  cardBrand: string;
  cardLast4: string;
  status: 'SUCCEEDED' | 'FAILED';
  declineCode?: string;
  errorMessage?: string;
  authorizationCode?: string;
}

export interface PaymentGatewayRefundParams {
  transactionId: string;
  amount?: number;
  reason?: string;
}

export interface PaymentGatewayRefundResult {
  success: boolean;
  refundId: string;
  status: 'REFUNDED' | 'FAILED';
  errorMessage?: string;
}

export interface IPaymentGateway {
  charge(params: PaymentGatewayChargeParams): Promise<PaymentGatewayChargeResult>;
  refund(params: PaymentGatewayRefundParams): Promise<PaymentGatewayRefundResult>;
}

export function detectCardBrand(cleanNumber: string): string {
  if (/^4/.test(cleanNumber)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(cleanNumber)) return 'MASTERCARD';
  if (/^3[47]/.test(cleanNumber)) return 'AMEX';
  return 'OTHER';
}

function luhnCheck(numStr: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = parseInt(numStr.charAt(i), 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n = (n % 10) + 1;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export class MockPaymentGateway implements IPaymentGateway {
  async charge(params: PaymentGatewayChargeParams): Promise<PaymentGatewayChargeResult> {
    const { amount, currency = 'MXN', card } = params;
    void currency;

    if (!amount || amount <= 0) {
      throw new AppError('El monto debe ser un número positivo', 400);
    }

    const cleanNumber = (card.number || '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(cleanNumber)) {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4: cleanNumber.slice(-4) || '0000',
        declineCode: 'INVALID_NUMBER',
        errorMessage: 'El número de tarjeta no es válido.',
      };
    }

    // Expiry check
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const expYear = card.expYear < 100 ? 2000 + card.expYear : card.expYear;

    if (
      card.expMonth < 1 ||
      card.expMonth > 12 ||
      expYear < currentYear ||
      (expYear === currentYear && card.expMonth < currentMonth)
    ) {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4: cleanNumber.slice(-4),
        declineCode: 'EXPIRED_CARD',
        errorMessage: 'La tarjeta se encuentra vencida.',
      };
    }

    // CVC check
    const cleanCvc = (card.cvc || '').trim();
    if (!/^\d{3,4}$/.test(cleanCvc)) {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4: cleanNumber.slice(-4),
        declineCode: 'INVALID_CVC',
        errorMessage: 'Código de seguridad (CVC) inválido.',
      };
    }

    // Simulated decline cases based on last 4 digits
    const cardLast4 = cleanNumber.slice(-4);
    if (cardLast4 === '0002') {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4,
        declineCode: 'INSUFFICIENT_FUNDS',
        errorMessage: 'Fondos insuficientes en la cuenta del cliente.',
      };
    }

    if (cardLast4 === '0005') {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4,
        declineCode: 'DO_NOT_HONOR',
        errorMessage: 'Transacción declinada por el banco emisor.',
      };
    }

    // Check Luhn algorithm for realistic testing (unless test prefix 4000 or 4242)
    if (!cleanNumber.startsWith('4242') && !cleanNumber.startsWith('4000') && !luhnCheck(cleanNumber)) {
      return {
        success: false,
        status: 'FAILED',
        transactionId: `ch_fail_${crypto.randomUUID()}`,
        cardBrand: detectCardBrand(cleanNumber),
        cardLast4,
        declineCode: 'LUHN_CHECK_FAILED',
        errorMessage: 'Dígito de control de tarjeta inválido.',
      };
    }

    // Successful charge simulation
    const brand = detectCardBrand(cleanNumber);
    const authCode = `AUTH_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const transactionId = `ch_mock_${crypto.randomUUID()}`;

    return {
      success: true,
      status: 'SUCCEEDED',
      transactionId,
      cardBrand: brand,
      cardLast4,
      authorizationCode: authCode,
    };
  }

  async refund(params: PaymentGatewayRefundParams): Promise<PaymentGatewayRefundResult> {
    if (!params.transactionId) {
      return {
        success: false,
        status: 'FAILED',
        refundId: '',
        errorMessage: 'Se requiere el transactionId para procesar el reembolso.',
      };
    }

    return {
      success: true,
      status: 'REFUNDED',
      refundId: `re_mock_${crypto.randomUUID()}`,
    };
  }
}

let gatewayInstance: IPaymentGateway | null = null;

export function getPaymentGateway(): IPaymentGateway {
  if (!gatewayInstance) {
    gatewayInstance = new MockPaymentGateway();
  }
  return gatewayInstance;
}
