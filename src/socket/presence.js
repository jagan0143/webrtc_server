// In-memory presence. Works for a single server process; use the Socket.IO
// Redis adapter + a shared store if this ever runs on several instances.

const socketsByUser = new Map(); // userId -> Set<socketId>
const activeCallByUser = new Map(); // userId -> callId (ringing or ongoing)

/** Returns true if this is the user's first socket (they just came online). */
export function addSocket(userId, socketId) {
  let set = socketsByUser.get(userId);
  const first = !set;
  if (!set) socketsByUser.set(userId, (set = new Set()));
  set.add(socketId);
  return first;
}

/** Returns true if this was the user's last socket (they just went offline). */
export function removeSocket(userId, socketId) {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size) return false;
  socketsByUser.delete(userId);
  return true;
}

export const isOnline = (userId) => socketsByUser.has(String(userId));

export const getActiveCall = (userId) => activeCallByUser.get(String(userId)) ?? null;

export const setActiveCall = (userId, callId) => activeCallByUser.set(String(userId), callId);

export function clearActiveCall(userId, callId) {
  if (activeCallByUser.get(String(userId)) === callId) activeCallByUser.delete(String(userId));
}
