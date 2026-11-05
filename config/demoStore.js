const DEMO_MERCHANT = Object.freeze({
  id: "TRUSTGATE_DEMO_SUPPLIES",
  name: "TrustGate Demo Supplies Store",
  currency: "USD",
  catalogVersion: "demo-2026-01",
  shippingMinor: 1200,
  taxMinor: 0,
  shippingRule: "Fixed $12 demo shipping fee per order; not a carrier quote.",
  taxRule: "No tax is added in this demo configuration; this is not a real-world tax calculation.",
  deliveryRule: "Delivery timing is unconfirmed and is not guaranteed by this demo catalog.",
});

module.exports = { DEMO_MERCHANT };
