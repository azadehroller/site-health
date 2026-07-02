# ROLLER Monitoring dashboard

A private dashboard that pulls reports from Sentry, Checkly, and Ahrefs. API credentials
live in server-side environment variables and are never exposed to the browser — the
frontend only ever calls this app's own `/api/*` functions on the same origin.

## Structure

```
roller-monitoring/
  index.html        Tabbed frontend (Sentry | Checkly | Ahrefs). Ahrefs tab is fully wired.
  api/
    ahrefs.js       Proxy -> https://api.ahrefs.com/v3   (env: AHREFS_API_KEY)
    sentry.js       Proxy -> https://sentry.io           (env: SENTRY_AUTH_TOKEN)
    checkly.js      Proxy -> https://api.checklyhq.com   (env: CHECKLY_API_KEY, CHECKLY_ACCOUNT_ID)
```

Each function reads its credentials from environment variables, forwards the request to the
provider, and returns the JSON. Because the frontend and the functions share one origin,
there is no CORS and no token in the browser.

## Environment variables

| Variable              | Used by      | Where to get it |
|-----------------------|--------------|-----------------|
| `AHREFS_API_KEY`      | /api/ahrefs  | Ahrefs → Account Settings → API Keys (owner/admin) |
| `SENTRY_AUTH_TOKEN`   | /api/sentry  | Sentry → Auth Tokens (scopes: org:read, project:read, event:read) |
| `SENTRY_ORG`          | /api/sentry  | Your Sentry org slug (from sentry.io/organizations/&lt;slug&gt;/). Injected into `{org}` in the path so it's never typed or hardcoded in the frontend |
| `SENTRY_BASE_URL`     | /api/sentry  | Optional; defaults to https://sentry.io (set for the EU region) |
| `CHECKLY_API_KEY`     | /api/checkly | Checkly → User Settings → API Keys |
| `CHECKLY_ACCOUNT_ID`  | /api/checkly | Checkly → Account Settings → General |

## Ahrefs API units

Ahrefs charges "units" per request (minimum 50; list endpoints ~225). This tab fetches only
on button click, runs a small number of summary calls per load, and requests a project's
issues only when you open it. Keep an eye on the units indicator; avoid auto-refresh loops.

## Deploying / hosting

This app exposes monitoring data behind privileged API keys, so it must not be publicly
accessible and needs proper access control. For how to host it safely, ask in the
**`ai-support`** Slack channel — they can guide the right setup for this kind of internal tool.

## Refining the Ahrefs reports

The Ahrefs Site Audit projects/issues tables currently render whatever columns the API
returns (defensive rendering). Once it's running, open the browser Network tab, grab a
sample response from `/api/ahrefs?path=/site-audit/projects` and `/site-audit/issues`, and
share it — then the columns (health score, broken links, broken images, missing alt, etc.)
can be mapped into proper labelled tables.
