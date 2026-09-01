import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Generates a valid minimal PDF buffer with readable text
function createSimplePdf(title: string, subtitle: string): Buffer {
  const content = `BT
/F1 24 Tf
50 700 Td
(${title}) Tj
/F1 14 Tf
0 -40 Td
(${subtitle}) Tj
/F1 10 Tf
0 -30 Td
(Documento generado por MindEase Clinical Storage) Tj
ET`;

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000340 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
420
%%EOF`;

  return Buffer.from(pdf, 'utf-8');
}

async function main() {
  const storageDir = path.join(process.cwd(), 'storage', 'private_documents');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
    console.log('Created directory:', storageDir);
  }

  const docs = await prisma.professionalDocument.findMany({
    include: { psychologist: { include: { user: true } } }
  });

  console.log(`Found ${docs.length} document records in database.`);

  for (const doc of docs) {
    const filePath = path.join(storageDir, doc.storageKey);
    if (!fs.existsSync(filePath)) {
      const pdfBuffer = createSimplePdf(
        `MindEase - ${doc.documentType}: ${doc.originalFilename}`,
        `Psychologist: ${doc.psychologist.user.name} (${doc.psychologist.user.email})`
      );
      fs.writeFileSync(filePath, pdfBuffer);
      console.log(`Created PDF file on disk for: ${doc.originalFilename} -> ${doc.storageKey}`);
    } else {
      console.log(`File already exists: ${doc.storageKey}`);
    }
  }

  console.log('Finished restoring documents on storage filesystem.');
}

main().finally(() => prisma.$disconnect());
