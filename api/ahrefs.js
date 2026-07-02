// /api/ahrefs.js — server-side proxy to Ahrefs API v3.
// The API key lives in an environment variable and is never sent to the browser.
// Frontend calls: /api/ahrefs?path=/site-explorer/domain-rating&target=roller.software&date=2026-07-02
//
// Env var required: AHREFS_API_KEY

module.exports = async (req, res) => {
  const key = process.env.AHREFS_API_KEY;
  if (!key) return res.status(500).json({ error: "AHREFS_API_KEY environment variable is not set." });

  const { path, ...rest } = req.query;
  if (!path || !String(path).startsWith("/")) {
    return res.status(400).json({ error: "Query param 'path' is required and must start with '/'." });
  }

  const url = new URL("https://api.ahrefs.com/v3" + path);
  for (const [k, v] of Object.entries(rest)) {
    if (v != null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : v);
  }

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" }
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
