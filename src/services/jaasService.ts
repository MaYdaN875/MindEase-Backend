import { createHash, createPrivateKey } from 'crypto';
import jwt from 'jsonwebtoken';
import { AppError } from '../middlewares/errorMiddleware';

export function jaasConfiguration() {
  const appId = process.env.JAAS_APP_ID || '';
  const keyId = process.env.JAAS_KEY_ID || '';
  const pem = (process.env.JAAS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (process.env.JAAS_ENABLED !== 'true' || process.env.JAAS_AUTH_REQUIRED_CONFIRMED !== 'true' ||
      !/^vpaas-magic-cookie-[a-f0-9]+$/.test(appId) || !keyId.startsWith(appId + '/') || !pem) {
    throw new AppError('Videollamada no disponible: falta configurar JaaS y su autenticación obligatoria', 503);
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Invalid key');
    return { appId, keyId, key };
  } catch { throw new AppError('Configuración de firma JaaS inválida', 503); }
}

export function createJaasSession(appointmentId: string, userId: string, professional: boolean, endAt: Date) {
  const { appId, keyId, key } = jaasConfiguration();
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + 300, Math.floor(endAt.getTime() / 1000));
  if (exp <= now) throw new AppError('El horario de la consulta ha terminado', 409);
  const room = 'mindease' + createHash('sha256').update(appId + ':' + appointmentId).digest('hex');
  const participant = createHash('sha256').update(appId + ':' + appointmentId + ':' + userId).digest('hex');
  const token = jwt.sign({
    aud: 'jitsi', iss: 'chat', sub: appId, room, nbf: now - 10, exp,
    context: { room: { regex: false }, user: { id: participant, name: professional ? 'Profesional' : 'Paciente', moderator: professional ? 'true' : 'false' },
      features: { recording: false, livestreaming: false, transcription: false, 'outbound-call': false, 'inbound-call': false, 'sip-inbound-call': false, 'sip-outbound-call': false, 'file-upload': false } },
  }, key, { algorithm: 'RS256', keyid: keyId });
  return { serverUrl: 'https://8x8.vc', room: `${appId}/${room}`, token, expiresAt: new Date(exp * 1000).toISOString(), displayName: professional ? 'Profesional' : 'Paciente' };
}
