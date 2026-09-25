import prisma from '../config/db';

export interface SendNotificationParams {
  userId: string;
  title: string;
  content: string;
  type?: 'APPOINTMENT_REQUEST' | 'APPOINTMENT_CONFIRMED' | 'APPOINTMENT_CANCELLED' | 'CONSULTATION_STARTED' | 'CONSULTATION_COMPLETED' | 'SYSTEM';
  referenceId?: string;
}

export const sendNotification = async (params: SendNotificationParams) => {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        title: params.title,
        content: params.content,
        type: params.type || 'SYSTEM',
        referenceId: params.referenceId || null,
        isRead: false,
      },
    });
    return notification;
  } catch (error) {
    console.error('[NotificationService] Error creating notification:', error);
    return null;
  }
};
