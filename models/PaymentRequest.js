const mongoose = require("mongoose");

const paymentRequestSchema = new mongoose.Schema({
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },
  agentName: { type: String, required: true },
  recipientEmail: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: "USD" },
  originalAmount: { type: Number },
  originalCurrency: { type: String },
  exchangeRate: { type: Number },
  exchangeRateUpdatedAt: { type: String },
  purpose: { type: String, required: true },
  category: { type: String },
  riskLevel: { type: String },
  riskScore: { type: Number },
  intentMatch: { type: Boolean },
  redFlags: { type: [String], default: [] },
  autonomyPercentage: { type: Number },
  autoSpendLimit: { type: Number },
  decision: {
    type: String,
    enum: ["AUTO_APPROVED", "MANUAL_APPROVAL_REQUIRED", "REJECTED"],
  },
  decisionReason: { type: String },
  humanDecision: {
    type: String,
    enum: ["PENDING", "APPROVED", "REJECTED", "NOT_REQUIRED"],
    default: "PENDING",
  },
  idempotencyKey: { type: String, required: true, unique: true },
  paypalOrderId: { type: String },
  paypalCaptureId: { type: String },
  paypalInvoiceId: { type: String },
  paypalLink: { type: String },
  paypalStatus: { type: String },
  paypalError: { type: String },
  pipelineStage: {
    type: String,
    enum: ["INTAKE", "AI_ANALYSIS", "DECIDED", "EXECUTED", "FAILED"],
    default: "INTAKE",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PaymentRequest", paymentRequestSchema);
