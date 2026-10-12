import { Router } from 'express';
import { register, login, forgotPassword, resetPassword, verifyEmail, resendVerification } from '../controllers/authController';

import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

router.post('/verify-email', authMiddleware as any, verifyEmail as any);
router.post('/resend-verification', authMiddleware as any, resendVerification as any);

export default router;
