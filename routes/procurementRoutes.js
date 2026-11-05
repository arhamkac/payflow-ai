const express = require("express");
const {
  getStorefront,
  listProjects,
  getProject,
  createProject,
  retryExtraction,
  answerClarifications,
  generatePlans,
  createManualPlan,
  editPlan,
  approvePlan,
  startCheckout,
  captureCheckout,
  cancelCheckout,
} = require("../controllers/procurementController");

const router = express.Router();

router.get("/storefront", getStorefront);
router.get("/projects", listProjects);
router.post("/projects", createProject);
router.get("/projects/:projectId", getProject);
router.post("/projects/:projectId/extract", retryExtraction);
router.post("/projects/:projectId/clarifications", answerClarifications);
router.post("/projects/:projectId/plans", generatePlans);
router.post("/projects/:projectId/plans/manual", createManualPlan);
router.put("/projects/:projectId/plans/:planId", editPlan);
router.post("/projects/:projectId/plans/:planId/approve", approvePlan);
router.post("/projects/:projectId/checkout", startCheckout);
router.post("/projects/:projectId/checkout/:attemptId/capture", captureCheckout);
router.post("/projects/:projectId/checkout/:attemptId/cancel", cancelCheckout);

module.exports = router;
