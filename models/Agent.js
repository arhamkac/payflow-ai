const mongoose = require("mongoose");

const agentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ownerEmail: { type: String, required: true },
  mandateLimit: { type: Number, required: true },
  perTransactionLimit: { type: Number, required: true },
  allowedCategories: { type: [String], default: ["software", "cloud"] },
  blockedCategories: { type: [String], default: [] },
  trustScore: { type: Number, default: 70 },
  status: { type: String, default: "ACTIVE" },
  mandateExpiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Agent", agentSchema);
