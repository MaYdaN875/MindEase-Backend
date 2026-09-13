const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedules, slotsForDate, localDate } = require('../src/services/scheduling');
const { consultationView, appointmentView, assertAppointmentTransition } = require('../src/services/clinicalPolicy');
process.env.SCHEDULE_TIME_ZONE = 'America/Mexico_City';
const monday = { dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '11:00', slotDuration: 50, isActive: true };

test('privacy: patient and administrative projections omit clinical notes', () => {
  const consultation = { id: 'clinical', status: 'IN_PROGRESS', clinicalNotes: 'PRIVATE', meetingUrl: 'https://example.org' };
  assert.equal(Object.hasOwn(consultationView(consultation, false), 'clinicalNotes'), false);
  assert.equal(consultationView(consultation, true).clinicalNotes, 'PRIVATE');
  const appointment = { psychologist: { userId: 'doctor' }, consultation };
  for (const viewer of ['patient', 'admin']) assert.equal(JSON.stringify(appointmentView(appointment, viewer)).includes('PRIVATE'), false);
  assert.equal(appointmentView(appointment, 'doctor').consultation.clinicalNotes, 'PRIVATE');
  assert.equal(consultation.clinicalNotes, 'PRIVATE');
});

for (const status of ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'PENDING']) {
  test('patient cannot set ' + status, () => assert.throws(() => assertAppointmentTransition('PENDING', status, false, false)));
}
test('patient may cancel a pending appointment', () => assert.doesNotThrow(() => assertAppointmentTransition('PENDING', 'CANCELLED', false, false)));
for (const state of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) test('closed appointments cannot reopen: ' + state, () => assert.throws(() => assertAppointmentTransition(state, 'CONFIRMED', true, true)));
test('active consultations cannot be cancelled and no-show requires elapsed slot', () => {
  assert.throws(() => assertAppointmentTransition('CONFIRMED', 'CANCELLED', true, false, 'IN_PROGRESS'));
  assert.throws(() => assertAppointmentTransition('CONFIRMED', 'NO_SHOW', true, false, 'SCHEDULED', new Date(Date.now() + 60000)));
  assert.doesNotThrow(() => assertAppointmentTransition('CONFIRMED', 'NO_SHOW', true, false, 'SCHEDULED', new Date(0)));
});
for (const duration of [0, -50, 1.5, 1500, '50']) test('reject invalid duration ' + duration, () => assert.throws(() => parseSchedules([{ ...monday, slotDuration: duration }])));
test('reject malformed hours, impossible dates and overlapping windows', () => {
  assert.throws(() => parseSchedules([{ ...monday, startTime: '9:00' }]));
  assert.throws(() => parseSchedules([{ ...monday, endTime: '24:00' }]));
  assert.throws(() => parseSchedules([monday, { ...monday, startTime: '10:00' }]));
  assert.throws(() => slotsForDate('2026-02-30', [monday]));
  assert.throws(() => slotsForDate('2026-09-14', [{ ...monday, slotDuration: -1 }]));
});
test('09:00 in Mexico City is 15:00 UTC, with no partial final slot', () => {
  const { slots } = slotsForDate('2026-09-14', [monday]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].startAt, '2026-09-14T15:00:00.000Z');
  assert.equal(slots[1].endAt, '2026-09-14T16:40:00.000Z');
  assert.equal(localDate(new Date('2026-09-15T03:00:00Z')), '2026-09-14');
});
test('adjacent windows allowed; disabled windows generate no slots', () => {
  assert.equal(parseSchedules([monday, { ...monday, startTime: '11:00', endTime: '13:00' }]).length, 2);
  assert.deepEqual(slotsForDate('2026-09-14', [{ ...monday, isActive: false }]).slots, []);
});
