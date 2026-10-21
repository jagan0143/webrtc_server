import { User } from '../models/User.js';
import { isOnline } from '../socket/presence.js';
import { asyncHandler, escapeRegex, toPublicUser } from '../utils/sanitize.js';

export const listUsers = asyncHandler(async (req, res) => {
  const search = String(req.query.search ?? '').trim().slice(0, 50);
  const filter = { _id: { $ne: req.userId } };
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };

  // Only the name is read from the database; mobile and email never leave it.
  const users = await User.find(filter).select('name').sort({ name: 1 }).limit(500).lean();
  const result = users
    .map((u) => toPublicUser(u, isOnline(u._id)))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  res.json({ users: result });
});
