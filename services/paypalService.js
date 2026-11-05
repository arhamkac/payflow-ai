const axios = require("axios");

const BASE_URL = "https://api-m.sandbox.paypal.com";
const SUPPORTED_CURRENCIES = [
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS",
  "JPY", "MYR", "MXN", "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD",
  "SEK", "CHF", "THB", "USD",
];

let tokenCache = { token: null, expiresAt: 0 };

function getConfigurationStatus() {
  const missing = [];
  if (!process.env.PAYPAL_CLIENT_ID) missing.push("PAYPAL_CLIENT_ID");
  if (!process.env.PAYPAL_CLIENT_SECRET) missing.push("PAYPAL_CLIENT_SECRET");

  return {
    configured: missing.length === 0,
    missing,
    currencies: SUPPORTED_CURRENCIES,
    clientId: process.env.PAYPAL_CLIENT_ID || "",
  };
}

function formatPayPalError(err, fallback) {
  const responseData = err.response?.data;
  const message = responseData?.message || responseData?.error_description;
  const details = Array.isArray(responseData?.details)
    ? responseData.details.map((detail) => detail.description || detail.issue).filter(Boolean).join("; ")
    : "";
  const isPermissionError = err.response?.status === 403
    || /insufficient permissions|insufficient privilege|not authorized/i.test(message || "");

  if (isPermissionError) {
    return [
      "PayPal denied the Checkout Orders request because this Sandbox REST app lacks the required checkout/payments permission.",
      "In PayPal Developer Dashboard, open Apps & Credentials > Sandbox Apps, select the REST app matching this server's PAYPAL_CLIENT_ID, enable the Checkout/Payments capability, and save.",
      "Restart the server to obtain a fresh access token, then retry the PayPal order.",
      details,
    ].filter(Boolean).join(" ");
  }

  return [message || fallback, details].filter(Boolean).join(" ");
}

async function getAccessToken() {
  const { configured, missing } = getConfigurationStatus();
  if (!configured) {
    throw new Error(`PayPal Sandbox is not configured. Add ${missing.join(", ")} to the root .env file and restart the server.`);
  }

  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/v1/oauth2/token`,
      "grant_type=client_credentials",
      {
        auth: {
          username: process.env.PAYPAL_CLIENT_ID,
          password: process.env.PAYPAL_CLIENT_SECRET,
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
  } catch (err) {
    throw new Error(formatPayPalError(
      err,
      "PayPal Sandbox authentication failed. Check the sandbox app client ID and secret."
    ));
  }

  tokenCache.token = response.data.access_token;
  tokenCache.expiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
  return tokenCache.token;
}

function authorizationHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function approvalLink(order) {
  return order?.links?.find((link) => link.rel === "approve" || link.rel === "payer-action")?.href || null;
}

function formatPayPalAmount(amount, currency) {
  const fractionDigits = ["HUF", "JPY", "TWD"].includes(currency) ? 0 : 2;
  return Number(amount).toFixed(fractionDigits);
}

function formatPayPalUsdMinor(minor) {
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("PayPal checkout amount must be a positive safe integer number of USD cents.");
  }
  return (minor / 100).toFixed(2);
}

async function createProcurementPayPalOrder({ amountMinor, description, referenceId, requestId }) {
  let token;
  try {
    const { configured, missing } = getConfigurationStatus();
    if (!configured) {
      throw new Error(`PayPal Sandbox is not configured. Add ${missing.join(", ")} to the root .env file and restart the server.`);
    }
    token = await getAccessToken();
  } catch (error) {
    error.definitive = true;
    throw error;
  }
  try {
    const response = await axios.post(
      `${BASE_URL}/v2/checkout/orders`,
      {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: referenceId,
          description: String(description).slice(0, 127),
          amount: { currency_code: "USD", value: formatPayPalUsdMinor(amountMinor) },
        }],
        application_context: {
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
      {
        headers: {
          ...authorizationHeaders(token),
          "PayPal-Request-Id": requestId,
        },
      }
    );
    if (!response.data.id) throw new Error("PayPal did not return a checkout order ID.");
    return {
      orderId: response.data.id,
      status: response.data.status || "CREATED",
      approvalUrl: approvalLink(response.data),
    };
  } catch (err) {
    const error = new Error(formatPayPalError(err, "PayPal could not create the procurement checkout order."));
    error.paypalStatus = err.response?.status;
    error.definitive = Number.isInteger(err.response?.status)
      && err.response.status >= 400 && err.response.status < 500;
    throw error;
  }
}

async function createPayPalOrder(payment) {
  if (!SUPPORTED_CURRENCIES.includes(payment.currency)) {
    throw new Error(
      `PayPal Checkout does not support ${payment.currency}. Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.`
    );
  }

  const token = await getAccessToken();
  let response;
  try {
    response = await axios.post(
      `${BASE_URL}/v2/checkout/orders`,
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: String(payment._id),
            description: payment.purpose.slice(0, 127),
            amount: {
              currency_code: payment.currency,
              value: formatPayPalAmount(payment.amount, payment.currency),
            },
          },
        ],
        application_context: {
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
      { headers: authorizationHeaders(token) }
    );
  } catch (err) {
    throw new Error(formatPayPalError(
      err,
      "PayPal could not create the checkout order. Check the Sandbox app and merchant account."
    ));
  }

  const link = approvalLink(response.data);
  if (!response.data.id || !link) {
    throw new Error("PayPal did not return an order ID and buyer approval link.");
  }

  return {
    paypalOrderId: response.data.id,
    paypalStatus: response.data.status || "CREATED",
    paypalLink: link,
  };
}

async function getPayPalOrder(paypalOrderId) {
  const token = await getAccessToken();
  try {
    const response = await axios.get(
      `${BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
      { headers: authorizationHeaders(token) }
    );
    return {
      paypalStatus: response.data.status || "UNKNOWN",
      paypalCaptureId: response.data.purchase_units?.[0]?.payments?.captures?.[0]?.id || null,
      currency: response.data.purchase_units?.[0]?.amount?.currency_code || null,
      amount: response.data.purchase_units?.[0]?.amount?.value || null,
    };
  } catch (err) {
    throw new Error(formatPayPalError(err, "Could not retrieve the PayPal order status."));
  }
}

async function capturePayPalOrder(paypalOrderId, requestId) {
  const token = await getAccessToken();
  try {
    const response = await axios.post(
      `${BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
      {},
      {
        headers: {
          ...authorizationHeaders(token),
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
      }
    );
    return {
      paypalStatus: response.data.status || "UNKNOWN",
      paypalCaptureId: response.data.purchase_units?.[0]?.payments?.captures?.[0]?.id || null,
      currency: response.data.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code || null,
      amount: response.data.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || null,
    };
  } catch (err) {
    throw new Error(formatPayPalError(err, "PayPal could not capture the approved order."));
  }
}

module.exports = {
  getAccessToken,
  getConfigurationStatus,
  SUPPORTED_CURRENCIES,
  createProcurementPayPalOrder,
  createPayPalOrder,
  getPayPalOrder,
  capturePayPalOrder,
};
