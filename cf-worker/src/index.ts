/**
 * Cloudflare Worker — edge-sandboxes
 *
 * Uses @cloudflare/sandbox for native sandbox execution.
 * Exposes the same API format as the EdgeOne deployment:
 *   POST /api/sandbox/create
 *   POST /api/sandbox/{id}/exec
 *   DELETE /api/sandbox/{id}
 *   GET  /api/sandbox/health
 *
 * Deploy:
 *   cd cf-worker
 *   npm install
 *   npx wrangler deploy
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  API_TOKEN?: string;
  DEFAULT_PROVIDER?: string;
  EDGEONE_WORKER_URL?: string;
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
};

function jsonResponse(data: unknown, status = 200): Response {
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

function corsResponse(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function checkAuth(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return true;
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.API_TOKEN}`;
}

async function createSandbox(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as any;
  const sandboxId = body.labels?.session || body.labels?.name || `sbx-${Date.now()}`;

  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Run setup commands if provided
  if (body.env_vars) {
    for (const [key, val] of Object.entries(body.env_vars)) {
      await sandbox.exec(`export ${key}="${val}"`);
    }
  }

  return jsonResponse({
    id: sandboxId,
    provider: "cloudflare",
    state: "running",
    _provider: "cloudflare",
  }, 201);
}

async function execCommand(request: Request, env: Env, sandboxId: string): Promise<Response> {
  const body = (await request.json()) as any;
  const { command, timeout } = body;

  if (!command) {
    return jsonResponse({ error: "command is required" }, 400);
  }

  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const start = Date.now();

  try {
    const result = await sandbox.exec(command, {
      timeout: timeout ? timeout * 1000 : undefined,
    });

    return jsonResponse({
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: Date.now() - start,
    });
  } catch (e: any) {
    return jsonResponse({
      exit_code: 1,
      stdout: "",
      stderr: e.message || String(e),
      duration_ms: Date.now() - start,
    });
  }
}

async function destroySandbox(request: Request, env: Env, sandboxId: string): Promise<Response> {
  try {
    const sandbox = getSandbox(env.Sandbox, sandboxId);
    await sandbox.destroy();
  } catch {
    // Ignore errors on destroy
  }
  return jsonResponse({ destroyed: true });
}

async function healthCheck(env: Env): Promise<Response> {
  return jsonResponse({
    status: "ok",
    providers: [
      {
        name: "cloudflare",
        healthy: true,
        circuit_state: "closed",
        failure_count: 0,
        accounts: 1,
      },
    ],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return corsResponse();
    if (!checkAuth(request, env)) return jsonResponse({ error: "Unauthorized" }, 401);

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === "/api/sandbox/health" || path === "/api/sandbox/") {
        if (request.method === "GET") {
          return healthCheck(env);
        }
      }

      // Create sandbox
      if (path === "/api/sandbox/create" && request.method === "POST") {
        return createSandbox(request, env);
      }

      // Execute command
      const execMatch = path.match(/^\/api\/sandbox\/([^/]+)\/exec$/);
      if (execMatch && request.method === "POST") {
        return execCommand(request, env, execMatch[1]);
      }

      // Destroy sandbox
      const destroyMatch = path.match(/^\/api\/sandbox\/([^/]+)$/);
      if (destroyMatch && request.method === "DELETE") {
        return destroySandbox(request, env, destroyMatch[1]);
      }

      return jsonResponse({ error: "Not found", path }, 404);
    } catch (e: any) {
      return jsonResponse({ error: e.message }, 500);
    }
  },
};
