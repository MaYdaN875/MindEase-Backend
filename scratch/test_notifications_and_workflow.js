const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

const BASE_URL = 'http://localhost:3000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-mindease';

function makeToken(userId, roles) {
  return jwt.sign({ userId, roles }, JWT_SECRET, { expiresIn: '1h' });
}

async function run() {
  console.log('===========================================================');
  console.log('   TESTING: APPOINTMENT WORKFLOW & NOTIFICATIONS SYSTEM    ');
  console.log('===========================================================');

  try {
    // 1. Find verified psychologist & patient
    const psyUser = await prisma.user.findFirst({
      where: { email: 'angelleon0100@gmail.com' },
      include: { psychologistProfile: true }
    });
    if (!psyUser || !psyUser.psychologistProfile) {
      throw new Error('Psychologist profile not found');
    }

    const patientUser = await prisma.user.findFirst({
      where: { email: 'danielleon0100@gmail.com' }
    });
    if (!patientUser) {
      throw new Error('Patient user not found');
    }

    const psyToken = makeToken(psyUser.id, ['PSYCHOLOGIST_VERIFIED', 'USER']);
    const patientToken = makeToken(patientUser.id, ['USER']);

    console.log(`[OK] Psychologist: ${psyUser.name} (${psyUser.id})`);
    console.log(`[OK] Patient: ${patientUser.name} (${patientUser.id})`);

    // Ensure psychologist has autoConfirmAppointments = false
    await prisma.psychologistProfile.update({
      where: { id: psyUser.psychologistProfile.id },
      data: { autoConfirmAppointments: false, consultationPrice: 350 }
    });
    console.log('[OK] Set psychologist autoConfirmAppointments = false');

    // 2. Patient creates appointment -> Should be PENDING
    const startAt = new Date(Date.now() + 86400000 * 5).toISOString(); // 5 days ahead
    const endAt = new Date(Date.now() + 86400000 * 5 + 50 * 60000).toISOString();

    console.log('\n[TEST 1] Patient booking appointment with autoConfirm = false...');
    const bookRes = await fetch(`${BASE_URL}/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        psychologistId: psyUser.psychologistProfile.id,
        startAt,
        endAt,
      }),
    });

    const bookData = await bookRes.json();
    console.log('Booking response:', bookRes.status, bookData.message);
    if (bookRes.status !== 201) {
      throw new Error(`Failed to book appointment: ${JSON.stringify(bookData)}`);
    }

    const apptId = bookData.data.appointment.id;
    const status = bookData.data.appointment.status;
    console.log(`[ASSERT] Appointment ID: ${apptId}, Status: ${status}`);
    if (status !== 'PENDING') {
      throw new Error(`Expected status PENDING, got ${status}`);
    }
    console.log('✓ PASS: Appointment correctly created with status PENDING');

    // 3. Verify psychologist received APPOINTMENT_REQUEST notification
    console.log('\n[TEST 2] Checking psychologist notifications...');
    const psyNotifRes = await fetch(`${BASE_URL}/notifications`, {
      headers: { Authorization: `Bearer ${psyToken}` },
    });
    const psyNotifData = await psyNotifRes.json();
    console.log('Psychologist notifications count:', psyNotifData.data?.length, 'Unread:', psyNotifData.unreadCount);
    const psyReqNotif = psyNotifData.data?.find(n => n.referenceId === apptId && n.type === 'APPOINTMENT_REQUEST');
    if (!psyReqNotif) {
      throw new Error('Psychologist did not receive APPOINTMENT_REQUEST notification');
    }
    console.log(`✓ PASS: Psychologist received: "${psyReqNotif.title}" - "${psyReqNotif.content}"`);

    // 4. Verify patient received confirmation acknowledgment notification
    console.log('\n[TEST 3] Checking patient notifications...');
    const patNotifRes = await fetch(`${BASE_URL}/notifications`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    const patNotifData = await patNotifRes.json();
    const patReqNotif = patNotifData.data?.find(n => n.referenceId === apptId && n.type === 'APPOINTMENT_REQUEST');
    if (!patReqNotif) {
      throw new Error('Patient did not receive APPOINTMENT_REQUEST acknowledgment');
    }
    console.log(`✓ PASS: Patient received: "${patReqNotif.title}" - "${patReqNotif.content}"`);

    // 5. Psychologist approves the appointment -> Should transition to CONFIRMED
    console.log('\n[TEST 4] Psychologist accepting appointment...');
    const approveRes = await fetch(`${BASE_URL}/appointments/${apptId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${psyToken}`,
      },
      body: JSON.stringify({ status: 'CONFIRMED' }),
    });
    const approveData = await approveRes.json();
    console.log('Approve response:', approveRes.status, approveData.message);
    if (approveRes.status !== 200 || approveData.data.appointment.status !== 'CONFIRMED') {
      throw new Error(`Failed to confirm appointment: ${JSON.stringify(approveData)}`);
    }
    console.log('✓ PASS: Appointment transitioned to CONFIRMED');

    // 6. Verify patient received APPOINTMENT_CONFIRMED notification
    console.log('\n[TEST 5] Checking patient confirmation notification...');
    const patNotifRes2 = await fetch(`${BASE_URL}/notifications`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    const patNotifData2 = await patNotifRes2.json();
    const confNotif = patNotifData2.data?.find(n => n.referenceId === apptId && n.type === 'APPOINTMENT_CONFIRMED');
    if (!confNotif) {
      throw new Error('Patient did not receive APPOINTMENT_CONFIRMED notification');
    }
    console.log(`✓ PASS: Patient received: "${confNotif.title}" - "${confNotif.content}"`);

    // 7. Mark notification as read
    console.log('\n[TEST 6] Marking notification as read...');
    const markRes = await fetch(`${BASE_URL}/notifications/${confNotif.id}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    const markData = await markRes.json();
    console.log('Mark read response:', markRes.status, markData.data?.isRead);
    if (!markData.data?.isRead) {
      throw new Error('Notification isRead was not updated to true');
    }
    console.log('✓ PASS: Single notification marked as read');

    // 8. Mark all as read
    console.log('\n[TEST 7] Marking all as read...');
    const markAllRes = await fetch(`${BASE_URL}/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    const markAllData = await markAllRes.json();
    console.log('Mark all response:', markAllRes.status, markAllData.message);

    const patNotifRes3 = await fetch(`${BASE_URL}/notifications`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    const patNotifData3 = await patNotifRes3.json();
    console.log(`[ASSERT] Unread count after mark-all: ${patNotifData3.unreadCount}`);
    if (patNotifData3.unreadCount !== 0) {
      throw new Error(`Expected 0 unread notifications, got ${patNotifData3.unreadCount}`);
    }
    console.log('✓ PASS: All notifications marked as read (unreadCount = 0)');

    // 9. Test Auto-Confirm: Update psychologist to autoConfirmAppointments = true
    console.log('\n[TEST 8] Testing autoConfirmAppointments = true...');
    await prisma.psychologistProfile.update({
      where: { id: psyUser.psychologistProfile.id },
      data: { autoConfirmAppointments: true },
    });

    const startAt2 = new Date(Date.now() + 86400000 * 6).toISOString(); // 6 days ahead
    const endAt2 = new Date(Date.now() + 86400000 * 6 + 50 * 60000).toISOString();

    const bookRes2 = await fetch(`${BASE_URL}/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        psychologistId: psyUser.psychologistProfile.id,
        startAt: startAt2,
        endAt: endAt2,
      }),
    });
    const bookData2 = await bookRes2.json();
    console.log('Auto-confirm booking response:', bookRes2.status, bookData2.message);
    if (bookData2.data.appointment.status !== 'CONFIRMED') {
      throw new Error(`Expected auto-confirmed status CONFIRMED, got ${bookData2.data.appointment.status}`);
    }
    console.log('✓ PASS: Appointment with autoConfirm = true was instantly CONFIRMED');

    // Clean up test appointments from DB
    await prisma.consultation.deleteMany({
      where: { appointmentId: { in: [apptId, bookData2.data.appointment.id] } }
    });
    await prisma.appointment.deleteMany({
      where: { id: { in: [apptId, bookData2.data.appointment.id] } }
    });
    // Reset autoConfirm back to false
    await prisma.psychologistProfile.update({
      where: { id: psyUser.psychologistProfile.id },
      data: { autoConfirmAppointments: false },
    });

    console.log('\n===========================================================');
    console.log('   🎉 ALL BACKEND APPOINTMENT & NOTIFICATION TESTS PASSED  ');
    console.log('===========================================================');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
