import { Router } from 'express';
import {
  listApplications,
  getApplication,
  assignRevisor,
  approveApplication,
  requestChanges,
  rejectApplication,
  downloadDocument,
  getAuditLogs,
} from '../controllers/adminController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { checkRole } from '../middlewares/rbacMiddleware';

const router = Router();

router.use(authMiddleware as any);

// Require ADMIN or REVISOR roles
router.get(
  '/psychologist-applications',
  checkRole(['ADMIN', 'REVISOR']) as any,
  listApplications as any
);
router.get(
  '/psychologist-applications/:applicationId',
  checkRole(['ADMIN', 'REVISOR']) as any,
  getApplication as any
);
router.post(
  '/psychologist-applications/:applicationId/assign',
  checkRole(['ADMIN', 'REVISOR']) as any,
  assignRevisor as any
);
router.post(
  '/psychologist-applications/:applicationId/approve',
  checkRole(['ADMIN', 'REVISOR']) as any,
  approveApplication as any
);
router.post(
  '/psychologist-applications/:applicationId/request-changes',
  checkRole(['ADMIN', 'REVISOR']) as any,
  requestChanges as any
);
router.post(
  '/psychologist-applications/:applicationId/reject',
  checkRole(['ADMIN', 'REVISOR']) as any,
  rejectApplication as any
);

// Secure file downloads (authorization checks internally)
router.get('/documents/:documentId/download', downloadDocument as any);

// Require ADMIN or SUPERADMIN roles
router.get('/audit-logs', checkRole(['ADMIN', 'SUPERADMIN']) as any, getAuditLogs as any);

export default router;
