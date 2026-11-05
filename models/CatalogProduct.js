const mongoose = require("mongoose");
const { isNonNegativeMinorUnitAmount } = require("../services/moneyService");

const attributeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  value: { type: String, required: true, trim: true, maxlength: 240 },
}, { _id: false });

const catalogProductSchema = new mongoose.Schema({
  sku: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, required: true, trim: true, maxlength: 1000 },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  unitPriceMinor: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  currency: { type: String, enum: ["USD"], default: "USD", required: true },
  stock: { type: Number, required: true, validate: isNonNegativeMinorUnitAmount },
  reservedQuantity: { type: Number, default: 0, validate: isNonNegativeMinorUnitAmount },
  attributes: { type: [attributeSchema], default: [] },
  compatibilityTags: { type: [String], default: [] },
  active: { type: Boolean, default: true, index: true },
  catalogVersion: { type: String, required: true },
  merchantId: { type: String, required: true, index: true },
  merchantName: { type: String, required: true },
  imagePath: { type: String, default: "" },
}, { timestamps: true });

catalogProductSchema.index({ sku: 1 }, { unique: true });
catalogProductSchema.index({ active: 1, category: 1, unitPriceMinor: 1 });
catalogProductSchema.pre("validate", function validateAvailableStock(next) {
  if (this.reservedQuantity > this.stock) {
    this.invalidate("reservedQuantity", "Reserved quantity cannot exceed catalog stock.");
  }
  next();
});

module.exports = mongoose.model("CatalogProduct", catalogProductSchema);
