const Invoice = require("../models/Invoice");
const { parseInvoiceFromText } = require("../services/aiService");
const { createPayPalInvoice, sendPayPalInvoice } = require("../services/paypalService");

async function parseInvoice(req, res) {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Please enter an invoice description." });
    const invoice = await parseInvoiceFromText(prompt);
    res.json({ invoice });
  } catch (err) {
    res.status(400).json({ error: "Couldn't understand the invoice details. Try rephrasing, e.g. 'Invoice for John at john@email.com for logo design, $500, due in 7 days.'" });
  }
}

async function createInvoice(req, res) {
  try {
    const { clientName, clientEmail, description, amount, currency, dueDate, aiPrompt } = req.body;

    if (!clientName || !clientEmail || !description || amount === undefined)
      return res.status(400).json({ error: "Please fill in all required fields: name, email, description, and amount." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (typeof amount !== "number" || amount <= 0)
      return res.status(400).json({ error: "Amount must be a number greater than zero." });

    const invoice = await Invoice.create({
      clientName, clientEmail, description, amount,
      currency: currency || "USD",
      dueDate: dueDate ? new Date(dueDate) : undefined,
      aiPrompt: aiPrompt || "",
      status: "DRAFT",
    });

    const { paypalInvoiceId, status } = await createPayPalInvoice(invoice);
    invoice.paypalInvoiceId = paypalInvoiceId;
    invoice.status = status;
    await invoice.save();

    res.status(201).json(invoice);
  } catch (err) {
    console.error("createInvoice error:", err.message);
    res.status(500).json({ error: "Failed to create invoice. Please check your PayPal sandbox settings and try again." });
  }
}

async function getInvoices(req, res) {
  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 });
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch invoices." });
  }
}

async function updateInvoice(req, res) {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found." });
    if (invoice.status === "SENT")
      return res.status(400).json({ error: "Cannot edit an invoice that has already been sent." });

    const { clientName, clientEmail, description, amount, currency, dueDate } = req.body;
    if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0))
      return res.status(400).json({ error: "Amount must be a number greater than zero." });

    if (clientName)  invoice.clientName  = clientName;
    if (clientEmail) invoice.clientEmail = clientEmail;
    if (description) invoice.description = description;
    if (amount)      invoice.amount      = amount;
    if (currency)    invoice.currency    = currency;
    if (dueDate)     invoice.dueDate     = new Date(dueDate);

    await invoice.save();
    res.json(invoice);
  } catch (err) {
    console.error("updateInvoice error:", err.message);
    res.status(500).json({ error: "Could not update invoice. Please try again." });
  }
}

async function sendInvoice(req, res) {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found." });
    if (!invoice.paypalInvoiceId) return res.status(400).json({ error: "This invoice has no PayPal ID. Please recreate it." });

    await sendPayPalInvoice(invoice.paypalInvoiceId);
    invoice.status = "SENT";
    await invoice.save();

    res.json(invoice);
  } catch (err) {
    console.error("sendInvoice error:", err.message);
    res.status(500).json({ error: "Failed to send invoice via PayPal. Please try again." });
  }
}

async function deleteInvoice(req, res) {
  try {
    const invoice = await Invoice.findByIdAndDelete(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found." });
    res.json({ message: "Invoice deleted." });
  } catch (err) {
    res.status(500).json({ error: "Could not delete invoice. Please try again." });
  }
}

module.exports = { parseInvoice, createInvoice, getInvoices, updateInvoice, sendInvoice, deleteInvoice };
