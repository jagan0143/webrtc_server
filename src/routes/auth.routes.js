import { Router } from 'express';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { login, me, register } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/error.js';
import { MOBILE_REGEX } from '../models/User.js';
import { normalizeMobile } from '../utils/sanitize.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again in a few minutes' },
});

const registerRules = [
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Name must be 2–50 characters'),
  body('mobile')
    .customSanitizer(normalizeMobile)
    .matches(MOBILE_REGEX)
    .withMessage('Enter a valid mobile number (10–15 digits)'),
  body('email').trim().toLowerCase().isEmail().withMessage('Enter a valid email address'),
  body('address')
    .trim()
    .isLength({ min: 3, max: 250 })
    .withMessage('Address must be 3–250 characters'),
  body('password')
    .isString()
    .isLength({ min: 6, max: 72 })
    .withMessage('Password must be 6–72 characters'),
];

const loginRules = [
  body('identifier').isString().trim().notEmpty().withMessage('Enter your email or mobile number'),
  body('password').isString().notEmpty().withMessage('Enter your password'),
];

router.post('/register', authLimiter, registerRules, validate, register);
router.post('/login', authLimiter, loginRules, validate, login);
router.get('/me', requireAuth, me);

export default router;
