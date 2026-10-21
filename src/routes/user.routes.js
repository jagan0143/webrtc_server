import { Router } from 'express';
import { listUsers } from '../controllers/user.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, listUsers);

export default router;
