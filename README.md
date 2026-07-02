# ROLLER Monitoring dashboard

A private dashboard that pulls reports from Sentry, Checkly, and Ahrefs. API credentials
live in server-side environment variables and are never exposed to the browser.

## For AI schedulers / Slack (recommended)

**Do not scrape `index.html`.** The dashboard is JavaScript-based and returns an empty shell
to anything that cannot run JS in a browser.

Use the server-side daily report endpoint instead:

```
GET https://your-app.vercel.app/api/daily-report?key=YOUR_REPORT_SECRET
GET https://your-app.vercel.app/api/daily-report?key=YOUR_REPORT_SECRET&format=text
GET https://your-app.vercel.app/api/daily-report?key=YOUR_REPORT_SECRET&format=text&slack=1
```

| Query param | Description |
|-------------|-------------|
| `key` | Required when `REPORT_SECRET` is set. Also accepts `Authorization: Bearer …` |
| `format=json` | Default — structured JSON with `sentry`, `checkly`, `ahrefs`, and `text` |
| `format=text` | Plain-text / Slack-friendly summary (field `text` in JSON is the same content) |
| `slack=1` | Also posts the text report to `SLACK_WEBHOOK_URL` |

Schedule your AI or cron job for **8:00 AM** (or any time) to hit this URL. No browser needed.

Example curl:

```bash
curl -s "https://site-health-alpha.vercel.app/api/daily-report?key=$REPORT_SECRET&format=text"
```

Post directly to Slack:

```bash
curl -s "https://site-health-alpha.vercel.app/api/daily-report?key=$REPORT_SECRET&slack=1"
```

## Structure

```
site-health/
  index.html           Human dashboard (Sentry | Checkly | Ahrefs tabs)
  lib/daily-report.js  Server-side report builder
  api/
    daily-report.js    Daily JSON/text report for AI & cron
    ahrefs.js          Proxy -> Ahrefs API v3
    sentry.js          Proxy -> Sentry API
    checkly.js         Proxy -> Checkly API
```

## Environment variables

| Variable              | Used by           | Where to get it |
|-----------------------|-------------------|-----------------|
| `AHREFS_API_KEY`      | ahrefs, report    | Ahrefs → Account Settings → API Keys |
| `SENTRY_AUTH_TOKEN`   | sentry, report    | Sentry → Auth Tokens (org:read, project:read, event:read) |
| `SENTRY_ORG`          | sentry, report    | Sentry org slug |
| `SENTRY_BASE_URL`     | sentry, report    | Optional; defaults to https://sentry.io |
| `CHECKLY_API_KEY`     | checkly, report   | Checkly → User Settings → API Keys |
| `CHECKLY_ACCOUNT_ID`  | checkly, report   | Checkly → Account Settings → General |
| `REPORT_SECRET`       | daily-report      | Any random string — protects `/api/daily-report` |
| `SLACK_WEBHOOK_URL`   | daily-report      | Slack incoming webhook (for `?slack=1`) |
| `REPORT_TIMEZONE`     | daily-report      | Optional; defaults to `Australia/Melbourne` |

## Human dashboard

The browser tabs are for manual viewing only. Each tab loads data when you open it (or click
**Reload report**). They call the same `/api/*` proxies but do not need to run for scheduled
reports.

## Ahrefs API units

Ahrefs charges units per request (minimum 50). The daily report makes three Ahrefs calls per
run. Avoid polling more often than once per day.

## Deploying / hosting

This app exposes monitoring data behind privileged API keys. Set `REPORT_SECRET` in production
and restrict access as appropriate. For hosting guidance, ask in **`ai-support`** Slack.
