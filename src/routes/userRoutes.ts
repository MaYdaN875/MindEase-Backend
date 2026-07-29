import { Router } from 'express';
import { getProfile, updateProfile } from '../controllers/userController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Apply authentication middleware to all routes below
router.use(authMiddleware as any);

router.get('/profile', getProfile as any);
router.put('/profile', updateProfile as any);

export default router;
