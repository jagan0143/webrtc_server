// The only shape of another user that ever leaves the server.
// Mobile number and email are deliberately never included.
export function toPublicUser(user, online = false) {
  if (!user) return null;
  return { _id: String(user._id), name: user.name, online: Boolean(online) };
}

// The logged-in user's own profile (only returned to themselves).
export function toSelfUser(user) {
  return {
    _id: String(user._id),
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    address: user.address,
    createdAt: user.createdAt,
  };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizeMobile = (value) => String(value ?? '').replace(/[\s\-().]/g, '');

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
