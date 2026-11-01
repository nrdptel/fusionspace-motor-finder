// Who may call the public data API (/api/v1/* and /availability.json) from a
// browser. Browsers attach an `Origin` header to cross-origin requests; this
// module decides from it, and the Pages Functions in functions/api/v1/ and
// functions/availability.json.ts are thin wrappers around gateApiRequest().
//
// The rule (see the Terms on /api):
//   - https://fusionspace.co and https://<sub>.fusionspace.co are allowed (the
//     project's own sites), plus the exact origins listed, comma-separated, in
//     the API_ALLOWED_ORIGINS environment variable (sites granted permission).
//     An allowed origin gets `Access-Control-Allow-Origin: <that origin>`.
//   - Any other Origin, including `null` and anything malformed, gets HTTP 403
//     with a short JSON body pointing to the terms.
//   - No Origin header at all (scripts, servers, command-line tools, and
//     same-origin GETs, which browsers send without one) is served as before;
//     the terms cover those uses too.
//
// Web APIs only (URL, Request, Response, Headers), so it runs unchanged on the
// Workers runtime and on Node under vitest (lib/apiAccess.test.ts).

/** Where a refused caller is sent: the terms section of the API page. */
export const TERMS_URL = "https://motor.fusionspace.co/api#terms";

/** The project's own domain: it and every subdomain of it are allowed. */
const OWN_DOMAIN = "fusionspace.co";

/** One DNS label: letters, digits and inner hyphens, 1–63 characters. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type OriginDecision =
  /** No Origin header: served as before, with no CORS header. */
  | { kind: "no-origin" }
  /** An allowed browser origin: echo it in Access-Control-Allow-Origin. */
  | { kind: "allowed"; origin: string }
  /** Any other Origin (or a malformed one): refuse with 403. */
  | { kind: "denied" };

/**
 * The exact origins in API_ALLOWED_ORIGINS, in the form browsers send them
 * (`https://example.com`, no path, no trailing slash). Entries are trimmed and
 * normalized, so `https://Example.com/` counts as `https://example.com`.
 * Entries that are not an origin (`*`, `null`, a URL with a path, junk) are
 * dropped rather than widening access.
 */
export function parseAllowedOrigins(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    if (url.origin === "null") continue; // opaque (non-http) origins can't be granted
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") continue;
    out.add(url.origin);
  }
  return out;
}

/** True for https://fusionspace.co and https://<sub>.fusionspace.co on the default port. */
function isOwnOrigin(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname;
  if (host === OWN_DOMAIN) return true;
  const suffix = `.${OWN_DOMAIN}`;
  if (!host.endsWith(suffix)) return false;
  const sub = host.slice(0, -suffix.length);
  return sub.split(".").every((label) => DNS_LABEL.test(label));
}

/**
 * Decide a request from its Origin header (`null`/`undefined` = header absent)
 * and the API_ALLOWED_ORIGINS value. Pure: no I/O, no globals.
 *
 * An Origin must be in the exact serialized form browsers send (scheme, host
 * and port only, lower case, no trailing slash); anything else is denied.
 */
export function decideApiOrigin(
  origin: string | null | undefined,
  allowedOriginsEnv?: string | null,
): OriginDecision {
  if (origin === null || origin === undefined) return { kind: "no-origin" };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { kind: "denied" };
  }
  // `null` (sandboxed frames, file: pages) fails to parse above; a parsed origin
  // must round-trip exactly, which rejects paths, credentials, explicit default
  // ports and non-canonical spellings.
  if (url.origin === "null" || url.origin !== origin) return { kind: "denied" };
  if (isOwnOrigin(url) || parseAllowedOrigins(allowedOriginsEnv).has(origin)) {
    return { kind: "allowed", origin };
  }
  return { kind: "denied" };
}

/** The slice of a Pages Functions context the gate needs. */
export type GateContext = {
  request: Request;
  env: Record<string, unknown>;
  /** Pass the request on to the static asset (Pages runs `_headers` rules on it). */
  next: () => Promise<Response>;
};

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

/** Add `Origin` to a response's Vary header, keeping what is already there. */
function varyOnOrigin(headers: Headers): void {
  const vary = headers.get("Vary");
  if (!vary) {
    headers.set("Vary", "Origin");
  } else if (!vary.split(",").some((v) => v.trim().toLowerCase() === "origin")) {
    headers.set("Vary", `${vary}, Origin`);
  }
}

/** The 403 sent to a browser origin without permission. */
export function deniedResponse(): Response {
  const body = {
    error: "origin_not_allowed",
    message:
      "Browser requests to this API from other websites need written permission. " +
      "See the terms.",
    terms: TERMS_URL,
  };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    },
  });
}

/**
 * Apply the origin rule to one request for a static API file. Allowed and
 * Origin-less requests go on to the asset via `next()`; the asset's own headers
 * (Cache-Control from `_headers`) are kept, any upstream
 * Access-Control-Allow-Origin is replaced, and `Vary: Origin` is added.
 */
export async function gateApiRequest(ctx: GateContext): Promise<Response> {
  const { request } = ctx;
  const raw = ctx.env.API_ALLOWED_ORIGINS;
  const decision = decideApiOrigin(
    request.headers.get("Origin"),
    typeof raw === "string" ? raw : undefined,
  );
  if (decision.kind === "denied") return deniedResponse();

  if (request.method === "OPTIONS") {
    const headers = new Headers({ Allow: ALLOWED_METHODS, Vary: "Origin" });
    if (decision.kind === "allowed") {
      headers.set("Access-Control-Allow-Origin", decision.origin);
      headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
      const asked = request.headers.get("Access-Control-Request-Headers");
      if (asked) {
        headers.set("Access-Control-Allow-Headers", asked);
        headers.set("Vary", "Origin, Access-Control-Request-Headers");
      }
      headers.set("Access-Control-Max-Age", "86400");
    }
    return new Response(null, { status: 204, headers });
  }

  const upstream = await ctx.next();
  // Re-wrap so the headers are mutable (asset responses' headers may not be).
  const res = new Response(upstream.body, upstream);
  res.headers.delete("Access-Control-Allow-Origin");
  res.headers.delete("Access-Control-Allow-Methods");
  if (decision.kind === "allowed") {
    res.headers.set("Access-Control-Allow-Origin", decision.origin);
  }
  varyOnOrigin(res.headers);
  return res;
}
