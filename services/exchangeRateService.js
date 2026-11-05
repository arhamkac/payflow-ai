const axios = require("axios");

const RATE_URL = "https://open.er-api.com/v6/latest";
const CACHE_DURATION_MS = 60 * 60 * 1000;

const rateCache = new Map();

async function getCurrencyRates(currency) {
  const cached = rateCache.get(currency);
  if (cached && Date.now() - cached.cachedAt < CACHE_DURATION_MS) {
    return cached;
  }

  let response;
  try {
    response = await axios.get(`${RATE_URL}/${encodeURIComponent(currency)}`, { timeout: 10000 });
  } catch (err) {
    throw new Error(`Could not retrieve live ${currency} exchange rates. Check the server's internet connection and try again.`);
  }

  const data = response.data;
  if (data.result !== "success" || data.base_code !== currency || !data.rates) {
    throw new Error(`The exchange-rate provider returned an invalid ${currency} rate table.`);
  }

  const rates = {
    rates: data.rates,
    updatedAt: data.time_last_update_utc || new Date().toISOString(),
    cachedAt: Date.now(),
  };
  rateCache.set(currency, rates);
  return rates;
}

async function convertCurrency(amount, fromCurrency, toCurrency) {
  if (!/^[A-Z]{3}$/.test(fromCurrency) || !/^[A-Z]{3}$/.test(toCurrency)) {
    throw new Error("Currency codes must be three-letter ISO codes.");
  }

  const { rates, updatedAt } = fromCurrency === toCurrency
    ? { rates: { [toCurrency]: 1 }, updatedAt: null }
    : await getCurrencyRates(fromCurrency);
  const rate = rates[toCurrency];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`No ${fromCurrency} exchange rate is currently available for ${toCurrency}.`);
  }

  const fractionDigits = ["HUF", "JPY", "TWD"].includes(toCurrency) ? 0 : 2;
  const factor = 10 ** fractionDigits;
  return {
    amount: Math.round(amount * rate * factor) / factor,
    rate,
    updatedAt,
  };
}

module.exports = { convertCurrency };
