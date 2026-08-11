import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Finding user angelleon0100@gmail.com...');
  try {
    const user = await prisma.user.findUnique({
      where: { email: 'angelleon0100@gmail.com' },
      include: { psychologistProfile: true }
    });

    if (!user) {
      console.error('User not found in database');
      return;
    }

    if (!user.psychologistProfile) {
      console.error('Psychologist profile not found for this user');
      return;
    }

    const profile = user.psychologistProfile;
    console.log('Current profile status:', profile.status);

    // Update profile clinical fields if null (they are required by the backend to submit)
    const updatedProfile = await prisma.psychologistProfile.update({
      where: { id: profile.id },
      data: {
        licenseNumber: profile.licenseNumber || 'CED-87391823',
        description: profile.description || 'Especialista en terapia cognitivo-conductual, enfocado en resiliencia, ansiedad y estrés.',
        academicBackground: profile.academicBackground || 'Licenciatura en Psicología Clínica - Universidad de Guadalajara (2018).',
        experience: profile.experience || '8 años de experiencia en consulta privada y clínica.',
        location: profile.location || 'Guadalajara, Jalisco',
        consultationPrice: profile.consultationPrice || 650.0,
        status: 'PENDIENTE_REVISION'
      }
    });
    console.log('Updated profile clinical fields. New status:', updatedProfile.status);

    // Log history
    await prisma.verificationStatusHistory.create({
      data: {
        psychologistId: profile.id,
        fromStatus: profile.status,
        toStatus: 'PENDIENTE_REVISION',
        changedById: user.id,
        comment: 'Solicitud enviada para validación vía script de desarrollo',
      }
    });
    console.log('Created status history entry');

    // Create VerificationRequest record so it is loaded by the admin panel
    const existingReq = await prisma.verificationRequest.findFirst({
      where: { psychologistId: profile.id }
    });

    if (!existingReq) {
      const req = await prisma.verificationRequest.create({
        data: {
          psychologistId: profile.id,
          status: 'PENDING'
        }
      });
      console.log('Successfully created Verification Request:', req.id);
    } else {
      console.log('Verification Request already exists:', existingReq.id);
      // Ensure its status is PENDING
      await prisma.verificationRequest.update({
        where: { id: existingReq.id },
        data: { status: 'PENDING' }
      });
    }

    console.log('Success! Jonh dow is now submitted and will show up in the admin panel.');
  } catch (err) {
    console.error('Error running script:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
