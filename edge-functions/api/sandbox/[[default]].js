/**
 * edge-sandboxes — EdgeOne Edge Function
 *
 * Single bundled file for EdgeOne Pages Functions.
 * Route: /edge-functions/api/sandbox/[[default]].js
 *
 * Deploy:
 *   1. Create Pages project on EdgeOne console
 *   2. This file is auto-detected
 *   3. Set env vars in dashboard
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** @typedef {{ provider?: string; fallback?: string[]; image?: string; labels?: Record<string, string>; env_vars?: Record<string, string>; timeout?: number }} SandboxRequest */
/** @typedef {{ id: string; provider: string; state: string; labels?: Record<string, string> }} SandboxInstance */
/** @typedef {{ exit_code: number; stdout: string; stderr: string; duration_ms?: number }} ExecutionResult */

// ─── Circuit Breaker ────────────────────────────────────────────────────────

class CircuitBreaker {
  state = "closed";
  failureCount = 0;
  successCount = 0;
  lastFailureTime = 0;

  constructor(failureThreshold = 5, recoveryTimeout = 60) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout * 1000;
    this.successThreshold = 2;
  }

  isOpen() {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeout) {
        this.state = "half_open";
        this.successCount = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess() {
    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "closed";
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "half_open" || this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.successCount = 0;
    }
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────

class E2BProvider {
  name = "e2b";
  constructor(apiKey) { this.apiKey = apiKey; }

  async createSandbox(req) {
    const resp = await fetch("https://api.e2b.dev/sandboxes", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: req.image || "base", envVars: req.env_vars || {}, timeout: req.timeout || 120 }),
    });
    if (!resp.ok) throw new Error(`E2B create failed: ${resp.status}`);
    const data = await resp.json();
    return { id: data.sandboxID, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId, command, timeout) {
    const start = Date.now();
    const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}/commands`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command, timeout: timeout || 30 }),
    });
    if (!resp.ok) throw new Error(`E2B exec failed: ${resp.status}`);
    const data = await resp.json();
    return { exit_code: data.exitCode ?? 0, stdout: data.stdout ?? "", stderr: data.stderr ?? "", duration_ms: Date.now() - start };
  }

  async destroySandbox(sandboxId) {
    const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
      method: "DELETE", headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    return resp.ok;
  }

  async listSandboxes() {
    const resp = await fetch("https://api.e2b.dev/sandboxes", { headers: { "Authorization": `Bearer ${this.apiKey}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(s => ({ id: s.sandboxID, provider: this.name, state: s.state || "running" }));
  }
}

class DaytonaProvider {
  name = "daytona";
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://app.daytona.io/api";
  }

  async createSandbox(req) {
    const resp = await fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: req.image || "daytonaio/ai-test:0.2.3", envVars: req.env_vars || {}, labels: req.labels || {} }),
    });
    if (!resp.ok) throw new Error(`Daytona create failed: ${resp.status}`);
    const data = await resp.json();
    return { id: data.id, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId, command, timeout) {
    const start = Date.now();
    const resp = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    if (!resp.ok) throw new Error(`Daytona exec failed: ${resp.status}`);
    const data = await resp.json();
    return { exit_code: data.exitCode ?? 0, stdout: data.stdout ?? "", stderr: data.stderr ?? "", duration_ms: Date.now() - start };
  }

  async destroySandbox(sandboxId) {
    const resp = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}`, {
      method: "DELETE", headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    return resp.ok;
  }

  async listSandboxes() {
    const resp = await fetch(`${this.baseUrl}/sandboxes`, { headers: { "Authorization": `Bearer ${this.apiKey}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = Array.isArray(data) ? data : data.items || [];
    return items.map(s => ({ id: s.id, provider: this.name, state: "running", labels: s.labels || {} }));
  }
}

class ModalProvider {
  name = "modal";
  constructor(token) { this.token = token; }

  async createSandbox(req) {
    const resp = await fetch("https://api.modal.com/v1/sandboxes", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: req.image || "python:3.12-slim", env: req.env_vars || {}, timeout: req.timeout || 120 }),
    });
    if (!resp.ok) throw new Error(`Modal create failed: ${resp.status}`);
    const data = await resp.json();
    return { id: data.id, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId, command, timeout) {
    const start = Date.now();
    const resp = await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command, timeout: timeout || 30 }),
    });
    if (!resp.ok) throw new Error(`Modal exec failed: ${resp.status}`);
    const data = await resp.json();
    return { exit_code: data.exit_code ?? 0, stdout: data.stdout ?? "", stderr: data.stderr ?? "", duration_ms: Date.now() - start };
  }

  async destroySandbox(sandboxId) {
    const resp = await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}`, {
      method: "DELETE", headers: { "Authorization": `Bearer ${this.token}` },
    });
    return resp.ok;
  }

  async listSandboxes() {
    const resp = await fetch("https://api.modal.com/v1/sandboxes", { headers: { "Authorization": `Bearer ${this.token}` } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map(s => ({ id: s.id, provider: this.name, state: s.state || "running" }));
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

class SandboxRouter {
  constructor() {
    this.providers = new Map();
    this.circuitBreakers = new Map();
    this.defaultProvider = null;
  }

  registerProvider(name, provider) {
    this.providers.set(name, provider);
    this.circuitBreakers.set(name, new CircuitBreaker());
    if (!this.defaultProvider) this.defaultProvider = name;
  }

  resolveChain(provider, fallback) {
    const chain = [];
    if (provider) chain.push(provider);
    if (fallback) chain.push(...fallback);
    if (!chain.length && this.defaultProvider) chain.push(this.defaultProvider);
    return chain.filter(name => {
      const p = this.providers.get(name);
      const cb = this.circuitBreakers.get(name);
      return p && (!cb || !cb.isOpen());
    });
  }

  async createSandbox(req) {
    const chain = this.resolveChain(req.provider, req.fallback);
    if (!chain.length) throw new Error("No healthy providers available");
    let lastError = null;
    for (const name of chain) {
      const provider = this.providers.get(name);
      const cb = this.circuitBreakers.get(name);
      try {
        const instance = await provider.createSandbox(req);
        cb.recordSuccess();
        return { ...instance, _provider: name };
      } catch (e) {
        cb.recordFailure();
        lastError = e;
      }
    }
    throw new Error(`All providers failed: ${lastError?.message}`);
  }

  async executeCommand(provider, sandboxId, command, timeout) {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`Provider '${provider}' not found`);
    return p.executeCommand(sandboxId, command, timeout);
  }

  async destroySandbox(provider, sandboxId) {
    const p = this.providers.get(provider);
    if (!p) return false;
    return p.destroySandbox(sandboxId);
  }

  getHealthStatus() {
    return Array.from(this.providers.entries()).map(([name]) => {
      const cb = this.circuitBreakers.get(name);
      return { name, healthy: !cb.isOpen(), circuit_state: cb.state, failure_count: cb.failureCount };
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createRouter(env) {
  const router = new SandboxRouter();
  if (env.E2B_API_KEY) router.registerProvider("e2b", new E2BProvider(env.E2B_API_KEY));
  if (env.DAYTONA_API_KEY) router.registerProvider("daytona", new DaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_API_URL));
  if (env.MODAL_TOKEN_ID) router.registerProvider("modal", new ModalProvider(env.MODAL_TOKEN_ID));
  if (env.DEFAULT_PROVIDER) router.defaultProvider = env.DEFAULT_PROVIDER;
  return router;
}

function checkAuth(request, env) {
  if (!env.API_TOKEN) return true;
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.API_TOKEN}`;
}

function jsonResponse(data, status = 200) {
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

function corsResponse() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

async function handleRequest(request, env) {
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
      const body = await request.json();
      const instance = await router.createSandbox(body);
      return jsonResponse(instance, 201);
    }

    const execMatch = path.match(/^\/([^/]+)\/exec$/);
    if (execMatch && request.method === "POST") {
      const sandboxId = execMatch[1];
      const body = await request.json();
      const result = await router.executeCommand(body.provider, sandboxId, body.command, body.timeout);
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
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ─── EdgeOne Entry Point ────────────────────────────────────────────────────

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
