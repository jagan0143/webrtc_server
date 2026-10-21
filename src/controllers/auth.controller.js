import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { signToken } from '../middleware/auth.js';
import { asyncHandler, normalizeMobile, toPublicUser, toSelfUser } from '../utils/sanitize.js';

export const register = asyncHandler(async (req, res) => {
  const { name, mobile, email, address, password } = req.body;

  const clashes = await User.find({ $or: [{ email }, { mobile }] }).select('email mobile').lean();
  if (clashes.length) {
    const errors = {};
    if (clashes.some((u) => u.email === email)) errors.email = 'Email is already registered';
    if (clashes.some((u) => u.mobile === mobile)) errors.mobile = 'Mobile number is already registered';
    return res.status(409).json({ message: 'An account with these details already exists', errors });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, mobile, email, address, passwordHash });

  // Let everyone who is online see the new contact straight away.
  req.app.get('io')?.emit('user:new', toPublicUser(user, false));

  res.status(201).json({ token: signToken(user._id), user: toSelfUser(user) });
});

export const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const query = identifier.includes('@')
    ? { email: identifier.toLowerCase() }
    : { mobile: normalizeMobile(identifier) };

  const user = await User.findOne(query).select('+passwordHash');
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ message: 'Incorrect email/mobile or password' });

  res.json({ token: signToken(user._id), user: toSelfUser(user) });
});

export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ message: 'Account not found' });
  res.json({ user: toSelfUser(user) });
});
