import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import prisma from '../config/db';
import { AppError } from '../middlewares/errorMiddleware';
import { TokenPayload } from '../utils/jwt';

export type MediaScope = 'community' | 'support';
export const mediaRoot = () => path.resolve(process.env.MEDIA_STORAGE_ROOT || path.join(process.cwd(), 'storage', 'media'));
const formats = {
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'],
  'image/webp': ['.webp'], 'application/pdf': ['.pdf'],
};
export function inspectMedia(bytes: Buffer, filename: string, declaredMime: string) {
  let mime: keyof typeof formats | undefined;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') mime = 'image/png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (bytes.length >= 8 && bytes.toString('ascii', 0, 5) === '%PDF-' && bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) mime = 'application/pdf';
  if (!mime || mime !== declaredMime || !formats[mime].includes(path.extname(filename).toLowerCase())) {
    throw new AppError('El contenido, extension y tipo del archivo no coinciden. Usa una imagen o PDF valido.', 400);
  }
  return { mimeType: mime, extension: formats[mime][0] };
}

export async function saveMedia(file: Express.Multer.File, ownerId: string, scope: MediaScope) {
  const format = inspectMedia(file.buffer, file.originalname, file.mimetype);
  const filename = `${crypto.randomUUID()}${format.extension}`;
  const dir = path.join(mediaRoot(), scope);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, filename);
  await fs.writeFile(target, file.buffer, { flag: 'wx' });
  try {
    await prisma.mediaAsset.create({ data: { filename, ownerId, scope, mimeType: format.mimeType, sizeBytes: file.size } });
  } catch (error) { await fs.unlink(target); throw error; }
  return `/uploads/${scope}/${filename}`;
}

export function parseMediaUrl(url: string): { scope: MediaScope; filename: string } | null {
  const match = /^\/uploads\/(community|support)\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|gif|webp|pdf))$/.exec(url);
  return match ? { scope: match[1] as MediaScope, filename: match[2] } : null;
}

export async function canReadMedia(url: string, user?: TokenPayload): Promise<boolean> {
  const parsed = parseMediaUrl(url);
  if (!parsed) return false;
  const communityStaff = !!user?.roles.some(r => ['ADMIN', 'SUPERADMIN', 'MODERATOR'].includes(r));
  const supportStaff = !!user?.roles.some(r => ['ADMIN', 'SUPERADMIN', 'SUPPORT'].includes(r));
  if (parsed.scope === 'community') {
    const publicPost = await prisma.postMedia.findFirst({ where: { OR: [{ url }, { thumbnailUrl: url }], post: { status: 'PUBLISHED', channel: { isActive: true } } }, select: { id: true } });
    const publicCover = await prisma.communityChannel.findFirst({ where: { coverImageUrl: url, isActive: true }, select: { id: true } });
    if (publicPost || publicCover) return true;
  }
  if (!user) return false;
  if (parsed.scope === 'community' ? communityStaff : supportStaff) return true;
  const asset = await prisma.mediaAsset.findUnique({ where: { filename: parsed.filename } });
  if (asset?.scope === parsed.scope && asset.ownerId === user.userId) return true;
  if (parsed.scope === 'community') {
    return !!(await prisma.postMedia.findFirst({ where: { OR: [{ url }, { thumbnailUrl: url }], post: { authorId: user.userId } }, select: { id: true } })) ||
      !!(await prisma.communityChannel.findFirst({ where: { coverImageUrl: url, psychologist: { userId: user.userId } }, select: { id: true } }));
  }
  return !!(await prisma.ticketMessage.findFirst({ where: { attachments: { has: url }, isInternalNote: false, ticket: { userId: user.userId } }, select: { id: true } })) ||
    !!(await prisma.userReport.findFirst({ where: { evidenceUrls: { has: url }, reporterId: user.userId }, select: { id: true } }));
}

// Prevent a user from attaching someone else's private upload to public content.
export async function validateMediaReferences(urls: (string | null | undefined)[], ownerId: string, scope: MediaScope) {
  for (const url of urls.filter((v): v is string => !!v)) {
    const parsed = parseMediaUrl(url);
    if (!parsed) {
      // External educational resources remain supported, never treated as owned storage.
      let external: URL;
      try { external = new URL(url); } catch { throw new AppError('Referencia de archivo invalida', 400); }
      if (scope !== 'community' || !['https:', 'http:'].includes(external.protocol) || external.username || external.password || external.pathname.startsWith('/uploads/')) throw new AppError('Sube el adjunto desde esta cuenta; no se permiten referencias privadas ajenas', 400);
      continue;
    }
    if (parsed.scope !== scope) throw new AppError('No puedes publicar archivos de otro modulo', 400);
    const asset = await prisma.mediaAsset.findUnique({ where: { filename: parsed.filename } });
    if (asset) {
      if (asset.ownerId !== ownerId || asset.scope !== scope) throw new AppError('El archivo pertenece a otra cuenta', 403);
    } else {
      // Legacy files have no owner record. Only keep references already owned by this user.
      const own = scope === 'community'
        ? await prisma.postMedia.findFirst({ where: { url, post: { authorId: ownerId } }, select: { id: true } })
        : await prisma.ticketMessage.findFirst({ where: { attachments: { has: url }, senderId: ownerId }, select: { id: true } });
      const cover = scope === 'community' && await prisma.communityChannel.findFirst({ where: { coverImageUrl: url, psychologist: { userId: ownerId } }, select: { id: true } });
      if (!own && !cover) throw new AppError('Archivo antiguo sin propietario verificable: vuelve a subirlo', 403);
    }
  }
}
