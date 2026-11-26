import PDFDocument from 'pdfkit';
import { InitialInterviewReport } from './geminiReportProvider';

const disclaimer = 'Informe preliminar generado mediante IA. No constituye un diagnóstico ni sustituye la valoración de un profesional.';

export async function createInitialInterviewPdf(input: {
  recordId: string;
  createdAt: Date;
  report: InitialInterviewReport & { generalData?: Record<string, string | number | null> };
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 56, left: 58, right: 58 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#006A6A')
      .text('Entrevista inicial — Informe preliminar', { align: 'center' });
    doc.moveDown(0.7);
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
      .text(`Expediente: ${input.recordId}`)
      .text(`Fecha de entrevista: ${input.createdAt.toLocaleDateString('es-MX', { timeZone: 'UTC' })}`);
    doc.moveDown();

    const section = (title: string, body: string | string[]) => {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#006A6A').text(title);
      doc.moveDown(0.2);
      const lines = Array.isArray(body) ? body.map(item => `• ${item}`).join('\n') : body;
      doc.font('Helvetica').fontSize(9).fillColor('#1e293b').text(lines || 'No referido.', { lineGap: 2 });
      doc.moveDown(0.65);
    };

    if (input.report.generalData) {
      section('Datos generales mínimos', Object.entries(input.report.generalData)
        .filter(([, value]) => value !== null && value !== '')
        .map(([label, value]) => `${label}: ${value}`));
    }
    section('Motivo principal de consulta', input.report.mainConcern);
    section('Situación actual', input.report.currentSituation);
    section('Síntomas y manifestaciones referidas', input.report.reportedSymptoms);
    section('Duración y evolución', input.report.durationAndCourse);
    section('Antecedentes personales relevantes', input.report.personalHistory);
    section('Antecedentes familiares relevantes', input.report.familyHistory);
    section('Red de apoyo', input.report.supportNetwork);
    section('Seguridad y posibles factores de riesgo', input.report.safetyInformation);
    section('Factores protectores referidos', input.report.protectiveFactors);
    section('Objetivos y expectativas', input.report.patientObjectives);
    section('Posibles áreas de exploración clínica', input.report.clinicalAreasToExplore);
    section('Hipótesis clínicas preliminares orientativas (no diagnósticas)', input.report.preliminaryHypotheses.map(item =>
      `${item.hypothesis} Incertidumbre: ${item.uncertainty} Información adicional: ${item.informationNeeded}`));
    section('Información contradictoria o por aclarar', input.report.inconsistenciesToClarify);
    section('Información faltante para explorar', input.report.missingInformation);
    section('Sugerencias de evaluación y seguimiento profesional', input.report.professionalRecommendations);

    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#7f1d1d').text(disclaimer, { lineGap: 2 });
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text(`MindEase · Documento confidencial · Página ${page + 1} de ${range.count}`,
          58, doc.page.height - 38, { align: 'center', width: doc.page.width - 116 });
    }
    doc.end();
  });
}
