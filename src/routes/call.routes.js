import { Router } from 'express';
import { listCalls, markMissedSeen, missedCount } from '../controllers/call.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
router.get('/', listCalls);
router.get('/missed/count', missedCount);
router.patch('/missed/seen', markMissedSeen);

export default router;
