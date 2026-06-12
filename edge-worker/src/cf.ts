/**
 * Cloudflare Worker adapter.
 *
 * Deploy: npx wrangler deploy
 */

import { Env, handleRequest } from "./core";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
