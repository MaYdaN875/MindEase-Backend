import { cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getMessaging as getFirebaseMessaging, Messaging } from 'firebase-admin/messaging';
import prisma from '../config/db';

export interface PushPayload {
  userId: string;
  type?: string;
  referenceId?: string | null;
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// Generic, non-clinical copy for lock-screen privacy.
const GENERIC_PUSH_COPY: Record<string, { title: string; body: string }> = {
  APPOINTMENT_REQUEST: {
    title: 'MindEase',
    body: 'Tienes una nueva solicitud de cita.',
  },
  APPOINTMENT_CONFIRMED: {
    title: 'MindEase',
    body: 'Tienes una actualización en tu cita.',
  },
  APPOINTMENT_CANCELLED: {
    title: 'MindEase',
    body: 'Tienes una actualización en tu cita.',
  },
  CONSULTATION_STARTED: {
    title: 'MindEase',
    body: 'Tu consulta está lista para comenzar.',
  },
  CONSULTATION_COMPLETED: {
    title: 'MindEase',
    body: 'Tu consulta ha finalizado.',
  },
  PRIVATE_MESSAGE: {
    title: 'MindEase',
    body: 'Tienes un nuevo mensaje en MindEase.',
  },
  PRE_BOOKING_MESSAGE: {
    title: 'MindEase',
    body: 'Tienes un nuevo mensaje en MindEase.',
  },
  SYSTEM: {
    title: 'MindEase',
    body: 'Tienes una nueva notificación en MindEase.',
  },
};

let initAttempted = false;
let messagingInstance: Messaging | null = null;

function parseServiceAccountFromEnv(): ServiceAccount | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      const decoded = rawJson.startsWith('{')
        ? rawJson
        : Buffer.from(rawJson, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: String(parsed.private_key).replace(/\\n/g, '\n'),
        };
      }
    } catch {
      console.error('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON or base64 JSON');
      return null;
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  return null;
}

function getMessaging(): Messaging | null {
  if ((process.env.FCM_ENABLED || 'false').toLowerCase() !== 'true') {
    return null;
  }

  if (initAttempted) {
    return messagingInstance;
  }
  initAttempted = true;

  if (getApps().length > 0) {
    messagingInstance = getFirebaseMessaging();
    return messagingInstance;
  }

  const serviceAccount = parseServiceAccountFromEnv();
  if (!serviceAccount) {
    console.warn('[FCM] FCM_ENABLED=true but Firebase credentials are incomplete; push disabled.');
    return null;
  }

  try {
    initializeApp({
      credential: cert(serviceAccount),
    });
    messagingInstance = getFirebaseMessaging();
    return messagingInstance;
  } catch (error) {
    console.error(
      '[FCM] Failed to initialize Firebase Admin SDK:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return null;
  }
}

export function getGenericPushCopy(type?: string): { title: string; body: string } {
  return GENERIC_PUSH_COPY[type || 'SYSTEM'] || GENERIC_PUSH_COPY.SYSTEM;
}

/**
 * Fire-and-forget helper to deliver a generic FCM push notification to all
 * registered devices of a user. Never throws so business flows cannot fail.
 */
export async function sendPushToUser(payload: PushPayload): Promise<void> {
  const messaging = getMessaging();
  if (!messaging) return;

  try {
    const devices = await prisma.deviceToken.findMany({
      where: { userId: payload.userId },
      select: { token: true },
    });

    if (devices.length === 0) return;

    const tokens = devices.map((d) => d.token);
    const type = payload.type || 'SYSTEM';
    const copy = getGenericPushCopy(type);
    const data: Record<string, string> = { type };
    if (payload.referenceId) {
      data.referenceId = payload.referenceId;
    }

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: copy.title,
        body: copy.body,
      },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'mindease_general',
        },
      },
    });

    const staleTokens: string[] = [];
    response.responses.forEach((res, idx) => {
      if (!res.success && res.error?.code) {
        if (INVALID_TOKEN_CODES.has(res.error.code)) {
          staleTokens.push(tokens[idx]);
        } else {
          console.error(`[FCM] Delivery failed code=${res.error.code}`);
        }
      }
    });

    if (staleTokens.length > 0) {
      await prisma.deviceToken.deleteMany({
        where: { token: { in: staleTokens } },
      });
    }
  } catch (error) {
    console.error(
      '[FCM] Unexpected push error:',
      error instanceof Error ? error.message : 'unknown error'
    );
  }
}
