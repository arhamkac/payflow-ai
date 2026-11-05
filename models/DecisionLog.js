const mongoose = require("mongoose");

const decisionLogSchema = new mongoose.Schema({
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentRequest", required: true },
  actor: { type: String, enum: ["AGENT", "AI", "SYSTEM", "HUMAN", "PAYPAL"], required: true },
  action: { type: String, required: true },
  reason: { type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("DecisionLog", decisionLogSchema);
