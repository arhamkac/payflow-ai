const Agent = require("../models/Agent");
const PaymentRequest = require("../models/PaymentRequest");
const DecisionLog = require("../models/DecisionLog");
const trustService = require("../services/trustService");

function withMetrics(agent) {
  const obj = agent.toObject ? agent.toObject() : agent;
  const autonomyPercentage = trustService.calculateAutonomyPercentage(obj.trustScore);
  const autoSpendLimit = trustService.calculateAutoSpendLimit(obj.mandateLimit, autonomyPercentage);
  return { ...obj, autonomyPercentage, autoSpendLimit };
}

async function createAgent(req, res) {
  try {
    const { name, ownerEmail, mandateLimit, perTransactionLimit, allowedCategories, blockedCategories } = req.body;
    if (!name || !ownerEmail || mandateLimit === undefined || perTransactionLimit === undefined) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const agent = await Agent.create({
      name,
      ownerEmail,
      mandateLimit,
      perTransactionLimit,
      allowedCategories: Array.isArray(allowedCategories) ? allowedCategories : (allowedCategories ? String(allowedCategories).split(",").map((s) => s.trim()).filter(Boolean) : undefined),
      blockedCategories: Array.isArray(blockedCategories) ? blockedCategories : (blockedCategories ? String(blockedCategories).split(",").map((s) => s.trim()).filter(Boolean) : []),
    });
    res.status(201).json(withMetrics(agent));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getAgents(req, res) {
  try {
    const agents = await Agent.find().sort({ createdAt: -1 });
    res.json(agents.map(withMetrics));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function revokeAgent(req, res) {
  try {
    const agent = await Agent.findByIdAndUpdate(req.params.id, { status: "REVOKED" }, { new: true });
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    res.json(withMetrics(agent));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getAgentTrust(req, res) {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    const autonomyPercentage = trustService.calculateAutonomyPercentage(agent.trustScore);
    const autoSpendLimit = trustService.calculateAutoSpendLimit(agent.mandateLimit, autonomyPercentage);
    const recentPayments = await PaymentRequest.find({ agentId: agent._id }).sort({ createdAt: -1 }).limit(10);
    const recentLogs = await DecisionLog.find({ requestId: { $in: recentPayments.map((p) => p._id) } }).sort({ createdAt: -1 }).limit(20);
    res.json({
      agentId: agent._id,
      name: agent.name,
      trustScore: agent.trustScore,
      autonomyPercentage,
      autoSpendLimit,
      mandateLimit: agent.mandateLimit,
      perTransactionLimit: agent.perTransactionLimit,
      status: agent.status,
      recentPayments,
      recentLogs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { createAgent, getAgents, revokeAgent, getAgentTrust };
