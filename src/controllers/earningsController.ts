import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { getPsychologistFinancials, maskClabe } from '../services/earningsService';
import { requireProfessional, serializable } from '../services/clinicalPolicy';

import { cents, validClabe } from '../services/money';
import { getPaymentGateway } from '../services/paymentGateway';

const payoutSchema = z.object({
  amount: z.number().positive('El monto a retirar debe ser mayor a 0'),
  bankName: z.string().trim().min(2, 'Ingresa el nombre del banco').max(100),
  accountClabe: z.string().trim().regex(/^\d{18}$/, 'La CLABE interbancaria debe tener exactamente 18 dígitos numéricos'),
  idempotencyKey: z.string().uuid(),
  notes: z.string().max(500).optional(),
});

export const getMyEarnings = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const profile = await prisma.psychologistProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('Perfil de psicólogo no encontrado', 404);

    const financials = await getPsychologistFinancials(profile.id);
    res.status(200).json({
      status: 'success',
      data: { financials },
    });
  } catch (error) {
    next(error);
  }
};

export const requestPayout = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = payoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400);
    }

    const { amount, bankName, accountClabe, notes, idempotencyKey } = parsed.data;
    cents(amount);
    if (!validClabe(accountClabe)) throw new AppError('CLABE inválida: verifica el dígito de control', 400);
    getPaymentGateway(); // Payout requests are simulation-only until a real provider is integrated.
    const userId = req.user!.userId;

    const profile = await prisma.psychologistProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('Perfil de psicólogo no encontrado', 404);

    const payout = await serializable(async tx => {
      await requireProfessional(tx, profile.id);
      const existing = await tx.payoutRequest.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.psychologistId !== profile.id || Number(existing.amount) !== amount || existing.accountClabe !== maskClabe(accountClabe) || existing.bankName !== bankName) throw new AppError('Llave de retiro ya utilizada', 409);
        return existing;
      }
      // Re-calculate live balance inside transaction to block concurrent overdraws
      const payments = await tx.payment.findMany({
        where: {
          psychologistId: profile.id,
          currency: 'MXN',
          status: 'SUCCEEDED',
          appointment: { status: 'COMPLETED' },
        },
        select: { netAmount: true },
      });

      const payouts = await tx.payoutRequest.findMany({
        where: {
          psychologistId: profile.id,
          currency: 'MXN',
          status: { in: ['REQUESTED', 'PROCESSING', 'COMPLETED'] },
        },
        select: { amount: true },
      });

      const totalEarned = payments.reduce((sum, p) => sum + cents(p.netAmount), 0);
      const totalReservedOrWithdrawn = payouts.reduce((sum, p) => sum + cents(p.amount), 0);
      const liveAvailable = (totalEarned - totalReservedOrWithdrawn) / 100;

      if (amount > liveAvailable) {
        throw new AppError(
          `Fondos insuficientes: El monto solicitado ($${amount.toFixed(2)}) excede tu saldo disponible ($${liveAvailable.toFixed(2)})`,
          400
        );
      }

      return tx.payoutRequest.create({
        data: {
          psychologistId: profile.id,
          currency: 'MXN',
          amount,
          bankName,
          accountClabe: maskClabe(accountClabe),
          idempotencyKey,
          notes,
          status: 'REQUESTED',
        },
      });
    });

    res.status(201).json({
      status: 'success',
      message: 'Solicitud de retiro simulada: no se realizará una transferencia bancaria',
      data: {
        payout: {
          id: payout.id,
          amount: Number(payout.amount),
          currency: payout.currency,
          bankName: payout.bankName,
          accountClabe: maskClabe(payout.accountClabe),
          status: payout.status,
          requestedAt: payout.requestedAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getMyPayouts = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const profile = await prisma.psychologistProfile.findUnique({ where: { userId } });
    if (!profile) throw new AppError('Perfil de psicólogo no encontrado', 404);

    const payouts = await prisma.payoutRequest.findMany({
      where: { psychologistId: profile.id },
      orderBy: { requestedAt: 'desc' },
    });

    res.status(200).json({
      status: 'success',
      data: {
        payouts: payouts.map(p => ({
          id: p.id,
          amount: Number(p.amount),
          currency: p.currency,
          status: p.status,
          bankName: p.bankName,
          accountClabe: maskClabe(p.accountClabe),
          requestedAt: p.requestedAt,
          processedAt: p.processedAt,
          notes: p.notes,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};
