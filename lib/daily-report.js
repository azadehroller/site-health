// Builds the daily monitoring report server-side (no browser / JS required).

const REPORT_PERIOD = "24h";
const AHREFS_TARGET = "roller.software";

function reportDate() {
  const tz = process.env.REPORT_TIMEZONE || "Australia/Melbourne";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
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
  const [issues, cwvAgg, cwvPages, slow, apdex] = await Promise.all([
    sentryFetch(base + "/issues/", { query: "is:unresolved", statsPeriod: REPORT_PERIOD, limit: 100 }),
    sentryFetch(base + "/events/", {
      field: ["p75(measurements.lcp)", "p75(measurements.fcp)", "p75(measurements.cls)", "p75(measurements.inp)", "p75(measurements.ttfb)"],
      query: "event.type:transaction",
      statsPeriod: REPORT_PERIOD
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "p75(measurements.lcp)", "p75(measurements.inp)", "p75(measurements.cls)", "count()"],
      query: "event.type:transaction has:measurements.lcp",
      orderby: "-count()",
      statsPeriod: REPORT_PERIOD,
      per_page: 15
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "p95(transaction.duration)", "count()"],
      query: "event.type:transaction",
      orderby: "-p95(transaction.duration)",
      statsPeriod: REPORT_PERIOD,
      per_page: 10
    }),
    sentryFetch(base + "/events/", {
      field: ["transaction", "failure_rate()", "apdex(3000)", "count()"],
      query: "event.type:transaction",
      orderby: "-count()",
      statsPeriod: REPORT_PERIOD,
      per_page: 10
    })
  ]);

  const issueList = Array.isArray(issues) ? issues : [];
  const cwv = rows(cwvAgg)[0] || {};

  return {
    summary: {
      unresolvedIssues: issueList.length,
      highPriority: issueList.filter((i) => i.priority === "high").length,
      errorEvents: issueList.reduce((s, i) => s + (parseInt(i.count, 10) || 0), 0)
    },
    webVitals: {
      lcpMs: cwv["p75(measurements.lcp)"],
      fcpMs: cwv["p75(measurements.fcp)"],
      cls: cwv["p75(measurements.cls)"],
      inpMs: cwv["p75(measurements.inp)"],
      ttfbMs: cwv["p75(measurements.ttfb)"]
    },
    issues: issueList.slice(0, 25).map((i) => ({
      id: i.shortId,
      title: i.title,
      level: i.level,
      priority: i.priority,
      events: i.count,
      users: i.userCount,
      lastSeen: i.lastSeen,
      culprit: i.culprit,
      url: i.permalink
    })),
    cwvByPage: rows(cwvPages).map((r) => ({
      page: r.transaction,
      views: r["count()"],
      lcpMs: r["p75(measurements.lcp)"],
      cls: r["p75(measurements.cls)"],
      inpMs: r["p75(measurements.inp)"]
    })),
    slowestPages: rows(slow).map((r) => ({
      page: r.transaction,
      p95DurationMs: r["p95(transaction.duration)"],
      samples: r["count()"]
    })),
    apdex: rows(apdex).map((r) => ({
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
  const [dr, projects, sub] = await Promise.all([
    ahrefsFetch("/site-explorer/domain-rating", { target: AHREFS_TARGET, date }),
    ahrefsFetch("/site-audit/projects"),
    ahrefsFetch("/subscription-info/limits-and-usage")
  ]);

  const projectRows = projects?.healthscores || projects?.projects || (Array.isArray(projects) ? projects : []);

  return {
    target: AHREFS_TARGET,
    domainRating: findNum(dr, ["domain_rating"]),
    ahrefsRank: findNum(dr, ["ahrefs_rank"]),
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
      total: p.total
    }))
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`*ROLLER Site Health — Daily Report*`);
  lines.push(`Date: ${report.reportDate} · Period: last ${report.period} · Generated: ${report.generatedAt}`);
  lines.push("");

  lines.push("*Sentry*");
  lines.push(`• Unresolved issues: ${report.sentry.summary.unresolvedIssues} (${report.sentry.summary.highPriority} high priority, ${report.sentry.summary.errorEvents} events)`);
  const w = report.sentry.webVitals;
  lines.push(`• Web Vitals p75: LCP ${fmt(w.lcpMs, "ms")} · FCP ${fmt(w.fcpMs, "ms")} · CLS ${fmt(w.cls)} · INP ${fmt(w.inpMs, "ms")} · TTFB ${fmt(w.ttfbMs, "ms")}`);
  if (report.sentry.issues.length) {
    lines.push("• Top issues:");
    report.sentry.issues.slice(0, 8).forEach((i) => {
      lines.push(`  – ${i.id}: ${i.title} (${i.events} events, ${i.priority}) ${i.url}`);
    });
  }
  lines.push("");

  lines.push("*Checkly*");
  const cs = report.checkly.summary;
  lines.push(`• Checks: ${cs.total} total · ${cs.passing} passing · ${cs.failing} failing · ${cs.degraded} degraded`);
  report.checkly.statuses.forEach((s) => {
    lines.push(`  – ${s.name}: ${s.status}${s.responseMs != null ? ` (${Math.round(s.responseMs)} ms)` : ""}`);
  });
  lines.push("");

  lines.push("*Ahrefs*");
  lines.push(`• ${report.ahrefs.target}: DR ${report.ahrefs.domainRating ?? "—"} · Rank ${report.ahrefs.ahrefsRank ?? "—"}`);
  if (report.ahrefs.units.used != null) {
    lines.push(`• API units: ${report.ahrefs.units.used}${report.ahrefs.units.limit != null ? ` / ${report.ahrefs.units.limit}` : ""}`);
  }
  report.ahrefs.siteAuditProjects.slice(0, 5).forEach((p) => {
    lines.push(`  – ${p.name}: health ${p.healthScore ?? "—"}${p.urlsWithErrors != null ? `, ${p.urlsWithErrors} URLs with errors` : ""}`);
  });

  if (report.errors?.length) {
    lines.push("");
    lines.push("*Errors while building report*");
    report.errors.forEach((e) => lines.push(`• ${e.source}: ${e.message}`));
  }

  return lines.join("\n");
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

  const [sentry, checkly, ahrefs] = await Promise.all([
    wrap("sentry", fetchSentryReport),
    wrap("checkly", fetchChecklyReport),
    wrap("ahrefs", () => fetchAhrefsReport(date))
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    reportDate: date,
    period: REPORT_PERIOD,
    sentry: sentry || { summary: {}, webVitals: {}, issues: [], cwvByPage: [], slowestPages: [], apdex: [] },
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
