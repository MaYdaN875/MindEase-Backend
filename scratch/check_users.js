const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    include: {
      userRoles: { include: { role: true } },
      psychologistProfile: true,
    },
  });

  console.log('Total users:', users.length);
  for (const u of users) {
    console.log({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: u.userRoles.map((r) => r.role.name),
      status: u.status,
      psychStatus: u.psychologistProfile?.status,
    });
  }
}

main().finally(() => prisma.$disconnect());
