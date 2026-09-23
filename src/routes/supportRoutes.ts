import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
import { supportUpload } from '../middlewares/uploadMiddleware';
import {
  uploadSupportAttachment,
  createTicket,
  getMyTickets,
  getTicketById,
  addTicketMessage,
  closeTicket,
} from '../controllers/ticketController';
import {
  getAllTickets,
  assignTicket,
  updateTicketStatus,
  addAgentMessage,
  getSupportMetrics,
  getSupportAgents,
} from '../controllers/supportAgentController';
import {
  createUserReport,
  getUserReports,
  investigateUserReport,
} from '../controllers/userReportController';

const router = Router();

// ========================
// FILE ATTACHMENTS
// ========================
router.post('/upload', authMiddleware, supportUpload.single('file'), uploadSupportAttachment);

// ========================
// USER TICKET ENDPOINTS
// ========================
router.post('/tickets', authMiddleware, createTicket);
router.get('/tickets', authMiddleware, getMyTickets);
router.get('/tickets/:id', authMiddleware, getTicketById);
router.post('/tickets/:id/messages', authMiddleware, addTicketMessage);
router.put('/tickets/:id/close', authMiddleware, closeTicket);

// ========================
// SUPPORT AGENT CONSOLE
// ========================
router.get('/agent/tickets', authMiddleware, getAllTickets);
router.put('/agent/tickets/:id/assign', authMiddleware, assignTicket);
router.put('/agent/tickets/:id/status', authMiddleware, updateTicketStatus);
router.post('/agent/tickets/:id/messages', authMiddleware, addAgentMessage);
router.get('/agent/metrics', authMiddleware, getSupportMetrics);
router.get('/agent/agents', authMiddleware, getSupportAgents);

// ========================
// USER CONDUCT REPORTS & MODERATION
// ========================
router.post('/user-reports', authMiddleware, createUserReport);
router.get('/user-reports', authMiddleware, getUserReports);
router.put('/user-reports/:id/investigate', authMiddleware, investigateUserReport);

export default router;
