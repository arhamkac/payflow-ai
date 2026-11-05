const express = require("express");
const router = express.Router();
const {
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
} = require("../controllers/paymentController");

router.post("/request", requestPayment);
router.get("/paypal/status", getPayPalStatus);
router.get("/fx/quote", getCurrencyQuote);
router.get("/", getPayments);
router.put("/:id", updatePayment);
router.get("/:id", getPayment);
router.post("/:id/approve", approvePayment);
router.post("/:id/reject", rejectPayment);
router.post("/:id/paypal/retry", retryPayPalOrder);
router.post("/:id/paypal/status", refreshPayPalStatus);
router.post("/:id/paypal/capture", capturePayPalPayment);

module.exports = router;
