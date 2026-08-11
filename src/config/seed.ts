import prisma from './db';

const ROLES = [
  'USER',
  'PSYCHOLOGIST_APPLICANT',
  'PSYCHOLOGIST_VERIFIED',
  'MODERATOR',
  'REVISOR',
  'SUPPORT',
  'ADMIN',
  'SUPERADMIN',
];

export const seedDatabase = async (): Promise<void> => {
  try {
    console.log('Seeding database roles...');
    for (const roleName of ROLES) {
      await prisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName },
      });
    }

    const SPECIALTIES = [
      'Ansiedad',
      'Depresión',
      'Estrés Laboral',
      'Terapia Familiar',
      'Problemas de Pareja',
      'Autoestima',
      'Duelo y Pérdida',
      'Trastornos del Sueño',
    ];

    console.log('Seeding default specialties...');
    for (const specName of SPECIALTIES) {
      await prisma.specialty.upsert({
        where: { name: specName },
        update: {},
        create: { name: specName },
      });
    }

    console.log('Database seeded successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};
