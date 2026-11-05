const OpenAI = require("openai");

const SYSTEM_PROMPT =
  "You are a payment risk analyzer. Analyze the payment request and return only a JSON object with keys: category (software | marketing | cloud | travel | other), riskLevel (low | medium | high), riskScore (0-100 number), intentMatch (boolean), redFlags (array of strings). No markdown, no explanation.";

function safeDefaults() {
  return {
    category: "other",
    riskLevel: "high",
    riskScore: 80,
    intentMatch: false,
    redFlags: ["AI response invalid"],
  };
}

function validate(data) {
  const allowedCategories = ["software", "marketing", "cloud", "travel", "other"];
  const allowedRisk = ["low", "medium", "high"];
  if (!allowedCategories.includes(data.category)) data.category = "other";
  if (!allowedRisk.includes(data.riskLevel)) data.riskLevel = "high";
  if (typeof data.riskScore !== "number" || data.riskScore < 0 || data.riskScore > 100) data.riskScore = 80;
  if (typeof data.intentMatch !== "boolean") data.intentMatch = false;
  if (!Array.isArray(data.redFlags)) data.redFlags = [];
  return data;
}

async function analyzePaymentRisk({ purpose, amount, currency, recipientEmail }, isRetry = false) {
  try {
    if (!process.env.GROQ_API_KEY || !process.env.GROQ_MODEL) {
      throw new Error("GROQ_API_KEY and GROQ_MODEL are required for AI analysis.");
    }
    const client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      maxRetries: 0,
      timeout: 15000,
    });
    const res = await client.chat.completions.create({
      model: process.env.GROQ_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Purpose: ${purpose}\nAmount: ${amount} ${currency}\nRecipient: ${recipientEmail}`,
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return validate(parsed);
  } catch (err) {
    if (!isRetry && err?.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      return analyzePaymentRisk({ purpose, amount, currency, recipientEmail }, true);
    }
    return safeDefaults();
  }
}

module.exports = { analyzePaymentRisk };
