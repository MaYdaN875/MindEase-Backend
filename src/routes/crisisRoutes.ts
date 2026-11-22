import { Router } from 'express';
import { z } from 'zod';
import { AISafetyService } from '../ai/services/aiSafetyService';
import { CrisisProtocolService } from '../services/crisisProtocolService';

const router = Router();

// Public by design: crisis resources must remain reachable even if a session expires.
router.get('/resources', async (req, res, next) => {
  try {
    const country = z.string().regex(/^[A-Za-z]{2}$/).optional().parse(req.query.country)?.toUpperCase() || 'MX';
    const resources = await AISafetyService.getCrisisResources(country);
    res.set('Cache-Control', 'no-store').json({ status: 'success', data: { notice: CrisisProtocolService.publicNotice, resources } });
  } catch (error) { next(error); }
});

export default router;
