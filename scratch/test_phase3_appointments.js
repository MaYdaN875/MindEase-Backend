const { PrismaClient } = require('@prisma/client');

const BASE_URL = process.env.API_URL || 'http://localhost:3000/api';
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
    }
  }
});

async function runPhase3Tests() {
  console.log('===============================================================');
  console.log('   INTEGRATION TESTING: PHASE 3 - APPOINTMENTS & CONSULTATION  ');
  console.log('===============================================================');

  try {
    // 1. Register a Psychologist Account
    const psyEmail = `dr.agenda_${Date.now()}@mindease.com`;
    console.log(`\n[1] Registering psychologist: ${psyEmail}`);
    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: psyEmail,
        password: 'securePassword123',
        name: 'Dra. Sofía Mendoza',
        phone: '5550011223',
        role: 'PSYCHOLOGIST',
        acceptedPrivacy: true,
      }),
    });

    const regData = await regRes.json();
    if (regRes.status !== 201) throw new Error(`Registration failed: ${JSON.stringify(regData)}`);
    const psyUserId = regData.data.user.id;

    // Directly elevate to VERIFICADO in DB for agenda testing
    console.log('[2] Elevating psychologist to VERIFICADO in database...');
    const verifiedRole = await prisma.role.findUnique({ where: { name: 'PSYCHOLOGIST_VERIFIED' } });
    if (verifiedRole) {
      await prisma.userRole.create({
        data: { userId: psyUserId, roleId: verifiedRole.id },
      });
    }

    const psyProfile = await prisma.psychologistProfile.update({
      where: { userId: psyUserId },
      data: {
        status: 'VERIFICADO',
        consultationPrice: 650.0,
      },
    });

    // Re-login to get updated JWT with verified role
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: psyEmail, password: 'securePassword123' }),
    });
    const loginData = await loginRes.json();
    const psyToken = loginData.data.token;
    console.log(`Psychologist verified and logged in. Profile ID: ${psyProfile.id}`);

    // 2. Register a Patient User
    const patEmail = `paciente_${Date.now()}@mindease.com`;
    console.log(`\n[3] Registering patient: ${patEmail}`);
    const patRegRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: patEmail,
        password: 'securePassword123',
        name: 'Roberto Gómez',
        phone: '5559988776',
        role: 'USER',
        acceptedPrivacy: true,
      }),
    });
    const patRegData = await patRegRes.json();
    const patToken = patRegData.data.token;
    console.log(`Patient registered. User ID: ${patRegData.data.user.id}`);

    // 3. Configure Recurring Weekly Schedule
    console.log('\n[4] Configuring psychologist recurring availability schedule...');
    const availRes = await fetch(`${BASE_URL}/psychologists/me/availability`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${psyToken}`,
      },
      body: JSON.stringify({
        availabilities: [
          {
            dayOfWeek: 'MONDAY',
            startTime: '09:00',
            endTime: '13:00',
            slotDuration: 50,
            isActive: true,
          },
          {
            dayOfWeek: 'WEDNESDAY',
            startTime: '15:00',
            endTime: '19:00',
            slotDuration: 50,
            isActive: true,
          },
        ],
      }),
    });
    const availData = await availRes.json();
    if (availRes.status !== 200) throw new Error(`Availability config failed: ${JSON.stringify(availData)}`);
    console.log(`Configured ${availData.data.availabilities.length} availability windows successfully.`);

    // 4. Calculate target date for next Monday
    const today = new Date();
    const daysUntilMonday = ((1 + 7 - today.getUTCDay()) % 7) || 7;
    const nextMonday = new Date(today);
    nextMonday.setUTCDate(today.getUTCDate() + daysUntilMonday);
    const mondayDateStr = nextMonday.toISOString().split('T')[0];

    console.log(`\n[5] Fetching available slots for target date: ${mondayDateStr} (Monday)...`);
    const slotsRes = await fetch(`${BASE_URL}/psychologists/${psyProfile.id}/available-slots?date=${mondayDateStr}`, {
      headers: { Authorization: `Bearer ${patToken}` },
    });
    const slotsData = await slotsRes.json();
    if (slotsRes.status !== 200) throw new Error(`Slot retrieval failed: ${JSON.stringify(slotsData)}`);

    const availableSlots = slotsData.data.slots.filter((s) => s.available);
    console.log(`Found ${availableSlots.length} available slots for ${mondayDateStr}.`);
    if (availableSlots.length === 0) throw new Error('Expected available slots, found none.');

    const selectedSlot = availableSlots[0];
    console.log(`Selected slot: ${selectedSlot.startAt} - ${selectedSlot.endAt}`);

    // 5. Patient Books the Appointment
    console.log('\n[6] Patient booking the appointment...');
    const bookRes = await fetch(`${BASE_URL}/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patToken}`,
      },
      body: JSON.stringify({
        psychologistId: psyProfile.id,
        startAt: selectedSlot.startAt,
        endAt: selectedSlot.endAt,
      }),
    });
    const bookData = await bookRes.json();
    if (bookRes.status !== 201) throw new Error(`Booking failed: ${JSON.stringify(bookData)}`);
    const appointmentId = bookData.data.appointment.id;
    console.log(`Appointment booked! ID: ${appointmentId}, Status: ${bookData.data.appointment.status}, Price: $${bookData.data.appointment.price}`);

    // 6. Collision Test: Attempt to book the exact same slot again
    console.log('\n[7] Testing collision detection (booking the same slot again)...');
    const duplicateRes = await fetch(`${BASE_URL}/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patToken}`,
      },
      body: JSON.stringify({
        psychologistId: psyProfile.id,
        startAt: selectedSlot.startAt,
        endAt: selectedSlot.endAt,
      }),
    });
    console.log(`Collision status response: ${duplicateRes.status} (Expected 409)`);
    if (duplicateRes.status !== 409) throw new Error('Collision detection failed: duplicate slot was booked!');

    // 7. Verify Slot is now marked unavailable
    console.log('\n[8] Verifying slot is now marked as unavailable in calendar query...');
    const recheckSlotsRes = await fetch(`${BASE_URL}/psychologists/${psyProfile.id}/available-slots?date=${mondayDateStr}`, {
      headers: { Authorization: `Bearer ${patToken}` },
    });
    const recheckSlotsData = await recheckSlotsRes.json();
    const targetedSlot = recheckSlotsData.data.slots.find((s) => s.startAt === selectedSlot.startAt);
    console.log(`Targeted slot availability after booking: ${targetedSlot.available} (Expected: false)`);
    if (targetedSlot.available !== false) throw new Error('Slot should be marked as unavailable!');

    // 8. Psychologist Starts the Consultation
    console.log('\n[9] Psychologist starting the live clinical consultation...');
    const startRes = await fetch(`${BASE_URL}/consultations/${appointmentId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${psyToken}`,
      },
      body: JSON.stringify({
        meetingUrl: 'https://video.mindease.com/rooms/consultation-secure-session-123',
      }),
    });
    const startData = await startRes.json();
    if (startRes.status !== 200) throw new Error(`Start consultation failed: ${JSON.stringify(startData)}`);
    console.log(`Consultation started! Status: ${startData.data.consultation.status}, Meeting: ${startData.data.consultation.meetingUrl}`);

    // 9. Psychologist Adds Confidential Clinical Notes
    console.log('\n[10] Psychologist recording confidential clinical progress notes...');
    const notesRes = await fetch(`${BASE_URL}/consultations/${appointmentId}/notes`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${psyToken}`,
      },
      body: JSON.stringify({
        clinicalNotes: 'Paciente muestra buena disposición. Se acuerda trabajar reestructuración cognitiva para ansiedad situacional.',
      }),
    });
    const notesData = await notesRes.json();
    if (notesRes.status !== 200) throw new Error(`Updating notes failed: ${JSON.stringify(notesData)}`);
    console.log('Clinical notes saved successfully.');

    // 10. Medical Confidentiality Test: Patient requests consultation details
    console.log('\n[11] Verifying patient medical confidentiality (notes omission)...');
    const patConsRes = await fetch(`${BASE_URL}/consultations/${appointmentId}`, {
      headers: { Authorization: `Bearer ${patToken}` },
    });
    const patConsData = await patConsRes.json();
    console.log(`Patient view of clinicalNotes: ${patConsData.data.consultation.clinicalNotes}`);
    if (patConsData.data.consultation.clinicalNotes !== undefined) {
      throw new Error('Confidentiality breach: Patient can see clinicalNotes!');
    }
    console.log('Confidentiality verified: clinicalNotes are strictly hidden from patient.');

    // 11. Psychologist Completes Consultation
    console.log('\n[12] Psychologist completing consultation...');
    const compRes = await fetch(`${BASE_URL}/consultations/${appointmentId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const compData = await compRes.json();
    if (compRes.status !== 200) throw new Error(`Completion failed: ${JSON.stringify(compData)}`);
    console.log(`Consultation and appointment completed! Final status: ${compData.data.consultation.status}`);

    console.log('\n===============================================================');
    console.log('   ALL 12 APPOINTMENT & CONSULTATION TESTS PASSED CLEANLY!     ');
    console.log('===============================================================');
  } catch (error) {
    console.error('\n❌ Test execution encountered an error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runPhase3Tests();
