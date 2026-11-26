/** The interview is currently a prototype, available only to explicitly listed test patients. */
export function isDemoInterviewAllowed(patientId: string): boolean {
  if (process.env.INITIAL_INTERVIEW_DEMO_ENABLED !== 'true') return false;
  const allowed = (process.env.INITIAL_INTERVIEW_DEMO_USER_IDS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  return allowed.includes(patientId);
}
