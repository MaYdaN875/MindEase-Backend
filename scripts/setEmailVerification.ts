/**
 * Herramienta de pruebas: quita (o restablece) la verificación de correo de UNA cuenta.
 *
 * Uso:
 *   npx ts-node scripts/setEmailVerification.ts <correo> unverify
 *   npx ts-node scripts/setEmailVerification.ts <correo> verify
 *
 * Solo modifica la cuenta indicada. Muestra el host de la base de datos antes de
 * actuar para que confirmes si es local o Railway. No imprime contraseñas.
 */
import prisma from '../src/config/db';

const main = async (): Promise<void> => {
  const [emailArg, action] = process.argv.slice(2);
  if (!emailArg || !['verify', 'unverify'].includes(action)) {
    console.error('Uso: npx ts-node scripts/setEmailVerification.ts <correo> <verify|unverify>');
    process.exit(1);
  }

  let host = 'desconocido';
  try {
    host = new URL(process.env.DATABASE_URL || '').host;
  } catch (_e) {
    // DATABASE_URL missing or malformed; Prisma will fail below if so.
  }
  console.log(`Base de datos destino: ${host}`);

  const email = emailArg.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No existe una cuenta con el correo ${email}`);
    process.exit(1);
  }

  if (action === 'unverify') {
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } }),
      // Clear old codes so the cooldown and attempt counters start fresh.
      prisma.emailVerificationCode.deleteMany({ where: { userId: user.id } }),
    ]);
    console.log(`Listo: ${email} ahora figura como SIN verificar.`);
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    console.log(`Listo: ${email} ahora figura como VERIFICADO.`);
  }
};

main()
  .catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
