# Public data API

A read-only JSON API of the motor catalog — every AeroTech / Cesaroni /
Loki motor we track, with per-vendor stock and pricing. It's free for personal,
non-commercial use and for FusionSpace's own tools; any other website, app or
service, and any commercial use, needs written permission first. See
[Terms](#terms).

**Base URL:** `https://motor.fusionspace.co/api/v1/`

It's served as **static files on a CDN** (Cloudflare Pages), so:

- **No API key and no rate limits.**
- **Browsers can call it only from fusionspace.co sites and sites granted
  permission**; a browser request from any other site gets HTTP 403. Scripts,
  servers and command-line tools, which send no `Origin` header, are served as
  usual, and the terms cover them too. See [Browser access](#browser-access).
- **Refreshed about hourly** (it regenerates on each deploy of the site). Read
  `meta.json` for the exact `generated_at` timestamp.
- It's static JSON, so there are **no query parameters** — fetch a file and
  filter client-side (the whole dataset is small).

Generated at build time by `frontend/scripts/gen-api.mjs`; the shape is guarded
by `frontend/lib/publicApi.test.ts`.

## Endpoints

| Endpoint | What it is |
|---|---|
| [`GET /api/v1/meta.json`](https://motor.fusionspace.co/api/v1/meta.json) | Schema version, `generated_at`, counts, manufacturer list, endpoint index. Poll this cheaply to detect updates. |
| [`GET /api/v1/motors.json`](https://motor.fusionspace.co/api/v1/motors.json) | Every matched motor we have a listing for (D-class and up, matching the site). |
| [`GET /api/v1/in-stock.json`](https://motor.fusionspace.co/api/v1/in-stock.json) | Same shape, only motors in stock at ≥1 vendor. |
| [`GET /api/v1/vendors.json`](https://motor.fusionspace.co/api/v1/vendors.json) | The vendors we track, with per-vendor motor + in-stock counts. |
| `GET /api/v1/motors/{manufacturer}/{designation}.json` | A single motor. Slugs mirror the site's `/motor` URL — e.g. [`…/motors/aerotech/H128W.json`](https://motor.fusionspace.co/api/v1/motors/aerotech/H128W.json) (`manufacturer` ∈ `aerotech`/`cesaroni`/`loki`; a `/` in a designation is encoded as `~`). |
| [`GET /api/v1/openapi.json`](https://motor.fusionspace.co/api/v1/openapi.json) | OpenAPI 3.1 spec for everything above (drop it into Swagger/Postman/codegen). |

## Bulk availability feed

[`GET /availability.json`](https://motor.fusionspace.co/availability.json) — one
small (~30 KB) static file with a stock summary for **every** listed motor, so a
client can badge a whole list ("in stock now · N vendors") from a single fetch
instead of one page load per motor. Same [browser access](#browser-access) rule
and ~10 min cache as the API; refreshed on the hourly build.

```jsonc
{
  "_generated": "2026-07-14T02:00:00Z",   // ISO 8601 UTC
  "motors": {
    // key = "<manufacturer-slug>/<designation>", matching the /motor/<mfr>/<designation> URL
    "aerotech/I161W":          { "vendors": 9, "inStock": 4 },  // 9 vendors list it; 4 have it in stock now
    "cesaroni/1234J567-15A":   { "vendors": 3, "inStock": 0 }
  }
}
```

`vendors` = distinct vendors listing the motor; `inStock` = distinct vendors with
it in stock right now (these mirror `vendor_count` / `in_stock_vendor_count` in
the Motor schema below). Designations are verbatim as ThrustCurve spells them; the
few containing a `/` (e.g. `aerotech/F42T/L`) are also emitted under the site's
URL spelling with `/` → `~` (`aerotech/F42T~L`), so a lookup by either resolves.

## Schema

Every payload carries `schema_version` (currently `1`) and `generated_at` (ISO
8601 UTC). Breaking changes ship under a new version path (`/api/v2/…`); the
`v1` shape is stable.

### Motor

```jsonc
{
  "id": 1234,                       // stable numeric id for this motor
  "path": "/api/v1/motors/aerotech/H128W.json",  // this motor's own endpoint
  "manufacturer": "AeroTech",       // "AeroTech" | "Cesaroni Technology" | "Loki Research"
  "designation": "H128W",
  "common_name": "H128",            // designation without the propellant code; may be null
  "impulse_class": "H",             // single letter, A–O
  "diameter_mm": 29,
  "total_impulse_ns": 176.2,        // nullable
  "avg_thrust_n": 128,              // nullable
  "burn_time_s": 1.4,               // nullable
  "propellant": "White Lightning",  // nullable
  "sparky": false,                  // metal-additive (throws sparks)
  "motor_type": "reload",           // "reload" | "SU" (single-use) | "hybrid" | null
  "case_info": "RMS-29/180",        // reload hardware; null for single-use
  "hazmat": "required",             // "required" (>62.5g propellant / H+) | "varies" (F/G near the limit, vendor-dependent) | "none" (<=62.5g, A-E)
  "delays": "6,10,14",              // nullable
  "delay_adjustable": true,
  "discontinued": false,            // out of production — old stock only
  "in_stock": true,                 // in stock at ≥1 vendor right now
  "vendor_count": 5,                // DISTINCT vendors carrying it (in or out of stock)
  "in_stock_vendor_count": 3,
  "listing_count": 9,               // total listings — a vendor may list several variants (delays, packs)
  "cheapest_in_stock": {            // pack-aware per-unit cheapest in-stock listing; null if none
    "price_cents": 6000,
    "unit_price_cents": 3000,       // sticker price ÷ pack size
    "currency": "USD",
    "vendor": "Wildman",
    "vendor_slug": "wildman",
    "url": "https://…",
    "pack_size": 2
  },
  "listings": [ /* Listing[] — see below */ ]
}
```

### Listing

```jsonc
{
  "vendor": "Chris' Rocket Supplies",
  "vendor_slug": "csrocketry",
  "url": "https://…",               // product page (where you'd buy it)
  "status": "in_stock",             // "in_stock" | "out_of_stock" | "special_order" | "unknown"
  "price_cents": 3499,              // sticker price; nullable
  "unit_price_cents": 3499,         // per-unit (sticker ÷ pack_size); nullable
  "currency": "USD",
  "pack_size": 1,                   // multipack size (1 = single)
  "stock_count": null,              // units on hand when the vendor exposes it
  "lead_time": null,                // e.g. "16–20 weeks" for backorder vendors
  "last_seen": "2026-06-19T04:00:55Z"
}
```

> Prices are integer **cents**. `status` is `in_stock` whether or not a count is
> known; when a vendor publishes an on-hand count it's in `stock_count`.

### Vendor

```jsonc
{
  "slug": "csrocketry",
  "name": "Chris' Rocket Supplies",
  "motor_count": 488,      // DISTINCT motors this vendor carries
  "in_stock_count": 241    // distinct motors it has in stock
}
```

## Examples

```bash
# Cheapest in-stock H motors right now
curl -s https://motor.fusionspace.co/api/v1/in-stock.json \
  | jq '.motors[] | select(.impulse_class=="H")
        | {designation, from: .cheapest_in_stock.unit_price_cents, vendor: .cheapest_in_stock.vendor}'

# When was the data last refreshed?
curl -s https://motor.fusionspace.co/api/v1/meta.json | jq .generated_at
```

```js
// Browser — from a fusionspace.co page or a site granted permission
const { motors } = await (await fetch("https://motor.fusionspace.co/api/v1/in-stock.json")).json();
const cti54 = motors.filter((m) => m.manufacturer === "Cesaroni Technology" && m.diameter_mm === 54);
```

## Browser access

Browsers send an `Origin` header with cross-site requests, and the API answers
by it. This applies to everything under `/api/v1/` and to `/availability.json`.

| Request | Answer |
|---|---|
| `Origin: https://fusionspace.co` or `https://<name>.fusionspace.co` | The file, with `Access-Control-Allow-Origin` set to that origin and `Vary: Origin`. |
| `Origin:` a site granted permission | The same. |
| Any other `Origin`, including `null`, `http://` origins and lookalike domains | HTTP 403 with a short JSON body (below). |
| No `Origin` header (curl, scripts, servers, a page fetching from its own site) | The file, as before, with no CORS header. |

The rest of the site (its pages, `compare-data.json` and Next's page data) sends no
`Access-Control-Allow-Origin` at all, so a browser on another site can't read those
either. Links and images from other sites work as before.

`OPTIONS` preflight requests get the same decision. The 403 body:

```json
{
  "error": "origin_not_allowed",
  "message": "Browser requests to this API from other websites need written permission. See the terms.",
  "terms": "https://motor.fusionspace.co/api#terms"
}
```

The check runs in two Cloudflare Pages Functions,
`frontend/functions/api/v1/_middleware.ts` and
`frontend/functions/availability.json.ts`; the rule itself is
`frontend/lib/apiAccess.ts`, tested in `frontend/lib/apiAccess.test.ts`. Sites
granted permission are listed, comma-separated and exact
(`https://example.com`), in the Pages environment variable
`API_ALLOWED_ORIGINS`.

## Terms

These terms apply from **1 November 2026** to the data motor.fusionspace.co
publishes: the API's responses, `/availability.json`, the site's pages, and the
snapshot and history files under `data/` in this repository, including the
compilation of motor, listing, stock and price data in them.

- **Free for personal, non-commercial use**, and for FusionSpace's own tools.
  Caching responses, and keeping recorded responses as test fixtures, is fine
  within that use.
- **Any other website, app or service, and any commercial use, needs written
  permission first.** To ask, [open an issue on the GitHub
  repository](https://github.com/nrdptel/fusionspace-motor-finder/issues). A
  site that gets permission is added to the origins browsers may call the API
  from.
- **Credit** the data wherever it's shown: **"Motor stock data from
  motor.fusionspace.co"**, linked to <https://motor.fusionspace.co>.
- **Copies obtained before 1 November 2026** were published under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and those copies
  keep that licence: a Creative Commons licence can't be withdrawn. Data
  obtained from 1 November 2026 on is under these terms.
- **The code is separate.** It stays under the [MIT License](../LICENSE): fork
  it, change it, and run your own copy that collects its own data. These terms
  cover the data this site publishes, not the code.

Vendor names, prices, stock levels and product links are factual information
gathered from the listed retailers, provided **as-is, with no warranty** of
accuracy or availability; trademarks belong to their owners. The data is
aggregated from public vendor listings and [ThrustCurve](https://www.thrustcurve.org)
— verify stock and price on the vendor's own page before relying on it.

Please **use this API rather than scraping the vendors directly** — that's the
whole point of it, and it keeps load off the shops. The catalog is small and
refreshes hourly, so caching a copy and polling `meta.json` for changes is plenty.

There's no per-key or per-IP rate limit. Cloudflare's standard automatic abuse
protection applies to all traffic, as it does to any site behind a CDN — normal
use never encounters it.
