import { DayOfWeek } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../middlewares/errorMiddleware';

// Weekly wall-clock hours belong to the platform timezone; timestamps are UTC.
export function scheduleTimeZone() { return process.env.SCHEDULE_TIME_ZONE || 'America/Mexico_City'; }
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Utiliza horas válidas en formato HH:mm');
const scheduleSchema = z.object({
  dayOfWeek: z.nativeEnum(DayOfWeek), startTime: time, endTime: time,
  slotDuration: z.number().int().min(1).max(1440).default(50), isActive: z.boolean().default(true),
}).refine(s => s.startTime < s.endTime, 'El inicio debe ser anterior al fin');
export type Schedule = z.infer<typeof scheduleSchema>;

export function parseSchedules(value: unknown): Schedule[] {
  const result = z.array(scheduleSchema).max(100).safeParse(value);
  if (!result.success) throw new AppError(result.error.issues[0].message, 400);
  const schedules = result.data;
  for (let i = 0; i < schedules.length; i++) {
    const a = schedules[i];
    const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    if (minutes(a.endTime) - minutes(a.startTime) < a.slotDuration) throw new AppError('La jornada debe permitir al menos una sesión completa', 400);
    if (a.isActive && schedules.slice(i + 1).some(b => b.isActive && b.dayOfWeek === a.dayOfWeek && a.startTime < b.endTime && b.startTime < a.endTime)) {
      throw new AppError('Las jornadas del mismo día no pueden superponerse', 400);
    }
  }
  return schedules;
}

export function validateDate(date: unknown): asserts date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('Utiliza una fecha YYYY-MM-DD', 400);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new AppError('Fecha inválida', 400);
}

function parts(date: Date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: scheduleTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
}

export function localDate(date: Date) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function wallTime(date: string, hour: string) {
  const target = Date.parse(`${date}T${hour}:00Z`);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(candidate));
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (represented === target) return new Date(candidate);
    candidate += target - represented;
  }
  throw new AppError('El horario no existe en la zona horaria configurada', 400);
}

export function slotsForDate(date: string, schedules: Schedule[]) {
  validateDate(date);
  const days = [DayOfWeek.SUNDAY, DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY];
  const dayOfWeek = days[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const slots = new Map<string, { startAt: string; endAt: string }>();
  for (const raw of schedules.filter(s => s.isActive && s.dayOfWeek === dayOfWeek)) {
    // Validate legacy database rows too, to prevent unbounded loops.
    const [schedule] = parseSchedules([raw]);
    const end = wallTime(date, schedule.endTime).getTime();
    const duration = schedule.slotDuration * 60000;
    for (let start = wallTime(date, schedule.startTime).getTime(); start + duration <= end; start += duration) {
      const startAt = new Date(start).toISOString();
      slots.set(startAt, { startAt, endAt: new Date(start + duration).toISOString() });
    }
  }
  return { dayOfWeek, slots: [...slots.values()].sort((a, b) => a.startAt.localeCompare(b.startAt)) };
}
