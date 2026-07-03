// Builds the daily monitoring report server-side (no browser / JS required).

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

// Ahrefs domain-rating lags — today's date often returns "bad date". Walk back up to 7 days.
async function fetchAhrefsDomainRating(preferredDate) {
  let lastError;
  for (let i = 0; i < 7; i++) {
    const date = shiftDate(preferredDate, -i);
    try {
      const data = await ahrefsFetch("/site-explorer/domain-rating", { target: AHREFS_TARGET, date });
      return { data, date };
    } catch (e) {
      lastError = e;
      if (!String(e.message).includes("bad date")) throw e;
    }
  }
  throw lastError || new Error("No valid Ahrefs domain-rating date found");
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

async function fetchSentryReport() {
  const base = "/api/0/organizations/{org}";
  const [cwvAgg, cwvPages, slow, apdex] = await Promise.all([
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
    })
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
    }))
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

  return {
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

async function fetchAhrefsReport(date) {
  const partialErrors = [];
  let dr = null;
  let ratingDate = null;

  try {
    const rating = await fetchAhrefsDomainRating(date);
    dr = rating.data;
    ratingDate = rating.date;
  } catch (e) {
    partialErrors.push(String(e.message || e));
  }

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

  const projectRows = projects?.healthscores || projects?.projects || (Array.isArray(projects) ? projects : []);

  return {
    target: AHREFS_TARGET,
    ratingDate,
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

function formatText(report) {
  const lines = [];
  lines.push(`*ROLLER Site Health — Daily Report*`);
  lines.push(`Date: ${report.reportDate} · Period: last ${report.period} · Generated: ${report.generatedAt}`);
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

  // ── Ahrefs: SEO ──
  lines.push("*Ahrefs — SEO*");
  const ah = report.ahrefs || {};
  const projects = ah.siteAuditProjects || [];
  const ahrefsOk = ah.domainRating != null || projects.length > 0;

  if (!ahrefsOk) {
    lines.push("• Ahrefs data could not be loaded for this run.");
    if (report.errors?.length) {
      report.errors.filter((e) => e.source === "ahrefs").forEach((e) => lines.push(`  – ${e.message}`));
    }
  } else {
    if (ah.ratingDate && ah.ratingDate !== report.reportDate) {
      lines.push(`• Domain rating as of ${ah.ratingDate} (latest available from Ahrefs)`);
    }
    lines.push(`• ${ah.target || AHREFS_TARGET}: Domain Rating ${ah.domainRating ?? "—"} · Ahrefs Rank ${ah.ahrefsRank ?? "—"}`);
    if (projects.length) {
      lines.push(`• Site Audit (${projects.length} project${projects.length === 1 ? "" : "s"}):`);
      projects.forEach((p) => {
        let line = `  – ${p.name}: health score ${p.healthScore ?? "—"}/100`;
        if (p.urlsWithErrors != null) line += `, ${p.urlsWithErrors} URLs with errors`;
        if (p.urlsWithWarnings != null) line += `, ${p.urlsWithWarnings} URLs with warnings`;
        if (p.total != null) line += `, ${p.total} URLs crawled`;
        lines.push(line);
      });
    }
    if (ah.units?.used != null) {
      lines.push(`• API units used: ${ah.units.used}${ah.units.limit != null ? ` / ${ah.units.limit}` : ""}`);
    }
  }

  lines.push("");
  lines.push("*Slack summary (copy these three lines)*");
  lines.push(`SENTRY: LCP ${fmt(w.lcpMs, "ms")}, FCP ${fmt(w.fcpMs, "ms")}, CLS ${fmt(w.cls)}, TTFB ${fmt(w.ttfbMs, "ms")}${perf.siteApdex != null ? `, Apdex ${fmtApdex(perf.siteApdex)}` : ""}`);
  lines.push(`CHECKLY: ${cs.passing ?? "—"}/${cs.total ?? "—"} checks passing`);
  if (ahrefsOk && projects.length) {
    const top = projects[0];
    lines.push(`AHREFS: Domain Rating ${ah.domainRating ?? "—"}, rank ${ah.ahrefsRank ?? "—"}, ${top.name} health ${top.healthScore ?? "—"}/100, ${top.urlsWithErrors ?? "—"} URLs with errors`);
  } else if (ahrefsOk) {
    lines.push(`AHREFS: Domain Rating ${ah.domainRating ?? "—"}, rank ${ah.ahrefsRank ?? "—"}`);
  } else {
    lines.push("AHREFS: data not available this run");
  }

  if (report.errors?.length) {
    const nonAhrefs = report.errors.filter((e) => e.source !== "ahrefs" || !ahrefsOk);
    if (nonAhrefs.length) {
      lines.push("");
      lines.push("*Errors while building report*");
      nonAhrefs.forEach((e) => lines.push(`• ${e.source}: ${e.message}`));
    }
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

  const [sentry, checkly, ahrefsRaw] = await Promise.all([
    wrap("sentry", fetchSentryReport),
    wrap("checkly", fetchChecklyReport),
    fetchAhrefsReport(date)
  ]);

  const ahrefs = ahrefsRaw || { target: AHREFS_TARGET, siteAuditProjects: [], units: {} };
  if (ahrefsRaw?.partialErrors?.length) {
    ahrefsRaw.partialErrors.forEach((message) => errors.push({ source: "ahrefs", message }));
  }
  delete ahrefs.partialErrors;
  ahrefs.dataAvailable = ahrefs.domainRating != null || (ahrefs.siteAuditProjects?.length > 0);

  const report = {
    generatedAt: new Date().toISOString(),
    reportDate: date,
    period: REPORT_PERIOD,
    sentry: sentry || { webVitals: {}, performance: {}, cwvByPage: [], slowestPages: [], apdex: [] },
    checkly: checkly || { summary: {}, statuses: [], checks: [], alertChannels: [] },
    ahrefs: ahrefs || { target: AHREFS_TARGET, siteAuditProjects: [], units: {} },
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
