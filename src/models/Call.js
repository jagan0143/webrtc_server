import mongoose from 'mongoose';

export const CALL_STATUSES = ['ringing', 'ongoing', 'completed', 'missed', 'rejected', 'busy', 'failed'];

// Statuses that show up in the callee's "Missed" list.
export const MISSED_STATUSES = ['missed', 'busy'];

const callSchema = new mongoose.Schema(
  {
    caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    media: { type: String, enum: ['audio', 'video'], default: 'audio' },
    status: { type: String, enum: CALL_STATUSES, default: 'ringing' },
    startedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number, default: 0 },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    calleeSeen: { type: Boolean, default: false },
  },
  { timestamps: true }
);

callSchema.index({ caller: 1, createdAt: -1 });
callSchema.index({ callee: 1, createdAt: -1 });
callSchema.index({ callee: 1, status: 1, calleeSeen: 1 });

export const Call = mongoose.model('Call', callSchema);
