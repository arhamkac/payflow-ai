const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const SYSTEM_PROMPT = `You are an invoice data extractor. Extract invoice fields from the user's message and return ONLY a JSON object with these keys:
- clientName (string)
- clientEmail (string)
- description (string)
- amount (number, positive)
- currency (string, e.g. "USD", "INR")
- dueDate (string, YYYY-MM-DD format — convert relative dates like "due in 7 days" to absolute date based on today)

Return nothing except the JSON object. No explanation, no markdown.`;

function validateParsed(data) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!data.clientName) throw new Error("Missing clientName");
  if (!data.clientEmail || !emailRegex.test(data.clientEmail)) throw new Error("Invalid or missing clientEmail");
  if (!data.description) throw new Error("Missing description");
  if (!data.amount || typeof data.amount !== "number" || data.amount <= 0) throw new Error("Amount must be a positive number");
  if (!data.currency) data.currency = "USD";
  if (!data.dueDate) throw new Error("Missing dueDate");
}

async function parseInvoiceFromText(prompt, retry = false) {
  try {
    const response = await client.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    validateParsed(parsed);
    return parsed;
  } catch (err) {
    // Retry once on rate limit
    if (!retry && err?.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      return parseInvoiceFromText(prompt, true);
    }
    throw new Error(err.message || "AI parsing failed");
  }
}

module.exports = { parseInvoiceFromText };
