// /api/sentry.js — server-side proxy to the Sentry API.
// Frontend calls: /api/sentry?path=/api/0/organizations/{org}/issues/&query=is:unresolved&statsPeriod=14d
// The literal token {org} in the path is replaced server-side with the SENTRY_ORG env var,
// so the frontend never needs to know or hardcode the organization slug.
//
// Env vars: SENTRY_AUTH_TOKEN (scopes: org:read, project:read, event:read), SENTRY_ORG
// Optional: SENTRY_BASE_URL (defaults to https://sentry.io; set for the EU region)

module.exports = async (req, res) => {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) return res.status(500).json({ error: "SENTRY_AUTH_TOKEN environment variable is not set." });

  const { path, ...rest } = req.query;
  if (!path || !String(path).startsWith("/")) {
    return res.status(400).json({ error: "Query param 'path' is required and must start with '/'." });
  }

  let p = String(path);
  if (p.includes("{org}")) {
    const org = process.env.SENTRY_ORG;
    if (!org) return res.status(500).json({ error: "SENTRY_ORG environment variable is not set (the requested path uses {org})." });
    p = p.replace(/\{org\}/g, encodeURIComponent(org));
  }

  const base = process.env.SENTRY_BASE_URL || "https://sentry.io";
  const url = new URL(base.replace(/\/+$/, "") + p);
  for (const [k, v] of Object.entries(rest)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  try {
    const upstream = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
