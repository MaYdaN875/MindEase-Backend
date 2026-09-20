import { AppError } from '../middlewares/errorMiddleware';

export function cents(value: unknown): number {
  const amount = Number(value);
  const result = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(result) || result > 999999999999 || Math.abs(amount * 100 - result) > 0.00001) {
    throw new AppError('El importe debe ser positivo y tener como máximo dos decimales', 400);
  }
  return result;
}

export function paymentView<T extends { amount: unknown; platformFee: unknown; netAmount: unknown }>(payment: T) {
  return { ...payment, amount: Number(payment.amount), platformFee: Number(payment.platformFee), netAmount: Number(payment.netAmount) };
}

export function validClabe(value: string): boolean {
  if (!/^\d{18}$/.test(value)) return false;
  const weights = [3, 7, 1];
  const sum = [...value.slice(0, 17)].reduce((total, digit, i) => total + (Number(digit) * weights[i % 3]) % 10, 0);
  return (10 - sum % 10) % 10 === Number(value[17]);
}
