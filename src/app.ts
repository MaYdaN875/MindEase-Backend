import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import psychologistRoutes from './routes/psychologistRoutes';
import adminRoutes from './routes/adminRoutes';
import path from 'path';
import appointmentRoutes from './routes/appointmentRoutes';
import consultationRoutes from './routes/consultationRoutes';
import notificationRoutes from './routes/notificationRoutes';
import paymentRoutes from './routes/paymentRoutes';
import communityRoutes from './routes/communityRoutes';
import supportRoutes from './routes/supportRoutes';
import { errorHandler } from './middlewares/errorMiddleware';


dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Serve static uploaded files (community media, documents, images)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

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
