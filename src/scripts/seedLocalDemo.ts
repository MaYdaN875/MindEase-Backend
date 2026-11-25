import 'dotenv/config';
import { randomBytes } from 'crypto';
import { DayOfWeek, Prisma } from '@prisma/client';
import prisma from '../config/db';
import { hashPassword } from '../utils/hash';
import { calculateFees } from '../services/feePolicy';
import { localDate, slotsForDate } from '../services/scheduling';

const demoMarker = 'LOCAL-TEST';
const demoProfiles = [
  {
    email: 'psicologa.ansiedad@test.mindease.local',
    name: 'Laura Mendoza (demo local)',
    description:
      'Perfil sintético exclusivo para pruebas locales; no representa a una profesional real.',
    academicBackground: 'Perfil de demostración local.',
    experience: 'Experiencia de demostración; no corresponde a una persona real.',
    consultationPrice: 650,
    specialties: ['Ansiedad', 'Estrés Laboral'],
    days: [DayOfWeek.MONDAY, DayOfWeek.WEDNESDAY, DayOfWeek.FRIDAY],
  },
  {
    email: 'psicologo.familiar@test.mindease.local',
    name: 'Diego Ríos (demo local)',
    description:
      'Perfil sintético exclusivo para pruebas locales; no representa a un profesional real.',
    academicBackground: 'Perfil de demostración local.',
    experience: 'Experiencia de demostración; no corresponde a una persona real.',
    consultationPrice: 700,
    specialties: ['Terapia Familiar', 'Autoestima'],
    days: [DayOfWeek.TUESDAY, DayOfWeek.THURSDAY, DayOfWeek.SATURDAY],
  },
] as const;

function assertLocalDemoEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Los datos de demostración están deshabilitados en producción.');
  }
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Configura NODE_ENV=development para continuar.');
  }
  if (process.env.ENABLE_LOCAL_TEST_DATA !== 'true') {
    throw new Error('Configura ENABLE_LOCAL_TEST_DATA=true solo para esta ejecución.');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL es obligatorio.');
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error('El seed solo puede conectarse a una base de datos local.');
  }

  const requestedEmail = process.env.TEST_PSYCHOLOGIST_EMAIL?.trim();
  const requestedPassword = process.env.TEST_PSYCHOLOGIST_PASSWORD;
  if (!requestedEmail || !requestedPassword || requestedPassword.length < 8) {
    throw new Error(
      'Define TEST_PSYCHOLOGIST_EMAIL y una TEST_PSYCHOLOGIST_PASSWORD de al menos 8 caracteres.',
    );
  }

  return {
    requestedEmail: requestedEmail.toLowerCase(),
    requestedPassword,
    patientEmail: (
      process.env.TEST_PATIENT_EMAIL ||
      process.env.TEST_USER_EMAIL ||
      'paciente@test.mindease.local'
    )
      .trim()
      .toLowerCase(),
  };
}

function scheduleForDays(days: readonly DayOfWeek[]) {
  return days.map((dayOfWeek) => ({
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
    slotDuration: 50,
    isActive: true,
  }));
}

async function ensurePsychologist(
  tx: Prisma.TransactionClient,
  input: {
    email: string;
    password: string;
    name: string;
    description: string;
    academicBackground: string;
    experience: string;
    consultationPrice: number;
    specialties: readonly string[];
    days: readonly DayOfWeek[];
  },
) {
  const existing = await tx.user.findUnique({
    where: { email: input.email },
    include: { psychologistProfile: true },
  });
  if (existing) {
    if (
      !existing.psychologistProfile?.licenseNumber?.startsWith(`${demoMarker}-`) ||
      existing.psychologistProfile.status !== 'VERIFICADO'
    ) {
      throw new Error(
        `El correo ${input.email} ya existe y no es un perfil demo local; no se modificó.`,
      );
    }
    if (existing.name !== input.name) {
      await tx.user.update({
        where: { id: existing.id },
        data: { name: input.name },
      });
    }
    return {
      profileId: existing.psychologistProfile.id,
      created: false,
      generatedPassword: null,
    };
  }

  const roles = await Promise.all(
    ['USER', 'PSYCHOLOGIST_VERIFIED'].map((name) =>
      tx.role.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );
  const specialties = await Promise.all(
    input.specialties.map((name) =>
      tx.specialty.upsert({
        where: { name },
        update: {},
        create: { name },
      }),
    ),
  );
  const licenseNumber = `${demoMarker}-${randomBytes(5).toString('hex').toUpperCase()}`;
  const user = await tx.user.create({
    data: {
      email: input.email,
      passwordHash: await hashPassword(input.password),
      name: input.name,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      userRoles: {
        create: roles.map((role) => ({
          role: { connect: { id: role.id } },
        })),
      },
      psychologistProfile: {
        create: {
          description: input.description,
          academicBackground: input.academicBackground,
          experience: input.experience,
          consultationPrice: input.consultationPrice,
          languages: 'Español',
          location: 'Atención en línea (demo local)',
          licenseNumber,
          status: 'VERIFICADO',
          autoConfirmAppointments: true,
          specialties: {
            create: specialties.map((specialty) => ({
              specialty: { connect: { id: specialty.id } },
            })),
          },
          availabilities: {
            create: scheduleForDays(input.days),
          },
        },
      },
    },
    include: { psychologistProfile: true },
  });

  if (!user.psychologistProfile) {
    throw new Error(`No se pudo crear el perfil local de ${input.email}.`);
  }
  return {
    profileId: user.psychologistProfile.id,
    created: true,
    generatedPassword: input.password,
  };
}

function nextAvailableSlot(days: readonly DayOfWeek[]) {
  const schedule = scheduleForDays(days);
  const now = new Date();
  for (let offset = 1; offset <= 21; offset += 1) {
    const date = localDate(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000));
    const slot = slotsForDate(date, schedule).slots.find(
      (candidate) => new Date(candidate.startAt).getTime() > now.getTime() + 60 * 60 * 1000,
    );
    if (slot) return slot;
  }
  throw new Error('No se encontró un horario futuro para la cita de demostración.');
}

async function main() {
  const { requestedEmail, requestedPassword, patientEmail } =
    assertLocalDemoEnvironment();

  try {
    const patient = await prisma.user.findUnique({
      where: { email: patientEmail },
      include: { initialInterview: true },
    });
    if (
      !patient ||
      patient.initialInterview?.status !== 'COMPLETED' ||
      !patient.initialInterview.pdfCiphertext
    ) {
      throw new Error(
        'El paciente de prueba debe tener una entrevista completada y un PDF antes de crear la cita.',
      );
    }

    const requestedAccount = {
      email: requestedEmail,
      password: requestedPassword,
      name: 'Nicolas Scherzer',
      description:
        'Perfil sintético exclusivo para pruebas locales; no representa a un profesional real.',
      academicBackground: 'Perfil de demostración local.',
      experience: 'Experiencia de demostración; no corresponde a una persona real.',
      consultationPrice: 750,
      specialties: ['Ansiedad', 'Depresión'],
      days: [
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
      ],
    };
    const additionalAccounts = demoProfiles.map((profile) => ({
      ...profile,
      password: randomBytes(18).toString('hex'),
    }));

    const result = await prisma.$transaction(async (tx) => {
      const accounts: Awaited<ReturnType<typeof ensurePsychologist>>[] = [];
      accounts.push(await ensurePsychologist(tx, requestedAccount));
      for (const profile of additionalAccounts) {
        accounts.push(await ensurePsychologist(tx, profile));
      }

      const appointmentProfile = await tx.psychologistProfile.findUniqueOrThrow({
        where: { id: accounts[0].profileId },
      });
      const idempotencyKey = `${demoMarker}:initial-report:${patient.id}:${appointmentProfile.id}`;
      const existingPayment = await tx.payment.findUnique({
        where: { idempotencyKey },
        include: { appointment: true },
      });
      if (existingPayment) {
        if (
          existingPayment.status !== 'SUCCEEDED' ||
          existingPayment.appointment.status !== 'CONFIRMED'
        ) {
          throw new Error(
            'La cita demo ya existe, pero su pago o estado no es válido; no se alteró.',
          );
        }
        return { accounts, appointmentId: existingPayment.appointmentId };
      }

      const slot = nextAvailableSlot(requestedAccount.days);
      const fees = calculateFees(requestedAccount.consultationPrice);
      const mockResult = {
        success: true,
        status: 'SUCCEEDED',
        transactionId: `LOCAL-MOCK-${randomBytes(8).toString('hex')}`,
        cardBrand: 'MOCK',
        cardLast4: '0000',
      };
      const appointment = await tx.appointment.create({
        data: {
          psychologistId: appointmentProfile.id,
          userId: patient.id,
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          status: 'CONFIRMED',
          price: requestedAccount.consultationPrice,
          currency: 'MXN',
          payment: {
            create: {
              patient: { connect: { id: patient.id } },
              psychologist: { connect: { id: appointmentProfile.id } },
              amount: fees.grossAmount,
              currency: 'MXN',
              platformFee: fees.platformFee,
              netAmount: fees.netAmount,
              status: 'SUCCEEDED',
              paymentMethod: 'CREDIT_CARD',
              transactionId: mockResult.transactionId,
              idempotencyKey,
              attempts: {
                create: {
                  idempotencyKey,
                  provider: 'MOCK',
                  providerIntentId: mockResult.transactionId,
                  status: 'SUCCEEDED',
                },
              },
            },
          },
        },
      });
      await tx.mockGatewayOperation.create({
        data: {
          key: `charge:${idempotencyKey}`,
          result: mockResult as Prisma.InputJsonValue,
        },
      });
      return { accounts, appointmentId: appointment.id };
    });

    console.log(
      JSON.stringify(
        {
          result: 'local demo data ready',
          verification: 'SIMULATED_LOCAL_ONLY',
          payment: 'MOCK_SUCCEEDED_LOCAL_ONLY',
          reportReady: true,
          appointmentId: result.appointmentId,
          accounts: [
            {
              email: requestedEmail,
              created: result.accounts[0].created,
              passwordProvidedViaEnvironment: true,
            },
            ...additionalAccounts.map((account, index) => ({
              email: account.email,
              created: result.accounts[index + 1].created,
              ...(result.accounts[index + 1].generatedPassword
                ? { password: account.password }
                : {}),
            })),
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
