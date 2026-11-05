const mongoose = require("mongoose");

const requirementSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, maxlength: 80 },
  category: { type: String, trim: true, maxlength: 80 },
  description: { type: String, required: true, trim: true, maxlength: 500 },
  minQuantity: { type: Number, min: 1, validate: Number.isInteger },
  compatibilityTags: { type: [String], default: [] },
}, { _id: false });

const clarificationSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 500 },
  critical: { type: Boolean, default: true },
  answer: { type: String, trim: true, maxlength: 1000 },
  answeredAt: { type: Date },
}, { _id: false });

const structuredRequirementsSchema = new mongoose.Schema({
  requiredItems: { type: [requirementSchema], default: [] },
  optionalItems: { type: [requirementSchema], default: [] },
  availableEquipment: { type: [String], default: [] },
  compatibilityConstraints: { type: [String], default: [] },
  deadline: { type: Date },
  deliveryAssumptions: { type: [String], default: [] },
}, { _id: false });

const candidateMappingSchema = new mongoose.Schema({
  requirementKey: { type: String, required: true, trim: true, maxlength: 80 },
  candidates: [{
    sku: { type: String, required: true, trim: true, uppercase: true },
    rationale: { type: String, maxlength: 240 },
    quantity: { type: Number, min: 1, validate: Number.isSafeInteger },
  }],
}, { _id: false });

const procurementProjectSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  originalGoal: { type: String, required: true, trim: true, maxlength: 4000 },
  beneficiaryCount: { type: Number, required: true, min: 1, max: 10000, validate: Number.isInteger },
  currency: { type: String, enum: ["USD"], default: "USD", required: true },
  budgetMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  contingencyMinor: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  reservedBudgetMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  committedBudgetMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  structuredRequirements: { type: structuredRequirementsSchema, default: () => ({}) },
  clarificationQuestions: { type: [clarificationSchema], default: [] },
  candidateMappings: { type: [candidateMappingSchema], default: [] },
  aiStatus: { type: String, enum: ["NOT_RUN", "READY", "FAILED"], default: "NOT_RUN" },
  aiError: { type: String, maxlength: 1000 },
  assumptionsConfirmedAt: { type: Date },
  status: {
    type: String,
    enum: ["DRAFT", "NEEDS_CLARIFICATION", "READY_TO_PLAN", "PLANNED", "APPROVED", "CHECKOUT", "COMPLETED", "CANCELLED"],
    default: "DRAFT",
    index: true,
  },
}, { timestamps: true });

procurementProjectSchema.pre("validate", function validateContingency(next) {
  if (this.contingencyMinor > this.budgetMinor) {
    this.invalidate("contingencyMinor", "Contingency cannot exceed the total budget.");
  }
  next();
});

procurementProjectSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("ProcurementProject", procurementProjectSchema);
