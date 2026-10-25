const Invoice = require("../models/Invoice");
const { parseInvoiceFromText } = require("../services/aiService");
const { createPayPalInvoice, sendPayPalInvoice } = require("../services/paypalService");

// POST /api/invoices/parse
async function parseInvoice(req, res) {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    const invoice = await parseInvoiceFromText(prompt);
    res.json({ invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// POST /api/invoices
async function createInvoice(req, res) {
  try {
    const { clientName, clientEmail, description, amount, currency, dueDate, aiPrompt } = req.body;

    // Basic validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!clientName || !clientEmail || !description || !amount)
      return res.status(400).json({ error: "clientName, clientEmail, description, and amount are required" });
    if (!emailRegex.test(clientEmail))
      return res.status(400).json({ error: "Invalid clientEmail" });
    if (typeof amount !== "number" || amount <= 0)
      return res.status(400).json({ error: "amount must be a positive number" });

    // Save to MongoDB first (status DRAFT)
    const invoice = await Invoice.create({
      clientName, clientEmail, description, amount,
      currency: currency || "USD",
      dueDate: dueDate ? new Date(dueDate) : undefined,
      aiPrompt: aiPrompt || "",
      status: "DRAFT",
    });

    // Create PayPal invoice
    const { paypalInvoiceId, status } = await createPayPalInvoice(invoice);
    invoice.paypalInvoiceId = paypalInvoiceId;
    invoice.status = status || "DRAFT";
    await invoice.save();

    res.status(201).json(invoice);
  } catch (err) {
    console.error("createInvoice error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/invoices
async function getInvoices(req, res) {
  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 });
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/invoices/:id/send
async function sendInvoice(req, res) {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (!invoice.paypalInvoiceId) return res.status(400).json({ error: "No PayPal invoice ID on this invoice" });

    await sendPayPalInvoice(invoice.paypalInvoiceId);
    invoice.status = "SENT";
    await invoice.save();

    res.json(invoice);
  } catch (err) {
    console.error("sendInvoice error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { parseInvoice, createInvoice, getInvoices, sendInvoice };
