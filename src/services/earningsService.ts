import prisma from '../config/db';

export function maskClabe(clabe: string): string {
  if (!clabe) return '';
  const clean = clabe.trim();
  if (clean.length < 4) return clean;
  return '*'.repeat(Math.max(0, clean.length - 4)) + clean.slice(-4);
}

export interface MonthlyEarningsBreakdown {
  month: string; // e.g. "2026-09"
  monthName: string; // e.g. "Septiembre 2026"
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  consultationCount: number;
}

export interface TransactionSummaryItem {
  paymentId: string;
  appointmentId: string;
  createdAt: string;
  patientName: string;
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  currency: string;
  appointmentStatus: string;
  fundStatus: 'HELD' | 'AVAILABLE';
  cardLast4?: string | null;
  cardBrand?: string | null;
}

export interface PsychologistFinancials {
  psychologistId: string;
  currency: string;
  availableBalance: number;       // Liberado tras consulta COMPLETED y no retirado
  heldBalance: number;            // En custodia (citas pagadas futuras/confirmadas no concluidas)
  pendingPayoutBalance: number;   // Solicitudes de retiro en proceso (reserva de saldo)
  totalWithdrawn: number;         // Retiros completados históricamente
  lifetimeNetEarnings: number;    // Ganancias netas históricas por consultas concluidas
  lifetimePlatformFees: number;   // Total de comisiones retenidas por plataforma
  lifetimeGrossVolume: number;    // Total bruto de consultas concluidas
  monthlyBreakdown: MonthlyEarningsBreakdown[];
  recentTransactions: TransactionSummaryItem[];
}

export async function getPsychologistFinancials(psychologistId: string): Promise<PsychologistFinancials> {
  // Query all succeeded payments for this psychologist
  const payments = await prisma.payment.findMany({
    where: {
      psychologistId,
      status: 'SUCCEEDED',
    },
    include: {
      appointment: {
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
          user: {
            select: {
              name: true,
              email: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Query all payout requests
  const payouts = await prisma.payoutRequest.findMany({
    where: { psychologistId },
    orderBy: { requestedAt: 'desc' },
  });

  let lifetimeGrossVolume = 0;
  let lifetimePlatformFees = 0;
  let lifetimeNetEarnings = 0;
  let heldBalance = 0;

  const monthlyMap = new Map<string, { gross: number; fee: number; net: number; count: number }>();
  const recentTransactions: TransactionSummaryItem[] = [];

  for (const payment of payments) {
    const isCompleted = payment.appointment.status === 'COMPLETED';
    const fundStatus: 'HELD' | 'AVAILABLE' = isCompleted ? 'AVAILABLE' : 'HELD';

    if (isCompleted) {
      lifetimeGrossVolume = Math.round((lifetimeGrossVolume + payment.amount) * 100) / 100;
      lifetimePlatformFees = Math.round((lifetimePlatformFees + payment.platformFee) * 100) / 100;
      lifetimeNetEarnings = Math.round((lifetimeNetEarnings + payment.netAmount) * 100) / 100;

      const dateStr = payment.createdAt.toISOString();
      const monthKey = dateStr.slice(0, 7); // "YYYY-MM"
      const existing = monthlyMap.get(monthKey) || { gross: 0, fee: 0, net: 0, count: 0 };
      existing.gross = Math.round((existing.gross + payment.amount) * 100) / 100;
      existing.fee = Math.round((existing.fee + payment.platformFee) * 100) / 100;
      existing.net = Math.round((existing.net + payment.netAmount) * 100) / 100;
      existing.count += 1;
      monthlyMap.set(monthKey, existing);
    } else {
      heldBalance = Math.round((heldBalance + payment.netAmount) * 100) / 100;
    }

    recentTransactions.push({
      paymentId: payment.id,
      appointmentId: payment.appointmentId,
      createdAt: payment.createdAt.toISOString(),
      patientName: payment.appointment.user.name,
      grossAmount: payment.amount,
      platformFee: payment.platformFee,
      netAmount: payment.netAmount,
      currency: payment.currency,
      appointmentStatus: payment.appointment.status,
      fundStatus,
      cardLast4: payment.cardLast4,
      cardBrand: payment.cardBrand,
    });
  }

  // Payout aggregations
  let pendingPayoutBalance = 0;
  let totalWithdrawn = 0;

  for (const payout of payouts) {
    if (payout.status === 'REQUESTED' || payout.status === 'PROCESSING') {
      pendingPayoutBalance = Math.round((pendingPayoutBalance + payout.amount) * 100) / 100;
    } else if (payout.status === 'COMPLETED') {
      totalWithdrawn = Math.round((totalWithdrawn + payout.amount) * 100) / 100;
    }
  }

  const rawAvailable = lifetimeNetEarnings - pendingPayoutBalance - totalWithdrawn;
  const availableBalance = Math.max(0, Math.round(rawAvailable * 100) / 100);

  const monthsEs = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthlyBreakdown: MonthlyEarningsBreakdown[] = Array.from(monthlyMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, data]) => {
      const [y, m] = month.split('-');
      const monthName = `${monthsEs[parseInt(m, 10) - 1]} ${y}`;
      return {
        month,
        monthName,
        grossAmount: data.gross,
        platformFee: data.fee,
        netAmount: data.net,
        consultationCount: data.count,
      };
    });

  return {
    psychologistId,
    currency: 'MXN',
    availableBalance,
    heldBalance,
    pendingPayoutBalance,
    totalWithdrawn,
    lifetimeNetEarnings,
    lifetimePlatformFees,
    lifetimeGrossVolume,
    monthlyBreakdown,
    recentTransactions,
  };
}
