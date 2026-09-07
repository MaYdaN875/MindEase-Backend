const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  const all = await prisma.psychologistAvailability.findMany();
  const seen = new Set();
  let deletedCount = 0;
  for (const item of all) {
    const key = `${item.psychologistId}-${item.dayOfWeek}-${item.startTime}-${item.endTime}`;
    if (seen.has(key)) {
      await prisma.psychologistAvailability.delete({ where: { id: item.id } });
      console.log(`Deleted duplicate: ${item.id} (${item.dayOfWeek} ${item.startTime}-${item.endTime})`);
      deletedCount++;
    } else {
      seen.add(key);
    }
  }
  console.log(`Total duplicate windows cleaned: ${deletedCount}`);
}

clean().finally(() => prisma.$disconnect());
