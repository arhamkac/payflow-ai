const MAX_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

function parseUsdMinorUnits(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Enter a non-negative USD amount with no more than two decimal places.");
  }

  const [whole, fraction = ""] = value.split(".");
  const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (minorUnits > MAX_MINOR_UNITS) {
    throw new Error("USD amount exceeds the supported monetary range.");
  }
  return Number(minorUnits);
}

function isNonNegativeMinorUnitAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

module.exports = { parseUsdMinorUnits, isNonNegativeMinorUnitAmount };
