// GET /api/daily-report
//
// Server-side daily report — no browser or JavaScript required.
// Intended for AI schedulers, cron jobs, and curl.
//
// Query params:
//   key       — required if REPORT_SECRET env is set (same value)
//   format    — "json" (default) | "text" (plain-text / Slack-friendly markdown)
//   slack     — "1" to also post the text report to SLACK_WEBHOOK_URL
//
// Env vars: all provider keys (see README) plus optional:
//   REPORT_SECRET      — bearer token / ?key= to protect this endpoint
//   SLACK_WEBHOOK_URL  — incoming webhook for ?slack=1
//   REPORT_TIMEZONE    — defaults to Australia/Melbourne for report date

const { buildDailyReport, postToSlack } = require("../lib/daily-report");

function authorize(req) {
  const secret = process.env.REPORT_SECRET;
  if (!secret) return true;
  const key = req.query.key;
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return key === secret || bearer === secret;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  if (!authorize(req)) {
    return res.status(401).json({
      error: "Unauthorized. Pass ?key=YOUR_REPORT_SECRET or Authorization: Bearer YOUR_REPORT_SECRET"
    });
  }

  try {
    const report = await buildDailyReport();
    const format = String(req.query.format || "json").toLowerCase();
    const postSlack = req.query.slack === "1" || req.query.slack === "true";

    if (postSlack) {
      try {
        await postToSlack(report.text);
        report.slack = { posted: true };
      } catch (e) {
        report.slack = { posted: false, error: String(e.message || e) };
      }
    }

    if (format === "text") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.status(200).send(report.text);
    }

    return res.status(200).json(report);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
