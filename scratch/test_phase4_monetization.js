const crypto = require('crypto');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const BASE_URL = 'http://localhost:3000/api';
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres:postgres@localhost:5432/mindease?schema=public"
    }
  }
});

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function runMonetizationTests() {
  console.log('====================================================');
  console.log('  INTEGRATION TESTING: FASE 4 — MONETIZACIÓN        ');
  console.log('====================================================\n');

  try {
    const timestamp = Date.now();
    const psyEmail = `dr.monetize.${timestamp}@mindease.com`;
    const patEmail = `pat.monetize.${timestamp}@mindease.com`;

    // 1. Setup Psychologist and Patient
    console.log('[1] Registrando psicólogo y paciente...');
    const psyReg = await request('/auth/register', {
      method: 'POST',
      body: { email: psyEmail, password: 'password123', name: 'Dr. Roberto Finanzas', role: 'PSYCHOLOGIST' }
    });
    if (!psyReg.ok) throw new Error('Falló registro psicólogo: ' + JSON.stringify(psyReg.data));
    const psyToken = psyReg.data.data.token;
    const psyUserId = psyReg.data.data.user.id;

    const patReg = await request('/auth/register', {
      method: 'POST',
      body: { email: patEmail, password: 'password123', name: 'Ana Paciente', role: 'USER' }
    });
    if (!patReg.ok) throw new Error('Falló registro paciente: ' + JSON.stringify(patReg.data));
    const patToken = patReg.data.data.token;
    const patUserId = patReg.data.data.user.id;

    // Verify Psychologist and set consultation price to $600 MXN
    const psyProfRes = await request('/psychologists/me', {
      headers: { Authorization: `Bearer ${psyToken}` }
    });
    const psyProfileId = psyProfRes.data.data.profile.id;

    const verRole = await prisma.role.upsert({ where: { name: 'PSYCHOLOGIST_VERIFIED' }, update: {}, create: { name: 'PSYCHOLOGIST_VERIFIED' } });
    await prisma.userRole.create({ data: { userId: psyUserId, roleId: verRole.id } });
    await prisma.psychologistProfile.update({
      where: { id: psyProfileId },
      data: { status: 'VERIFICADO', consultationPrice: 600.0, autoConfirmAppointments: false }
    });

    // Set availability
    await request('/psychologists/me/availability', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${psyToken}` },
      body: {
        availabilities: [
          { dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'TUESDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'WEDNESDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'THURSDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'FRIDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'SATURDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
          { dayOfWeek: 'SUNDAY', startTime: '08:00', endTime: '20:00', slotDuration: 50, isActive: true },
        ]
      }
    });
    console.log(' Psicólogo verificado con precio de consulta congelado a $600 MXN.');

    // Fetch tomorrow's slot
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);
    const slotsRes = await request(`/psychologists/${psyProfileId}/available-slots?date=${dateStr}`, {
      headers: { Authorization: `Bearer ${patToken}` }
    });
    const slot1 = slotsRes.data.data.slots[0];
    const slot2 = slotsRes.data.data.slots[1];
    const slot3 = slotsRes.data.data.slots[2];

    // Book appointment 1
    console.log('\n[2] Creando cita 1...');
    const apt1Res = await request('/appointments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: { psychologistId: psyProfileId, startAt: slot1.startAt, endAt: slot1.endAt }
    });
    if (!apt1Res.ok) throw new Error('Falló creación cita 1: ' + JSON.stringify(apt1Res.data));
    const apt1Id = apt1Res.data.data.appointment.id;
    console.log(` Cita 1 creada (ID: ${apt1Id}, Estado: ${apt1Res.data.data.appointment.status}, Precio congelado: $${apt1Res.data.data.appointment.price})`);

    // -------------------------------------------------------------
    // TEST 1: Cobro exitoso y snapshot histórico
    // -------------------------------------------------------------
    console.log('\n--- [TEST 1] Cobro exitoso y snapshot financiero histórico ---');
    const idemKey1 = crypto.randomUUID();
    const payRes1 = await request('/payments/checkout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${patToken}`,
        'Idempotency-Key': idemKey1,
      },
      body: {
        appointmentId: apt1Id,
        paymentMethod: 'CREDIT_CARD',
        card: {
          number: '4242424242424242',
          expMonth: 12,
          expYear: 2028,
          cvc: '123',
          holderName: 'Ana Paciente',
        },
      }
    });

    console.log(`Estado checkout cita 1: ${payRes1.status} (${payRes1.data?.message})`);
    if (payRes1.status !== 201) throw new Error('Falló checkout cita 1: ' + JSON.stringify(payRes1.data));

    const p1 = payRes1.data.data.payment;
    console.log('Datos del pago procesado:', {
      amount: p1.amount,
      platformFee: p1.platformFee,
      netAmount: p1.netAmount,
      status: p1.status,
      cardBrand: p1.cardBrand,
      cardLast4: p1.cardLast4,
    });

    if (p1.amount !== 600.0) throw new Error(`Monto incorrecto: esperado 600, recibido ${p1.amount}`);
    if (p1.platformFee !== 90.0) throw new Error(`Comisión de plataforma incorrecta: esperada 90, recibida ${p1.platformFee}`);
    if (p1.netAmount !== 510.0) throw new Error(`Monto neto incorrecto: esperado 510, recibido ${p1.netAmount}`);
    if (p1.status !== 'SUCCEEDED') throw new Error(`Estado de pago incorrecto: esperado SUCCEEDED, recibido ${p1.status}`);

    // Verify appointment is now CONFIRMED
    const apt1Verify = await request(`/appointments/${apt1Id}`, {
      headers: { Authorization: `Bearer ${patToken}` }
    });
    if (apt1Verify.data.data.appointment.status !== 'CONFIRMED') {
      throw new Error('La cita debía confirmarse tras el pago');
    }
    console.log(' PASSED: Pago exitoso, comisión de 15% calculada y cita confirmada.');

    // -------------------------------------------------------------
    // TEST 2: Tarjeta declinada (Fondos insuficientes)
    // -------------------------------------------------------------
    console.log('\n--- [TEST 2] Tarjeta declinada por el emisor ---');
    const apt2Res = await request('/appointments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: { psychologistId: psyProfileId, startAt: slot2.startAt, endAt: slot2.endAt }
    });
    const apt2Id = apt2Res.data.data.appointment.id;

    const declineRes = await request('/payments/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: {
        appointmentId: apt2Id,
        paymentMethod: 'CREDIT_CARD',
        card: {
          number: '4000000000000002', // Card ending in 0002 triggers INSUFFICIENT_FUNDS
          expMonth: 10,
          expYear: 2027,
          cvc: '456',
          holderName: 'Ana Paciente',
        },
      }
    });
    console.log(`Estado tarjeta declinada: ${declineRes.status} (${declineRes.data?.message})`);
    if (declineRes.status !== 402) throw new Error('Se esperaba código 402 para tarjeta declinada');

    // Verify appointment remained PENDING
    const apt2Verify = await request(`/appointments/${apt2Id}`, {
      headers: { Authorization: `Bearer ${patToken}` }
    });
    if (apt2Verify.data.data.appointment.status !== 'PENDING') {
      throw new Error('La cita no debe confirmarse si el pago falla');
    }
    console.log(' PASSED: Tarjeta declinada manejada correctamente y cita permanece PENDING.');

    // -------------------------------------------------------------
    // TEST 3: Idempotencia (reintento con misma clave)
    // -------------------------------------------------------------
    console.log('\n--- [TEST 3] Idempotencia en checkout ---');
    const retryRes = await request('/payments/checkout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${patToken}`,
        'Idempotency-Key': idemKey1, // Re-sending same idempotency key from TEST 1
      },
      body: {
        appointmentId: apt1Id,
        paymentMethod: 'CREDIT_CARD',
        card: {
          number: '4242424242424242',
          expMonth: 12,
          expYear: 2028,
          cvc: '123',
          holderName: 'Ana Paciente',
        },
      }
    });

    console.log(`Respuesta reintento idempotente: ${retryRes.status} (${retryRes.data?.message})`);
    if (retryRes.status !== 200) throw new Error('Se esperaba 200 en reintento idempotente');
    if (retryRes.data.data.payment.id !== p1.id) throw new Error('La transacción devuelta no coincide con la original');
    console.log(' PASSED: Idempotencia garantizada, no se duplicó el cobro.');

    // -------------------------------------------------------------
    // TEST 4: Prevención de doble checkout con distinta clave
    // -------------------------------------------------------------
    console.log('\n--- [TEST 4] Prevención de doble pago para la misma cita ---');
    const doublePayRes = await request('/payments/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: {
        appointmentId: apt1Id,
        idempotencyKey: crypto.randomUUID(), // New key
        paymentMethod: 'CREDIT_CARD',
        card: {
          number: '4242424242424242',
          expMonth: 12,
          expYear: 2028,
          cvc: '123',
          holderName: 'Ana Paciente',
        },
      }
    });
    console.log(`Respuesta doble pago: ${doublePayRes.status} (${doublePayRes.data?.message})`);
    if (doublePayRes.status !== 409) throw new Error('Se esperaba 409 Conflict al intentar pagar dos veces una cita');
    console.log(' PASSED: Doble pago rechazado con 409 Conflict.');

    // -------------------------------------------------------------
    // TEST 5: Cita futura permanece en Custodia (HELD)
    // -------------------------------------------------------------
    console.log('\n--- [TEST 5] Verificación de Fondos en Custodia (HELD) vs Disponible (AVAILABLE) ---');
    const earningsBeforeComplete = await request('/psychologists/me/earnings', {
      headers: { Authorization: `Bearer ${psyToken}` }
    });
    if (!earningsBeforeComplete.ok) throw new Error('Falló consulta de earnings: ' + JSON.stringify(earningsBeforeComplete.data));
    const fin1 = earningsBeforeComplete.data.data.financials;
    console.log('Métricas financieras con cita confirmada (futura):', {
      availableBalance: fin1.availableBalance,
      heldBalance: fin1.heldBalance,
      pendingPayoutBalance: fin1.pendingPayoutBalance,
    });

    if (fin1.heldBalance !== 510.0) throw new Error(`heldBalance incorrecto: esperado 510, recibido ${fin1.heldBalance}`);
    if (fin1.availableBalance !== 0.0) throw new Error(`availableBalance incorrecto: esperado 0, recibido ${fin1.availableBalance}`);
    console.log(' PASSED: Los fondos de la cita futura están en Custodia ($510) y el saldo disponible es $0.');

    // -------------------------------------------------------------
    // TEST 6: Liberación de fondos a AVAILABLE tras concluir la cita
    // -------------------------------------------------------------
    console.log('\n--- [TEST 6] Liberación de fondos tras cita COMPLETED ---');
    // Mark appointment 1 as COMPLETED in database to simulate consultation ended
    await prisma.appointment.update({
      where: { id: apt1Id },
      data: { status: 'COMPLETED' }
    });

    const earningsAfterComplete = await request('/psychologists/me/earnings', {
      headers: { Authorization: `Bearer ${psyToken}` }
    });
    const fin2 = earningsAfterComplete.data.data.financials;
    console.log('Métricas financieras tras completar la consulta:', {
      availableBalance: fin2.availableBalance,
      heldBalance: fin2.heldBalance,
      lifetimeNetEarnings: fin2.lifetimeNetEarnings,
      lifetimePlatformFees: fin2.lifetimePlatformFees,
    });

    if (fin2.heldBalance !== 0.0) throw new Error(`heldBalance incorrecto tras finalizar cita: esperado 0, recibido ${fin2.heldBalance}`);
    if (fin2.availableBalance !== 510.0) throw new Error(`availableBalance incorrecto tras finalizar cita: esperado 510, recibido ${fin2.availableBalance}`);
    console.log(' PASSED: Fondos transferidos con éxito a saldo disponible ($510.00).');

    // -------------------------------------------------------------
    // TEST 7: Intento de retiro superior al saldo disponible
    // -------------------------------------------------------------
    console.log('\n--- [TEST 7] Intento de retiro superior al saldo disponible ---');
    const overdrawRes = await request('/psychologists/me/payouts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${psyToken}` },
      body: {
        amount: 1000.0, // Available is 510
        bankName: 'BBVA México',
        accountClabe: '012180015487965213',
      }
    });
    console.log(`Respuesta sobregiro: ${overdrawRes.status} (${overdrawRes.data?.message})`);
    if (overdrawRes.status !== 400) throw new Error('Se esperaba 400 por solicitud de retiro superior al saldo');
    console.log(' PASSED: Retiro superior al saldo rechazado.');

    // -------------------------------------------------------------
    // TEST 8: Retiro exitoso y reserva inmediata de saldo
    // -------------------------------------------------------------
    console.log('\n--- [TEST 8] Retiro exitoso y reserva inmediata de saldo ---');
    const validPayoutRes = await request('/psychologists/me/payouts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${psyToken}` },
      body: {
        amount: 400.0, // Valid withdrawal (510 - 400 = 110 remaining)
        bankName: 'BBVA México',
        accountClabe: '012180015487965213',
      }
    });
    console.log(`Respuesta retiro válido: ${validPayoutRes.status} (${validPayoutRes.data?.message})`);
    if (validPayoutRes.status !== 201) throw new Error('Falló solicitud de retiro válido: ' + JSON.stringify(validPayoutRes.data));

    const payoutData = validPayoutRes.data.data.payout;
    console.log('Datos del retiro creado:', payoutData);
    if (payoutData.accountClabe !== '**************5213') {
      throw new Error(`CLABE no fue enmascarada adecuadamente: ${payoutData.accountClabe}`);
    }

    // Verify balance after payout requested
    const earningsAfterPayout = await request('/psychologists/me/earnings', {
      headers: { Authorization: `Bearer ${psyToken}` }
    });
    const fin3 = earningsAfterPayout.data.data.financials;
    console.log('Balance tras reservar retiro:', {
      availableBalance: fin3.availableBalance,
      pendingPayoutBalance: fin3.pendingPayoutBalance,
    });
    if (fin3.availableBalance !== 110.0) throw new Error(`availableBalance incorrecto: esperado 110, recibido ${fin3.availableBalance}`);
    if (fin3.pendingPayoutBalance !== 400.0) throw new Error(`pendingPayoutBalance incorrecto: esperado 400, recibido ${fin3.pendingPayoutBalance}`);
    console.log(' PASSED: Retiro registrado, CLABE enmascarada y saldo disponible reducido a $110.00.');

    // -------------------------------------------------------------
    // TEST 9: Cancelación de cita pagada y reembolso automático
    // -------------------------------------------------------------
    console.log('\n--- [TEST 9] Cancelación de cita pagada y reembolso ---');
    // Book slot 3
    const apt3Res = await request('/appointments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: { psychologistId: psyProfileId, startAt: slot3.startAt, endAt: slot3.endAt }
    });
    const apt3Id = apt3Res.data.data.appointment.id;

    // Pay slot 3
    const payRes3 = await request('/payments/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${patToken}` },
      body: {
        appointmentId: apt3Id,
        paymentMethod: 'DEBIT_CARD',
        card: {
          number: '4242424242424242',
          expMonth: 11,
          expYear: 2026,
          cvc: '999',
          holderName: 'Ana Paciente',
        },
      }
    });
    if (payRes3.status !== 201) throw new Error('Falló pago cita 3: ' + JSON.stringify(payRes3.data));

    // Cancel appointment 3
    const cancelRes = await request(`/appointments/${apt3Id}/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${patToken}` },
      body: { status: 'CANCELLED', cancellationReason: 'Imprevisto de trabajo' }
    });
    if (cancelRes.status !== 200) throw new Error('Falló cancelación cita 3: ' + JSON.stringify(cancelRes.data));

    // Verify payment record in DB is REFUNDED
    const paymentRefunded = await prisma.payment.findUnique({
      where: { appointmentId: apt3Id }
    });
    console.log('Estado de pago tras cancelación:', {
      status: paymentRefunded.status,
      refundReason: paymentRefunded.refundReason,
      refundedAt: paymentRefunded.refundedAt,
    });
    if (paymentRefunded.status !== 'REFUNDED') {
      throw new Error(`El pago debía marcarse como REFUNDED, estado actual: ${paymentRefunded.status}`);
    }
    console.log(' PASSED: Reembolso procesado y registrado automáticamente al cancelar.');

    // -------------------------------------------------------------
    // TEST 10: Historial de pagos y recibo digital para el paciente
    // -------------------------------------------------------------
    console.log('\n--- [TEST 10] Historial de pagos y recibo digital del paciente ---');
    const historyRes = await request('/payments/history', {
      headers: { Authorization: `Bearer ${patToken}` }
    });
    if (!historyRes.ok) throw new Error('Falló consulta historial: ' + JSON.stringify(historyRes.data));
    console.log(`Historial del paciente contiene ${historyRes.data.data.payments.length} transacciones.`);

    const receiptRes = await request(`/payments/${p1.id}/receipt`, {
      headers: { Authorization: `Bearer ${patToken}` }
    });
    if (!receiptRes.ok) throw new Error('Falló consulta de recibo: ' + JSON.stringify(receiptRes.data));
    const receipt = receiptRes.data.data.receipt;
    console.log('Recibo digital generado:', {
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
      platformFee: receipt.platformFee,
      netAmount: receipt.netAmount,
      psychologist: receipt.psychologist.name,
      patient: receipt.patient.name,
    });
    if (!receipt.receiptNumber.startsWith('REC-')) throw new Error('Número de recibo inválido');
    console.log(' PASSED: Historial y recibo digital generados con éxito.');

    console.log('\n====================================================');
    console.log('  ALL 10 MONETIZATION INTEGRATION TESTS PASSED!    ');
    console.log('====================================================');

  } catch (error) {
    console.error('\n TEST FAILED:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runMonetizationTests();
