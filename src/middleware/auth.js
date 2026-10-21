import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

export function verifyToken(token) {
  const payload = jwt.verify(token, env.jwtSecret);
  // Single-purpose tokens (e.g. "decline this call" from a notification) are never login sessions.
  if (payload.act) throw new Error('Not a session token');
  return payload.sub;
}

/** Short-lived token that lets a notification's Decline button reject one specific call. */
export function signCallActionToken(userId, callId) {
  return jwt.sign({ sub: String(userId), callId, act: 'reject-call' }, env.jwtSecret, { expiresIn: '3m' });
}

export function verifyCallActionToken(token, callId) {
  const payload = jwt.verify(token, env.jwtSecret);
  if (payload.act !== 'reject-call' || payload.callId !== callId) throw new Error('Wrong token');
  return payload.sub;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Not logged in' });
  try {
    req.userId = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ message: 'Session expired, please log in again' });
  }
}
