// /api/checkly.js — server-side proxy to the Checkly API v1.
// Frontend calls: /api/checkly?path=/v1/check-statuses
//
// Env vars required: CHECKLY_API_KEY, CHECKLY_ACCOUNT_ID

module.exports = async (req, res) => {
  const key = process.env.CHECKLY_API_KEY;
  const account = process.env.CHECKLY_ACCOUNT_ID;
  if (!key || !account) {
    return res.status(500).json({ error: "CHECKLY_API_KEY and/or CHECKLY_ACCOUNT_ID environment variables are not set." });
  }

  const { path, ...rest } = req.query;
  if (!path || !String(path).startsWith("/")) {
    return res.status(400).json({ error: "Query param 'path' is required and must start with '/'." });
  }

  const url = new URL("https://api.checklyhq.com" + path);
  for (const [k, v] of Object.entries(rest)) {
    if (v != null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: "Bearer " + key, "X-Checkly-Account": account }
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
