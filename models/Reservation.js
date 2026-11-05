const mongoose = require("mongoose");

const reservedItemSchema = new mongoose.Schema({
  sku: { type: String, required: true, trim: true, uppercase: true },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
}, { _id: false });

const reservationSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementProject", required: true, index: true },
  checkoutAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: "CheckoutAttempt", required: true, unique: true },
  budgetMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  items: { type: [reservedItemSchema], required: true },
  state: {
    type: String,
    enum: ["ACTIVE", "CONSUMED", "RELEASED", "RECONCILIATION_REQUIRED"],
    default: "ACTIVE",
    index: true,
  },
  expiresAt: { type: Date, required: true, index: true },
  consumedAt: { type: Date },
  releasedAt: { type: Date },
}, { timestamps: true });

reservationSchema.index({ projectId: 1, state: 1 });

module.exports = mongoose.model("Reservation", reservationSchema);
