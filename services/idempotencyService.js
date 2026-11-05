const PaymentRequest = require("../models/PaymentRequest");

function generateIdempotencyKey() {
  return `tg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

async function checkDuplicate(idempotencyKey) {
  if (!idempotencyKey) return null;
  return PaymentRequest.findOne({ idempotencyKey }).lean();
}

async function storeResult(idempotencyKey, paymentData) {
  return PaymentRequest.create({ ...paymentData, idempotencyKey });
}

module.exports = {
  generateIdempotencyKey,
  checkDuplicate,
  storeResult,
};
