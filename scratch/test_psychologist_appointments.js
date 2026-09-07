const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mindease-jwt-key-change-in-production';

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'angelleon0100@gmail.com' },
    include: {
      userRoles: { include: { role: true } },
      psychologistProfile: true,
    },
  });

  if (!user) {
    console.log('User not found!');
    return;
  }

  console.log(`User: ${user.name} (${user.email}), ID: ${user.id}`);
  console.log(`Roles: ${user.userRoles.map(ur => ur.role.name).join(', ')}`);
  console.log(`Psychologist Profile ID: ${user.psychologistProfile?.id}`);

  const token = jwt.sign(
    {
      userId: user.id,
      roles: user.userRoles.map((ur) => ur.role.name),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  const res = await fetch('http://localhost:3000/api/appointments?as=psychologist', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  console.log(`\nHTTP Status: ${res.status}`);
  const json = await res.json();
  console.log('Response JSON:', JSON.stringify(json, null, 2));
}

main().finally(() => prisma.$disconnect());
