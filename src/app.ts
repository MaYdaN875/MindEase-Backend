import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import { errorHandler } from './middlewares/errorMiddleware';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Base health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// App routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// Global Error Handler
app.use(errorHandler);

export default app;
