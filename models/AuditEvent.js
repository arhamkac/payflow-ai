const mongoose = require("mongoose");

const auditEventSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementProject", required: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actor: { type: String, enum: ["USER", "AI", "SYSTEM", "PAYPAL"], required: true },
  eventType: { type: String, required: true, trim: true, maxlength: 100 },
  reason: { type: String, trim: true, maxlength: 1000 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  timestamp: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

auditEventSchema.index({ projectId: 1, timestamp: -1 });

module.exports = mongoose.model("AuditEvent", auditEventSchema);
