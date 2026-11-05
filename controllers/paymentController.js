const Agent = require("../models/Agent");
const PaymentRequest = require("../models/PaymentRequest");
const DecisionLog = require("../models/DecisionLog");
const trustService = require("../services/trustService");
const { analyzePaymentRisk } = require("../services/aiService");
const {
  createPayPalOrder,
  getPayPalOrder,
  capturePayPalOrder,
  getConfigurationStatus,
  SUPPORTED_CURRENCIES,
} = require("../services/paypalService");
const idempotencyService = require("../services/idempotencyService");
const { convertCurrency } = require("../services/exchangeRateService");

async function logDecision(requestId, actor, action, reason) {
  await DecisionLog.create({ requestId, actor, action, reason });
}

async function createPayPalCheckout(payment) {
  const order = await createPayPalOrder(payment);
  payment.paypalOrderId = order.paypalOrderId;
  payment.paypalStatus = order.paypalStatus;
  payment.paypalLink = order.paypalLink;
  payment.paypalError = undefined;
  await payment.save();
  await logDecision(payment._id, "SYSTEM", "PAYPAL_ORDER_CREATED", order.paypalOrderId);
}

async function recordPayPalFailure(payment, err) {
  payment.paypalStatus = "FAILED";
  payment.paypalError = err.message || "PayPal Checkout order creation failed.";
  await payment.save();
  await logDecision(payment._id, "SYSTEM", "PAYPAL_ERROR", payment.paypalError);
}

function getPayPalStatus(req, res) {
  res.json({ mode: "sandbox", ...getConfigurationStatus() });
}

async function getCurrencyQuote(req, res) {
  try {
    const amount = Number(req.query.amount);
    const from = String(req.query.from || "").toUpperCase();
    const to = String(req.query.to || "").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter an amount greater than zero to get a conversion quote." });
    }
    if (!/^[A-Z]{3}$/.test(from)) {
      return res.status(400).json({ error: "Enter a valid three-letter source currency code." });
    }
    if (!SUPPORTED_CURRENCIES.includes(to)) {
      return res.status(400).json({ error: `PayPal Checkout does not support ${to}. Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.` });
    }

    const quote = await convertCurrency(amount, from, to);
    if (quote.amount <= 0) {
      return res.status(400).json({
        error: `${amount} ${from} is too small to charge in ${to} after currency conversion.`,
      });
    }
    res.json({
      amount,
      from,
      to,
      convertedAmount: quote.amount,
      rate: quote.rate,
      rateUpdatedAt: quote.updatedAt,
      provider: "ExchangeRate-API",
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not retrieve an exchange-rate quote." });
  }
}

async function requestPayment(req, res) {
  try {
    const { agentId, recipientEmail, amount, currency, purpose } = req.body;
    const paymentCurrency = (currency || "USD").toUpperCase();
    const sourceCurrency = String(req.body.sourceCurrency || "INR").toUpperCase();
    if (!agentId || !recipientEmail || amount === undefined || !purpose) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number." });
    }
    if (!/^[A-Z]{3}$/.test(sourceCurrency)) {
      return res.status(400).json({ error: "Enter a valid three-letter source currency code." });
    }
    if (!SUPPORTED_CURRENCIES.includes(paymentCurrency)) {
      return res.status(400).json({
        error: `PayPal Checkout does not support ${paymentCurrency}. Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      });
    }
    const conversion = await convertCurrency(amount, sourceCurrency, paymentCurrency);
    const checkoutAmount = conversion.amount;
    if (checkoutAmount <= 0) {
      return res.status(400).json({
        error: `${amount} ${sourceCurrency} is too small to charge in ${paymentCurrency} after currency conversion.`,
      });
    }

    const agent = await Agent.findById(agentId);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    if (agent.status !== "ACTIVE") return res.status(400).json({ error: "Agent is revoked." });

    const risk = await analyzePaymentRisk({ purpose, amount: checkoutAmount, currency: paymentCurrency, recipientEmail });

    const currentTrust = agent.trustScore;
    const riskAdjustedTrust = trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch);
    const autonomyPercentage = trustService.calculateAutonomyPercentage(riskAdjustedTrust);
    const autoSpendLimit = trustService.calculateAutoSpendLimit(agent.mandateLimit, autonomyPercentage);

    const { decision, reason: decisionReason } = trustService.decidePayment({
      amount: checkoutAmount,
      mandateLimit: agent.mandateLimit,
      perTransactionLimit: agent.perTransactionLimit,
      category: risk.category,
      allowedCategories: agent.allowedCategories,
      blockedCategories: agent.blockedCategories,
      intentMatch: risk.intentMatch,
      riskScore: risk.riskScore,
      autoSpendLimit,
    });

    let finalTrust = riskAdjustedTrust;
    if (decision === "AUTO_APPROVED") {
      finalTrust = trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch, "approved");
    } else if (decision === "REJECTED") {
      finalTrust = trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch, "rejected");
    }
    agent.trustScore = finalTrust;
    await agent.save();

    const payment = await PaymentRequest.create({
      agentId: agent._id,
      agentName: agent.name,
      idempotencyKey: idempotencyService.generateIdempotencyKey(),
      recipientEmail,
      amount: checkoutAmount,
      currency: paymentCurrency,
      originalAmount: amount,
      originalCurrency: sourceCurrency,
      exchangeRate: conversion.rate,
      exchangeRateUpdatedAt: conversion.updatedAt,
      purpose,
      category: risk.category,
      riskLevel: risk.riskLevel,
      riskScore: risk.riskScore,
      intentMatch: risk.intentMatch,
      redFlags: risk.redFlags,
      autonomyPercentage,
      autoSpendLimit,
      decision,
      decisionReason,
      humanDecision: decision === "AUTO_APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "PENDING",
      paypalStatus: decision === "AUTO_APPROVED" ? "PENDING" : undefined,
    });

    await logDecision(payment._id, "AGENT", "PAYMENT_REQUESTED", purpose);
    await logDecision(payment._id, "AI", "RISK_ANALYSIS", JSON.stringify(risk));
    await logDecision(payment._id, "SYSTEM", decision, `Decision: ${decision}`);

    if (decision === "AUTO_APPROVED") {
      try {
        await createPayPalCheckout(payment);
      } catch (err) {
        console.error("PayPal Checkout order error:", err.message);
        await recordPayPalFailure(payment, err);
      }
    }

    res.status(201).json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getPayments(req, res) {
  try {
    const payments = await PaymentRequest.find().sort({ createdAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updatePayment(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (payment.paypalStatus === "COMPLETED" || payment.paypalCaptureId) {
      return res.status(400).json({ error: "A completed PayPal payment cannot be edited." });
    }
    if (payment.paypalOrderId) {
      return res.status(400).json({ error: "This payment already has a PayPal order and checkout link, so it cannot be edited safely." });
    }

    const { recipientEmail, amount, currency, purpose } = req.body;
    const sourceCurrency = String(req.body.sourceCurrency || "").toUpperCase();
    const paymentCurrency = String(currency || "").toUpperCase();
    if (!recipientEmail || !purpose || amount === undefined || !sourceCurrency || !paymentCurrency) {
      return res.status(400).json({ error: "Recipient email, amount, source currency, checkout currency, and purpose are required." });
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number." });
    }
    if (!/^[A-Z]{3}$/.test(sourceCurrency)) {
      return res.status(400).json({ error: "Enter a valid three-letter source currency code." });
    }
    if (!SUPPORTED_CURRENCIES.includes(paymentCurrency)) {
      return res.status(400).json({
        error: `PayPal Checkout does not support ${paymentCurrency}. Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      });
    }

    const agent = await Agent.findById(payment.agentId);
    if (!agent) return res.status(404).json({ error: "The payment's agent no longer exists." });
    if (agent.status !== "ACTIVE") {
      return res.status(400).json({ error: "This payment cannot be edited because its agent is revoked." });
    }

    const conversion = await convertCurrency(amount, sourceCurrency, paymentCurrency);
    if (conversion.amount <= 0) {
      return res.status(400).json({
        error: `${amount} ${sourceCurrency} is too small to charge in ${paymentCurrency} after currency conversion.`,
      });
    }

    const risk = await analyzePaymentRisk({
      purpose,
      amount: conversion.amount,
      currency: paymentCurrency,
      recipientEmail,
    });
    const currentTrust = agent.trustScore;
    const riskAdjustedTrust = trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch);
    const autonomyPercentage = trustService.calculateAutonomyPercentage(riskAdjustedTrust);
    const autoSpendLimit = trustService.calculateAutoSpendLimit(agent.mandateLimit, autonomyPercentage);
    const { decision, reason: decisionReason } = trustService.decidePayment({
      amount: conversion.amount,
      mandateLimit: agent.mandateLimit,
      perTransactionLimit: agent.perTransactionLimit,
      category: risk.category,
      allowedCategories: agent.allowedCategories,
      blockedCategories: agent.blockedCategories,
      intentMatch: risk.intentMatch,
      riskScore: risk.riskScore,
      autoSpendLimit,
    });

    const oldAmount = payment.amount;
    const oldCurrency = payment.currency;
    payment.recipientEmail = recipientEmail;
    payment.amount = conversion.amount;
    payment.currency = paymentCurrency;
    payment.originalAmount = amount;
    payment.originalCurrency = sourceCurrency;
    payment.exchangeRate = conversion.rate;
    payment.exchangeRateUpdatedAt = conversion.updatedAt;
    payment.purpose = purpose;
    payment.category = risk.category;
    payment.riskLevel = risk.riskLevel;
    payment.riskScore = risk.riskScore;
    payment.intentMatch = risk.intentMatch;
    payment.redFlags = risk.redFlags;
    payment.autonomyPercentage = autonomyPercentage;
    payment.autoSpendLimit = autoSpendLimit;
    payment.decision = decision;
    payment.decisionReason = decisionReason;
    payment.humanDecision = decision === "AUTO_APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : "PENDING";
    payment.paypalStatus = decision === "AUTO_APPROVED" ? "PENDING" : undefined;
    payment.paypalError = undefined;
    payment.updatedAt = new Date();
    agent.trustScore = decision === "AUTO_APPROVED"
      ? trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch, "approved")
      : decision === "REJECTED"
        ? trustService.calculateTrustScore(currentTrust, risk.riskScore, risk.intentMatch, "rejected")
        : riskAdjustedTrust;
    await agent.save();
    await payment.save();

    await logDecision(
      payment._id,
      "HUMAN",
      "PAYMENT_EDITED",
      `Payment details updated and re-evaluated. Checkout amount changed from ${oldAmount} ${oldCurrency} to ${payment.amount} ${payment.currency}.`
    );
    await logDecision(payment._id, "AI", "RISK_ANALYSIS", JSON.stringify(risk));
    await logDecision(payment._id, "SYSTEM", decision, `Updated decision: ${decision}`);

    if (decision === "AUTO_APPROVED") {
      try {
        await createPayPalCheckout(payment);
      } catch (err) {
        console.error("PayPal Checkout order error after payment edit:", err.message);
        await recordPayPalFailure(payment, err);
      }
    }

    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getPayment(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    const logs = await DecisionLog.find({ requestId: payment._id }).sort({ createdAt: 1 });
    res.json({ payment, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function approvePayment(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (payment.decision !== "MANUAL_APPROVAL_REQUIRED" || payment.humanDecision !== "PENDING") {
      return res.status(400).json({ error: "Payment is not pending manual approval." });
    }

    payment.humanDecision = "APPROVED";
    await payment.save();

    try {
      await createPayPalCheckout(payment);
    } catch (err) {
      console.error("PayPal Checkout order error:", err.message);
      await recordPayPalFailure(payment, err);
    }

    const agent = await Agent.findById(payment.agentId);
    if (agent) {
      agent.trustScore = Math.min(100, agent.trustScore + 2);
      await agent.save();
    }

    await logDecision(payment._id, "HUMAN", "APPROVED", "Manual approval");
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function rejectPayment(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (payment.humanDecision !== "PENDING") {
      return res.status(400).json({ error: "Payment is not pending." });
    }

    payment.decision = "REJECTED";
    payment.humanDecision = "REJECTED";
    await payment.save();

    const agent = await Agent.findById(payment.agentId);
    if (agent) {
      agent.trustScore = Math.max(0, agent.trustScore - 5);
      await agent.save();
    }

    await logDecision(payment._id, "HUMAN", "REJECTED", "Manual rejection");
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function retryPayPalOrder(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (payment.humanDecision !== "APPROVED") {
      return res.status(400).json({ error: "Approve this payment before creating a PayPal Checkout order." });
    }
    if (payment.paypalStatus !== "FAILED") {
      return res.status(400).json({ error: "This payment does not have a failed PayPal order to retry." });
    }

    try {
      await createPayPalCheckout(payment);
      res.json(payment);
    } catch (err) {
      console.error("PayPal Checkout retry error:", err.message);
      await recordPayPalFailure(payment, err);
      res.status(502).json({ error: payment.paypalError, payment });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function refreshPayPalStatus(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (!payment.paypalOrderId) {
      return res.status(400).json({ error: "This payment does not have a PayPal Checkout order yet." });
    }

    const paypalOrder = await getPayPalOrder(payment.paypalOrderId);
    const previousStatus = payment.paypalStatus;
    payment.paypalStatus = paypalOrder.paypalStatus;
    if (paypalOrder.paypalCaptureId) payment.paypalCaptureId = paypalOrder.paypalCaptureId;
    if (paypalOrder.paypalStatus !== "FAILED") payment.paypalError = undefined;
    await payment.save();

    if (previousStatus !== payment.paypalStatus) {
      await logDecision(
        payment._id,
        "SYSTEM",
        "PAYPAL_STATUS_UPDATED",
        `${previousStatus || "UNKNOWN"} -> ${payment.paypalStatus}`
      );
    }

    res.json(payment);
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not retrieve PayPal order status." });
  }
}

async function capturePayPalPayment(req, res) {
  try {
    const payment = await PaymentRequest.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found." });
    if (!payment.paypalOrderId) {
      return res.status(400).json({ error: "This payment does not have a PayPal Checkout order." });
    }

    const currentOrder = await getPayPalOrder(payment.paypalOrderId);
    if (currentOrder.paypalStatus === "COMPLETED") {
      payment.paypalStatus = currentOrder.paypalStatus;
      if (currentOrder.paypalCaptureId) payment.paypalCaptureId = currentOrder.paypalCaptureId;
      await payment.save();
      return res.json(payment);
    }
    if (currentOrder.paypalStatus !== "APPROVED") {
      return res.status(400).json({
        error: `PayPal order must be approved by the buyer before capture (current status: ${currentOrder.paypalStatus}).`,
      });
    }

    const capture = await capturePayPalOrder(payment.paypalOrderId);
    payment.paypalStatus = capture.paypalStatus;
    payment.paypalCaptureId = capture.paypalCaptureId || undefined;
    payment.paypalError = undefined;
    await payment.save();
    await logDecision(
      payment._id,
      "SYSTEM",
      "PAYPAL_PAYMENT_CAPTURED",
      capture.paypalCaptureId || payment.paypalOrderId
    );

    if (capture.paypalStatus !== "COMPLETED") {
      return res.status(502).json({
        error: `PayPal returned capture status ${capture.paypalStatus}; payment is not confirmed complete.`,
        payment,
      });
    }

    res.json(payment);
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not capture the PayPal payment." });
  }
}

module.exports = {
  requestPayment,
  getPayments,
  updatePayment,
  getPayment,
  getPayPalStatus,
  getCurrencyQuote,
  approvePayment,
  rejectPayment,
  retryPayPalOrder,
  refreshPayPalStatus,
  capturePayPalPayment,
};
