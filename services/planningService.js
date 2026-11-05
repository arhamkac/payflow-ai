const crypto = require("crypto");
const { DEMO_MERCHANT } = require("../config/demoStore");
const { isNonNegativeMinorUnitAmount } = require("./moneyService");

const MAX_COMBINATIONS = 256;

function canonicalContent(project, planInput) {
  return {
    projectId: String(project._id),
    budgetMinor: project.budgetMinor,
    contingencyMinor: project.contingencyMinor,
    beneficiaryCount: project.beneficiaryCount,
    currency: project.currency,
    requirements: project.structuredRequirements,
    items: [...planInput.items]
      .map((item) => ({
        sku: item.sku.toUpperCase(),
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        currency: item.currency,
        catalogVersion: item.catalogVersion,
        merchantId: item.merchantId,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku)),
    requirementMappings: [...planInput.requirementMappings]
      .map((mapping) => ({
        requirementKey: mapping.requirementKey,
        sku: mapping.sku.toUpperCase(),
        quantity: mapping.quantity,
      }))
      .sort((a, b) => `${a.requirementKey}:${a.sku}`.localeCompare(`${b.requirementKey}:${b.sku}`)),
    subtotalMinor: planInput.subtotalMinor,
    shippingMinor: planInput.shippingMinor,
    taxMinor: planInput.taxMinor,
    totalMinor: planInput.totalMinor,
    merchantId: DEMO_MERCHANT.id,
  };
}

function normalizedCompatibilityTag(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashPlan(project, planInput) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalContent(project, planInput)))
    .digest("hex");
}

function getRequirements(project) {
  const structured = project.structuredRequirements || {};
  return [
    ...(structured.requiredItems || []).map((item) => ({ ...(item.toObject ? item.toObject() : item), required: true })),
    ...(structured.optionalItems || []).map((item) => ({ ...(item.toObject ? item.toObject() : item), required: false })),
  ];
}

function planLineFromProduct(product, quantity) {
  return {
    sku: product.sku,
    nameSnapshot: product.name,
    descriptionSnapshot: product.description,
    categorySnapshot: product.category,
    quantity,
    unitPriceMinor: product.unitPriceMinor,
    currency: product.currency,
    catalogVersion: product.catalogVersion,
    merchantId: product.merchantId,
  };
}

function inferRequirementMappings(project, items, suppliedMappings, catalogProducts) {
  const mappings = [...(suppliedMappings || [])];
  const requirements = getRequirements(project);
  const basketQuantities = new Map(items.map((item) => [item.sku, item.quantity]));
  const allocatedQuantities = new Map();
  for (const mapping of mappings) {
    if (Number.isSafeInteger(mapping.quantity) && mapping.quantity > 0) {
      allocatedQuantities.set(mapping.sku, (allocatedQuantities.get(mapping.sku) || 0) + mapping.quantity);
    }
  }
  const productsBySku = new Map(catalogProducts.map((product) => [product.sku.toUpperCase(), product]));
  const candidatesByRequirement = new Map(
    (project.candidateMappings || []).map((entry) => [
      entry.requirementKey,
      entry.candidates || [],
    ])
  );
  const normalizeWords = (value) => String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["the", "and", "for", "with"].includes(word))
    .map((word) => word.endsWith("s") ? word.slice(0, -1) : word);

  for (const requirement of requirements.filter((item) => item.required)) {
    if (mappings.some((mapping) => mapping.requirementKey === requirement.key)) continue;
    const neededQuantity = requirement.minQuantity || 1;
    const remaining = (sku) => (basketQuantities.get(sku) || 0) - (allocatedQuantities.get(sku) || 0);
    const candidateSkus = (candidatesByRequirement.get(requirement.key) || [])
      .map((candidate) => String(candidate.sku || "").toUpperCase());
    const suggestedProduct = candidateSkus
      .map((sku) => productsBySku.get(sku))
      .find((product) => product && remaining(product.sku) >= neededQuantity);
    const requirementWords = new Set(normalizeWords(requirement.description));
    const textMatch = catalogProducts
      .filter((product) => remaining(product.sku) >= neededQuantity)
      .map((product) => {
        const productWords = normalizeWords(`${product.name} ${product.category}`);
        const matches = productWords.filter((word) => requirementWords.has(word)).length;
        return { product, score: productWords.length ? matches / productWords.length : 0 };
      })
      .sort((left, right) => right.score - left.score)[0];
    const product = suggestedProduct || (textMatch?.score >= 0.66 ? textMatch.product : null);
    if (!product) continue;

    mappings.push({
      requirementKey: requirement.key,
      sku: product.sku,
      quantity: neededQuantity,
      rationale: "Automatically matched from the selected catalog product.",
    });
    allocatedQuantities.set(product.sku, (allocatedQuantities.get(product.sku) || 0) + neededQuantity);
  }
  return mappings;
}

function calculateTotals(items) {
  let subtotalMinor = 0;
  for (const item of items) {
    const lineTotal = item.unitPriceMinor * item.quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotalMinor + lineTotal)) {
      throw new Error("Basket total exceeds the supported monetary range.");
    }
    subtotalMinor += lineTotal;
  }
  const shippingMinor = DEMO_MERCHANT.shippingMinor;
  const taxMinor = DEMO_MERCHANT.taxMinor;
  const totalMinor = subtotalMinor + shippingMinor + taxMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new Error("Basket total exceeds the supported monetary range.");
  return { subtotalMinor, shippingMinor, taxMinor, totalMinor };
}

function validatePlan(project, planInput, catalogProducts, { checkStock = true, checkSnapshot = false } = {}) {
  const blockingIssues = [];
  const warnings = [DEMO_MERCHANT.shippingRule, DEMO_MERCHANT.taxRule, DEMO_MERCHANT.deliveryRule];
  const productsBySku = new Map(catalogProducts.map((product) => [product.sku.toUpperCase(), product]));
  const quantities = new Map();
  for (const line of planInput.items || []) {
    const sku = String(line.sku || "").toUpperCase();
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      blockingIssues.push(`${sku || "Line item"} must have a positive integer quantity.`);
      continue;
    }
    quantities.set(sku, (quantities.get(sku) || 0) + line.quantity);
    if (!Number.isSafeInteger(quantities.get(sku))) blockingIssues.push(`${sku} quantity exceeds the supported range.`);
  }
  if (quantities.size === 0) blockingIssues.push("A purchase plan must contain at least one catalog product.");

  const normalizedItems = [];
  for (const [sku, quantity] of quantities) {
    const product = productsBySku.get(sku);
    if (!product) {
      blockingIssues.push(`${sku} does not exist in the current catalog.`);
      continue;
    }
    if (!product.active) {
      blockingIssues.push(`${sku} is inactive and cannot be purchased.`);
      continue;
    }
    if (product.currency !== "USD" || product.merchantId !== DEMO_MERCHANT.id) {
      blockingIssues.push(`${sku} is not available from the configured USD demo merchant.`);
      continue;
    }
    const available = product.stock - product.reservedQuantity;
    if (checkStock && quantity > available) {
      blockingIssues.push(`${sku} requests ${quantity}, but only ${Math.max(0, available)} are available.`);
    }

    const inputLine = (planInput.items || []).find((line) => String(line.sku).toUpperCase() === sku);
    if (checkSnapshot && inputLine && (
      inputLine.unitPriceMinor !== product.unitPriceMinor
      || inputLine.catalogVersion !== product.catalogVersion
      || inputLine.merchantId !== product.merchantId
    )) {
      blockingIssues.push(`${sku} price, catalog version, or merchant changed since this plan was created.`);
    }
    normalizedItems.push(planLineFromProduct(product, quantity));
  }

  for (const constraint of project.structuredRequirements?.compatibilityConstraints || []) {
    const constraintTag = normalizedCompatibilityTag(constraint);
    const compatible = normalizedItems.some((item) => {
      const product = productsBySku.get(item.sku);
      return (product?.compatibilityTags || []).some((tag) => {
        const normalizedTag = normalizedCompatibilityTag(tag);
        return normalizedTag && (constraintTag.includes(normalizedTag) || normalizedTag.includes(constraintTag));
      });
    });
    if (!compatible) {
      blockingIssues.push(`No basket product satisfies the compatibility constraint "${constraint}".`);
    }
  }

  const mappings = inferRequirementMappings(
    project,
    normalizedItems,
    planInput.requirementMappings || [],
    catalogProducts
  );
  const requirementMap = new Map(getRequirements(project).map((requirement) => [requirement.key, requirement]));
  const mappedTotals = new Map();
  for (const mapping of mappings) {
    const requirementKey = String(mapping.requirementKey || "");
    const sku = String(mapping.sku || "").toUpperCase();
    const requirement = requirementMap.get(requirementKey);
    if (!requirement) {
      blockingIssues.push(`Mapping references unknown requirement "${requirementKey}".`);
      continue;
    }
    if (!Number.isSafeInteger(mapping.quantity) || mapping.quantity < 1) {
      blockingIssues.push(`Mapping for "${requirementKey}" must have a positive integer quantity.`);
      continue;
    }
    const product = productsBySku.get(sku);
    if (!product || !quantities.has(sku)) {
      blockingIssues.push(`Mapping for "${requirementKey}" references an item not in the basket.`);
      continue;
    }
    const sum = (mappedTotals.get(sku) || 0) + mapping.quantity;
    mappedTotals.set(sku, sum);
    if (sum > quantities.get(sku)) {
      blockingIssues.push(`Mapped quantities exceed the basket quantity for ${sku}.`);
    }
    const line = normalizedItems.find((item) => item.sku === sku);
    const productTags = new Set((product.compatibilityTags || []).map(normalizedCompatibilityTag));
    if (requirement.compatibilityTags?.length
      && !requirement.compatibilityTags.every((tag) => productTags.has(normalizedCompatibilityTag(tag)))) {
      blockingIssues.push(`${sku} does not satisfy all compatibility tags for "${requirementKey}".`);
    }
    mappings.push({
      requirementKey,
      sku,
      quantity: mapping.quantity,
      rationale: typeof mapping.rationale === "string" ? mapping.rationale.slice(0, 240) : undefined,
    });
    if (line && checkSnapshot && line.unitPriceMinor !== product.unitPriceMinor) {
      blockingIssues.push(`${sku} no longer matches the approved price snapshot.`);
    }
  }

  for (const requirement of getRequirements(project).filter((entry) => entry.required)) {
    const mappedQuantity = mappings
      .filter((mapping) => mapping.requirementKey === requirement.key)
      .reduce((sum, mapping) => sum + mapping.quantity, 0);
    if (!mappedQuantity) {
      blockingIssues.push(`Mandatory requirement "${requirement.description}" is not mapped to a basket item.`);
    } else if (requirement.minQuantity && mappedQuantity < requirement.minQuantity) {
      blockingIssues.push(`"${requirement.description}" requires at least ${requirement.minQuantity}; basket maps ${mappedQuantity}.`);
    }
  }

  let totals = { subtotalMinor: 0, shippingMinor: DEMO_MERCHANT.shippingMinor, taxMinor: DEMO_MERCHANT.taxMinor, totalMinor: DEMO_MERCHANT.shippingMinor + DEMO_MERCHANT.taxMinor };
  try {
    totals = calculateTotals(normalizedItems);
  } catch (err) {
    blockingIssues.push(err.message);
  }
  const usableBudget = project.budgetMinor - project.contingencyMinor;
  if (!isNonNegativeMinorUnitAmount(usableBudget)) {
    blockingIssues.push("Contingency exceeds the project budget.");
  } else if (totals.totalMinor > usableBudget) {
    blockingIssues.push(`Total is ${(totals.totalMinor - usableBudget) / 100} USD over the usable budget after contingency.`);
  }

  const unmetRequirements = getRequirements(project)
    .filter((requirement) => !mappings.some((mapping) => mapping.requirementKey === requirement.key))
    .map((requirement) => requirement.description);

  return {
    items: normalizedItems,
    requirementMappings: mappings,
    ...totals,
    assumptions: [...(project.structuredRequirements?.deliveryAssumptions || [])],
    unmetRequirements,
    warnings,
    validationReport: { valid: blockingIssues.length === 0, blockingIssues, warnings },
  };
}

function chooseCandidateMappings(project, mappings, catalogProducts) {
  const bySku = new Map(catalogProducts.map((product) => [product.sku.toUpperCase(), product]));
  const suggestions = new Map((mappings || []).map((entry) => [entry.requirementKey, entry.candidates || []]));
  const mandatory = getRequirements(project).filter((item) => item.required);
  const optional = getRequirements(project).filter((item) => !item.required);
  const alternatives = [];

  function candidateOptions(requirement) {
    const seen = new Set();
    return (suggestions.get(requirement.key) || [])
      .filter((candidate) => {
        const sku = String(candidate.sku || "").toUpperCase();
        const product = bySku.get(sku);
        if (!product || !product.active || seen.has(sku)) return false;
        const productTags = new Set((product.compatibilityTags || []).map(normalizedCompatibilityTag));
        if (requirement.compatibilityTags?.some((tag) => !productTags.has(normalizedCompatibilityTag(tag)))) return false;
        seen.add(sku);
        return true;
      })
      .map((candidate) => ({
        product: bySku.get(String(candidate.sku).toUpperCase()),
        quantity: candidate.quantity || requirement.minQuantity,
        rationale: candidate.rationale || "",
      }))
      .filter((candidate) => Number.isSafeInteger(candidate.quantity) && candidate.quantity > 0);
  }

  let visited = 0;
  function enumerateMandatory(index, lines, requirementMappings, ranking) {
    if (visited >= MAX_COMBINATIONS) return;
    if (index >= mandatory.length) {
      visited += 1;
      alternatives.push({ lines: [...lines], requirementMappings: [...requirementMappings], ranking });
      return;
    }
    const requirement = mandatory[index];
    for (const candidate of candidateOptions(requirement)) {
      if (visited >= MAX_COMBINATIONS) break;
      enumerateMandatory(
        index + 1,
        [...lines, { sku: candidate.product.sku, quantity: candidate.quantity }],
        [...requirementMappings, {
          requirementKey: requirement.key,
          sku: candidate.product.sku,
          quantity: candidate.quantity,
          rationale: candidate.rationale,
        }],
        ranking + Math.max(0, (suggestions.get(requirement.key) || []).findIndex((entry) => entry.sku.toUpperCase() === candidate.product.sku))
      );
    }
  }
  enumerateMandatory(0, [], [], 0);

  const scoreChoice = (base, strategy) => {
    const lines = [...base.lines];
    const requirementMappings = [...base.requirementMappings];
    if (strategy !== "LOWEST_COST") {
      let visitedOptional = 0;
      let best = null;
      const searchOptional = (index, currentLines, currentMappings, rank) => {
        if (visitedOptional >= MAX_COMBINATIONS) return;
        if (index >= optional.length) {
          visitedOptional += 1;
          const validation = validatePlan(project, { items: currentLines, requirementMappings: currentMappings }, catalogProducts);
          if (!validation.validationReport.valid) return;
          const coveredCount = currentMappings.filter((mapping) => optional.some((requirement) => requirement.key === mapping.requirementKey)).length;
          const score = {
            lines: currentLines,
            mappings: currentMappings,
            validation,
            coveredCount,
            rank,
          };
          if (!best
            || coveredCount > best.coveredCount
            || (coveredCount === best.coveredCount && strategy === "BALANCED" && rank < best.rank)
            || (coveredCount === best.coveredCount && rank === best.rank && validation.totalMinor < best.validation.totalMinor)) {
            best = score;
          }
          return;
        }

        searchOptional(index + 1, currentLines, currentMappings, rank);
        const requirement = optional[index];
        const options = candidateOptions(requirement)
          .sort((a, b) => a.product.unitPriceMinor - b.product.unitPriceMinor);
        for (const option of options) {
          if (visitedOptional >= MAX_COMBINATIONS) break;
          searchOptional(
            index + 1,
            [...currentLines, { sku: option.product.sku, quantity: option.quantity }],
            [...currentMappings, {
              requirementKey: requirement.key,
              sku: option.product.sku,
              quantity: option.quantity,
              rationale: option.rationale,
            }],
            rank + Math.max(0, (suggestions.get(requirement.key) || []).findIndex((entry) => entry.sku.toUpperCase() === option.product.sku))
          );
        }
      };
      searchOptional(0, lines, requirementMappings, base.ranking);
      if (best) {
        lines.splice(0, lines.length, ...best.lines);
        requirementMappings.splice(0, requirementMappings.length, ...best.mappings);
      }
    }

    const validation = validatePlan(project, { items: lines, requirementMappings }, catalogProducts);
    const coveredCount = requirementMappings.filter((mapping) => optional.some((requirement) => requirement.key === mapping.requirementKey)).length;
    return { lines, requirementMappings, validation, coveredCount, ranking: base.ranking };
  };

  const feasibleBases = alternatives
    .map((base) => ({ ...base, validation: validatePlan(project, base, catalogProducts) }))
    .filter((base) => base.validation.validationReport.valid)
    .sort((a, b) => a.validation.totalMinor - b.validation.totalMinor || a.ranking - b.ranking);

  const strategies = [
    { strategy: "LOWEST_COST", base: feasibleBases[0] },
    { strategy: "BALANCED", base: [...feasibleBases].sort((a, b) => a.ranking - b.ranking || a.validation.totalMinor - b.validation.totalMinor)[0] },
    { strategy: "MAXIMUM_COVERAGE", base: feasibleBases[0] },
  ];

  const output = [];
  for (const candidate of strategies) {
    if (!candidate.base) continue;
    const plan = scoreChoice(candidate.base, candidate.strategy);
    if (!plan.validation.validationReport.valid) continue;
    const itemKey = JSON.stringify(plan.lines.map((line) => [line.sku, line.quantity]).sort());
    if (output.some((existing) => existing.itemKey === itemKey)) continue;
    output.push({
      strategy: candidate.strategy,
      items: plan.validation.items,
      requirementMappings: plan.requirementMappings,
      ...plan.validation,
      itemKey,
    });
  }

  if (!output.length) {
    const mandatoryShortfall = mandatory.length
      ? mandatory.filter((requirement) => !candidateOptions(requirement).length).map((requirement) => requirement.description)
      : [];
    return {
      plans: [],
      unmetRequirements: mandatoryShortfall,
      explanation: mandatoryShortfall.length
        ? `No curated catalog products match these mandatory requirements: ${mandatoryShortfall.join("; ")}.`
        : "No mandatory basket fits the usable budget and available demo stock. Increase the budget, reduce quantities, or accept a different requirement.",
    };
  }

  return { plans: output, unmetRequirements: [], explanation: "" };
}

module.exports = {
  validatePlan,
  calculateTotals,
  hashPlan,
  chooseCandidateMappings,
};
