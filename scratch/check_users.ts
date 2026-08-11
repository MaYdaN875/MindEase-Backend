import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('=== PSYCHOLOGIST PROFILES ===');
    const profiles = await prisma.psychologistProfile.findMany({
      include: {
        user: true,
        documents: true,
        verificationRequests: true,
      }
    });

    for (const p of profiles) {
      console.log(`Profile ID: ${p.id}`);
      console.log(`User: ${p.user.name} (${p.user.email})`);
      console.log(`Status: ${p.status}`);
      console.log(`Documents count: ${p.documents.length}`);
      for (const d of p.documents) {
        console.log(`  - Doc: ${d.originalFilename} (Type: ${d.documentType}, Status: ${d.status})`);
      }
      console.log(`Verification Requests count: ${p.verificationRequests.length}`);
      for (const r of p.verificationRequests) {
        console.log(`  - Req ID: ${r.id} (Status: ${r.status}, CreatedAt: ${r.createdAt})`);
      }
      console.log('------------------------------------------------');
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
