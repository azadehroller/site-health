// Builds the daily monitoring report server-side (no browser / JS required).

const { buildJourneyGroups } = require("./checkly-journeys");

const REPORT_PERIOD = "24h";
const AHREFS_TARGET = "roller.software";

function reportDate() {
  const tz = process.env.REPORT_TIMEZONE || "Australia/Melbourne";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Ahrefs domain-rating requires a historical date (API rejects "today").
// We never use the report date — walk back from yesterday silently until one works.
async function fetchAhrefsDomainRating() {
  let lastError;
  const anchor = new Date().toISOString().slice(0, 10);
  for (let daysAgo = 1; daysAgo <= 14; daysAgo++) {
    const date = shiftDate(anchor, -daysAgo);
    try {
      const data = await ahrefsFetch("/site-explorer/domain-rating", { target: AHREFS_TARGET, date });
      return data;
    } catch (e) {
      lastError = e;
      const msg = String(e.message || e);
      if (!msg.includes("bad date") && !msg.includes("missing argument")) throw e;
    }
  }
  return null;
}

function findNum(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  const prim = (v) => typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(v));
  for (const k of keys) {
    const v = obj[k];
    if (v != null && prim(v)) return v;
  }
  for (const k of Object.keys(obj)) {
    if (!obj[k] || typeof obj[k] !== "object") continue;
    for (const nk of keys) {
      const v = obj[k][nk];
      if (v != null && prim(v)) return v;
    }
  }
  return null;
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

async function ahrefsFetch(path, params = {}) {
  const key = process.env.AHREFS_API_KEY;
  if (!key) throw new Error("AHREFS_API_KEY is not set");
  const url = new URL("https://api.ahrefs.com/v3" + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Ahrefs HTTP ${res.status}`);
  return data;
}

async function sentryFetch(path, params = {}) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error("SENTRY_AUTH_TOKEN is not set");
  let p = String(path);
  if (p.includes("{org}")) {
    const org = process.env.SENTRY_ORG;
    if (!org) throw new Error("SENTRY_ORG is not set");
    p = p.replace(/\{org\}/g, encodeURIComponent(org));
  }
  const base = (process.env.SENTRY_BASE_URL || "https://sentry.io").replace(/\/+$/, "");
  const url = new URL(base + p);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail || data?.error || `Sentry HTTP ${res.status}`);
  return data;
}

async function checklyFetch(path, params = {}) {
  const key = process.env.CHECKLY_API_KEY;
  const account = process.env.CHECKLY_ACCOUNT_ID;
  if (!key || !account) throw new Error("CHECKLY_API_KEY or CHECKLY_ACCOUNT_ID is not set");
  const url = new URL("https://api.checklyhq.com" + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: "Bearer " + key, "X-Checkly-Account": account }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || data?.error || `Checkly HTTP ${res.status}`);
  return data;
}

async function sentryCount(query) {
  const data = await sentryFetch("/api/0/organizations/{org}/events/", {
    field: ["count()"],
    query,
    statsPeriod: REPORT_PERIOD
  });
  const row = rows(data)[0];
  return row?.["count()"] ?? null;
}

async function fetchSentryReport() {
  const base = "/api/0/organizations/{org}";
  const [cwvAgg, cwvPages, slow, apdex, revenueJourneys, paidLpJourneys] = await Promise.all([
    sentryFetch(base + "/events/", {
      field: ["p75(measurements.lcp)", "p75(measurements.fcp)", "p75(measurements.cls)", "p75(measurements.inp)", "p75(measurements.ttfb)"],
      query: "event.type:transaction",
      statsPeriod: REPORT_PERIOD
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "p75(measurements.lcp)", "p75(measurements.inp)", "p75(measurements.cls)", "p75(measurements.fcp)", "count()"],
      query: "event.type:transaction has:measurements.lcp",
      orderby: "-count()",
      statsPeriod: REPORT_PERIOD,
      per_page: 10
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "p95(transaction.duration)", "count()"],
      query: "event.type:transaction",
      orderby: "-p95(transaction.duration)",
      statsPeriod: REPORT_PERIOD,
      per_page: 5
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "failure_rate()", "apdex(3000)", "count()"],
      query: "event.type:transaction",
      orderby: "-count()",
      statsPeriod: REPORT_PERIOD,
      per_page: 5
    }),
    sentryCount(
      "event.type:transaction (transaction:/get-started* OR transaction:/pricing* OR transaction:/checkout* OR transaction:/signup* OR transaction:/demo* OR transaction:/contact*)"
    ),
    sentryCount(
      "event.type:transaction (transaction:*/features/* OR transaction:*/industries/* OR transaction:*/pricing* OR transaction:*/venue-management*)"
    )
  ]);

  const cwv = rows(cwvAgg)[0] || {};
  const apdexRows = rows(apdex);
  const siteApdex = apdexRows.find((r) => r.transaction === "/") || apdexRows[0];

  return {
    webVitals: {
      lcpMs: cwv["p75(measurements.lcp)"],
      fcpMs: cwv["p75(measurements.fcp)"],
      cls: cwv["p75(measurements.cls)"],
      inpMs: cwv["p75(measurements.inp)"],
      ttfbMs: cwv["p75(measurements.ttfb)"]
    },
    performance: {
      siteApdex: siteApdex?.["apdex(3000)"],
      siteFailureRate: siteApdex?.["failure_rate()"],
      siteSamples: siteApdex?.["count()"]
    },
    cwvByPage: rows(cwvPages).map((r) => ({
      page: r.transaction,
      views: r["count()"],
      lcpMs: r["p75(measurements.lcp)"],
      fcpMs: r["p75(measurements.fcp)"],
      cls: r["p75(measurements.cls)"],
      inpMs: r["p75(measurements.inp)"]
    })),
    slowestPages: rows(slow).map((r) => ({
      page: r.transaction,
      p95DurationMs: r["p95(transaction.duration)"],
      samples: r["count()"]
    })),
    apdex: apdexRows.map((r) => ({
      page: r.transaction,
      apdex: r["apdex(3000)"],
      failureRate: r["failure_rate()"],
      samples: r["count()"]
    })),
    journeys: {
      revenueSessions24h: revenueJourneys,
      paidLpSessions24h: paidLpJourneys
    }
  };
}

async function fetchChecklyReport() {
  const [statuses, checks, alerts] = await Promise.all([
    checklyFetch("/v1/check-statuses"),
    checklyFetch("/v1/checks"),
    checklyFetch("/v1/alert-channels")
  ]);

  const statusList = Array.isArray(statuses) ? statuses : [];
  const checkList = Array.isArray(checks) ? checks : [];
  const alertList = Array.isArray(alerts) ? alerts : [];
  const journeyGroups = buildJourneyGroups(checkList, statusList);

  return {
    journeyGroups,
    summary: {
      total: statusList.length,
      passing: statusList.filter((s) => !s.hasFailures && !s.hasErrors && !s.isDegraded).length,
      failing: statusList.filter((s) => s.hasFailures || s.hasErrors).length,
      degraded: statusList.filter((s) => s.isDegraded).length
    },
    statuses: statusList.map((s) => ({
      name: s.name,
      checkId: s.checkId,
      status: s.hasFailures ? "failed" : s.hasErrors ? "error" : s.isDegraded ? "degraded" : "passing",
      responseMs: s.longestRun,
      updatedAt: s.updated_at,
      location: s.lastRunLocation
    })),
    checks: checkList.map((c) => ({
      name: c.name,
      type: c.checkType,
      frequencyMin: c.frequency,
      activated: c.activated,
      muted: c.muted,
      locations: c.locations
    })),
    alertChannels: alertList.map((a) => ({
      type: a.type,
      target: a.config?.address || a.config?.url || a.config?.channel || null,
      sendFailure: a.sendFailure,
      sendRecovery: a.sendRecovery
    }))
  };
}

async function fetchAhrefsReport() {
  const partialErrors = [];

  // Site Audit — no date param required (primary Ahrefs source)
  let projects = null;
  let sub = null;
  try {
    projects = await ahrefsFetch("/site-audit/projects");
  } catch (e) {
    partialErrors.push(`site-audit/projects: ${e.message || e}`);
  }
  try {
    sub = await ahrefsFetch("/subscription-info/limits-and-usage");
  } catch (e) {
    partialErrors.push(`subscription-info: ${e.message || e}`);
  }

  // Domain Rating — optional; silent date walk-back, never surfaced as a "date error"
  let dr = null;
  try {
    dr = await fetchAhrefsDomainRating();
  } catch (e) {
    const msg = String(e.message || e);
    if (!msg.includes("bad date")) partialErrors.push(msg);
  }

  const projectRows = projects?.healthscores || projects?.projects || (Array.isArray(projects) ? projects : []);

  return {
    target: AHREFS_TARGET,
    domainRating: dr ? findNum(dr, ["domain_rating"]) : null,
    ahrefsRank: dr ? findNum(dr, ["ahrefs_rank"]) : null,
    units: {
      used: findNum(sub, ["units_usage_api_key", "units_usage_workspace", "units_used"]),
      limit: findNum(sub, ["units_limit_workspace", "units_limit_api_key", "units_limit"])
    },
    siteAuditProjects: projectRows.map((p) => ({
      name: p.project_name || p.name,
      projectId: p.project_id,
      healthScore: p.health_score,
      status: p.status,
      targetUrl: p.target_url,
      urlsWithErrors: p.urls_with_errors,
      urlsWithWarnings: p.urls_with_warnings,
      total: p.total
    })),
    partialErrors
  };
}

function journeyLine(group, sentryExtra) {
  const count = group?.itemCount ?? "—";
  const status = group?.statusLabel ?? "unknown";
  let line = `- ${group?.label}: ${count}, ${status}`;
  if (group?.monitorPoints != null && group.monitorPoints !== group.itemCount) {
    line += ` (${group.monitorPoints} monitor points across ${group.checks?.length ?? 0} checks)`;
  }
  if (sentryExtra != null) line += ` · ${sentryExtra} user sessions (Sentry, 24h)`;
  return line;
}

function formatText(report) {
  const lines = [];
  lines.push(`*ROLLER Site Health — Daily Report*`);
  lines.push(`Date: ${report.reportDate} · Period: last ${report.period} · Generated: ${report.generatedAt}`);
  lines.push("");

  const journeys = report.checkly?.journeyGroups || [];
  const forms = journeys.find((g) => g.id === "forms");
  const paidLp = journeys.find((g) => g.id === "paidLp");
  const revenue = journeys.find((g) => g.id === "revenueJourney");
  const sentryJ = report.sentry?.journeys || {};

  lines.push("*User journeys & monitoring*");
  lines.push(journeyLine(forms));
  lines.push(journeyLine(paidLp, sentryJ.paidLpSessions24h));
  lines.push(journeyLine(revenue, sentryJ.revenueSessions24h));
  if (journeys.length) {
    lines.push("");
    lines.push("Checkly checks behind each group:");
    journeys.forEach((g) => {
      const checkBits = (g.checks || [])
        .map((c) => `${c.name} (${c.monitoredCount} items, ${c.status})`)
        .join("; ");
      lines.push(`• ${g.label}: ${checkBits || "—"}`);
    });
  }
  lines.push("");

  // ── Sentry: performance only ──
  lines.push("*Sentry — Performance & Core Web Vitals*");
  const w = report.sentry.webVitals || {};
  lines.push(`• Core Web Vitals (p75, last 24h): LCP ${fmt(w.lcpMs, "ms")} · FCP ${fmt(w.fcpMs, "ms")} · CLS ${fmt(w.cls)} · INP ${fmt(w.inpMs, "ms")} · TTFB ${fmt(w.ttfbMs, "ms")}`);
  const perf = report.sentry.performance || {};
  if (perf.siteApdex != null) {
    lines.push(`• Site Apdex (3000 ms threshold): ${fmtApdex(perf.siteApdex)} · failure rate ${fmtPct(perf.siteFailureRate)} · ${perf.siteSamples ?? "—"} pageload samples`);
  }
  if (report.sentry.cwvByPage?.length) {
    lines.push("• Core Web Vitals by page (top traffic):");
    report.sentry.cwvByPage.slice(0, 5).forEach((p) => {
      lines.push(`  – ${p.page}: LCP ${fmt(p.lcpMs, "ms")}, FCP ${fmt(p.fcpMs, "ms")}, CLS ${fmt(p.cls)}${p.inpMs != null ? `, INP ${fmt(p.inpMs, "ms")}` : ""} (${p.views} views)`);
    });
  }
  if (report.sentry.apdex?.length) {
    lines.push("• Apdex by page:");
    report.sentry.apdex.slice(0, 5).forEach((p) => {
      lines.push(`  – ${p.page}: Apdex ${fmtApdex(p.apdex)}, failure rate ${fmtPct(p.failureRate)}`);
    });
  }
  if (report.sentry.slowestPages?.length) {
    lines.push("• Slowest pages (p95 load time):");
    report.sentry.slowestPages.slice(0, 3).forEach((p) => {
      lines.push(`  – ${p.page}: ${fmt(p.p95DurationMs, "ms")} p95`);
    });
  }
  lines.push("");

  // ── Checkly: passing checks ──
  lines.push("*Checkly — Monitor status*");
  const cs = report.checkly.summary || {};
  lines.push(`• ${cs.passing ?? "—"}/${cs.total ?? "—"} checks passing${cs.failing ? `, ${cs.failing} failing` : ""}${cs.degraded ? `, ${cs.degraded} degraded` : ""}`);
  const passing = (report.checkly.statuses || []).filter((s) => s.status === "passing");
  const notPassing = (report.checkly.statuses || []).filter((s) => s.status !== "passing");
  if (passing.length) {
    lines.push("• Passing checks:");
    passing.forEach((s) => {
      lines.push(`  – ${s.name}${s.responseMs != null ? ` (${Math.round(s.responseMs)} ms)` : ""}`);
    });
  }
  if (notPassing.length) {
    lines.push("• Other checks:");
    notPassing.forEach((s) => {
      lines.push(`  – ${s.name}: ${s.status}${s.responseMs != null ? ` (${Math.round(s.responseMs)} ms)` : ""}`);
    });
  }
  lines.push("");

  // Ahrefs omitted from daily report (still available on the human dashboard homepage).
  // const ah = report.ahrefs || {};
  // const projects = ah.siteAuditProjects || [];
  // ...

  lines.push("");
  lines.push("*Slack summary (copy these lines)*");
  lines.push(`JOURNEYS: Forms ${forms?.itemCount ?? "—"} ${forms?.statusLabel ?? ""}; Paid LP ${paidLp?.itemCount ?? "—"} ${paidLp?.statusLabel ?? ""}; Revenue ${revenue?.itemCount ?? "—"} ${revenue?.statusLabel ?? ""}`);
  lines.push(`SENTRY: LCP ${fmt(w.lcpMs, "ms")}, FCP ${fmt(w.fcpMs, "ms")}, CLS ${fmt(w.cls)}, TTFB ${fmt(w.ttfbMs, "ms")}${perf.siteApdex != null ? `, Apdex ${fmtApdex(perf.siteApdex)}` : ""}`);
  lines.push(`CHECKLY: ${cs.passing ?? "—"}/${cs.total ?? "—"} checks passing`);

  if (report.errors?.length) {
    lines.push("");
    lines.push("*Errors while building report*");
    report.errors.forEach((e) => lines.push(`• ${e.source}: ${e.message}`));
  }

  return lines.join("\n");
}

function fmtApdex(v) {
  if (v == null || isNaN(v)) return "—";
  return Number(v).toFixed(2);
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmt(v, unit) {
  if (v == null || v === "") return "—";
  if (unit === "ms") return `${Math.round(v)} ms`;
  if (typeof v === "number") return String(Number(v.toFixed(3)));
  return String(v);
}

async function buildDailyReport() {
  const date = reportDate();
  const errors = [];
  const wrap = async (source, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push({ source, message: String(e.message || e) });
      return null;
    }
  };

  const [sentry, checkly /* , ahrefsRaw */] = await Promise.all([
    wrap("sentry", fetchSentryReport),
    wrap("checkly", fetchChecklyReport)
    // Ahrefs omitted from daily report — still on homepage dashboard.
    // wrap("ahrefs", fetchAhrefsReport)
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    reportDate: date,
    period: REPORT_PERIOD,
    sentry: sentry || { webVitals: {}, performance: {}, cwvByPage: [], slowestPages: [], apdex: [], journeys: {} },
    checkly: checkly || { summary: {}, statuses: [], checks: [], alertChannels: [], journeyGroups: [] },
    errors
  };

  report.text = formatText(report);
  return report;
}

async function postToSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack webhook HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
}

module.exports = { buildDailyReport, postToSlack, formatText, reportDate };
