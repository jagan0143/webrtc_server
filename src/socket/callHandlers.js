import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { signCallActionToken } from '../middleware/auth.js';
import { Call } from '../models/Call.js';
import { User } from '../models/User.js';
import * as push from '../services/push.js';
import { toPublicUser } from '../utils/sanitize.js';
import * as presence from './presence.js';

/**
 * Live call sessions, keyed by callId. The server owns the call record:
 * clients only ask for state changes, and the database is updated here.
 *
 * session = { callId, callerId, calleeId, callerName, media, state: 'ringing'|'ongoing',
 *             callerSocketId, calleeSocketId, startedAt, answeredAt,
 *             calleeHasPush, pushed, timer, graceTimer, disconnectedAt }
 *
 * A socket id of null on an ongoing call means that side's connection dropped and
 * we're inside the reconnect grace period (see startGrace / call:rejoin).
 */
const sessions = new Map();

export const userRoom = (userId) => `user:${userId}`;

const noop = () => {};

function saveCall(callId, update) {
  Call.updateOne({ _id: callId }, update).catch((err) =>
    console.error(`Failed to update call ${callId}:`, err.message)
  );
}

/** Removes a session and writes its final state. Returns the session, or null if already finished. */
function finishSession(callId, status, endedBy, endedAt = new Date()) {
  const s = sessions.get(callId);
  if (!s) return null;
  sessions.delete(callId);
  clearTimeout(s.timer);
  clearTimeout(s.graceTimer);
  presence.clearActiveCall(s.callerId, callId);
  presence.clearActiveCall(s.calleeId, callId);

  const durationSec = s.answeredAt ? Math.max(0, Math.round((endedAt - s.answeredAt) / 1000)) : 0;
  saveCall(callId, { status, endedAt, durationSec, ...(endedBy && { endedBy }) });
  return s;
}

const fromCaller = (s) => toPublicUser({ _id: s.callerId, name: s.callerName }, true);

const incomingPayload = (s) => ({ callId: s.callId, from: fromCaller(s), media: s.media });

// ---------- push notifications ----------

function sendPush(userId, payload, options) {
  push.sendToUser(userId, payload, options).catch((err) => console.error('Push failed:', err.message));
}

function armRingTimer(io, s, ms) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (sessions.get(s.callId) !== s || s.state !== 'ringing') return;
    finishSession(s.callId, 'missed');
    io.to(userRoom(s.calleeId)).emit('call:missed', { callId: s.callId, from: fromCaller(s) });
    io.to(s.callerSocketId).emit('call:no-answer', { callId: s.callId });
    pushMissed(s);
  }, Math.max(ms, 0));
}

/** Wake the callee's phone. Ringing is extended because opening the app from a notification takes time. */
function pushIncoming(io, s) {
  if (s.pushed || !s.calleeHasPush || s.state !== 'ringing') return;
  s.pushed = true;
  sendPush(
    s.calleeId,
    {
      type: 'incoming-call',
      ...incomingPayload(s),
      actionToken: signCallActionToken(s.calleeId, s.callId),
    },
    { ttl: Math.ceil(env.pushRingTimeoutMs / 1000), urgency: 'high', topic: s.callId }
  );
  const elapsed = Date.now() - s.startedAt;
  armRingTimer(io, s, Math.max(env.pushRingTimeoutMs - elapsed, 15_000));
}

/** Replaces the "X is calling" notification with "Missed call from X". */
function pushMissed(s) {
  if (!s.pushed) return;
  sendPush(s.calleeId, { type: 'missed-call', ...incomingPayload(s) }, { ttl: 24 * 3600, topic: s.callId });
}

// ---------- endings ----------

// Caller hung up before answer, or caller's socket went away while ringing.
function cancelRinging(io, s, endedBy) {
  if (!finishSession(s.callId, 'missed', endedBy)) return;
  io.to(userRoom(s.calleeId)).emit('call:missed', { callId: s.callId, from: fromCaller(s) });
  pushMissed(s);
}

function rejectRinging(io, s, byUserId, exceptSocket) {
  if (!finishSession(s.callId, 'rejected', byUserId)) return;
  io.to(s.callerSocketId).emit('call:rejected', { callId: s.callId });
  const others = io.to(userRoom(byUserId));
  (exceptSocket ? others.except(exceptSocket.id) : others).emit('call:dismissed', { callId: s.callId });
}

// Ongoing call ended by one side (hang-up, failure, or reconnect grace expired).
function endOngoing(io, s, byUserId, status = 'completed', endedAt) {
  if (!finishSession(s.callId, status, byUserId, endedAt)) return;
  const other = byUserId === s.callerId ? s.calleeSocketId : s.callerSocketId;
  if (other) io.to(other).emit('call:ended', { callId: s.callId, status });
}

/** One side of an ongoing call lost its connection: wait a little before ending the call. */
function startGrace(io, s, role) {
  if (role === 'caller') s.callerSocketId = null;
  else s.calleeSocketId = null;
  const byUserId = role === 'caller' ? s.callerId : s.calleeId;

  if (!s.callerSocketId && !s.calleeSocketId) return endOngoing(io, s, byUserId);

  s.disconnectedAt = new Date();
  io.to(s.callerSocketId || s.calleeSocketId).emit('call:peer-reconnecting', { callId: s.callId });
  clearTimeout(s.graceTimer);
  s.graceTimer = setTimeout(
    () => endOngoing(io, s, byUserId, 'completed', s.disconnectedAt),
    env.callReconnectGraceMs
  );
  return undefined;
}

// ---------- socket handlers ----------

export function registerCallHandlers(io, socket) {
  const me = socket.data.user; // { id, name }

  socket.on('call:initiate', async (payload, ack = noop) => {
    try {
      const calleeId = String(payload?.calleeId ?? '');
      const media = payload?.media === 'video' ? 'video' : 'audio';

      if (!mongoose.isValidObjectId(calleeId) || calleeId === me.id) return ack({ error: 'Invalid user' });
      if (presence.getActiveCall(me.id)) return ack({ error: 'You are already on a call' });

      const [callee, calleeHasPush] = await Promise.all([
        User.findById(calleeId).select('name').lean(),
        push.hasSubscriptions(calleeId),
      ]);
      if (!callee) return ack({ error: 'User not found' });

      // Re-check after the await, then reserve both users synchronously so
      // two simultaneous calls can't both get through.
      if (presence.getActiveCall(me.id)) return ack({ error: 'You are already on a call' });
      const calleeOnline = presence.isOnline(calleeId);
      const calleeBusy = Boolean(presence.getActiveCall(calleeId));
      const reachable = calleeOnline || calleeHasPush;
      const status = calleeBusy ? 'busy' : !reachable ? 'missed' : 'ringing';
      const callId = new mongoose.Types.ObjectId().toString();
      const now = new Date();

      if (status !== 'ringing') {
        await Call.create({ _id: callId, caller: me.id, callee: calleeId, media, status, startedAt: now, endedAt: now });
        if (status === 'busy') {
          io.to(userRoom(calleeId)).emit('call:missed', {
            callId,
            from: toPublicUser({ _id: me.id, name: me.name }, true),
          });
        }
        return ack({ callId, status: status === 'busy' ? 'busy' : 'unavailable' });
      }

      presence.setActiveCall(me.id, callId);
      presence.setActiveCall(calleeId, callId);
      const session = {
        callId,
        callerId: me.id,
        calleeId,
        callerName: me.name,
        media,
        state: 'ringing',
        callerSocketId: socket.id,
        calleeSocketId: null,
        startedAt: now.getTime(),
        answeredAt: null,
        calleeHasPush,
        pushed: false,
        timer: null,
        graceTimer: null,
        disconnectedAt: null,
      };
      sessions.set(callId, session);

      try {
        await Call.create({ _id: callId, caller: me.id, callee: calleeId, media, status: 'ringing', startedAt: now });
      } catch (err) {
        sessions.delete(callId);
        presence.clearActiveCall(me.id, callId);
        presence.clearActiveCall(calleeId, callId);
        throw err;
      }

      // The caller dropped while we were writing; its update may have run before the insert.
      if (!sessions.has(callId)) {
        saveCall(callId, { status: 'missed', endedAt: new Date() });
        return ack({ error: 'Call cancelled' });
      }

      armRingTimer(io, session, env.ringTimeoutMs);
      io.to(userRoom(calleeId)).emit('call:incoming', incomingPayload(session));
      // App closed or not on screen: wake the phone with a notification.
      if (!presence.isVisible(calleeId)) pushIncoming(io, session);

      ack({ callId, status: 'ringing' });
    } catch (err) {
      console.error('call:initiate failed:', err);
      ack({ error: 'Could not start the call. Please try again.' });
    }
  });

  socket.on('call:accept', (payload, ack = noop) => {
    const s = sessions.get(payload?.callId);
    if (!s || s.calleeId !== me.id || s.state !== 'ringing') {
      return ack({ error: 'This call is no longer available' });
    }
    clearTimeout(s.timer);
    s.state = 'ongoing';
    s.answeredAt = new Date();
    s.calleeSocketId = socket.id;
    saveCall(s.callId, { status: 'ongoing', answeredAt: s.answeredAt });

    io.to(s.callerSocketId).emit('call:accepted', { callId: s.callId, video: Boolean(payload?.video) });
    socket.to(userRoom(me.id)).emit('call:dismissed', { callId: s.callId }); // other tabs stop ringing
    ack({ ok: true });
  });

  socket.on('call:reject', (payload, ack = noop) => {
    const s = sessions.get(payload?.callId);
    if (s && s.calleeId === me.id && s.state === 'ringing') rejectRinging(io, s, me.id, socket);
    ack({ ok: true });
  });

  socket.on('call:cancel', (payload, ack = noop) => {
    const s = sessions.get(payload?.callId);
    if (s && s.callerSocketId === socket.id && s.state === 'ringing') cancelRinging(io, s, me.id);
    ack({ ok: true });
  });

  socket.on('call:end', (payload, ack = noop) => {
    const s = sessions.get(payload?.callId);
    if (!s) return ack({ ok: true });

    if (s.state === 'ringing') {
      // Hang-up before the call was answered.
      if (s.callerSocketId === socket.id) cancelRinging(io, s, me.id);
      else if (s.calleeId === me.id) rejectRinging(io, s, me.id, socket);
    } else if (socket.id === s.callerSocketId || socket.id === s.calleeSocketId) {
      endOngoing(io, s, me.id, payload?.reason === 'failed' ? 'failed' : 'completed');
    }
    ack({ ok: true });
  });

  /**
   * A client asks about a call it knows about, after (re)connecting or after being opened
   * from a notification. Re-attaches a dropped side of an ongoing call, and re-sends
   * call:incoming for a call that is still ringing.
   */
  socket.on('call:rejoin', (payload, ack = noop) => {
    const s = sessions.get(payload?.callId);
    if (!s) return ack({ state: null });

    if (s.state === 'ringing') {
      if (s.calleeId === me.id) {
        socket.emit('call:incoming', incomingPayload(s));
        return ack({ state: 'ringing', role: 'callee' });
      }
      return ack({ state: s.callerSocketId === socket.id ? 'ringing' : null, role: 'caller' });
    }

    const role = s.callerId === me.id ? 'caller' : s.calleeId === me.id ? 'callee' : null;
    if (!role) return ack({ state: null });
    const key = role === 'caller' ? 'callerSocketId' : 'calleeSocketId';
    if (s[key] && s[key] !== socket.id) return ack({ state: null }); // another tab owns this call

    if (!s[key]) {
      s[key] = socket.id;
      clearTimeout(s.graceTimer);
      s.graceTimer = null;
      s.disconnectedAt = null;
      const other = role === 'caller' ? s.calleeSocketId : s.callerSocketId;
      if (other) io.to(other).emit('call:peer-resumed', { callId: s.callId });
    }
    return ack({ state: 'ongoing', role });
  });

  socket.on('client:visibility', (payload) => {
    presence.setVisible(socket.id, Boolean(payload?.visible));
    if (presence.isVisible(me.id)) return;
    // The callee just put the app in the background while it was ringing.
    for (const s of sessions.values()) {
      if (s.calleeId === me.id && s.state === 'ringing') pushIncoming(io, s);
    }
  });

  // Pure relays between the two sockets in an ongoing call.
  for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice', 'call:media-toggle']) {
    socket.on(event, (payload) => {
      const s = sessions.get(payload?.callId);
      if (!s || s.state !== 'ongoing') return;
      const target =
        socket.id === s.callerSocketId ? s.calleeSocketId : socket.id === s.calleeSocketId ? s.callerSocketId : null;
      if (target) io.to(target).emit(event, payload);
    });
  }
}

/** A newly connected socket gets any call that is still ringing for this user. */
export function deliverPendingCalls(socket) {
  const me = socket.data.user;
  for (const s of sessions.values()) {
    if (s.calleeId === me.id && s.state === 'ringing') socket.emit('call:incoming', incomingPayload(s));
  }
}

/** Called after the socket has been removed from presence. */
export function handleCallDisconnect(io, socket) {
  const me = socket.data.user;
  for (const s of [...sessions.values()]) {
    if (s.state === 'ringing') {
      if (s.callerSocketId === socket.id) {
        cancelRinging(io, s, me.id);
      } else if (s.calleeId === me.id && !presence.isOnline(me.id)) {
        // Every device of the callee went away while it was ringing.
        if (s.calleeHasPush) pushIncoming(io, s);
        else if (finishSession(s.callId, 'missed')) io.to(s.callerSocketId).emit('call:no-answer', { callId: s.callId });
      }
    } else if (s.callerSocketId === socket.id) {
      startGrace(io, s, 'caller');
    } else if (s.calleeSocketId === socket.id) {
      startGrace(io, s, 'callee');
    }
  }
}

/** Decline from a notification button (no socket involved). Returns false if the call isn't ringing. */
export function rejectRingingCall(io, callId, userId) {
  const s = sessions.get(callId);
  if (!s || s.calleeId !== userId || s.state !== 'ringing') return false;
  rejectRinging(io, s, userId);
  return true;
}

/** Run at startup: no session survives a restart, so close out anything left open. */
export async function closeStaleCalls() {
  const now = new Date();
  const [ringing, ongoing] = await Promise.all([
    Call.updateMany({ status: 'ringing' }, { status: 'missed', endedAt: now }),
    Call.updateMany({ status: 'ongoing' }, { status: 'failed', endedAt: now }),
  ]);
  const n = ringing.modifiedCount + ongoing.modifiedCount;
  if (n) console.log(`Closed ${n} call(s) left open by a previous run`);
}
