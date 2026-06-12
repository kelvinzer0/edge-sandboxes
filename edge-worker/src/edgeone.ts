/**
 * Tencent EdgeOne adapter.
 *
 * Deploy:
 *   1. Create a Pages project on EdgeOne console
 *   2. Put this file in /edge-functions/api/sandbox/[[default]].js
 *   3. Set environment variables in EdgeOne dashboard
 */

import { Env, handleRequest } from "./core";

export async function onRequest(context: any): Promise<Response> {
  return handleRequest(context.request, context.env);
}
