# Hosting (Cloudflare Pages: static export + Pages Functions)

The catalog is served as **static assets on Cloudflare Pages** (unlimited
requests + bandwidth, free), and only the genuinely-dynamic surface runs as
**Pages Functions** (Workers, 100k invocations/day free): the alerts, which are
human-action volume, and the public data API's browser-origin check, which runs
in front of the API's static files. OG images are pre-generated to static.

Page views never invoke a Function (the site's pages don't fetch the API at
runtime). API requests do: each request to `/api/v1/*` or `/availability.json`
is one Function invocation, so API traffic now counts toward the Workers 100k
req/day cap. See [Free-tier limits](#free-tier-limits-we-design-around) for
what happens past it.

## Architecture

| Surface | How it's served |
|---|---|
| `/`, `/plan`, `/motor/[…]`, `/alerts`, `/privacy`, `/compare` shell | **static export** (`out/`), served as Pages static assets |
| `/compare?ids=…` | **client-rendered** from a static catalog JSON |
| OG images | **pre-generated PNGs** at build (`scripts/gen-og.mjs`, per-motor cards) → static assets; the site-wide `public/og/default.png` is a committed static file |
| `/api/alerts/*` (9 routes) | **Pages Functions** (`functions/api/alerts/*`) over the shared `lib/alerts/*` |
| `/api/v1/*`, `/availability.json` | **static files** (`scripts/gen-api.mjs`) behind a **Pages Function** origin check (`functions/api/v1/_middleware.ts`, `functions/availability.json.ts` over `lib/apiAccess.ts`) |
| Data refresh | hourly scrape commit → GitHub Actions build + `wrangler pages deploy` |

Externals: cron-job.org (hits the GH Actions dispatch), Upstash Redis
(REST/fetch), ZeptoMail (fetch). Subscriber state lives in Upstash, so a host
move needs no data migration — just matching `ALERTS_SECRET` /
`ALERTS_DISPATCH_SECRET` between the deploy env and the scrape's GH Actions
secrets.

## How the pieces fit

- **`next.config`**: `output: "export"`, `images.unoptimized: true`. Security
  headers live in `public/_headers` (not a `headers()` block, which export
  can't emit). No `next/image` loader or middleware that would block export.
- **`public/_headers`** — the security headers, and `Cache-Control` for the
  API files. It detaches Pages' default `Access-Control-Allow-Origin: *` from
  the API files (`! Access-Control-Allow-Origin`); the origin check sets CORS
  per request.
- **`public/_redirects`** — legacy `/compare/<ids>` path links 302 to the
  `/compare?ids=…` query form (the query form survives the redirect; a
  `.html`→clean-URL redirect on the path form would loop). Uses a named
  placeholder (`:ids`), since Cloudflare leaves a `:splat` literal in a
  query-string destination.
- **Pages Functions** (`functions/api/alerts/*`) export `onRequestPost` /
  `onRequestGet` and wrap the runtime-agnostic `lib/alerts/*` (fetch + Web
  Crypto). Env comes from the Functions `env` binding, not `process.env`.
  File-based routing: Wrangler auto-generates `_routes.json` from
  `functions/`, so only `/api/alerts/*`, `/api/v1/*` and `/availability.json`
  invoke a Function. Every other request is served as a static asset and never
  touches the Workers runtime, so it stays in the unlimited/free static tier.
- **API origin check** (`functions/api/v1/_middleware.ts` and
  `functions/availability.json.ts`, both wrapping `lib/apiAccess.ts`): browser
  requests from fusionspace.co sites and the origins in the
  `API_ALLOWED_ORIGINS` env var (comma-separated, set in the Pages dashboard)
  get `Access-Control-Allow-Origin` with their origin; other origins get 403;
  requests with no `Origin` header pass. Allowed requests are served by
  `context.next()`, which fetches the static file and applies the `_headers`
  rules to it. The middleware sits in `functions/api/v1/`, not `functions/api/`,
  so the alert Functions keep their behavior.
- **GitHub Actions deploy** (`.github/workflows/deploy-cloudflare.yml`) builds
  with the `NEXT_PUBLIC_*` vars present, then
  `wrangler pages deploy out --project-name <proj>`. Direct upload, so it
  doesn't consume the 500/mo Cloudflare build quota.

## Free-tier limits we design around

- Pages static requests + bandwidth: **unlimited**.
- Pages builds: 500/mo — avoided (we build in Actions, direct-upload).
- Files per deployment: **20,000** (≈8k now — per-motor HTML + OG card + API JSON, ~3 files each; watch as the catalog grows).
- Functions (Workers): **100k/day**, **10ms CPU**, **3MB** bundle — alerts plus
  every API request (the origin check is a few string comparisons, well inside
  10ms); never bundle the ~2MB snapshot into a Function. The cap resets at
  midnight UTC. Past it, Pages follows the project's **Settings > Runtime >
  Fail open / closed** setting: *fail open* serves the static files without
  running Functions, so the API still answers scripts and servers but with no
  CORS header (browsers on other sites, and Muster, can't read it until the
  reset) and the alert endpoints stop working; *fail closed* returns an error
  page for every API and alert request, scripts included. Fail open is the
  right setting here: Pages adds `Access-Control-Allow-Origin: *` to static
  assets by default, but `_headers` detaches it from the API files, so they
  fall back to no CORS rather than to open CORS.
