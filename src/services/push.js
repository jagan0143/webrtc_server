import webpush from 'web-push';
import { env } from '../config/env.js';
import { PushSubscription } from '../models/PushSubscription.js';

const configured = Boolean(env.vapid.publicKey && env.vapid.privateKey);
if (configured) {
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
} else {
  console.warn('Push notifications disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable them.');
}

export const pushEnabled = () => configured;

const MAX_SUBSCRIPTIONS_PER_USER = 10;

// Only real browser push services, so a crafted "endpoint" can't make the server call arbitrary URLs.
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];

export function isValidEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      PUSH_HOST_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))
    );
  } catch {
    return false;
  }
}

export async function saveSubscription(userId, { endpoint, keys }, userAgent = '') {
  await PushSubscription.updateOne(
    { endpoint },
    { user: userId, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: userAgent.slice(0, 300) },
    { upsert: true }
  );
  // Keep only the most recent devices.
  const extra = await PushSubscription.find({ user: userId })
    .sort({ updatedAt: -1 })
    .skip(MAX_SUBSCRIPTIONS_PER_USER)
    .select('_id')
    .lean();
  if (extra.length) await PushSubscription.deleteMany({ _id: { $in: extra.map((s) => s._id) } });
}

export const removeSubscription = (userId, endpoint) => PushSubscription.deleteOne({ user: userId, endpoint });

export async function hasSubscriptions(userId) {
  if (!configured) return false;
  return Boolean(await PushSubscription.exists({ user: userId }));
}

/**
 * Sends a payload to every device of a user. Returns how many deliveries the push services accepted.
 * `topic` lets a newer message (e.g. "missed call") replace an undelivered older one for the same call.
 */
export async function sendToUser(userId, payload, { ttl = 60, urgency = 'normal', topic } = {}) {
  if (!configured) return 0;
  const subs = await PushSubscription.find({ user: userId }).lean();
  if (!subs.length) return 0;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
        TTL: ttl,
        urgency,
        ...(topic && { topic }),
      })
    )
  );

  const gone = [];
  let delivered = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') delivered += 1;
    else if (r.reason?.statusCode === 404 || r.reason?.statusCode === 410) gone.push(subs[i]._id);
    else console.warn(`Push to ${new URL(subs[i].endpoint).hostname} failed:`, r.reason?.statusCode || r.reason?.message);
  });
  if (gone.length) await PushSubscription.deleteMany({ _id: { $in: gone } });
  return delivered;
}
