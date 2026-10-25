# PayFlow AI 💸

An AI-powered invoice assistant for freelancers. Describe your invoice in plain English — the AI extracts the data, creates a PayPal Sandbox invoice, and lets you send it from a simple dashboard.

---

## Features

- Natural language invoice creation via Groq LLM (Llama 3.3 70B)
- PayPal Sandbox invoice creation and sending
- MongoDB invoice storage with status tracking
- Minimal single-page dashboard (no build step)

---

## Tech Stack

- **Backend:** Node.js, Express, Mongoose
- **AI:** Groq API (OpenAI-compatible client)
- **Payments:** PayPal Sandbox Invoicing API
- **Frontend:** Vanilla HTML/JS (single file)
- **DB:** MongoDB

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/arhamkac/payflow-ai.git
cd payflow-ai
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 5000) |
| `MONGODB_URI` | MongoDB connection string |
| `GROQ_API_KEY` | Get from [console.groq.com](https://console.groq.com) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox app client secret |

### 3. PayPal Sandbox Setup

1. Go to [developer.paypal.com](https://developer.paypal.com/dashboard/)
2. Create a sandbox app under **Apps & Credentials**
3. Copy the **Client ID** and **Secret** into `.env`
4. Make sure the sandbox account has **Invoicing** permissions enabled

### 4. Run

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Open [http://localhost:5000](http://localhost:5000)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/invoices/parse` | Parse natural language → invoice JSON |
| `POST` | `/api/invoices` | Create invoice in DB + PayPal |
| `GET` | `/api/invoices` | Fetch all invoices |
| `POST` | `/api/invoices/:id/send` | Send invoice via PayPal |

---

## Example Prompt

```
Create an invoice for Rahul at rahul@example.com for website redesign, ₹15,000, due in 7 days.
```

---

## Project Structure

```
payflow-ai/
├── config/db.js
├── controllers/invoiceController.js
├── models/Invoice.js
├── routes/invoiceRoutes.js
├── services/aiService.js
├── services/paypalService.js
├── public/index.html
├── server.js
├── .env.example
└── README.md
```

---

## License

MIT
