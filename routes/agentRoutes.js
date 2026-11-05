const express = require("express");
const router = express.Router();
const { createAgent, getAgents, revokeAgent, getAgentTrust } = require("../controllers/agentController");

router.post("/", createAgent);
router.get("/", getAgents);
router.post("/:id/revoke", revokeAgent);
router.get("/:id/trust", getAgentTrust);

module.exports = router;
