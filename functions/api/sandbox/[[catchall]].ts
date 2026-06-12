/**
 * Cloudflare Pages Function — edge-sandboxes
 *
 * Env vars (set in Cloudflare dashboard):
 *   E2B_API_KEY=your-key
 *   DAYTONA_API_KEY=your-key
 *   EDGEONE_WORKER_URL=https://xxx.edgeone.dev
 *   CLOUDFLARE_WORKER_URL=https://xxx.workers.dev
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  API_TOKEN?: string;
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  EDGEONE_WORKER_URL?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function cors() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "OPTIONS") return cors();

  if (env.API_TOKEN) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.API_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/sandbox/, "") || "/";

  try {
    if ((path === "/health" || path === "/") && request.method === "GET") {
      return json({
        status: "ok",
        providers: [{
          name: "cloudflare",
          healthy: true,
          circuit_state: "closed",
          failure_count: 0,
          accounts: 1,
        }],
      });
    }

    if (path === "/create" && request.method === "POST") {
      const body = (await request.json()) as any;
      const id = body.labels?.session || body.labels?.name || `sbx-${Date.now()}`;
      const sandbox = getSandbox(env.Sandbox, id);

      if (body.env_vars) {
        for (const [k, v] of Object.entries(body.env_vars)) {
          await sandbox.exec(`export ${k}="${v}"`);
        }
      }

      return json({ id, provider: "cloudflare", state: "running", _provider: "cloudflare" }, 201);
    }

    const execMatch = path.match(/^\/([^/]+)\/exec$/);
    if (execMatch && request.method === "POST") {
      const body = (await request.json()) as any;
      const sandbox = getSandbox(env.Sandbox, execMatch[1]);
      const start = Date.now();

      try {
        const result = await sandbox.exec(body.command, {
          timeout: body.timeout ? body.timeout * 1000 : undefined,
        });
        return json({
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: Date.now() - start,
        });
      } catch (e: any) {
        return json({
          exit_code: 1,
          stdout: "",
          stderr: e.message,
          duration_ms: Date.now() - start,
        });
      }
    }

    const destroyMatch = path.match(/^\/([^/]+)$/);
    if (destroyMatch && request.method === "DELETE") {
      try {
        const sandbox = getSandbox(env.Sandbox, destroyMatch[1]);
        await sandbox.destroy();
      } catch {}
      return json({ destroyed: true });
    }

    return json({ error: "Not found", path }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
};
