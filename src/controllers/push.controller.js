import { env } from '../config/env.js';
import { verifyCallActionToken } from '../middleware/auth.js';
import * as push from '../services/push.js';
import { rejectRingingCall } from '../socket/callHandlers.js';
import { asyncHandler } from '../utils/sanitize.js';

export const getConfig = (req, res) => {
  res.json({ enabled: push.pushEnabled(), publicKey: push.pushEnabled() ? env.vapid.publicKey : null });
};

export const subscribe = asyncHandler(async (req, res) => {
  if (!push.pushEnabled()) return res.status(503).json({ message: 'Notifications are not set up on the server' });
  const { endpoint, keys } = req.body?.subscription || {};
  if (
    typeof endpoint !== 'string' ||
    endpoint.length > 1000 ||
    !push.isValidEndpoint(endpoint) ||
    typeof keys?.p256dh !== 'string' ||
    typeof keys?.auth !== 'string' ||
    keys.p256dh.length > 200 ||
    keys.auth.length > 100
  ) {
    return res.status(400).json({ message: 'Invalid push subscription' });
  }
  await push.saveSubscription(req.userId, { endpoint, keys }, req.get('user-agent') || '');
  res.status(201).json({ ok: true });
});

export const unsubscribe = asyncHandler(async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === 'string') await push.removeSubscription(req.userId, endpoint);
  res.json({ ok: true });
});

export const sendTest = asyncHandler(async (req, res) => {
  const sent = await push.sendToUser(req.userId, { type: 'test' }, { ttl: 60 });
  if (!sent) return res.status(404).json({ message: 'No device is registered for notifications yet' });
  res.json({ sent });
});

// Decline button on an incoming-call notification. Authorised by the call-scoped token in the push payload.
export const rejectFromNotification = (req, res) => {
  const { callId, token } = req.body || {};
  let userId;
  try {
    userId = verifyCallActionToken(String(token), String(callId));
  } catch {
    return res.status(401).json({ message: 'Invalid or expired action' });
  }
  const ok = rejectRingingCall(req.app.get('io'), String(callId), userId);
  res.json({ ok });
};
