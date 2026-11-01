// Pins the public API's browser-origin rule (lib/apiAccess.ts): which Origin
// headers get CORS, which get 403, and that requests without one are served as
// before. Also guards the route files and public/_headers, so a rename or a
// wildcard CORS line can't silently reopen the API.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  TERMS_URL,
  decideApiOrigin,
  gateApiRequest,
  parseAllowedOrigins,
} from "./apiAccess";

const allowed = (origin: string) => ({ kind: "allowed", origin });
const DENIED = { kind: "denied" };
const NO_ORIGIN = { kind: "no-origin" };

describe("decideApiOrigin", () => {
  it("allows the bare domain", () => {
    expect(decideApiOrigin("https://fusionspace.co")).toEqual(allowed("https://fusionspace.co"));
  });

  it("allows any subdomain, at any depth", () => {
    for (const o of [
      "https://motor.fusionspace.co",
      "https://muster.fusionspace.co",
      "https://hpr.fusionspace.co",
      "https://a.b.fusionspace.co",
      "https://x-1.fusionspace.co",
    ]) {
      expect(decideApiOrigin(o)).toEqual(allowed(o));
    }
  });

  it("allows the exact origins listed in API_ALLOWED_ORIGINS", () => {
    const env = " https://partner.example ,https://other.example:8443,, http://localhost:3000 ";
    expect(decideApiOrigin("https://partner.example", env)).toEqual(allowed("https://partner.example"));
    expect(decideApiOrigin("https://other.example:8443", env)).toEqual(
      allowed("https://other.example:8443"),
    );
    expect(decideApiOrigin("http://localhost:3000", env)).toEqual(allowed("http://localhost:3000"));
    // Listed origins are exact: no subdomains, no other ports or schemes.
    expect(decideApiOrigin("https://sub.partner.example", env)).toEqual(DENIED);
    expect(decideApiOrigin("https://other.example", env)).toEqual(DENIED);
    expect(decideApiOrigin("http://partner.example", env)).toEqual(DENIED);
    expect(decideApiOrigin("https://unlisted.example", env)).toEqual(DENIED);
  });

  it("denies everyone else when API_ALLOWED_ORIGINS is unset or empty", () => {
    for (const env of [undefined, null, "", " , "]) {
      expect(decideApiOrigin("https://example.com", env)).toEqual(DENIED);
      expect(decideApiOrigin("https://motor.fusionspace.co", env)).toEqual(
        allowed("https://motor.fusionspace.co"),
      );
    }
  });

  it("denies lookalike domains", () => {
    for (const o of [
      "https://evilfusionspace.co",
      "https://xfusionspace.co",
      "https://fusionspace.co.evil.com",
      "https://motor.fusionspace.co.evil.com",
      "https://fusionspace.com",
      "https://fusionspace.co.",
      "https://motor.fusionspace.co.",
      "https://fusionspace-co.com",
      "https://fusionspace.co@evil.com",
      "https://evil.com#.fusionspace.co",
      "https://evil.com?.fusionspace.co",
    ]) {
      expect(decideApiOrigin(o), o).toEqual(DENIED);
    }
  });

  it("denies http and other schemes, and non-default ports, on the own domain", () => {
    for (const o of [
      "http://fusionspace.co",
      "http://motor.fusionspace.co",
      "ws://motor.fusionspace.co",
      "ftp://motor.fusionspace.co",
      "https://motor.fusionspace.co:8443",
    ]) {
      expect(decideApiOrigin(o), o).toEqual(DENIED);
    }
  });

  it("treats a missing Origin header as no origin", () => {
    expect(decideApiOrigin(null)).toEqual(NO_ORIGIN);
    expect(decideApiOrigin(undefined)).toEqual(NO_ORIGIN);
    expect(decideApiOrigin(null, "https://partner.example")).toEqual(NO_ORIGIN);
  });

  it("denies malformed and non-canonical origins", () => {
    for (const o of [
      "",
      "null",
      "not a url",
      "https://",
      "https:/motor.fusionspace.co",
      "motor.fusionspace.co",
      "https://motor.fusionspace.co/", // trailing slash: not what browsers send
      "https://motor.fusionspace.co/api",
      "https://MOTOR.fusionspace.co", // browsers send lower case
      "https://fusionspace.co:443", // browsers omit the default port
      "https://user:pass@motor.fusionspace.co",
      "https://.fusionspace.co",
      "https://a..fusionspace.co",
      "https://-a.fusionspace.co",
      "https://a_b.fusionspace.co",
      "*",
    ]) {
      expect(decideApiOrigin(o), JSON.stringify(o)).toEqual(DENIED);
    }
  });

  it("never lets a listed wildcard or null widen access", () => {
    expect(decideApiOrigin("https://example.com", "*")).toEqual(DENIED);
    expect(decideApiOrigin("null", "null")).toEqual(DENIED);
    expect(decideApiOrigin("*", "*")).toEqual(DENIED);
  });
});

describe("parseAllowedOrigins", () => {
  it("normalizes entries to the form browsers send", () => {
    expect([...parseAllowedOrigins("https://Partner.Example/, https://b.example:443")]).toEqual([
      "https://partner.example",
      "https://b.example",
    ]);
  });

  it("drops entries that are not an origin", () => {
    expect([
      ...parseAllowedOrigins(
        "*, null, junk, foo://opaque/, https://a.example/path, https://u@b.example, https://c.example?q, https://d.example",
      ),
    ]).toEqual(["https://d.example"]);
  });

  it("is empty when unset", () => {
    expect(parseAllowedOrigins(undefined).size).toBe(0);
    expect(parseAllowedOrigins("").size).toBe(0);
  });
});

/** A static-asset stand-in for `context.next()`: the file, with its _headers rules. */
const asset = (extra: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response('{"schema_version":1}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=600",
          ...extra,
        },
      }),
  );

const request = (method: string, headers: Record<string, string> = {}) =>
  new Request("https://motor.fusionspace.co/api/v1/meta.json", { method, headers });

describe("gateApiRequest", () => {
  it("serves a request with no Origin unchanged, without CORS", async () => {
    const next = asset();
    const res = await gateApiRequest({ request: request("GET"), env: {}, next });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"schema_version":1}');
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("echoes an allowed origin and keeps the asset's caching", async () => {
    const next = asset();
    const res = await gateApiRequest({
      request: request("GET", { Origin: "https://muster.fusionspace.co" }),
      env: {},
      next,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://muster.fusionspace.co");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    expect(await res.text()).toBe('{"schema_version":1}');
  });

  it("allows an origin granted in env.API_ALLOWED_ORIGINS", async () => {
    const res = await gateApiRequest({
      request: request("GET", { Origin: "https://partner.example" }),
      env: { API_ALLOWED_ORIGINS: "https://partner.example" },
      next: asset(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://partner.example");
  });

  it("refuses any other origin with a 403 pointing to the terms, without reading the file", async () => {
    const next = asset();
    const res = await gateApiRequest({
      request: request("GET", { Origin: "https://example.com" }),
      env: { API_ALLOWED_ORIGINS: "https://partner.example" },
      next,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("origin_not_allowed");
    expect(body.terms).toBe(TERMS_URL);
    expect(TERMS_URL).toBe("https://motor.fusionspace.co/api#terms");
  });

  it("replaces a wildcard CORS header from upstream and keeps an existing Vary", async () => {
    const next = asset({ "Access-Control-Allow-Origin": "*", Vary: "Accept-Encoding" });
    const plain = await gateApiRequest({ request: request("GET"), env: {}, next });
    expect(plain.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(plain.headers.get("Vary")).toBe("Accept-Encoding, Origin");
    const own = await gateApiRequest({
      request: request("GET", { Origin: "https://fusionspace.co" }),
      env: {},
      next,
    });
    expect(own.headers.get("Access-Control-Allow-Origin")).toBe("https://fusionspace.co");
  });

  it("handles HEAD like GET", async () => {
    const next = vi.fn(async () => new Response(null, { status: 200, headers: { "Cache-Control": "public, max-age=600" } }));
    const res = await gateApiRequest({
      request: request("HEAD", { Origin: "https://motor.fusionspace.co" }),
      env: {},
      next,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://motor.fusionspace.co");
  });

  it("answers a preflight from an allowed origin itself", async () => {
    const next = asset();
    const res = await gateApiRequest({
      request: request("OPTIONS", {
        Origin: "https://muster.fusionspace.co",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "if-none-match",
      }),
      env: {},
      next,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://muster.fusionspace.co");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("if-none-match");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("refuses a preflight from another origin", async () => {
    const res = await gateApiRequest({
      request: request("OPTIONS", { Origin: "https://example.com", "Access-Control-Request-Method": "GET" }),
      env: {},
      next: asset(),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers OPTIONS without an Origin with the allowed methods", async () => {
    const res = await gateApiRequest({ request: request("OPTIONS"), env: {}, next: asset() });
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("wiring", () => {
  const root = resolve(__dirname, "..");

  it("gates /api/v1/* and /availability.json through Pages Functions", () => {
    // Pages maps these file names to the routes /api/v1/* and /availability.json.
    for (const file of ["functions/api/v1/_middleware.ts", "functions/availability.json.ts"]) {
      const path = resolve(root, file);
      expect(existsSync(path), file).toBe(true);
      expect(readFileSync(path, "utf8")).toMatch(/export const onRequest = [^\n]*gateApiRequest\(context\)/);
    }
  });

  it("keeps wildcard CORS out of public/_headers", () => {
    const headers = readFileSync(resolve(root, "public/_headers"), "utf8");
    const rules = headers
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(rules).not.toMatch(/Access-Control-Allow-Origin/i);
  });
});
