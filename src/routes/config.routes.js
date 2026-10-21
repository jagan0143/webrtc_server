import { Router } from 'express';
import { iceServers } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ICE servers come from the server so TURN credentials are never baked into the client bundle.
router.get('/ice', requireAuth, (req, res) => {
  res.json({ iceServers: iceServers() });
});

export default router;
