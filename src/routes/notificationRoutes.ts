import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
  getMyNotifications,
  markAsRead,
  markAllAsRead,
  registerDeviceToken,
  unregisterDeviceToken,
} from '../controllers/notificationController';

const router = Router();

router.use(authMiddleware);

router.get('/', getMyNotifications);
router.post('/device-token', registerDeviceToken);
router.delete('/device-token', unregisterDeviceToken);
router.patch('/read-all', markAllAsRead);
router.patch('/:id/read', markAsRead);

export default router;
