const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema({
  clientName:     { type: String, required: true },
  clientEmail:    { type: String, required: true },
  description:    { type: String, required: true },
  amount:         { type: Number, required: true },
  currency:       { type: String, default: "USD" },
  dueDate:        { type: Date },
  paypalInvoiceId:{ type: String },
  status:         { type: String, default: "DRAFT" },
  aiPrompt:       { type: String },
  createdAt:      { type: Date, default: Date.now },
});

module.exports = mongoose.model("Invoice", invoiceSchema);
