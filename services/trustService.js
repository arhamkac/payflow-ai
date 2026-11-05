function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function calculateAutonomyPercentage(trustScore) {
  if (trustScore >= 90) return 80;
  if (trustScore >= 70) return 50;
  if (trustScore >= 40) return 20;
  return 0;
}

function calculateAutoSpendLimit(mandateLimit, autonomyPercentage) {
  return (mandateLimit * autonomyPercentage) / 100;
}

function calculateRiskPenalty(riskScore, intentMatch) {
  let penalty = 0;
  if (riskScore >= 61) penalty += 25;
  else if (riskScore >= 31) penalty += 10;
  if (intentMatch === false) penalty += 20;
  return penalty;
}

function calculateTrustScore(currentTrustScore, riskScore, intentMatch, outcome = "none") {
  let score = currentTrustScore - calculateRiskPenalty(riskScore, intentMatch);
  if (outcome === "approved" || outcome === "completed") score += 2;
  if (outcome === "rejected") score -= 5;
  return clamp(score, 0, 100);
}

function decidePayment({
  amount,
  mandateLimit,
  perTransactionLimit,
  category,
  allowedCategories = [],
  blockedCategories = [],
  intentMatch,
  riskScore,
  autoSpendLimit,
}) {
  if (amount > mandateLimit) return { decision: "REJECTED", reason: "Amount exceeds mandate limit" };
  if (blockedCategories.includes(category)) return { decision: "REJECTED", reason: "Category is blocked" };
  if (intentMatch === false && riskScore > 60) return { decision: "REJECTED", reason: "Intent mismatch with high risk" };
  if (
    amount <= autoSpendLimit &&
    amount <= perTransactionLimit &&
    intentMatch === true &&
    allowedCategories.includes(category)
  ) {
    return { decision: "AUTO_APPROVED", reason: "Within auto-spend limit and policy allowed" };
  }
  return { decision: "MANUAL_APPROVAL_REQUIRED", reason: "Exceeds auto-spend limit or requires human review" };
}

module.exports = {
  calculateTrustScore,
  calculateAutonomyPercentage,
  calculateAutoSpendLimit,
  decidePayment,
  calculateRiskPenalty,
};
