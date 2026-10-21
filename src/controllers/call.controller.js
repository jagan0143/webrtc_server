import { Call, MISSED_STATUSES } from '../models/Call.js';
import { isOnline } from '../socket/presence.js';
import { asyncHandler, toPublicUser } from '../utils/sanitize.js';

const PAGE_SIZE = 30;

const missedFilter = (userId) => ({ callee: userId, status: { $in: MISSED_STATUSES } });

export const listCalls = asyncHandler(async (req, res) => {
  const me = req.userId;
  const type = req.query.type === 'missed' ? 'missed' : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const filter =
    type === 'missed'
      ? missedFilter(me)
      : { $or: [{ caller: me }, { callee: me }], status: { $ne: 'ringing' } };

  const docs = await Call.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE + 1)
    .populate('caller', 'name')
    .populate('callee', 'name')
    .lean();

  const items = docs.slice(0, PAGE_SIZE).map((c) => {
    const outgoing = String(c.caller?._id) === me;
    const other = outgoing ? c.callee : c.caller;
    return {
      _id: String(c._id),
      direction: outgoing ? 'outgoing' : 'incoming',
      otherUser: other
        ? toPublicUser(other, isOnline(other._id))
        : { _id: null, name: 'Deleted user', online: false },
      media: c.media,
      status: c.status,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      durationSec: c.durationSec,
    };
  });

  res.json({ items, page, hasMore: docs.length > PAGE_SIZE });
});

export const missedCount = asyncHandler(async (req, res) => {
  const count = await Call.countDocuments({ ...missedFilter(req.userId), calleeSeen: false });
  res.json({ count });
});

export const markMissedSeen = asyncHandler(async (req, res) => {
  await Call.updateMany({ ...missedFilter(req.userId), calleeSeen: false }, { calleeSeen: true });
  res.json({ count: 0 });
});
