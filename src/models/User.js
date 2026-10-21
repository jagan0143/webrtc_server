import mongoose from 'mongoose';

export const MOBILE_REGEX = /^\+?\d{10,15}$/;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    mobile: { type: String, required: true, unique: true, trim: true, match: MOBILE_REGEX },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    address: { type: String, required: true, trim: true, maxlength: 250 },
    passwordHash: { type: String, required: true, select: false },
    lastSeen: { type: Date },
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
