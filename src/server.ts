import app from './app';
import prisma from './config/db';
import { seedDatabase } from './config/seed';

const PORT = process.env.PORT || 3000;

const startServer = async (): Promise<void> => {
  await seedDatabase();

  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  const gracefulShutdown = async (): Promise<void> => {
    console.log('Shutting down server gracefully...');
    server.close(async () => {
      console.log('Express server closed.');
      await prisma.$disconnect();
      console.log('Database client disconnected.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
};

startServer().catch((error) => {
  console.error('Failed to start server:', error);
});
