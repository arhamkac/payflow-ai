require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const connectDB = require("./config/db");
const agentRoutes = require("./routes/agentRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const procurementRoutes = require("./routes/procurementRoutes");

const app = express();

const PORT = process.env.PORT || 5000;
const allowedOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: "TrustGate is local-only; cross-origin requests are not allowed." });
  }
  next();
});
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "32kb" }));

const clientBuild = path.join(__dirname, "client", "dist");
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    return res.sendFile(path.join(clientBuild, "index.html"));
  });
}

app.use("/api/agents", agentRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/procurement", procurementRoutes);
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

connectDB()
  .then(() => app.listen(PORT, "127.0.0.1", () => console.log(`TrustGate running locally on 127.0.0.1:${PORT}`)))
  .catch((error) => {
    console.error("TrustGate could not connect to MongoDB:", error.message);
    process.exitCode = 1;
  });
