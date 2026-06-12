import type { Env, SandboxRequest } from "./types";
import { SandboxRouter } from "./router";
import { createProviders } from "./providers";

export function createRouter(env: Env): SandboxRouter {
  const router = new SandboxRouter();
  const providers = createProviders(env);

  for (const [name, provider] of providers) {
    router.registerProvider(name, provider);
  }

  if (env.DEFAULT_PROVIDER) router.defaultProvider = env.DEFAULT_PROVIDER;
  return router;
}

export function checkAuth(request: Request, env: Env): boolean {
  if (!env.API_TOKEN) return true;
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.API_TOKEN}`;
}

export function jsonResponse(data: unknown, status = 200): Response {
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

export function corsResponse(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return corsResponse();
  if (!checkAuth(request, env)) return jsonResponse({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/sandbox/, "") || "/";
  const router = createRouter(env);

  try {
    if (path === "/health" || path === "/") {
      if (request.method === "GET") {
        return jsonResponse({ status: "ok", providers: router.getHealthStatus() });
      }
    }

    if (path === "/create" && request.method === "POST") {
      const body = (await request.json()) as SandboxRequest;
      const instance = await router.createSandbox(body);
      return jsonResponse(instance, 201);
    }

    const execMatch = path.match(/^\/([^/]+)\/exec$/);
    if (execMatch && request.method === "POST") {
      const sandboxId = execMatch[1];
      const body = (await request.json()) as { command: string; provider?: string; timeout?: number };
      const provider = body.provider || env.DEFAULT_PROVIDER || "cloudflare";
      const result = await router.executeCommand(provider, sandboxId, body.command, body.timeout);
      return jsonResponse(result);
    }

    const destroyMatch = path.match(/^\/([^/]+)$/);
    if (destroyMatch && request.method === "DELETE") {
      const sandboxId = destroyMatch[1];
      const provider = url.searchParams.get("provider") || env.DEFAULT_PROVIDER || "";
      const ok = await router.destroySandbox(provider, sandboxId);
      return jsonResponse({ destroyed: ok });
    }

    return jsonResponse({ error: "Not found", path }, 404);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}
