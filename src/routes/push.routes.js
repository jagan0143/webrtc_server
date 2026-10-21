import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getConfig, rejectFromNotification, sendTest, subscribe, unsubscribe } from '../controllers/push.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const limiter = (limit) =>
  rateLimit({ windowMs: 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false });

router.get('/config', getConfig);
router.post('/subscribe', requireAuth, limiter(30), subscribe);
router.post('/unsubscribe', requireAuth, unsubscribe);
router.post('/test', requireAuth, limiter(5), sendTest);
router.post('/actions/reject', limiter(30), rejectFromNotification);

export default router;
