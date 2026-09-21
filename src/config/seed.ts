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

    const COMMUNITY_CATEGORIES = [
      { name: 'Ansiedad', slug: 'ansiedad', description: 'Canales dedicados al manejo de la ansiedad, crisis de pánico y relajación.' },
      { name: 'Depresión', slug: 'depresion', description: 'Estrategias para el afrontamiento del estado de ánimo y motivación.' },
      { name: 'Mindfulness', slug: 'mindfulness', description: 'Prácticas de atención plena, meditación y bienestar cotidiano.' },
      { name: 'Autoestima', slug: 'autoestima', description: 'Construcción del autoconcepto, seguridad personal y límites saludables.' },
      { name: 'Duelo y Pérdida', slug: 'duelo', description: 'Procesos de pérdida, despedida y resignificación.' },
      { name: 'Relaciones', slug: 'relaciones', description: 'Comunicación asertiva, pareja, dinámicas familiares y apego.' },
      { name: 'Estrés Laboral', slug: 'estres-laboral', description: 'Prevención del burnout, productividad consciente y balance vida-trabajo.' },
    ];

    console.log('Seeding default community categories...');
    for (const cat of COMMUNITY_CATEGORIES) {
      await prisma.communityCategory.upsert({
        where: { slug: cat.slug },
        update: { name: cat.name, description: cat.description },
        create: { name: cat.name, slug: cat.slug, description: cat.description },
      });
    }

    console.log('Database seeded successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};
