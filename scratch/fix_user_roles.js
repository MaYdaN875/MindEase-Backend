const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const roleApplicant = await prisma.role.findUnique({ where: { name: 'PSYCHOLOGIST_APPLICANT' } });
  const roleVerified = await prisma.role.findUnique({ where: { name: 'PSYCHOLOGIST_VERIFIED' } });

  if (!roleApplicant || !roleVerified) {
    console.error('Roles not found');
    return;
  }

  const verifiedProfiles = await prisma.psychologistProfile.findMany({
    where: { status: 'VERIFICADO' },
    include: { user: true },
  });

  for (const p of verifiedProfiles) {
    console.log(`Fixing user ${p.user.name} (${p.user.email})...`);
    // Delete applicant role
    await prisma.userRole.deleteMany({
      where: { userId: p.userId, roleId: roleApplicant.id },
    });

    // Ensure verified role exists
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: p.userId, roleId: roleVerified.id } },
      update: {},
      create: { userId: p.userId, roleId: roleVerified.id },
    });
    console.log(`  -> UserRole set to PSYCHOLOGIST_VERIFIED.`);
  }

  console.log('All verified psychologists have been updated.');
}

main().finally(() => prisma.$disconnect());
