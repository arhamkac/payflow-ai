const mongoose = require("mongoose");

const checkoutAttemptSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementProject", required: true, index: true },
  approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval", required: true, index: true },
  clientIdempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
  requestHash: { type: String, required: true },
  reservationId: { type: mongoose.Schema.Types.ObjectId, ref: "Reservation", required: true },
  paypalOrderId: { type: String, index: true },
  captureId: { type: String, index: true },
  expectedAmountMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  currency: { type: String, enum: ["USD"], required: true },
  executionState: {
    type: String,
    enum: ["RESERVED", "ORDER_CREATING", "APPROVAL_PENDING", "APPROVED", "CAPTURE_PENDING", "COMPLETED", "FAILED", "CANCELLED", "RECONCILIATION_REQUIRED"],
    default: "RESERVED",
    index: true,
  },
  paypalCreateRequestId: { type: String, required: true },
  paypalCaptureRequestId: { type: String, required: true },
  sanitizedError: { type: String, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

checkoutAttemptSchema.index({ clientIdempotencyKey: 1 }, { unique: true });
checkoutAttemptSchema.index({ projectId: 1, createdAt: -1 });

module.exports = mongoose.model("CheckoutAttempt", checkoutAttemptSchema);
