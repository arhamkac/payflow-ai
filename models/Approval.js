const mongoose = require("mongoose");

const approvalSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementProject", required: true, index: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
  planVersion: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  contentHash: { type: String, required: true },
  approvedTotalMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  currency: { type: String, enum: ["USD"], required: true },
  approvedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  invalidatedAt: { type: Date },
  invalidationReason: { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

approvalSchema.index({ projectId: 1, planId: 1, contentHash: 1 });

module.exports = mongoose.model("Approval", approvalSchema);
