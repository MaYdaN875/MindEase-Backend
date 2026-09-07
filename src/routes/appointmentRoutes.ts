import { Router } from 'express';
import {
  createAppointment,
  getMyAppointments,
  getAppointmentById,
  updateAppointmentStatus,
} from '../controllers/appointmentController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

router.use(authMiddleware as any);

router.post('/', createAppointment as any);
router.get('/', getMyAppointments as any);
router.get('/:id', getAppointmentById as any);
router.patch('/:id/status', updateAppointmentStatus as any);

export default router;
