import { cents } from './money';

export function getPlatformFeeRate(): number {
  const envRate = process.env.PLATFORM_FEE_PERCENT;
  if (envRate) {
    const parsed = Number(envRate);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100 || !envRate.trim()) {
      throw new Error('PLATFORM_FEE_PERCENT must be a percentage between 0 and 100');
    }
    return parsed / 100;
  }
  return 0.15; // 15% default platform commission
}

export interface FeeCalculation {
  grossAmount: number;
  platformFee: number;
  netAmount: number;
  feeRate: number;
  feePercentage: number;
}

export function calculateFees(grossAmount: number, customRate?: number): FeeCalculation {
  const rate = customRate !== undefined ? customRate : getPlatformFeeRate();
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Invalid platform fee rate');
  const grossCents = cents(grossAmount);
  const feeCents = Math.round(grossCents * rate);
  const safeGross = grossCents / 100;
  const platformFee = feeCents / 100;
  const netAmount = (grossCents - feeCents) / 100;

  return {
    grossAmount: safeGross,
    platformFee,
    netAmount,
    feeRate: rate,
    feePercentage: Math.round(rate * 100),
  };
}
