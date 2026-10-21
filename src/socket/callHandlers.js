import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { Call } from '../models/Call.js';
import { User } from '../models/User.js';
import { toPublicUser } from '../utils/sanitize.js';
import * as presence from './presence.js';

/**
 * Live call sessions, keyed by callId. The server owns the call record:
 * clients only ask for state changes, and the database is updated here.
 *
 * session = { callId, callerId, calleeId, callerName, media, state: 'ringing'|'ongoing',
 *             callerSocketId, calleeSocketId, answeredAt, timer }
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
function finishSession(callId, status, endedBy) {
  const s = sessions.get(callId);
  if (!s) return null;
  sessions.delete(callId);
  clearTimeout(s.timer);
  presence.clearActiveCall(s.callerId, callId);
  presence.clearActiveCall(s.calleeId, callId);

  const endedAt = new Date();
  const durationSec = s.answeredAt ? Math.max(0, Math.round((endedAt - s.answeredAt) / 1000)) : 0;
  saveCall(callId, { status, endedAt, durationSec, ...(endedBy && { endedBy }) });
  return s;
}

const fromCaller = (s) => toPublicUser({ _id: s.callerId, name: s.callerName }, true);

// Caller hung up before answer, or caller's socket went away while ringing.
function cancelRinging(io, s, endedBy) {
  if (!finishSession(s.callId, 'missed', endedBy)) return;
  io.to(userRoom(s.calleeId)).emit('call:missed', { callId: s.callId, from: fromCaller(s) });
}

// Ongoing call ended by one side (hang-up, failure or disconnect).
function endOngoing(io, s, bySocketId, byUserId, status = 'completed') {
  if (!finishSession(s.callId, status, byUserId)) return;
  const other = bySocketId === s.callerSocketId ? s.calleeSocketId : s.callerSocketId;
  if (other) io.to(other).emit('call:ended', { callId: s.callId, status });
}

export function registerCallHandlers(io, socket) {
  const me = socket.data.user; // { id, name }

  socket.on('call:initiate', async (payload, ack = noop) => {
    try {
      const calleeId = String(payload?.calleeId ?? '');
      const media = payload?.media === 'video' ? 'video' : 'audio';

      if (!mongoose.isValidObjectId(calleeId) || calleeId === me.id) return ack({ error: 'Invalid user' });
      if (presence.getActiveCall(me.id)) return ack({ error: 'You are already on a call' });

      const callee = await User.findById(calleeId).select('name').lean();
      if (!callee) return ack({ error: 'User not found' });

      // Re-check after the await, then reserve both users synchronously so
      // two simultaneous calls can't both get through.
      if (presence.getActiveCall(me.id)) return ack({ error: 'You are already on a call' });
      const calleeOnline = presence.isOnline(calleeId);
      const calleeBusy = Boolean(presence.getActiveCall(calleeId));
      const status = !calleeOnline ? 'missed' : calleeBusy ? 'busy' : 'ringing';
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
        answeredAt: null,
        timer: null,
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

      session.timer = setTimeout(() => {
        const s = sessions.get(callId);
        if (!s || s.state !== 'ringing') return;
        finishSession(callId, 'missed');
        io.to(userRoom(s.calleeId)).emit('call:missed', { callId, from: fromCaller(s) });
        io.to(s.callerSocketId).emit('call:no-answer', { callId });
      }, env.ringTimeoutMs);

      io.to(userRoom(calleeId)).emit('call:incoming', { callId, from: fromCaller(session), media });
      ack({ callId, status: 'ringing', ringTimeoutMs: env.ringTimeoutMs });
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
    if (!s || s.calleeId !== me.id || s.state !== 'ringing') return ack({ ok: true });
    finishSession(s.callId, 'rejected', me.id);
    io.to(s.callerSocketId).emit('call:rejected', { callId: s.callId });
    socket.to(userRoom(me.id)).emit('call:dismissed', { callId: s.callId });
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
      else if (s.calleeId === me.id) {
        finishSession(s.callId, 'rejected', me.id);
        io.to(s.callerSocketId).emit('call:rejected', { callId: s.callId });
        socket.to(userRoom(me.id)).emit('call:dismissed', { callId: s.callId });
      }
    } else if (socket.id === s.callerSocketId || socket.id === s.calleeSocketId) {
      endOngoing(io, s, socket.id, me.id, payload?.reason === 'failed' ? 'failed' : 'completed');
    }
    ack({ ok: true });
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

/** Called after the socket has been removed from presence. */
export function handleCallDisconnect(io, socket) {
  const me = socket.data.user;
  for (const s of [...sessions.values()]) {
    if (s.callerSocketId === socket.id) {
      if (s.state === 'ringing') cancelRinging(io, s, me.id);
      else endOngoing(io, s, socket.id, me.id);
    } else if (s.calleeSocketId === socket.id && s.state === 'ongoing') {
      endOngoing(io, s, socket.id, me.id);
    } else if (s.calleeId === me.id && s.state === 'ringing' && !presence.isOnline(me.id)) {
      // Every device of the callee went away while it was ringing.
      if (finishSession(s.callId, 'missed')) io.to(s.callerSocketId).emit('call:no-answer', { callId: s.callId });
    }
  }
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
