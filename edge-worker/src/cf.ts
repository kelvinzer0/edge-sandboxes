/**
 * Cloudflare Worker entry — edge-sandboxes
 *
 * When deployed to Cloudflare:
 * - @cloudflare/sandbox is auto-detected (Sandbox Durable Object binding)
 * - Additional providers via env URLs (EDGEONE_WORKER_URL, etc.)
 * - Auto fallback if default fails
 */

export { Sandbox } from "@cloudflare/sandbox";

import type { Env } from "./types";
import { handleRequest } from "./handlers";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
