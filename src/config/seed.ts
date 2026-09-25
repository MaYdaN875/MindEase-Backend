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

    console.log('Seeding default AI crisis resources...');
    const CRISIS_RESOURCES = [
      {
        countryCode: 'MX',
        name: 'Línea de la Vida (México)',
        phone: '800 911 2000',
        url: 'https://www.gob.mx/salud/conadic/acciones-y-programas/linea-de-la-vida-988',
        description: 'Atención especializada en salud mental y prevención del suicidio, 24/7.',
        type: 'SUICIDE_PREVENTION',
      },
      {
        countryCode: 'MX',
        name: 'Número de Emergencias 911',
        phone: '911',
        url: null,
        description: 'Servicio de atención a emergencias y auxilio médico inmediato.',
        type: 'EMERGENCY',
      },
      {
        countryCode: 'MX',
        name: 'SAPTEL (Salud Mental)',
        phone: '55 5259 8121',
        url: 'https://www.saptel.org.mx',
        description: 'Servicio de apoyo psicológico vía telefónica.',
        type: 'MENTAL_HEALTH',
      },
    ];

    for (const res of CRISIS_RESOURCES) {
      const existing = await prisma.aICrisisResource.findFirst({
        where: { name: res.name, countryCode: res.countryCode },
      });
      if (!existing) {
        await prisma.aICrisisResource.create({ data: res });
      }
    }

    console.log('Database seeded successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};
