// Parse Checkly check scripts and map checks to manager-facing journey groups.

const JOURNEY_GROUPS = [
  {
    id: "forms",
    label: "Forms",
    checkNames: [
      "Test active forms",
      "Test inactive forms",
      "Freshness sales pages form check"
    ],
    arrayVars: ["FORMS", "PAGES"]
  },
  {
    id: "paidLp",
    label: "LP running paid campaign",
    checkNames: [
      "Light health check version for p0 pages",
      "Paid core pages health check",
      "Industries health check",
      "Features pages health check"
    ],
    arrayVars: ["URLS", "PAGES"],
    dedupeUrls: true
  },
  {
    id: "revenueJourney",
    label: "Revenue-critical journey",
    checkNames: [
      "Get started overall health check",
      "Get started form submit ",
      "Get started form submit",
      "Social tags fire test"
    ],
    arrayVars: ["URLS", "PAGES", "FORMS", "EXPECTED"]
  }
];

function parseArrayBlock(script, varName) {
  if (!script) return "";
  const m = script.match(new RegExp(`const\\s+${varName}\\s*=\\s*\\[`, "m"));
  if (!m) return "";
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < script.length && depth) {
    if (script[i] === "[") depth++;
    else if (script[i] === "]") depth--;
    i++;
  }
  return script.slice(start, i - 1);
}

function countMonitoredItems(script, arrayVars) {
  const items = [];

  for (const varName of arrayVars) {
    const block = parseArrayBlock(script, varName);
    if (!block) continue;

    // Object rows: { url: '...', formId: '...', guid: '...' }
    const objectRows = block.match(/\{[^}]+\}/g) || [];
    for (const row of objectRows) {
      const formId = row.match(/formId:\s*['"]([^'"]+)['"]/);
      const guid = row.match(/guid:\s*['"]([^'"]+)['"]/);
      const url = row.match(/url:\s*['"]([^'"]+)['"]/);
      const label = row.match(/label:\s*['"]([^'"]+)['"]/);
      if (formId) items.push({ type: "form", key: formId[1] });
      else if (guid) items.push({ type: "form", key: guid[1] });
      else if (url) items.push({ type: "url", key: normalizeUrl(url[1]) });
      else if (label) items.push({ type: "tag", key: label[1] });
    }

    // Bare URL strings in arrays
    const bareUrls = block.match(/['"]https?:\/\/[^'"]+['"]/g) || [];
    for (const u of bareUrls) {
      items.push({ type: "url", key: normalizeUrl(u.replace(/['"]/g, "")) });
    }

    const guids = block.match(/guid:\s*['"]([^'"]+)['"]/g) || [];
    guids.forEach((g) => items.push({ type: "form", key: g.match(/['"]([^'"]+)['"]/)[1] }));
  }

  const formGuid = script.match(/FORM_GUID\s*=\s*['"]([^'"]+)['"]/);
  if (formGuid) items.push({ type: "form", key: formGuid[1] });

  if (!items.length && script.includes("PAGE_URL")) {
    const pageUrl = script.match(/PAGE_URL\s*=\s*['"]([^'"]+)['"]/);
    if (pageUrl) items.push({ type: "url", key: normalizeUrl(pageUrl[1]) });
  }
  if (!items.length && script.includes("page.goto(")) {
    const goto = script.match(/page\.goto\(['"]([^'"]+)['"]/);
    if (goto) items.push({ type: "url", key: normalizeUrl(goto[1]) });
  }

  return dedupeItems(items);
}

function normalizeUrl(url) {
  return url.split("?")[0].replace(/\/+$/, "").toLowerCase();
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = `${item.type}:${item.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function checkStatus(statusRow) {
  if (!statusRow) return { status: "unknown", healthy: false };
  if (statusRow.hasFailures) return { status: "failed", healthy: false };
  if (statusRow.hasErrors) return { status: "error", healthy: false };
  if (statusRow.isDegraded) return { status: "degraded", healthy: false };
  return { status: "passing", healthy: true };
}

function buildJourneyGroups(checkList, statusList) {
  const statusByName = Object.fromEntries(statusList.map((s) => [s.name.trim(), s]));
  const checkByName = Object.fromEntries(checkList.map((c) => [c.name.trim(), c]));

  return JOURNEY_GROUPS.map((group) => {
    const checks = [];
    let monitoredItems = [];

    for (const name of group.checkNames) {
      const check = checkByName[name];
      const status = statusByName[name];
      if (!check && !status) continue;
      const st = checkStatus(status);
      const script = check?.script || "";
      const items = countMonitoredItems(script, group.arrayVars);
      checks.push({
        name: name,
        activated: check?.activated !== false,
        status: st.status,
        healthy: st.healthy && check?.activated !== false,
        monitoredCount: items.length || (status ? 1 : 0),
        responseMs: status?.longestRun
      });
      monitoredItems = monitoredItems.concat(items);
    }

    if (group.dedupeUrls) {
      monitoredItems = dedupeItems(monitoredItems.filter((i) => i.type === "url" || i.type === "form" || i.type === "tag"));
    } else {
      monitoredItems = dedupeItems(monitoredItems);
    }

    const itemCount = monitoredItems.length || checks.reduce((s, c) => s + (c.monitoredCount || 0), 0);
    const monitorPoints = checks.reduce((s, c) => s + (c.monitoredCount || 0), 0);
    const activeChecks = checks.filter((c) => c.activated !== false);
    const healthyChecks = activeChecks.filter((c) => c.healthy);
    const allHealthy = activeChecks.length > 0 && healthyChecks.length === activeChecks.length;

    return {
      id: group.id,
      label: group.label,
      itemCount,
      monitorPoints,
      checks,
      activeChecks: activeChecks.length,
      healthyChecks: healthyChecks.length,
      allHealthy,
      statusLabel: allHealthy ? "active & healthy" : `${healthyChecks.length}/${activeChecks.length} checks passing`
    };
  });
}

module.exports = { JOURNEY_GROUPS, buildJourneyGroups, countMonitoredItems };
