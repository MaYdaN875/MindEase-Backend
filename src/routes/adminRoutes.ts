import { Router } from 'express';
import {
  listApplications,
  getApplication,
  assignRevisor,
  approveApplication,
  requestChanges,
  rejectApplication,
  downloadDocument,
  updateDocumentStatus,
  getAuditLogs,
  listUsers,
  listRoles,
  updateUserRoles,
  updateUserStatus,
  listSpecialties,
  createSpecialty,
  updateSpecialty,
  deleteSpecialty,
  getDashboardStats,
  exportAuditLogsCsv,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  broadcastNotification,
} from '../controllers/adminController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { checkRole } from '../middlewares/rbacMiddleware';

const router = Router();

router.use(authMiddleware as any);

// Dashboard & Metrics
router.get(
  '/dashboard/stats',
  checkRole(['ADMIN', 'REVISOR', 'SUPERADMIN']) as any,
  getDashboardStats as any
);

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

// Secure file downloads and document status validation
router.get('/documents/:documentId/download', downloadDocument as any);
router.put(
  '/documents/:documentId/status',
  checkRole(['ADMIN', 'REVISOR']) as any,
  updateDocumentStatus as any
);

// Security, Audit Logs & Compliance Export
router.get('/audit-logs/export-csv', checkRole(['ADMIN', 'SUPERADMIN']) as any, exportAuditLogsCsv as any);
router.get('/audit-logs', checkRole(['ADMIN', 'SUPERADMIN']) as any, getAuditLogs as any);

// User & Role Management endpoints
router.get('/users', checkRole(['ADMIN', 'SUPERADMIN']) as any, listUsers as any);
router.get('/roles', checkRole(['ADMIN', 'SUPERADMIN']) as any, listRoles as any);
router.put('/users/:userId/roles', checkRole(['ADMIN', 'SUPERADMIN']) as any, updateUserRoles as any);
router.put('/users/:userId/status', checkRole(['ADMIN', 'SUPERADMIN']) as any, updateUserStatus as any);

// Dynamic Specialties Management endpoints
router.get('/specialties', checkRole(['ADMIN', 'REVISOR', 'SUPERADMIN']) as any, listSpecialties as any);
router.post('/specialties', checkRole(['ADMIN', 'SUPERADMIN']) as any, createSpecialty as any);
router.put('/specialties/:specialtyId', checkRole(['ADMIN', 'SUPERADMIN']) as any, updateSpecialty as any);
router.delete('/specialties/:specialtyId', checkRole(['ADMIN', 'SUPERADMIN']) as any, deleteSpecialty as any);

// System Notifications endpoints
router.get('/notifications', listNotifications as any);
router.put('/notifications/mark-all-read', markAllNotificationsRead as any);
router.put('/notifications/:notificationId/read', markNotificationRead as any);
router.post('/notifications/broadcast', checkRole(['ADMIN', 'SUPERADMIN']) as any, broadcastNotification as any);

export default router;
