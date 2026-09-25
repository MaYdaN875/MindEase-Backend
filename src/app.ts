import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import psychologistRoutes from './routes/psychologistRoutes';
import adminRoutes from './routes/adminRoutes';
import { authMiddleware, optionalAuthMiddleware } from './middlewares/authMiddleware';
import { downloadMedia, mediaAccess } from './controllers/mediaController';
import appointmentRoutes from './routes/appointmentRoutes';
import consultationRoutes from './routes/consultationRoutes';
import notificationRoutes from './routes/notificationRoutes';
import paymentRoutes from './routes/paymentRoutes';
import communityRoutes from './routes/communityRoutes';
import supportRoutes from './routes/supportRoutes';
import aiRoutes from './ai/routes/aiRoutes';
import chatRoutes from './routes/chatRoutes';
import reviewRoutes from './routes/reviewRoutes';
import { errorHandler } from './middlewares/errorMiddleware';
import { stripeWebhook } from './controllers/stripeController';


dotenv.config();

const app = express();

app.use(cors());
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
app.use(express.json());

// Never expose storage with express.static: authorization is checked on every read.
app.get('/uploads/:scope/:filename', optionalAuthMiddleware, downloadMedia);
app.post('/api/media/access', authMiddleware, mediaAccess);

// Base health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// App routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/psychologists', psychologistRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/reviews', reviewRoutes);



// 404 Not Found fallback in JSON
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
});

// Global Error Handler
app.use(errorHandler);

export default app;
