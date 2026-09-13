export function getPlatformFeeRate(): number {
  const envRate = process.env.PLATFORM_FEE_PERCENT;
  if (envRate) {
    const parsed = parseFloat(envRate);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      return parsed > 1 ? parsed / 100 : parsed;
    }
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
  const safeGross = Math.round(grossAmount * 100) / 100;
  const platformFee = Math.round(safeGross * rate * 100) / 100;
  const netAmount = Math.round((safeGross - platformFee) * 100) / 100;

  return {
    grossAmount: safeGross,
    platformFee,
    netAmount,
    feeRate: rate,
    feePercentage: Math.round(rate * 100),
  };
}
