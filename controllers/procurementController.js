const crypto = require("crypto");
const mongoose = require("mongoose");
const ProcurementProject = require("../models/ProcurementProject");
const CatalogProduct = require("../models/CatalogProduct");
const Plan = require("../models/Plan");
const Approval = require("../models/Approval");
const CheckoutAttempt = require("../models/CheckoutAttempt");
const Reservation = require("../models/Reservation");
const AuditEvent = require("../models/AuditEvent");
const { DEMO_MERCHANT } = require("../config/demoStore");
const { parseUsdMinorUnits } = require("../services/moneyService");
const { extractProcurementRequirements } = require("../services/procurementAiService");
const { validatePlan, hashPlan, chooseCandidateMappings } = require("../services/planningService");
const {
  getConfigurationStatus,
  createProcurementPayPalOrder,
  getPayPalOrder,
  capturePayPalOrder,
} = require("../services/paypalService");

const GOAL_MAX_LENGTH = 4000;
const APPROVAL_HOURS = Math.min(168, Math.max(1, Number(process.env.PROCUREMENT_APPROVAL_HOURS) || 24));
const RESERVATION_HOURS = Math.min(72, Math.max(1, Number(process.env.PROCUREMENT_RESERVATION_HOURS) || 24));

function sendError(res, error, fallback = "Procurement request failed.") {
  const status = Number.isInteger(error.status) ? error.status : 500;
  return res.status(status).json({
    error: error.message || fallback,
    ...(Array.isArray(error.diff) ? { differences: error.diff } : {}),
  });
}

async function writeAudit(projectId, entityId, actor, eventType, reason, metadata = {}, session) {
  const [event] = await AuditEvent.create([{
    projectId,
    entityId,
    actor,
    eventType,
    reason,
    metadata,
  }], session ? { session } : undefined);
  return event;
}

async function releaseReservation(reservation, session) {
  for (const item of reservation.items) {
    const stockUpdate = await CatalogProduct.updateOne(
      { sku: item.sku, reservedQuantity: { $gte: item.quantity } },
      { $inc: { reservedQuantity: -item.quantity } },
      { session }
    );
    if (stockUpdate.modifiedCount !== 1) {
      throw new Error(`Could not release reserved stock for ${item.sku}; manual reconciliation is required.`);
    }
  }
  const budgetUpdate = await ProcurementProject.updateOne(
    { _id: reservation.projectId, reservedBudgetMinor: { $gte: reservation.budgetMinor } },
    { $inc: { reservedBudgetMinor: -reservation.budgetMinor } },
    { session }
  );
  if (budgetUpdate.modifiedCount !== 1) {
    throw new Error("Could not release the reserved budget; manual reconciliation is required.");
  }
  reservation.state = "RELEASED";
  reservation.releasedAt = new Date();
  await reservation.save({ session });
}

function unansweredCriticalQuestions(project) {
  return project.clarificationQuestions.filter((item) => item.critical && !item.answer?.trim());
}

function updateProjectReadiness(project) {
  project.status = unansweredCriticalQuestions(project).length ? "NEEDS_CLARIFICATION" : "READY_TO_PLAN";
}

function amountInput(value, fieldName) {
  try {
    const minor = parseUsdMinorUnits(value);
    if (minor <= 0) throw new Error(`${fieldName} must be greater than zero.`);
    return minor;
  } catch (error) {
    error.status = 400;
    throw error;
  }
}

function nonNegativeAmountInput(value, fieldName) {
  try {
    return parseUsdMinorUnits(value);
  } catch (error) {
    error.status = 400;
    error.message = `${fieldName}: ${error.message}`;
    throw error;
  }
}

async function invalidatePlans(projectId, reason) {
  await Plan.updateMany(
    { projectId, status: { $in: ["DRAFT", "VALIDATED", "APPROVED"] } },
    { $set: { status: "SUPERSEDED" } }
  );
  await Approval.updateMany(
    { projectId, invalidatedAt: null },
    { $set: { invalidatedAt: new Date(), invalidationReason: reason } }
  );
}

function applyExtraction(project, extraction, explicit) {
  const budgetMinor = explicit.budgetMinor
    ?? (extraction.budgetUsd ? nonNegativeAmountInput(extraction.budgetUsd, "AI-extracted budget") : undefined)
    ?? project.budgetMinor;
  let contingencyMinor = explicit.contingencyMinor
    ?? (extraction.contingencyUsd ? nonNegativeAmountInput(extraction.contingencyUsd, "AI-extracted contingency") : undefined);
  if (contingencyMinor === undefined && extraction.contingencyPercent !== undefined) {
    contingencyMinor = Math.round(budgetMinor * extraction.contingencyPercent / 100);
  }
  contingencyMinor ??= project.contingencyMinor;

  if (contingencyMinor > budgetMinor) {
    const error = new Error("Contingency cannot exceed the total budget.");
    error.status = 400;
    throw error;
  }

  project.title = explicit.title || extraction.title || project.title;
  project.budgetMinor = budgetMinor;
  project.contingencyMinor = contingencyMinor;
  if (explicit.beneficiaryCount !== undefined) {
    project.beneficiaryCount = explicit.beneficiaryCount;
  } else if (extraction.beneficiaryCount !== undefined) {
    project.beneficiaryCount = extraction.beneficiaryCount;
  }
  project.structuredRequirements = {
    requiredItems: extraction.requiredItems,
    optionalItems: extraction.optionalItems,
    availableEquipment: extraction.availableEquipment,
    compatibilityConstraints: extraction.compatibilityConstraints,
    deadline: extraction.deadline ? new Date(extraction.deadline) : undefined,
    deliveryAssumptions: [
      ...extraction.deliveryAssumptions,
      DEMO_MERCHANT.deliveryRule,
    ],
  };
  project.candidateMappings = extraction.candidateMappings;

  const existingQuestions = new Map(
    project.clarificationQuestions.map((question) => [question.question, question])
  );
  const questions = extraction.clarificationQuestions.map((question) => ({
    question: question.question,
    critical: true,
    answer: existingQuestions.get(question.question)?.answer,
    answeredAt: existingQuestions.get(question.question)?.answeredAt,
  }));
  if (!project.budgetMinor) {
    questions.push({ question: "What is the total budget in USD?", critical: true });
  }
  if (!explicit.beneficiaryCount && !extraction.beneficiaryCount) {
    questions.push({ question: "How many people will benefit from this purchase?", critical: true });
  }
  for (const requirement of extraction.requiredItems) {
    if (!requirement.minQuantity) {
      questions.push({
        question: `What minimum quantity is required for "${requirement.description}"?`,
        critical: true,
      });
    }
  }
  const currentQuestionTexts = new Set(questions.map((question) => question.question));
  for (const question of project.clarificationQuestions) {
    if (question.answer?.trim() && !currentQuestionTexts.has(question.question)) {
      questions.push(question.toObject ? question.toObject() : question);
    }
  }
  project.clarificationQuestions = [
    ...new Map(questions.map((question) => [question.question, question])).values(),
  ];
  for (const requirement of project.structuredRequirements.requiredItems) {
    const quantityQuestion = project.clarificationQuestions.find((question) => (
      question.question.includes(requirement.description)
      && /minimum quantity/i.test(question.question)
      && question.answer?.trim()
    ));
    if (quantityQuestion) {
      const quantity = Number(quantityQuestion.answer.trim());
      if (Number.isSafeInteger(quantity) && quantity > 0) requirement.minQuantity = quantity;
    }
  }
  project.aiStatus = "READY";
  project.aiError = undefined;
  project.assumptionsConfirmedAt = undefined;
  updateProjectReadiness(project);
}

async function runExtraction(project, explicit = {}) {
  const catalog = await CatalogProduct.find({
    active: true,
    merchantId: DEMO_MERCHANT.id,
    currency: "USD",
  }).lean();
  const hasUnansweredQuestion = (pattern) => project.clarificationQuestions.some(
    (question) => pattern.test(question.question) && !question.answer?.trim()
  );
  const hasUnansweredBudget = hasUnansweredQuestion(/budget/i);
  const hasUnansweredBeneficiaries = hasUnansweredQuestion(/how many people|beneficiar/i);
  const effective = {
    ...explicit,
    beneficiaryCount: explicit.beneficiaryCount
      ?? (project.aiStatus === "NOT_RUN" || hasUnansweredBeneficiaries ? undefined : project.beneficiaryCount),
    budgetMinor: explicit.budgetMinor
      ?? (!hasUnansweredBudget && project.budgetMinor ? project.budgetMinor : undefined),
    contingencyMinor: explicit.contingencyMinor
      ?? (project.contingencyMinor ? project.contingencyMinor : undefined),
  };
  const extraction = await extractProcurementRequirements({
    goal: project.originalGoal,
    beneficiaryCount: effective.beneficiaryCount,
    budgetUsd: explicit.budgetUsd
      ?? (effective.budgetMinor !== undefined ? (effective.budgetMinor / 100).toFixed(2) : undefined),
    contingencyUsd: explicit.contingencyUsd
      ?? (effective.contingencyMinor !== undefined ? (effective.contingencyMinor / 100).toFixed(2) : undefined),
    clarificationAnswers: project.clarificationQuestions
      .filter((question) => question.answer?.trim())
      .slice(-20)
      .map((question) => ({ question: question.question, answer: question.answer })),
    catalog,
  });
  applyExtraction(project, extraction, effective);
  await project.save();
  await invalidatePlans(project._id, "Procurement requirements were re-extracted.");
  await writeAudit(
    project._id,
    project._id,
    "AI",
    "REQUIREMENTS_EXTRACTED",
    "AI extracted requirements and proposed catalog mappings; deterministic validation is required before approval.",
    { requiredCount: extraction.requiredItems.length, optionalCount: extraction.optionalItems.length }
  );
  return project;
}

async function getStorefront(req, res) {
  try {
    const products = await CatalogProduct.find({
      active: true,
      merchantId: DEMO_MERCHANT.id,
      currency: "USD",
    }).sort({ category: 1, unitPriceMinor: 1 }).lean();
    res.json({
      merchant: DEMO_MERCHANT,
      products: products.map((product) => ({
        ...product,
        availableStock: Math.max(0, product.stock - product.reservedQuantity),
        demoInventory: true,
      })),
      paypal: getConfigurationStatus(),
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listProjects(req, res) {
  try {
    const projects = await ProcurementProject.find().sort({ updatedAt: -1 }).lean();
    res.json(projects);
  } catch (error) {
    sendError(res, error);
  }
}

async function getProject(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId).lean();
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    const [plans, approvals, checkoutAttempts, audit] = await Promise.all([
      Plan.find({ projectId: project._id }).sort({ version: -1 }).lean(),
      Approval.find({ projectId: project._id }).sort({ approvedAt: -1 }).lean(),
      CheckoutAttempt.find({ projectId: project._id }).sort({ createdAt: -1 }).lean(),
      AuditEvent.find({ projectId: project._id }).sort({ timestamp: -1 }).limit(100).lean(),
    ]);
    res.json({ project, plans, approvals, checkoutAttempts, audit });
  } catch (error) {
    sendError(res, error);
  }
}

async function createProject(req, res) {
  let project;
  try {
    const { title, originalGoal, currency = "USD" } = req.body;
    if (currency !== "USD") {
      return res.status(400).json({ error: "TrustGate Procurement currently supports USD only." });
    }
    if (typeof originalGoal !== "string" || !originalGoal.trim() || originalGoal.length > GOAL_MAX_LENGTH) {
      return res.status(400).json({ error: `Describe a goal using 1-${GOAL_MAX_LENGTH} characters.` });
    }
    const suppliedBeneficiaries = req.body.beneficiaryCount === undefined || req.body.beneficiaryCount === ""
      ? undefined
      : Number(req.body.beneficiaryCount);
    if (suppliedBeneficiaries !== undefined
      && (!Number.isSafeInteger(suppliedBeneficiaries) || suppliedBeneficiaries < 1 || suppliedBeneficiaries > 10000)) {
      return res.status(400).json({ error: "Beneficiary count must be an integer from 1 to 10,000." });
    }
    const suppliedBudgetMinor = req.body.budgetUsd === undefined || req.body.budgetUsd === ""
      ? undefined
      : amountInput(req.body.budgetUsd, "Budget");
    const suppliedContingencyMinor = req.body.contingencyUsd === undefined || req.body.contingencyUsd === ""
      ? undefined
      : nonNegativeAmountInput(req.body.contingencyUsd, "Contingency");
    if (suppliedContingencyMinor !== undefined
      && suppliedBudgetMinor !== undefined
      && suppliedContingencyMinor > suppliedBudgetMinor) {
      return res.status(400).json({ error: "Contingency cannot exceed the budget." });
    }

    project = await ProcurementProject.create({
      title: typeof title === "string" && title.trim() ? title.trim().slice(0, 160) : originalGoal.trim().slice(0, 160),
      originalGoal: originalGoal.trim(),
      beneficiaryCount: suppliedBeneficiaries || 1,
      currency,
      budgetMinor: suppliedBudgetMinor || 0,
      contingencyMinor: suppliedContingencyMinor || 0,
      status: "DRAFT",
      aiStatus: "NOT_RUN",
    });
    await writeAudit(project._id, project._id, "USER", "PROJECT_CREATED", "Procurement goal saved.", {
      title: project.title,
      currency,
    });
  } catch (error) {
    return sendError(res, error);
  }

  try {
    const extracted = await runExtraction(project, {
      title: req.body.title,
      beneficiaryCount: req.body.beneficiaryCount ? Number(req.body.beneficiaryCount) : undefined,
      budgetUsd: req.body.budgetUsd || undefined,
      contingencyUsd: req.body.contingencyUsd || undefined,
      budgetMinor: req.body.budgetUsd ? amountInput(req.body.budgetUsd, "Budget") : undefined,
      contingencyMinor: req.body.contingencyUsd ? nonNegativeAmountInput(req.body.contingencyUsd, "Contingency") : undefined,
    });
    return res.status(201).json({ project: extracted, extractionError: null });
  } catch (error) {
    project.aiStatus = "FAILED";
    project.aiError = error.message.slice(0, 1000);
    if (!req.body.budgetUsd) {
      project.clarificationQuestions.push({ question: "What is the total budget in USD?", critical: true });
    }
    if (!req.body.beneficiaryCount) {
      project.clarificationQuestions.push({ question: "How many people will benefit from this purchase?", critical: true });
    }
    updateProjectReadiness(project);
    await project.save();
    await writeAudit(project._id, project._id, "SYSTEM", "REQUIREMENTS_EXTRACTION_FAILED", error.message);
    return res.status(201).json({ project, extractionError: error.message });
  }
}

async function retryExtraction(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    if (project.status === "COMPLETED" || project.status === "CHECKOUT") {
      return res.status(409).json({ error: "Requirements cannot be re-extracted after checkout has started." });
    }
    const extracted = await runExtraction(project);
    res.json({ project: extracted, extractionError: null });
  } catch (error) {
    sendError(res, error);
  }
}

async function answerClarifications(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    if (project.status === "COMPLETED" || project.status === "CHECKOUT") {
      return res.status(409).json({ error: "Clarifications cannot be changed after checkout has started." });
    }

    const { answers = [], beneficiaryCount, budgetUsd, contingencyUsd } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: "Answers must be an array." });
    let materialChange = false;
    for (const answer of answers) {
      if (!Number.isSafeInteger(answer.index) || answer.index < 0 || answer.index >= project.clarificationQuestions.length) {
        return res.status(400).json({ error: "A clarification answer references an invalid question." });
      }
      if (typeof answer.value !== "string" || answer.value.length > 1000) {
        return res.status(400).json({ error: "Clarification answers must be strings of 1,000 characters or fewer." });
      }
      const currentQuestion = project.clarificationQuestions[answer.index];
      if (currentQuestion.answer !== answer.value.trim()) materialChange = true;
      currentQuestion.answer = answer.value.trim();
      currentQuestion.answeredAt = new Date();
      const question = project.clarificationQuestions[answer.index].question.toLowerCase();
      if (question.includes("budget")) {
        const newBudget = amountInput(answer.value.trim(), "Budget");
        if (newBudget !== project.budgetMinor) materialChange = true;
        project.budgetMinor = newBudget;
      } else if (question.includes("how many people") || question.includes("beneficiary count")) {
        const count = Number(answer.value.trim());
        if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
          return res.status(400).json({ error: "Beneficiary count must be an integer from 1 to 10,000." });
        }
        if (count !== project.beneficiaryCount) materialChange = true;
        project.beneficiaryCount = count;
      }
    }
    if (beneficiaryCount !== undefined) {
      const count = Number(beneficiaryCount);
      if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
        return res.status(400).json({ error: "Beneficiary count must be an integer from 1 to 10,000." });
      }
      if (count !== project.beneficiaryCount) materialChange = true;
      project.beneficiaryCount = count;
    }
    if (budgetUsd !== undefined) {
      const newBudget = amountInput(budgetUsd, "Budget");
      if (newBudget !== project.budgetMinor) materialChange = true;
      project.budgetMinor = newBudget;
    }
    if (contingencyUsd !== undefined) {
      const newContingency = nonNegativeAmountInput(contingencyUsd, "Contingency");
      if (newContingency !== project.contingencyMinor) materialChange = true;
      project.contingencyMinor = newContingency;
    }
    project.assumptionsConfirmedAt = req.body.confirmAssumptions === true ? new Date() : undefined;
    if (project.contingencyMinor > project.budgetMinor) {
      return res.status(400).json({ error: "Contingency cannot exceed the budget." });
    }
    for (const requirement of project.structuredRequirements.requiredItems) {
      const question = project.clarificationQuestions.find((entry) => (
        entry.question.includes(requirement.description) && entry.question.includes("minimum quantity")
      ));
      if (question?.answer) {
        const quantity = Number(question.answer);
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
          return res.status(400).json({ error: `Provide a positive whole-number quantity for "${requirement.description}".` });
        }
        if (quantity !== requirement.minQuantity) materialChange = true;
        requirement.minQuantity = quantity;
      }
    }
    updateProjectReadiness(project);
    project.updatedAt = new Date();
    await project.save();
    if (materialChange) await invalidatePlans(project._id, "Clarification answers or project budget changed.");
    await writeAudit(project._id, project._id, "USER", "CLARIFICATIONS_ANSWERED", "Organizer updated missing procurement details.", {
      answeredCount: answers.length,
      beneficiaryCount: project.beneficiaryCount,
      budgetMinor: project.budgetMinor,
      contingencyMinor: project.contingencyMinor,
    });
    res.json(project);
  } catch (error) {
    sendError(res, error);
  }
}

function nextPlanVersion(projectId) {
  return Plan.findOne({ projectId }).sort({ version: -1 }).select("version").lean()
    .then((previous) => (previous?.version || 0) + 1);
}

async function savePlan(project, strategy, items, mappings, actor, reason, { supersedePrevious = true } = {}) {
  const skus = [...new Set(items.map((item) => String(item.sku || "").toUpperCase()))];
  const products = await CatalogProduct.find({ sku: { $in: skus } });
  const validation = validatePlan(project, { items, requirementMappings: mappings }, products);
  const version = await nextPlanVersion(project._id);
  const contentHash = hashPlan(project, validation);
  if (supersedePrevious) {
    const previousPlans = await Plan.find({ projectId: project._id, status: { $in: ["DRAFT", "VALIDATED", "APPROVED"] } });
    for (const previous of previousPlans) {
      previous.status = "SUPERSEDED";
      await previous.save();
    }
    const approvals = await Approval.find({
      projectId: project._id,
      invalidatedAt: null,
    });
    for (const approval of approvals) {
      approval.invalidatedAt = new Date();
      approval.invalidationReason = "A new plan version was created.";
      await approval.save();
    }
  }
  const plan = await Plan.create({
    projectId: project._id,
    version,
    strategy,
    strategyExplanation: strategy === "LOWEST_COST"
      ? "Lowest validated total for mandatory coverage; this is a bounded candidate search, not a global-optimum guarantee."
      : strategy === "BALANCED"
        ? "Prefers the AI's first eligible catalog matches, then lower validated cost."
        : "Adds eligible optional requirements that fit the usable budget after mandatory coverage.",
    ...validation,
    contentHash,
    status: validation.validationReport.valid ? "VALIDATED" : "DRAFT",
  });
  project.status = "PLANNED";
  await project.save();
  await writeAudit(project._id, plan._id, actor, "PLAN_VERSION_CREATED", reason, {
    version,
    strategy,
    totalMinor: plan.totalMinor,
    contentHash,
    validation: plan.validationReport,
  });
  return plan;
}

async function generatePlans(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    if (project.status === "CHECKOUT" || project.status === "COMPLETED") {
      return res.status(409).json({ error: "New plans cannot be generated after checkout begins." });
    }
    if (unansweredCriticalQuestions(project).length) {
      return res.status(409).json({
        error: "Answer all critical clarification questions before generating plans.",
        questions: unansweredCriticalQuestions(project),
      });
    }
    const products = await CatalogProduct.find({
      active: true,
      merchantId: DEMO_MERCHANT.id,
      currency: "USD",
    });
    const proposals = chooseCandidateMappings(project, project.candidateMappings, products);
    if (!proposals.plans.length) {
      return res.status(422).json({
        error: proposals.explanation || "No feasible basket can be generated.",
        unmetRequirements: proposals.unmetRequirements,
      });
    }

    await invalidatePlans(project._id, "A new set of AI plan options was generated.");
    const plans = [];
    for (const candidate of proposals.plans) {
      const plan = await savePlan(
        project,
        candidate.strategy,
        candidate.items,
        candidate.requirementMappings,
        "AI",
        `AI-proposed ${candidate.strategy} basket; deterministic validation passed.`,
        { supersedePrevious: false }
      );
      plans.push(plan);
    }
    res.status(201).json({ plans, strategyNotes: {
      LOWEST_COST: "Lowest validated total for mandatory coverage.",
      BALANCED: "Favors the AI's first eligible catalog matches, then lower validated cost.",
      MAXIMUM_COVERAGE: "Adds the most eligible optional requirements that fit the usable budget.",
      boundedSearch: "Mandatory combinations are explored up to 256 candidates; no global-optimum claim is made.",
    } });
  } catch (error) {
    sendError(res, error);
  }
}

async function editPlan(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    if (project.status === "CHECKOUT" || project.status === "COMPLETED") {
      return res.status(409).json({ error: "Plans cannot be changed after checkout begins." });
    }
    const oldPlan = await Plan.findOne({ _id: req.params.planId, projectId: project._id });
    if (!oldPlan) return res.status(404).json({ error: "Plan version not found for this project." });
    if (!Array.isArray(req.body.items) || req.body.items.length > 50 || !Array.isArray(req.body.requirementMappings || [])) {
      return res.status(400).json({ error: "Provide at most 50 basket lines and an array of requirement mappings." });
    }
    const oldSnapshot = oldPlan.toObject();
    const plan = await savePlan(
      project,
      oldPlan.strategy,
      req.body.items,
      req.body.requirementMappings || [],
      "USER",
      "Organizer edited the basket; a new version was created and prior approvals invalidated."
    );
    await writeAudit(project._id, plan._id, "USER", "PLAN_CHANGED", "New basket version supersedes prior review.", {
      previousVersion: oldSnapshot.version,
      version: plan.version,
      previousHash: oldSnapshot.contentHash,
      contentHash: plan.contentHash,
    });
    res.status(201).json(plan);
  } catch (error) {
    sendError(res, error);
  }
}

async function createManualPlan(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    if (project.status === "CHECKOUT" || project.status === "COMPLETED") {
      return res.status(409).json({ error: "Plans cannot be changed after checkout begins." });
    }
    if (unansweredCriticalQuestions(project).length) {
      return res.status(409).json({ error: "Answer all critical clarification questions before creating a basket." });
    }
    if (!Array.isArray(req.body.items) || req.body.items.length > 50) {
      return res.status(400).json({ error: "Provide at most 50 basket lines." });
    }
    const plan = await savePlan(
      project,
      "BALANCED",
      req.body.items,
      Array.isArray(req.body.requirementMappings) ? req.body.requirementMappings : [],
      "USER",
      "Organizer created a basket manually from the curated demo catalog."
    );
    res.status(201).json(plan);
  } catch (error) {
    sendError(res, error);
  }
}

async function approvePlan(req, res) {
  try {
    const project = await ProcurementProject.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Procurement project not found." });
    const plan = await Plan.findOne({ _id: req.params.planId, projectId: project._id });
    if (!plan) return res.status(404).json({ error: "Plan version not found for this project." });
    if (plan.status === "CHECKOUT" || project.status === "CHECKOUT" || project.status === "COMPLETED") {
      return res.status(409).json({ error: "A plan with an existing checkout attempt cannot be reapproved. Reconcile or complete that attempt first." });
    }
    if (!["VALIDATED", "APPROVED"].includes(plan.status) || !plan.validationReport.valid) {
      return res.status(409).json({ error: "Only a deterministically validated plan can be approved." });
    }
    const unanswered = unansweredCriticalQuestions(project);
    if (unanswered.length) {
      return res.status(409).json({ error: "Resolve critical assumptions before approving.", questions: unanswered });
    }
    if (!project.assumptionsConfirmedAt) {
      return res.status(409).json({ error: "Confirm the listed delivery and demo-store assumptions before approving this plan." });
    }
    const approvalProducts = await CatalogProduct.find({ sku: { $in: plan.items.map((item) => item.sku) } });
    const currentValidation = validatePlan(project, {
      items: plan.items,
      requirementMappings: plan.requirementMappings,
    }, approvalProducts, { checkStock: true, checkSnapshot: true });
    if (!currentValidation.validationReport.valid || currentValidation.totalMinor !== plan.totalMinor) {
      return res.status(409).json({
        error: "Catalog, stock, compatibility, or totals changed. Create and review a new plan version before approval.",
        differences: currentValidation.validationReport.blockingIssues,
      });
    }
    if (hashPlan(project, plan.toObject()) !== plan.contentHash) {
      return res.status(409).json({ error: "Plan content changed; regenerate it and review the new version before approval." });
    }
    const expiresAt = new Date(Date.now() + APPROVAL_HOURS * 60 * 60 * 1000);
    await Approval.updateMany(
      { projectId: project._id, invalidatedAt: null },
      { $set: { invalidatedAt: new Date(), invalidationReason: "A replacement approval was issued." } }
    );
    const approval = await Approval.create({
      projectId: project._id,
      planId: plan._id,
      planVersion: plan.version,
      contentHash: plan.contentHash,
      approvedTotalMinor: plan.totalMinor,
      currency: "USD",
      expiresAt,
    });
    plan.status = "APPROVED";
    project.status = "APPROVED";
    await Promise.all([plan.save(), project.save()]);
    await writeAudit(project._id, approval._id, "USER", "PLAN_APPROVED", "Organizer approved this exact plan version and total.", {
      planId: String(plan._id),
      planVersion: plan.version,
      contentHash: plan.contentHash,
      approvedTotalMinor: plan.totalMinor,
      expiresAt,
    });
    res.status(201).json({ approval, plan, project });
  } catch (error) {
    sendError(res, error);
  }
}

function assertPlanCurrent(project, plan, products) {
  if (plan.status !== "APPROVED" && plan.status !== "CHECKOUT") {
    throw Object.assign(new Error("This plan version is not approved."), { status: 409 });
  }
  if (hashPlan(project, plan.toObject()) !== plan.contentHash) {
    throw Object.assign(new Error("Plan hash changed after approval. Recreate and review the plan before checkout."), { status: 409 });
  }
  const validation = validatePlan(project, {
    items: plan.items,
    requirementMappings: plan.requirementMappings,
  }, products, { checkStock: true, checkSnapshot: true });
  if (!validation.validationReport.valid) {
    throw Object.assign(new Error(`Plan cannot proceed: ${validation.validationReport.blockingIssues.join(" ")}`), {
      status: 409,
      diff: validation.validationReport.blockingIssues,
    });
  }
}

async function startCheckout(req, res) {
  let session;
  let attempt;
  let reservation;
  let approval;
  let plan;
  let project;
  let reservationCommitted = false;
  const approvalId = req.body.approvalId;
  const clientIdempotencyKey = String(req.get("Idempotency-Key") || req.body.idempotencyKey || "");
  try {
    const { projectId } = req.params;
    if (!/^[\w.-]{16,200}$/.test(clientIdempotencyKey)) {
      return res.status(400).json({ error: "Checkout requires a 16-200 character idempotency key." });
    }
    const existing = await CheckoutAttempt.findOne({ clientIdempotencyKey });
    if (existing) {
      if (existing.projectId.toString() !== projectId || existing.approvalId.toString() !== String(approvalId)) {
        return res.status(409).json({ error: "Idempotency key was already used for a different checkout request." });
      }
      return res.json({ attempt: existing, orderId: existing.paypalOrderId, reused: true });
    }

    session = await mongoose.startSession();
    const attemptId = new mongoose.Types.ObjectId();
    const reservationId = new mongoose.Types.ObjectId();
    const requestHash = crypto.createHash("sha256").update(`${projectId}:${approvalId}`).digest("hex");
    await session.withTransaction(async () => {
      project = await ProcurementProject.findById(projectId).session(session);
      if (!project) throw Object.assign(new Error("Procurement project not found."), { status: 404 });
      if (!project.assumptionsConfirmedAt || unansweredCriticalQuestions(project).length) {
        throw Object.assign(new Error("Confirm assumptions and resolve critical questions before checkout."), { status: 409 });
      }
      approval = await Approval.findOne({
        _id: approvalId,
        projectId: project._id,
        invalidatedAt: null,
      }).session(session);
      if (!approval) throw Object.assign(new Error("Valid approval not found. Review and approve the current plan."), { status: 409 });
      if (approval.expiresAt <= new Date()) throw Object.assign(new Error("Approval expired. Review and approve the plan again."), { status: 409 });
      plan = await Plan.findOne({ _id: approval.planId, projectId: project._id }).session(session);
      if (!plan || plan.version !== approval.planVersion || plan.contentHash !== approval.contentHash
        || plan.totalMinor !== approval.approvedTotalMinor) {
        throw Object.assign(new Error("Approved plan snapshot no longer matches. Review the current plan and approve again."), { status: 409 });
      }
      const activeAttempt = await CheckoutAttempt.findOne({
        projectId: project._id,
        executionState: {
          $in: ["RESERVED", "ORDER_CREATING", "APPROVAL_PENDING", "APPROVED", "CAPTURE_PENDING", "RECONCILIATION_REQUIRED"],
        },
      }).session(session);
      if (activeAttempt) {
        throw Object.assign(new Error("This approval already has an active checkout attempt. Reuse or reconcile that attempt before starting another."), { status: 409 });
      }
      const skus = [...new Set(plan.items.map((item) => item.sku))];
      const products = await CatalogProduct.find({ sku: { $in: skus } }).session(session);
      assertPlanCurrent(project, plan, products);

      const budgetReservation = await ProcurementProject.updateOne(
        {
          _id: project._id,
          $expr: {
            $lte: [
              { $add: ["$reservedBudgetMinor", "$committedBudgetMinor", plan.totalMinor] },
              { $subtract: ["$budgetMinor", "$contingencyMinor"] },
            ],
          },
        },
        { $inc: { reservedBudgetMinor: plan.totalMinor } },
        { session }
      );
      if (budgetReservation.modifiedCount !== 1) {
        throw Object.assign(new Error("This purchase would exceed the project's usable budget after existing reservations and completed purchases."), { status: 409 });
      }

      const reservedItems = [];
      for (const line of plan.items) {
        const updated = await CatalogProduct.updateOne(
          {
            sku: line.sku,
            active: true,
            currency: "USD",
            merchantId: DEMO_MERCHANT.id,
            $expr: { $gte: [{ $subtract: ["$stock", "$reservedQuantity"] }, line.quantity] },
          },
          { $inc: { reservedQuantity: line.quantity } },
          { session }
        );
        if (updated.modifiedCount !== 1) {
          throw Object.assign(new Error(`${line.sku} stock changed while reserving; review and revalidate the plan.`), { status: 409 });
        }
        reservedItems.push({ sku: line.sku, quantity: line.quantity });
      }

      [reservation] = await Reservation.create([{
        _id: reservationId,
        projectId: project._id,
        checkoutAttemptId: attemptId,
        budgetMinor: plan.totalMinor,
        items: reservedItems,
        state: "ACTIVE",
        expiresAt: new Date(Date.now() + RESERVATION_HOURS * 60 * 60 * 1000),
      }], { session });
      [attempt] = await CheckoutAttempt.create([{
        _id: attemptId,
        projectId: project._id,
        approvalId: approval._id,
        clientIdempotencyKey,
        requestHash,
        reservationId,
        expectedAmountMinor: plan.totalMinor,
        currency: "USD",
        executionState: "ORDER_CREATING",
        paypalCreateRequestId: crypto.randomUUID(),
        paypalCaptureRequestId: crypto.randomUUID(),
      }], { session });
      plan.status = "CHECKOUT";
      project.status = "CHECKOUT";
      await Promise.all([plan.save({ session }), project.save({ session })]);
      await writeAudit(project._id, attempt._id, "SYSTEM", "BUDGET_AND_STOCK_RESERVED", "Budget allocation and stock reserved atomically before PayPal order creation.", {
        budgetMinor: plan.totalMinor,
        items: reservedItems,
        expiresAt: reservation.expiresAt,
      }, session);
    });

    reservationCommitted = true;
    await session.endSession();
    session = null;
    const order = await createProcurementPayPalOrder({
      amountMinor: attempt.expectedAmountMinor,
      description: `${project.title} - plan v${plan.version}`,
      referenceId: String(attempt._id),
      requestId: attempt.paypalCreateRequestId,
    });
    attempt.paypalOrderId = order.orderId;
    attempt.executionState = "APPROVAL_PENDING";
    await attempt.save();
    await writeAudit(project._id, attempt._id, "PAYPAL", "PAYPAL_ORDER_CREATED", "Sandbox checkout order created for approved basket.", {
      paypalOrderId: order.orderId,
      amountMinor: attempt.expectedAmountMinor,
      currency: "USD",
    });
    return res.status(201).json({ attempt, orderId: order.orderId });
  } catch (error) {
    if (session) await session.endSession();
    if (error.code === 11000) {
      const priorAttempt = await CheckoutAttempt.findOne({ clientIdempotencyKey });
      if (priorAttempt
        && priorAttempt.projectId.toString() === req.params.projectId
        && priorAttempt.approvalId.toString() === String(approvalId)) {
        return res.json({ attempt: priorAttempt, orderId: priorAttempt.paypalOrderId, reused: true });
      }
      return res.status(409).json({ error: "Checkout request was already created or the idempotency key is in use." });
    }
    if (reservationCommitted && attempt?._id && reservation?._id) {
      if (error.definitive) {
        const releaseSession = await mongoose.startSession();
        try {
          await releaseSession.withTransaction(async () => {
            const currentReservation = await Reservation.findById(reservation._id).session(releaseSession);
            if (currentReservation?.state === "ACTIVE") {
              await releaseReservation(currentReservation, releaseSession);
            }
            attempt.executionState = "FAILED";
            attempt.sanitizedError = error.message.slice(0, 1000);
            await attempt.save({ session: releaseSession });
            const currentProject = await ProcurementProject.findById(attempt.projectId).session(releaseSession);
            const currentApproval = await Approval.findById(attempt.approvalId).session(releaseSession);
            const currentPlan = currentApproval
              ? await Plan.findById(currentApproval.planId).session(releaseSession)
              : null;
            if (currentProject?.status === "CHECKOUT") currentProject.status = "APPROVED";
            if (currentPlan?.status === "CHECKOUT") currentPlan.status = "APPROVED";
            if (currentProject) await currentProject.save({ session: releaseSession });
            if (currentPlan) await currentPlan.save({ session: releaseSession });
            await writeAudit(attempt.projectId, attempt._id, "PAYPAL", "PAYPAL_ORDER_FAILED", error.message, {}, releaseSession);
          });
        } catch (releaseError) {
          attempt.executionState = "RECONCILIATION_REQUIRED";
          attempt.sanitizedError = releaseError.message.slice(0, 1000);
          await attempt.save();
          reservation.state = "RECONCILIATION_REQUIRED";
          await reservation.save();
          await writeAudit(attempt.projectId, attempt._id, "SYSTEM", "RESERVATION_RELEASE_FAILED", releaseError.message);
          error.status = 502;
        } finally {
          await releaseSession.endSession();
        }
      } else {
        attempt.executionState = "RECONCILIATION_REQUIRED";
        attempt.sanitizedError = (error.message || "PayPal order creation outcome is ambiguous.").slice(0, 1000);
        await attempt.save();
        reservation.state = "RECONCILIATION_REQUIRED";
        await reservation.save();
        await writeAudit(attempt.projectId, attempt._id, "PAYPAL", "PAYPAL_ORDER_OUTCOME_AMBIGUOUS", attempt.sanitizedError);
      }
    }
    if (attempt?._id) {
      return res.status(error.status || error.paypalStatus || 502).json({
        error: error.message || "PayPal checkout could not be created.",
        attempt,
        reconciliationRequired: attempt.executionState === "RECONCILIATION_REQUIRED",
      });
    }
    return sendError(res, error);
  }
}

async function captureCheckout(req, res) {
  try {
    const attempt = await CheckoutAttempt.findOne({
      _id: req.params.attemptId,
      projectId: req.params.projectId,
    });
    if (!attempt) return res.status(404).json({ error: "Checkout attempt not found." });
    if (attempt.executionState === "COMPLETED") return res.json({ attempt, completed: true });
    if (!attempt.paypalOrderId) return res.status(409).json({ error: "PayPal order has not been created." });
    if (!["APPROVAL_PENDING", "APPROVED", "CAPTURE_PENDING", "RECONCILIATION_REQUIRED"].includes(attempt.executionState)) {
      return res.status(409).json({ error: `Checkout cannot be captured from state ${attempt.executionState}.` });
    }
    const [project, approval, reservation] = await Promise.all([
      ProcurementProject.findById(attempt.projectId),
      Approval.findById(attempt.approvalId),
      Reservation.findById(attempt.reservationId),
    ]);
    const plan = approval
      ? await Plan.findOne({ _id: approval.planId, projectId: attempt.projectId })
      : null;
    if (!project || !approval || !plan || !reservation) {
      return res.status(409).json({ error: "Approved procurement snapshot or reservation is missing; manual reconciliation is required." });
    }
    if (approval.invalidatedAt || approval.expiresAt <= new Date()
      || approval.contentHash !== plan.contentHash
      || approval.approvedTotalMinor !== attempt.expectedAmountMinor) {
      attempt.executionState = "RECONCILIATION_REQUIRED";
      attempt.sanitizedError = "Approval expired or no longer matches the checkout snapshot.";
      await attempt.save();
      await Reservation.updateOne(
        { _id: reservation._id, state: "ACTIVE" },
        { $set: { state: "RECONCILIATION_REQUIRED" } }
      );
      await writeAudit(project._id, attempt._id, "SYSTEM", "CAPTURE_BLOCKED_BY_APPROVAL_CHANGE", attempt.sanitizedError);
      return res.status(409).json({ error: `${attempt.sanitizedError} Do not capture; reconcile the PayPal order before releasing its reservation.` });
    }
    if (hashPlan(project, plan.toObject()) !== approval.contentHash) {
      return res.status(409).json({ error: "Approved basket content changed. Capture is blocked; review the plan diff and reconcile this PayPal order." });
    }

    const products = await CatalogProduct.find({ sku: { $in: plan.items.map((item) => item.sku) } });
    const validation = validatePlan(project, {
      items: plan.items,
      requirementMappings: plan.requirementMappings,
    }, products, { checkStock: false, checkSnapshot: true });
    if (!validation.validationReport.valid || validation.totalMinor !== attempt.expectedAmountMinor) {
      attempt.executionState = "RECONCILIATION_REQUIRED";
      attempt.sanitizedError = `Current catalog differs from approved snapshot: ${validation.validationReport.blockingIssues.join(" ")}`.slice(0, 1000);
      await attempt.save();
      await writeAudit(project._id, attempt._id, "SYSTEM", "CAPTURE_BLOCKED_BY_CATALOG_CHANGE", attempt.sanitizedError, {
        differences: validation.validationReport.blockingIssues,
      });
      return res.status(409).json({ error: attempt.sanitizedError, differences: validation.validationReport.blockingIssues });
    }

    const currentOrder = await getPayPalOrder(attempt.paypalOrderId);
    if (currentOrder.currency !== "USD"
      || Number(currentOrder.amount) !== attempt.expectedAmountMinor / 100) {
      attempt.executionState = "RECONCILIATION_REQUIRED";
      attempt.sanitizedError = "PayPal order amount or currency does not match the approved USD total.";
      await attempt.save();
      await writeAudit(project._id, attempt._id, "PAYPAL", "PAYPAL_AMOUNT_MISMATCH", attempt.sanitizedError, {
        expectedAmountMinor: attempt.expectedAmountMinor,
        actualAmount: currentOrder.amount,
        actualCurrency: currentOrder.currency,
      });
      return res.status(409).json({ error: attempt.sanitizedError });
    }
    if (currentOrder.paypalStatus === "COMPLETED" && currentOrder.paypalCaptureId) {
      return finalizeCapture(attempt, currentOrder, project, plan, reservation, res);
    }
    if (currentOrder.paypalStatus !== "APPROVED") {
      return res.status(409).json({ error: `Buyer must approve this PayPal order first (current status: ${currentOrder.paypalStatus}).` });
    }
    attempt.executionState = "CAPTURE_PENDING";
    await attempt.save();
    let capture;
    try {
      capture = await capturePayPalOrder(attempt.paypalOrderId, attempt.paypalCaptureRequestId);
    } catch (error) {
      attempt.executionState = "RECONCILIATION_REQUIRED";
      attempt.sanitizedError = error.message.slice(0, 1000);
      await attempt.save();
      await writeAudit(project._id, attempt._id, "PAYPAL", "PAYPAL_CAPTURE_OUTCOME_AMBIGUOUS", attempt.sanitizedError);
      return res.status(502).json({ error: "Capture result is not confirmed. Reservation is held for reconciliation.", attempt });
    }
    if (capture.paypalStatus !== "COMPLETED" || !capture.paypalCaptureId
      || capture.currency !== "USD" || Number(capture.amount) !== attempt.expectedAmountMinor / 100) {
      attempt.executionState = "RECONCILIATION_REQUIRED";
      attempt.sanitizedError = "PayPal capture was not confirmed with the approved amount and currency.";
      await attempt.save();
      await writeAudit(project._id, attempt._id, "PAYPAL", "PAYPAL_CAPTURE_REQUIRES_RECONCILIATION", attempt.sanitizedError, {
        status: capture.paypalStatus,
        amount: capture.amount,
        currency: capture.currency,
      });
      return res.status(502).json({ error: attempt.sanitizedError, attempt });
    }
    return finalizeCapture(attempt, capture, project, plan, reservation, res);
  } catch (error) {
    return sendError(res, error);
  }
}

async function finalizeCapture(attempt, capture, project, plan, reservation, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const currentAttempt = await CheckoutAttempt.findById(attempt._id).session(session);
      const currentReservation = await Reservation.findById(reservation._id).session(session);
      if (!currentAttempt || !currentReservation) throw new Error("Checkout reservation disappeared during capture finalization.");
      if (currentAttempt.executionState === "COMPLETED") return;
      if (!["ACTIVE", "RECONCILIATION_REQUIRED"].includes(currentReservation.state)) {
        throw new Error("Reservation is not active; capture cannot be finalized automatically.");
      }
      for (const item of currentReservation.items) {
        const result = await CatalogProduct.updateOne(
          { sku: item.sku, stock: { $gte: item.quantity }, reservedQuantity: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity, reservedQuantity: -item.quantity } },
          { session }
        );
        if (result.modifiedCount !== 1) {
          throw new Error(`Could not reconcile stock for ${item.sku} after confirmed capture.`);
        }
      }
      currentReservation.state = "CONSUMED";
      currentReservation.consumedAt = new Date();
      await currentReservation.save({ session });
      const currentProject = await ProcurementProject.findById(project._id).session(session);
      if (!currentProject || currentProject.reservedBudgetMinor < currentReservation.budgetMinor) {
        throw new Error("Project budget reservation is inconsistent; reconciliation is required.");
      }
      currentProject.reservedBudgetMinor -= currentReservation.budgetMinor;
      currentProject.committedBudgetMinor += currentReservation.budgetMinor;
      if (!Number.isSafeInteger(currentProject.committedBudgetMinor)) {
        throw new Error("Committed project budget exceeds the safe monetary range.");
      }
      currentAttempt.captureId = capture.paypalCaptureId;
      currentAttempt.executionState = "COMPLETED";
      currentAttempt.sanitizedError = undefined;
      currentAttempt.updatedAt = new Date();
      await currentAttempt.save({ session });
      currentProject.status = "COMPLETED";
      plan.status = "COMPLETED";
      await Promise.all([currentProject.save({ session }), plan.save({ session })]);
      await writeAudit(project._id, currentAttempt._id, "PAYPAL", "PAYMENT_CAPTURED", "PayPal confirmed capture of the exact approved basket amount.", {
        captureId: capture.paypalCaptureId,
        amountMinor: currentAttempt.expectedAmountMinor,
        currency: currentAttempt.currency,
      }, session);
    });
    const completed = await CheckoutAttempt.findById(attempt._id);
    return res.json({ attempt: completed, completed: true });
  } catch (error) {
    attempt.executionState = "RECONCILIATION_REQUIRED";
    attempt.sanitizedError = error.message.slice(0, 1000);
    await attempt.save();
    await Reservation.updateOne(
      { _id: reservation._id, state: "ACTIVE" },
      { $set: { state: "RECONCILIATION_REQUIRED" } }
    );
    await writeAudit(project._id, attempt._id, "SYSTEM", "CAPTURE_FINALIZATION_FAILED", error.message);
    return res.status(502).json({ error: "PayPal capture succeeded but inventory finalization needs reconciliation.", attempt });
  } finally {
    await session.endSession();
  }
}

async function cancelCheckout(req, res) {
  try {
    const attempt = await CheckoutAttempt.findOne({ _id: req.params.attemptId, projectId: req.params.projectId });
    if (!attempt) return res.status(404).json({ error: "Checkout attempt not found." });
    if (!attempt.paypalOrderId) return res.status(409).json({ error: "There is no PayPal order to reconcile." });
    const order = await getPayPalOrder(attempt.paypalOrderId);
    if (!["VOIDED", "CANCELLED"].includes(order.paypalStatus)) {
      return res.status(409).json({
        error: `PayPal order is ${order.paypalStatus}; reservation remains held until cancellation is confirmed or manually reconciled.`,
        attempt,
      });
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const reservation = await Reservation.findById(attempt.reservationId).session(session);
        if (reservation && ["ACTIVE", "RECONCILIATION_REQUIRED"].includes(reservation.state)) {
          await releaseReservation(reservation, session);
        }
        attempt.executionState = "CANCELLED";
        await attempt.save({ session });
        const project = await ProcurementProject.findById(attempt.projectId).session(session);
        const approval = await Approval.findById(attempt.approvalId).session(session);
        const plan = approval ? await Plan.findById(approval.planId).session(session) : null;
        if (project?.status === "CHECKOUT") project.status = "APPROVED";
        if (plan?.status === "CHECKOUT") plan.status = "APPROVED";
        if (project) await project.save({ session });
        if (plan) await plan.save({ session });
        await writeAudit(attempt.projectId, attempt._id, "PAYPAL", "RESERVATION_RELEASED", "PayPal confirmed that the order was voided/cancelled.", {}, session);
      });
    } finally {
      await session.endSession();
    }
    res.json({ attempt, released: true });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
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
};
