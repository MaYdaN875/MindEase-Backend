import { Router } from 'express';
import {
  getProfile,
  updateProfile,
  uploadDocument,
  deleteDocument,
  submitForReview,
  getReviewStatus,
} from '../controllers/psychologistController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { upload } from '../middlewares/uploadMiddleware';

const router = Router();

router.use(authMiddleware as any);

router.get('/me', getProfile as any);
router.put('/me/profile', updateProfile as any);
router.post('/me/documents', upload.single('document'), uploadDocument as any);
router.delete('/me/documents/:documentId', deleteDocument as any);
router.post('/me/submit-review', submitForReview as any);
router.get('/me/review-status', getReviewStatus as any);

export default router;
