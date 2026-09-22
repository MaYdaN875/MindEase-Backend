import { Router } from 'express';
import { checkout, getPatientHistory, getReceipt } from '../controllers/paymentController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { paymentConfig, createStripeIntent } from '../controllers/stripeController';

const router = Router();

router.use(authMiddleware as any);
router.get('/config', paymentConfig);
router.post('/intent', createStripeIntent as any);

router.post('/checkout', checkout as any);
router.get('/history', getPatientHistory as any);
router.get('/:id/receipt', getReceipt as any);

export default router;
