import { Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import jwt from 'jsonwebtoken';
import prisma from '../config/db';
import { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { AppError } from '../middlewares/errorMiddleware';
import { canReadMedia, inspectMedia, mediaRoot, parseMediaUrl } from '../services/mediaPolicy';

export async function mediaAccess(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!parseMediaUrl(url) || !await canReadMedia(url, req.user)) throw new AppError('Archivo no disponible', 404);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new AppError('Servicio no configurado', 503);
    // No userId claim: download tickets cannot be used as application authentication JWTs.
    const ticket = jwt.sign({ media: url }, secret, { algorithm: 'HS256', subject: req.user!.userId, audience: 'media-download', expiresIn: '60s' });
    res.set('Cache-Control', 'no-store').json({ status: 'success', data: { url: `${url}?access=${ticket}`, expiresIn: 60 } });
  } catch (error) { next(error); }
}

export async function downloadMedia(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const url = `/uploads/${req.params.scope}/${req.params.filename}`;
    const parsed = parseMediaUrl(url);
    if (!parsed) throw new AppError('Archivo no disponible', 404);
    if (typeof req.query.access === 'string' && process.env.JWT_SECRET) {
      try {
        const ticket = jwt.verify(req.query.access, process.env.JWT_SECRET, { algorithms: ['HS256'], audience: 'media-download' });
        if (typeof ticket !== 'string' && ticket.media === url && ticket.sub) {
          const user = await prisma.user.findUnique({ where: { id: ticket.sub }, include: { userRoles: { include: { role: true } } } });
          if (user?.status === 'ACTIVE') req.user = { userId: user.id, roles: user.userRoles.map(ur => ur.role.name) };
        }
      } catch { /* Expired or forged ticket grants no additional access. */ }
    }
    if (!await canReadMedia(url, req.user)) throw new AppError('Archivo no disponible', 404);
    const asset = await prisma.mediaAsset.findUnique({ where: { filename: parsed.filename } });
    const target = asset ? path.join(mediaRoot(), parsed.scope, parsed.filename) : path.join(process.cwd(), 'uploads', parsed.scope, parsed.filename);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile() || stat.size > 10 * 1024 * 1024) throw new AppError('Archivo no disponible', 404);
    const bytes = await fs.readFile(target);
    const ext = path.extname(parsed.filename);
    const mime = asset?.mimeType || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' } as Record<string, string>)[ext];
    inspectMedia(bytes, parsed.filename, mime);
    res.set({ 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${parsed.filename}"` });
    res.send(bytes);
  } catch (error) { next(error); }
}
