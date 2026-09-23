import { PrismaClient, UserStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
    }
  }
});

async function main() {
  const adminUsers = await prisma.user.findMany({
    where: {
      userRoles: {
        some: {
          role: {
            name: { in: ['ADMIN', 'SUPERADMIN'] }
          }
        }
      }
    },
    include: {
      userRoles: {
        include: { role: true }
      }
    }
  });

  console.log('--- ADMIN USERS IN DATABASE ---');
  adminUsers.forEach(u => {
    console.log(`Email: ${u.email} | Name: ${u.name} | Roles: ${u.userRoles.map(r => r.role.name).join(', ')}`);
  });

  // Ensure default administrator account admin@mindease.com exists with known password
  const defaultAdminEmail = 'admin@mindease.com';
  let defaultAdmin = await prisma.user.findUnique({
    where: { email: defaultAdminEmail }
  });

  const hashedPassword = await bcrypt.hash('Admin123!', 10);
  const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
  const superAdminRole = await prisma.role.findUnique({ where: { name: 'SUPERADMIN' } });

  if (!defaultAdmin) {
    console.log('\nCreating standard default admin: admin@mindease.com...');
    defaultAdmin = await prisma.user.create({
      data: {
        email: defaultAdminEmail,
        passwordHash: hashedPassword,
        name: 'Administrador Principal',
        status: UserStatus.ACTIVE
      }
    });

    if (adminRole) {
      await prisma.userRole.create({
        data: { userId: defaultAdmin.id, roleId: adminRole.id }
      });
    }
    if (superAdminRole) {
      await prisma.userRole.create({
        data: { userId: defaultAdmin.id, roleId: superAdminRole.id }
      });
    }
    console.log('Default admin created successfully.');
  } else {
    // Update password to ensure it's predictable
    await prisma.user.update({
      where: { id: defaultAdmin.id },
      data: {
        passwordHash: hashedPassword,
        status: UserStatus.ACTIVE
      }
    });

    // Ensure roles are assigned
    if (adminRole) {
      const hasAdmin = await prisma.userRole.findUnique({
        where: { userId_roleId: { userId: defaultAdmin.id, roleId: adminRole.id } }
      });
      if (!hasAdmin) {
        await prisma.userRole.create({
          data: { userId: defaultAdmin.id, roleId: adminRole.id }
        });
      }
    }
    if (superAdminRole) {
      const hasSuperAdmin = await prisma.userRole.findUnique({
        where: { userId_roleId: { userId: defaultAdmin.id, roleId: superAdminRole.id } }
      });
      if (!hasSuperAdmin) {
        await prisma.userRole.create({
          data: { userId: defaultAdmin.id, roleId: superAdminRole.id }
        });
      }
    }
    console.log(`\nUpdated default admin: ${defaultAdminEmail} password reset to 'Admin123!' with ADMIN & SUPERADMIN roles.`);
  }

  // Test login through API
  try {
    const loginRes = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: defaultAdminEmail,
        password: 'Admin123!'
      })
    });
    const loginData: any = await loginRes.json();
    console.log('API Login Verification:', loginRes.status, loginData.status, loginData.data?.user?.roles);
  } catch (err: any) {
    console.log('Could not connect to API for verification:', err.message);
  }
}

main().finally(() => prisma.$disconnect());
