import { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { paymentView } from '../services/money';
import { reservePayment, finalizePayment } from '../services/paymentWorkflow';
import { paymentProvider, stripeClient, StripePaymentGateway, assertIntentMatches } from '../services/stripeGateway';
import { processPendingRefunds } from '../services/refundPolicy';

function safeError(res: Response, error: unknown) {
  // Never return/log Stripe payloads, secrets, or request headers.
  res.status(error instanceof AppError ? error.statusCode : 503).json({ status: 'error',
    message: error instanceof AppError ? error.message : 'Pago pendiente de conciliacion. Reintenta la misma reserva.' });
}

export async function paymentConfig(_req: Request, res: Response) {
  try {
    const provider = paymentProvider();
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
    if (provider === 'STRIPE') {
      stripeClient();
      if (!publishableKey.startsWith('pk_test_')) throw new AppError('Falta STRIPE_PUBLISHABLE_KEY de pruebas en el backend', 503);
    }
    res.json({ data: { provider, publishableKey: provider === 'STRIPE' ? publishableKey : null } });
  } catch (error) { safeError(res, error); }
}

export async function createStripeIntent(req: AuthenticatedRequest, res: Response) {
  try {
    if (paymentProvider() !== 'STRIPE') throw new AppError('Stripe no esta habilitado', 409);
    stripeClient();
    const parsed = z.object({ appointmentId: z.string().uuid(), idempotencyKey: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) throw new AppError('Reserva o llave invalida; no envies datos de tarjeta', 400);
    if (req.header('idempotency-key') && req.header('idempotency-key') !== parsed.data.idempotencyKey) throw new AppError('Llaves inconsistentes', 400);
    const attempt = await reservePayment(req.user!.userId, parsed.data.appointmentId, parsed.data.idempotencyKey, 'STRIPE');
    if (attempt.status === 'FAILED') {
      res.status(409).json({ status: 'error', definitiveFailure: true, message: 'El intento ha sido cancelado. Puedes iniciar otro intento.' });
      return;
    }
    const gateway = new StripePaymentGateway();
    const result = await gateway.lookupCharge(attempt.idempotencyKey);
    if (result) await finalizePayment(attempt.id, result);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.paymentId } });
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: payment.appointmentId } });
    const intent = await gateway.intentForAttempt(attempt.id);
    // A canceled appointment must never expose a still-confirmable client secret.
    const canPay = payment.status === 'PROCESSING' && appointment.status === 'PENDING' &&
      ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status);
    res.json({ data: { payment: paymentView(payment), appointmentStatus: appointment.status,
      autoConfirmed: false, clientSecret: canPay ? intent.client_secret : null,
      intentStatus: intent.status, definitiveFailure: intent.status === 'canceled' } });
  } catch (error) { safeError(res, error); }
}

export async function stripeWebhook(req: Request, res: Response) {
  let event: Stripe.Event;
  try {
    const signature = req.header('stripe-signature');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature || !Buffer.isBuffer(req.body)) { res.sendStatus(400); return; }
    event = stripeClient().webhooks.constructEvent(req.body, signature, secret);
    if (event.livemode) { res.sendStatus(400); return; }
  } catch { res.sendStatus(400); return; }
  const supported = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.processing',
    'payment_intent.canceled', 'refund.created', 'refund.updated', 'refund.failed'];
  if (!supported.includes(event.type)) { res.json({ received: true }); return; }
  try {
    if (await prisma.stripeWebhookEvent.findUnique({ where: { id: event.id } })) { res.json({ received: true }); return; }
    if (event.type.startsWith('payment_intent.')) {
      const object = event.data.object as Stripe.PaymentIntent;
      const attempt = await prisma.paymentAttempt.findFirst({ where: { provider: 'STRIPE', OR: [
        { providerIntentId: object.id }, ...(object.metadata?.attemptId ? [{ id: object.metadata.attemptId }] : []),
      ] }, include: { payment: true } });
      if (attempt) {
        // Retrieve authoritative state so delayed failure events cannot reverse success.
        const current = await stripeClient().paymentIntents.retrieve(object.id);
        assertIntentMatches(current, attempt);
        if (!attempt.providerIntentId) await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { providerIntentId: current.id } });
        const result = await new StripePaymentGateway().lookupCharge(attempt.idempotencyKey);
        if (result) await finalizePayment(attempt.id, result);
      }
    } else {
      const refund = await stripeClient().refunds.retrieve((event.data.object as Stripe.Refund).id);
      const intentId = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
      if (intentId) {
        const attempt = await prisma.paymentAttempt.findUnique({ where: { providerIntentId: intentId } });
        if (attempt?.provider === 'STRIPE' && attempt.status === 'PROCESSING') {
          const result = await new StripePaymentGateway().lookupCharge(attempt.idempotencyKey);
          if (result) await finalizePayment(attempt.id, result);
        }
        const payment = await prisma.payment.findFirst({ where: { transactionId: intentId } });
        if (payment) {
          // Dashboard refunds also freeze earnings. Partial/failed refunds remain for review.
          await prisma.payment.updateMany({ where: { id: payment.id, status: 'SUCCEEDED' }, data: { status: 'REFUND_PENDING', refundId: refund.id, refundReason: 'Reembolso registrado en Stripe' } });
          await processPendingRefunds(payment.id);
        }
      }
    }
    // Effects above are idempotent; a crash before this marker safely replays them.
    await prisma.stripeWebhookEvent.upsert({ where: { id: event.id }, create: { id: event.id, type: event.type }, update: {} });
    res.json({ received: true });
  } catch { res.status(503).json({ message: 'Evento pendiente de conciliacion' }); }
}
