import { Router } from 'express';
import {
  getConsultation,
  startConsultation,
  completeConsultation,
  updateClinicalNotes,
} from '../controllers/consultationController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

router.use(authMiddleware as any);

router.get('/:appointmentId', getConsultation as any);
router.post('/:appointmentId/start', startConsultation as any);
router.post('/:appointmentId/complete', completeConsultation as any);
router.patch('/:appointmentId/notes', updateClinicalNotes as any);

export default router;
