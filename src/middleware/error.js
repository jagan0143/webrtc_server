import { validationResult } from 'express-validator';

// Turns express-validator results into { message, errors: { field: msg } }.
export function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  const errors = {};
  for (const e of result.array()) errors[e.path] ??= e.msg;
  res.status(400).json({ message: 'Please fix the highlighted fields', errors });
}

export function notFound(req, res) {
  res.status(404).json({ message: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0];
    const label = field === 'email' ? 'Email' : 'Mobile number';
    return res.status(409).json({
      message: 'An account with these details already exists',
      errors: field ? { [field]: `${label} is already registered` } : undefined,
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }
  console.error(err);
  res.status(err.status || 500).json({ message: err.expose ? err.message : 'Internal server error' });
}
