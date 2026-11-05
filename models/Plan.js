const mongoose = require("mongoose");
const { isNonNegativeMinorUnitAmount } = require("../services/moneyService");

const planLineSchema = new mongoose.Schema({
  sku: { type: String, required: true, trim: true, uppercase: true },
  nameSnapshot: { type: String, required: true, trim: true },
  descriptionSnapshot: { type: String, required: true, trim: true },
  categorySnapshot: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  unitPriceMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  currency: { type: String, enum: ["USD"], required: true },
  catalogVersion: { type: String, required: true },
  merchantId: { type: String, required: true },
}, { _id: false });

const requirementMappingSchema = new mongoose.Schema({
  requirementKey: { type: String, required: true },
  sku: { type: String, required: true, trim: true, uppercase: true },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  rationale: { type: String, trim: true, maxlength: 240 },
}, { _id: false });

const validationReportSchema = new mongoose.Schema({
  valid: { type: Boolean, required: true },
  blockingIssues: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
}, { _id: false });

const planSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: "ProcurementProject", required: true, index: true },
  version: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  strategy: { type: String, enum: ["LOWEST_COST", "BALANCED", "MAXIMUM_COVERAGE"], required: true },
  strategyExplanation: { type: String, trim: true, maxlength: 1000 },
  items: { type: [planLineSchema], default: [] },
  requirementMappings: { type: [requirementMappingSchema], default: [] },
  subtotalMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  shippingMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  taxMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  totalMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  assumptions: { type: [String], default: [] },
  unmetRequirements: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
  validationReport: { type: validationReportSchema, required: true },
  contentHash: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ["DRAFT", "VALIDATED", "APPROVED", "SUPERSEDED", "CHECKOUT", "COMPLETED"],
    default: "DRAFT",
    index: true,
  },
}, { timestamps: true });

planSchema.index({ projectId: 1, version: 1 }, { unique: true });
planSchema.pre("validate", function validatePlanTotals(next) {
  let calculatedSubtotal = 0;
  for (const item of this.items) {
    const lineTotal = item.quantity * item.unitPriceMinor;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(calculatedSubtotal + lineTotal)) {
      this.invalidate("subtotalMinor", "Plan subtotal exceeds the supported monetary range.");
      return next();
    }
    calculatedSubtotal += lineTotal;
  }
  const calculatedTotal = calculatedSubtotal + this.shippingMinor + this.taxMinor;
  if (!Number.isSafeInteger(calculatedTotal)) {
    this.invalidate("totalMinor", "Plan total exceeds the supported monetary range.");
  } else {
    if (this.subtotalMinor !== calculatedSubtotal) {
      this.invalidate("subtotalMinor", "Plan subtotal must match its line item snapshots.");
    }
    if (this.totalMinor !== calculatedTotal) {
      this.invalidate("totalMinor", "Plan total must equal subtotal, shipping, and tax.");
    }
  }
  next();
});

module.exports = mongoose.model("Plan", planSchema);
