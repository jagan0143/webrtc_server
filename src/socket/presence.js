// In-memory presence. Works for a single server process; use the Socket.IO
// Redis adapter + a shared store if this ever runs on several instances.

const socketsByUser = new Map(); // userId -> Set<socketId>
const visibleSockets = new Set(); // socketIds whose app is currently on screen
const activeCallByUser = new Map(); // userId -> callId (ringing or ongoing)

/** Returns true if this is the user's first socket (they just came online). */
export function addSocket(userId, socketId, visible = true) {
  const first = !socketsByUser.has(userId);
  if (first) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(socketId);
  setVisible(socketId, visible);
  return first;
}

/** Returns true if this was the user's last socket (they just went offline). */
export function removeSocket(userId, socketId) {
  visibleSockets.delete(socketId);
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size) return false;
  socketsByUser.delete(userId);
  return true;
}

export function setVisible(socketId, visible) {
  if (visible) visibleSockets.add(socketId);
  else visibleSockets.delete(socketId);
}

export const isOnline = (userId) => socketsByUser.has(String(userId));

/** True if the user has the app open and on screen on at least one device. */
export function isVisible(userId) {
  const set = socketsByUser.get(String(userId));
  return Boolean(set && [...set].some((id) => visibleSockets.has(id)));
}

export const getActiveCall = (userId) => activeCallByUser.get(String(userId)) ?? null;

export const setActiveCall = (userId, callId) => activeCallByUser.set(String(userId), callId);

export function clearActiveCall(userId, callId) {
  if (activeCallByUser.get(String(userId)) === callId) activeCallByUser.delete(String(userId));
}
