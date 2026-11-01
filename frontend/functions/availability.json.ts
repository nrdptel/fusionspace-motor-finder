// Cloudflare Pages Function for the bulk availability feed at /availability.json
// (a static file written by scripts/gen-api.mjs). The file name maps to exactly
// that one route, so the origin check runs here without a root middleware that
// would run on every page. Same rule as /api/v1/* (lib/apiAccess.ts):
// `context.next()` serves the static file for allowed and Origin-less requests.
import { gateApiRequest, type GateContext } from "../lib/apiAccess";

export const onRequest = (context: GateContext): Promise<Response> => gateApiRequest(context);
