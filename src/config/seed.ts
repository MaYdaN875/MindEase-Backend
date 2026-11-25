import prisma from './db';
import { hashPassword } from '../utils/hash';

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

    const LEGAL_TEXTS = [
      { code: 'PRIVACY_POLICY', title: 'Aviso de privacidad', version: '1.0', audience: 'ALL' as const, content: 'MindEase trata los datos necesarios para crear y administrar la cuenta, facilitar citas, comunicaciones y los servicios contratados. Conservamos los datos conforme a la finalidad informada y aplicamos controles de acceso. Puedes solicitar información sobre tus datos mediante los canales de soporte. Este texto debe ser revisado y sustituido por la política aprobada por asesoría legal antes de un lanzamiento público.' },
      { code: 'TERMS_OF_SERVICE', title: 'Términos de uso de MindEase', version: '1.0', audience: 'ALL' as const, content: 'MindEase es una plataforma tecnológica para conectar usuarios y profesionales, gestionar citas y facilitar servicios digitales. No sustituye servicios de emergencia ni garantiza atención inmediata. La persona usuaria debe proporcionar información veraz y usar la plataforma respetando a otras personas. Este texto debe ser revisado y sustituido por los términos aprobados por asesoría legal antes de un lanzamiento público.' },
      { code: 'PROFESSIONAL_TERMS', title: 'Términos profesionales', version: '1.0', audience: 'PSYCHOLOGIST' as const, content: 'La persona profesional declara que la información y documentos enviados son veraces, que cuenta con las credenciales requeridas y que cumplirá con sus obligaciones profesionales aplicables. La aprobación de un perfil depende del proceso de verificación de MindEase. Este texto debe ser revisado y sustituido por los términos profesionales aprobados por asesoría legal antes de un lanzamiento público.' },
    ];
    console.log('Seeding default legal texts...');
    for (const legal of LEGAL_TEXTS) await prisma.legalText.upsert({ where: { code: legal.code }, update: {}, create: legal });

    if (process.env.NODE_ENV !== 'production' && process.env.SEED_TEST_USER === 'true') {
      const email = (process.env.TEST_USER_EMAIL || 'paciente@test.mindease.local').trim().toLowerCase();
      const role = await prisma.role.findUnique({ where: { name: 'USER' } });
      if (!role) throw new Error('USER role is missing after seed');

      const existing = await prisma.user.findUnique({ where: { email }, include: { userRoles: true } });
      if (!existing) {
        const password = process.env.TEST_USER_PASSWORD;
        if (!password || password.length < 8) {
          throw new Error('TEST_USER_PASSWORD is required and must contain at least 8 characters');
        }
        await prisma.user.create({
          data: {
            email,
            passwordHash: await hashPassword(password),
            name: 'Paciente de prueba',
            status: 'ACTIVE',
            emailVerifiedAt: new Date(),
            userRoles: { create: { roleId: role.id } },
          },
        });
        console.log(`Test patient seeded and email pre-verified: ${email}`);
      } else {
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            emailVerifiedAt: existing.emailVerifiedAt || new Date(),
            userRoles: existing.userRoles.length
              ? undefined
              : { create: { roleId: role.id } },
          },
        });
        console.log(`Test patient restored and email pre-verified: ${email}`);
      }
    }

    console.log('Database seeded successfully.');
  } catch (error) {
    console.error('Error seeding database:', error);
  }
};
