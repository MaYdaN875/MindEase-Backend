const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const appointments = await prisma.appointment.findMany({
    include: {
      psychologist: {
        include: { user: true }
      },
      user: true
    }
  });
  console.log(`Total appointments in DB: ${appointments.length}`);
  for (const a of appointments) {
    console.log(`ID: ${a.id} | Psychologist: ${a.psychologist?.user?.name} (${a.psychologist?.user?.email}) | Profile ID: ${a.psychologistId} | Patient: ${a.user?.name} (${a.user?.email}) | Start: ${a.startAt.toISOString()} | Status: ${a.status}`);
  }

  const avail = await prisma.psychologistAvailability.findMany();
  console.log(`\nTotal availability windows in DB: ${avail.length}`);
  for (const av of avail) {
    console.log(`ID: ${av.id} | Day: ${av.dayOfWeek} | ${av.startTime} - ${av.endTime} | Duration: ${av.slotDuration} min | Active: ${av.isActive}`);
  }
}

main().finally(() => prisma.$disconnect());
