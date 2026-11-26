// Local disposable databases only. This does not restore application data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'prisma', 'migrations');
const schemaFile = path.join(root, 'prisma', 'schema.prisma');
const baselineFile = path.join(root, 'prisma', 'bootstrap', 'baseline.sql');
const schemaHash = '3f7feed8808c1f7586b9d33356e7dc80227b07c46b32f92d66dd1da4198da0ed';
const historyHash = '2c92fae15cc3e1e9c377871899b0597de4bdd667a36d60acecf7e7f6bb67960f';
const baselineHash = '85baf1614f7b565d2d5ad07f8fbd8bd9f6f5e80e7f76c2edb19910d53c885eb7';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const normalized = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Bootstrap is disabled in production.');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly.');
  const target = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '55439' ||
      !/^\/mindease_bootstrap_[a-z0-9_]+$/.test(target.pathname) ||
      (target.searchParams.get('schema') || 'public') !== 'public') {
    throw new Error('Only a dedicated local database named mindease_bootstrap_* on port 55439 and schema public is permitted.');
  }
  const names = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const history = crypto.createHash('sha256');
  for (const name of names) {
    history.update(name + '\n');
    history.update(normalized(path.join(migrationsDir, name, 'migration.sql')));
  }
  if (digest(normalized(schemaFile)) !== schemaHash || history.digest('hex') !== historyHash ||
      digest(normalized(baselineFile)) !== baselineHash) {
    throw new Error('The schema, baseline or migration history changed; review the frozen baseline before proceeding.');
  }
  const db = new PrismaClient();
  try {
    const objects = await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r','p','v','m','S','f')`);
    const types = await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema() AND t.typtype IN ('e','d')`);
    const functions = await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema()`);
    if (objects[0].count || types[0].count || functions[0].count) throw new Error('Target schema is not empty; refusing to change it.');
  } finally {
    await db.$disconnect();
  }
  const prisma = require.resolve('prisma/build/index.js');
  const run = args => execFileSync(process.execPath, [prisma, ...args], { cwd: root, env: process.env, stdio: 'pipe' });
  run(['db', 'execute', '--schema', schemaFile, '--file', baselineFile]);
  run(['migrate', 'diff', '--from-schema-datasource', schemaFile, '--to-schema-datamodel', schemaFile, '--exit-code']);
  const verify = new PrismaClient();
  try {
    const checks = await verify.$queryRawUnsafe(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema() AND conname IN ('PrivateMessage_content_length', 'PrivateMessage_exactly_one_context', 'PatientReview_rating_check', 'PatientReview_comment_check')`);
    if (checks.length !== 4) throw new Error('Required custom check constraints are missing.');
  } finally {
    await verify.$disconnect();
  }
  for (const name of names) run(['migrate', 'resolve', '--applied', name, '--schema', schemaFile]);
  run(['migrate', 'status', '--schema', schemaFile]);
  console.log(`Local empty database initialized and ${names.length} historical migrations recorded as baselined. No application data was restored.`);
}

main().catch(error => {
  console.error('Bootstrap failed:', error.message);
  if (error.stderr) console.error(error.stderr.toString());
  console.error('If initialization began, discard only this disposable test database and start with a new empty one.');
  process.exitCode = 1;
});
