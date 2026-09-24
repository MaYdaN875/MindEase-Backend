import { Router } from 'express';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { aiRateLimiter } from '../middlewares/aiRateLimiter';
import {
  getConsentStatus,
  registerConsent,
  createSession,
  getActiveSession,
  getSessionById,
  sendMessage,
  completeSession,
  getRecommendations,
} from '../controllers/aiOrientationController';

const router = Router();

// Consentimiento informado
router.get('/orientation/consent', authMiddleware as any, getConsentStatus as any);
router.post('/orientation/consent', authMiddleware as any, registerConsent as any);

// Sesiones de orientación
router.post('/orientation/sessions', authMiddleware as any, createSession as any);
router.get('/orientation/sessions/active', authMiddleware as any, getActiveSession as any);
router.get('/orientation/sessions/:id', authMiddleware as any, getSessionById as any);

// Mensajes (con rate limiting)
router.post(
  '/orientation/sessions/:id/messages',
  authMiddleware as any,
  aiRateLimiter as any,
  sendMessage as any
);

// Conclusión y recomendaciones
router.post('/orientation/sessions/:id/complete', authMiddleware as any, completeSession as any);
router.get('/orientation/sessions/:id/recommendations', authMiddleware as any, getRecommendations as any);

export default router;
