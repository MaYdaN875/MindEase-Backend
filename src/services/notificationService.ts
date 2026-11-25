import prisma from '../config/db';
import { sendPushToUser } from './pushNotificationService';

export interface SendNotificationParams {
  userId: string;
  title: string;
  content: string;
  type?: 'APPOINTMENT_REQUEST' | 'APPOINTMENT_CONFIRMED' | 'APPOINTMENT_CANCELLED' | 'CONSULTATION_STARTED' | 'CONSULTATION_COMPLETED' | 'PRIVATE_MESSAGE' | 'PRE_BOOKING_MESSAGE' | 'SYSTEM';
  referenceId?: string;
}

export const sendNotification = async (params: SendNotificationParams) => {
  try {
    const type = params.type || 'SYSTEM';
    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        title: params.title,
        content: params.content,
        type,
        referenceId: params.referenceId || null,
        isRead: false,
      },
    });
    void sendPushToUser({
      userId: params.userId,
      type,
      referenceId: params.referenceId || null,
    });
    return notification;
  } catch (error) {
    console.error('[NotificationService] Error creating notification:', error);
    return null;
  }
};
