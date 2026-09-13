import { Router } from 'express';
import {
  getProfile,
  updateProfile,
  uploadDocument,
  deleteDocument,
  submitForReview,
  getReviewStatus,
  getVerifiedPsychologists,
  getPublicProfileById,
  getPsychologistDashboard,
} from '../controllers/psychologistController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

import {
  getMyAvailability,
  updateMyAvailability,
  getAvailableSlots,
} from '../controllers/availabilityController';

import {
  getMyEarnings,
  requestPayout,
  getMyPayouts,
} from '../controllers/earningsController';

const router = Router();

// Public routes (Directory, Available slots calculation, Public profile)
router.get('/', getVerifiedPsychologists as any);
router.get('/:psychologistId/available-slots', getAvailableSlots as any);
router.get('/:id/public', getPublicProfileById as any);

// Protected routes requiring authentication
router.use(authMiddleware as any);

router.get('/me', getProfile as any);
router.get('/me/dashboard', getPsychologistDashboard as any);
router.put('/me/profile', updateProfile as any);
router.post('/me/documents', upload.single('document'), uploadDocument as any);
router.delete('/me/documents/:documentId', deleteDocument as any);
router.post('/me/submit-review', submitForReview as any);
router.get('/me/review-status', getReviewStatus as any);

// Availability & Scheduling (for logged in psychologist)
router.get('/me/availability', getMyAvailability as any);
router.put('/me/availability', updateMyAvailability as any);

// Financials, Earnings & Payouts
router.get('/me/earnings', getMyEarnings as any);
router.post('/me/payouts', requestPayout as any);
router.get('/me/payouts', getMyPayouts as any);

export default router;
