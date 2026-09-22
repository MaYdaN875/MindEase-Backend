// Explicit additive local migration. No reset, db push, data deletion, or secret output.
require('dotenv').config();
const fs = require('node:fs');
const { PrismaClient } = require('@prisma/client');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('Only local database allowed');
  const db = new PrismaClient();
  try {
    const columns = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'PaymentAttempt'`;
    if (!columns.some(c => c.column_name === 'idempotencyKey')) throw Error('Previous payment schema missing');
    const table = await db.$queryRaw`SELECT to_regclass('"StripeWebhookEvent"')::text AS name`;
    if (columns.some(c => c.column_name === 'provider') && columns.some(c => c.column_name === 'providerIntentId') && table[0].name) {
      console.log('Stripe migration already present'); return;
    }
    if (columns.some(c => ['provider', 'providerIntentId'].includes(c.column_name)) || table[0].name) throw Error('Partial migration requires review');
    const sql = fs.readFileSync('prisma/migrations/20260921000000_stripe_payments/migration.sql', 'utf8');
    await db.$transaction(async tx => {
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    });
    console.log('Stripe additive migration applied; existing data preserved');
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error('Migration failed; database not reset.', error.code || error.message.split('\n').at(-1)); process.exitCode = 1; });
