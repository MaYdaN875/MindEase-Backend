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
    console.error('Psychologist user not found');
    return;
  }

  const token = jwt.sign(
    {
      userId: user.id,
      roles: user.userRoles.map((ur) => ur.role.name),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log(`Testing GET /api/psychologists/me/dashboard for ${user.name}...`);
  const res = await fetch('http://localhost:3000/api/psychologists/me/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log(`HTTP Status: ${res.status}`);
  const json = await res.json();
  console.log('Dashboard Data:\n', JSON.stringify(json, null, 2));
}

main().finally(() => prisma.$disconnect());
