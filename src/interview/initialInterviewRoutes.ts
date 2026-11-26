import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
import { requireVerifiedEmail } from '../middlewares/emailVerifiedMiddleware';
import { aiRateLimiter } from '../ai/middlewares/aiRateLimiter';
import {
  answer,
  complete,
  downloadProfessionalPdf,
  getPrivacyNotice,
  getProgress,
  getProfessionalReport,
  review,
  revise,
  resumeProfessionalInterview,
  getStatus,
  start,
} from './initialInterviewController';

const router = Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(authMiddleware as any, requireVerifiedEmail as any);

router.get('/status', getStatus as any);
router.get('/privacy', getPrivacyNotice as any);
router.get('/progress', getProgress as any);
router.post('/start', aiRateLimiter as any, start as any);
router.post('/answer', aiRateLimiter as any, answer as any);
router.get('/review', review as any);
router.put('/review', aiRateLimiter as any, revise as any);
router.post('/professional/patients/:patientId/resume', resumeProfessionalInterview as any);
router.post('/complete', aiRateLimiter as any, complete as any);
router.get('/professional/patients/:patientId/initial-report', getProfessionalReport as any);
router.get('/professional/patients/:patientId/initial-report.pdf', downloadProfessionalPdf as any);

export default router;
