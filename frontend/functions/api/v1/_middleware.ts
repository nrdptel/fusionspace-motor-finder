// Cloudflare Pages middleware for the public data API: every request under
// /api/v1/* (all static JSON files written by scripts/gen-api.mjs) passes
// through here first. The origin rule lives in lib/apiAccess.ts (unit-tested in
// lib/apiAccess.test.ts): own sites and API_ALLOWED_ORIGINS get CORS, other
// browser origins get 403, requests with no Origin header go on to the file.
//
// Scoped to /api/v1/ on purpose: the alert Functions under /api/alerts/ are the
// site's own same-origin endpoints and keep their behavior.
import { gateApiRequest, type GateContext } from "../../../lib/apiAccess";

export const onRequest = (context: GateContext): Promise<Response> => gateApiRequest(context);
