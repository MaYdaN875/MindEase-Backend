import Stripe from 'stripe';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';
import { cents } from './money';
import { IPaymentGateway, PaymentGatewayChargeParams, PaymentGatewayChargeResult, PaymentGatewayRefundParams, PaymentGatewayRefundResult } from './paymentGateway';

export function paymentProvider(): 'MOCK' | 'STRIPE' {
  const provider = process.env.PAYMENT_PROVIDER?.toUpperCase() ||
    (process.env.NODE_ENV !== 'test' && process.env.STRIPE_SECRET_KEY ? 'STRIPE' : 'MOCK');
  if (provider !== 'MOCK' && provider !== 'STRIPE') throw new AppError('Proveedor de pagos no configurado', 503);
  return provider;
}

let client: Stripe | undefined;
let clientKey: string | undefined;
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY || '';
  // This delivery is sandbox-only. Production also needs Connect and operational review.
  if (!key.startsWith('sk_test_')) throw new AppError('Configura una clave de pruebas de Stripe; pagos reales deshabilitados', 503);
  if (!client || clientKey !== key) {
    client = new Stripe(key, { timeout: 15000, maxNetworkRetries: 2 });
    clientKey = key;
  }
  return client;
}

export function assertIntentMatches(intent: Stripe.PaymentIntent, attempt: {
  id: string; providerIntentId: string | null;
  payment: { id: string; amount: unknown; currency: string };
}) {
  if (intent.livemode || intent.metadata.attemptId !== attempt.id ||
      intent.metadata.paymentId !== attempt.payment.id ||
      (attempt.providerIntentId && intent.id !== attempt.providerIntentId) ||
      intent.amount !== cents(attempt.payment.amount) ||
      intent.currency !== attempt.payment.currency.toLowerCase() ||
      (intent.status === 'succeeded' && intent.amount_received !== intent.amount)) {
    throw new AppError('El pago no coincide con la reserva', 409);
  }
}

export class StripePaymentGateway implements IPaymentGateway {
  async intentForAttempt(attemptId: string): Promise<Stripe.PaymentIntent> {
    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { payment: true } });
    if (attempt.provider !== 'STRIPE') throw new AppError('Proveedor del intento incompatible', 409);
    const stripe = stripeClient();
    let intent: Stripe.PaymentIntent;
    if (attempt.providerIntentId) {
      intent = await stripe.paymentIntents.retrieve(attempt.providerIntentId, { expand: ['latest_charge'] });
    } else {
      // Stripe can prune idempotency keys after 24h: never recreate an uncertain old charge.
      if (attempt.createdAt.getTime() < Date.now() - 23 * 3600000) {
        throw new AppError('Intento antiguo pendiente de conciliacion manual', 409);
      }
      intent = await stripe.paymentIntents.create({
        amount: cents(attempt.payment.amount), currency: attempt.payment.currency.toLowerCase(),
        payment_method_types: ['card'],
        metadata: { attemptId: attempt.id, paymentId: attempt.payment.id },
      }, { idempotencyKey: `mindease:pi:${attempt.idempotencyKey}` });
      assertIntentMatches(intent, attempt);
      await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { providerIntentId: intent.id } });
    }
    assertIntentMatches(intent, attempt);
    return intent;
  }

  async lookupCharge(key: string): Promise<PaymentGatewayChargeResult | null> {
    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { idempotencyKey: key }, include: { payment: { include: { appointment: true } } } });
    let intent = await this.intentForAttempt(attempt.id);
    const expired = attempt.createdAt.getTime() < Date.now() - 15 * 60000;
    const closed = attempt.payment.appointment.status === 'CANCELLED' || attempt.payment.appointment.startAt.getTime() <= Date.now();
    if ((expired || closed) && ['requires_payment_method', 'requires_action', 'requires_confirmation'].includes(intent.status)) {
      try { intent = await stripeClient().paymentIntents.cancel(intent.id); }
      catch { intent = await stripeClient().paymentIntents.retrieve(intent.id, { expand: ['latest_charge'] }); }
    }
    assertIntentMatches(intent, attempt);
    if (!['succeeded', 'canceled'].includes(intent.status)) return null;
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    return { success: intent.status === 'succeeded', status: intent.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      refundDetected: !!charge && (charge.refunded || charge.amount_refunded > 0),
      transactionId: intent.id, cardBrand: charge?.payment_method_details?.card?.brand || '',
      cardLast4: charge?.payment_method_details?.card?.last4 || '' };
  }

  async charge(_params: PaymentGatewayChargeParams): Promise<PaymentGatewayChargeResult> {
    throw new AppError('Utiliza PaymentSheet; no envies datos de tarjeta al servidor', 400);
  }

  async refund(params: PaymentGatewayRefundParams): Promise<PaymentGatewayRefundResult> {
    const stripe = stripeClient();
    const payment = await prisma.payment.findFirstOrThrow({ where: { transactionId: params.transactionId } });
    let refund: Stripe.Refund | undefined;
    if (payment.refundId) refund = await stripe.refunds.retrieve(payment.refundId);
    else {
      // Recover refunds created in Dashboard or before a lost response; never double-refund.
      const refunds = await stripe.refunds.list({ payment_intent: params.transactionId, limit: 100 });
      if (refunds.has_more) throw new AppError('Historial de reembolsos requiere revision manual', 409);
      const relevant = refunds.data.filter(r => r.status !== 'failed' && r.status !== 'canceled');
      if (relevant.length > 1 || (relevant[0] && relevant[0].amount !== cents(params.amount))) {
        throw new AppError('Reembolso parcial requiere conciliacion manual', 409);
      }
      refund = relevant[0];
      if (!refund) refund = await stripe.refunds.create({ payment_intent: params.transactionId, amount: cents(params.amount) }, { idempotencyKey: params.idempotencyKey });
      await prisma.payment.update({ where: { id: payment.id }, data: { refundId: refund.id } });
    }
    if (refund.amount !== cents(params.amount) || refund.currency !== payment.currency.toLowerCase()) throw new AppError('Reembolso parcial requiere revision manual', 409);
    return { success: refund.status === 'succeeded', refundId: refund.id,
      status: refund.status === 'succeeded' ? 'REFUNDED' : 'FAILED' };
  }
}
