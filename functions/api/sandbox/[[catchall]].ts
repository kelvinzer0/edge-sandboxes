/**
 * Cloudflare Pages Function — edge-sandboxes
 */

interface Env {
  Sandbox?: DurableObjectNamespace;
  API_TOKEN?: string;
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

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/sandbox/, "") || "/";

  try {
    // Health
    if ((path === "/health" || path === "/") && request.method === "GET") {
      return json({ status: "ok", providers: [{ name: "cloudflare", healthy: true, circuit_state: "closed", failure_count: 0, accounts: 1 }] });
    }

    // Create sandbox
    if (path === "/create" && request.method === "POST") {
      const body = (await request.json()) as any;
      const id = body.labels?.session || body.labels?.name || `sbx-${Date.now()}`;

      // Use @cloudflare/sandbox if available
      if (env.Sandbox) {
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox = getSandbox(env.Sandbox, id);
        if (body.env_vars) {
          for (const [k, v] of Object.entries(body.env_vars)) {
            await sandbox.exec(`export ${k}="${v}"`);
          }
        }
      }

      return json({ id, provider: "cloudflare", state: "running", _provider: "cloudflare" }, 201);
    }

    // Exec command
    const execMatch = path.match(/^\/([^/]+)\/exec$/);
    if (execMatch && request.method === "POST") {
      const body = (await request.json()) as any;
      const start = Date.now();

      if (env.Sandbox) {
        const { getSandbox } = await import("@cloudflare/sandbox");
        const sandbox = getSandbox(env.Sandbox, execMatch[1]);
        try {
          const result = await sandbox.exec(body.command, { timeout: body.timeout ? body.timeout * 1000 : undefined });
          return json({ exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start });
        } catch (e: any) {
          return json({ exit_code: 1, stdout: "", stderr: e.message, duration_ms: Date.now() - start });
        }
      }

      return json({ exit_code: 1, stdout: "", stderr: "Sandbox not available", duration_ms: Date.now() - start });
    }

    // Destroy
    const destroyMatch = path.match(/^\/([^/]+)$/);
    if (destroyMatch && request.method === "DELETE") {
      if (env.Sandbox) {
        try {
          const { getSandbox } = await import("@cloudflare/sandbox");
          const sandbox = getSandbox(env.Sandbox, destroyMatch[1]);
          await sandbox.destroy();
        } catch {}
      }
      return json({ destroyed: true });
    }

    return json({ error: "Not found", path }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
};
