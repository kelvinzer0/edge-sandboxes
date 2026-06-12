/**
 * edge-sandboxes — EdgeOne Edge Function
 *
 * Single bundled file for EdgeOne Pages Functions.
 * Route: /edge-functions/api/sandbox/[[default]].js
 *
 * Supports multiple API keys per provider with round-robin:
 *   E2B_API_KEY=key1,key2,key3
 *   DAYTONA_API_KEY=daytona-key1,daytona-key2
 */

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

// ─── Multi-Account Provider ─────────────────────────────────────────────────

class MultiAccountProvider {
  constructor(name, accounts) {
    this.name = name;
    this.accounts = accounts.map((p, i) => ({
      provider: p,
      circuitBreaker: new CircuitBreaker(),
      id: String(i),
    }));
    this.currentIndex = 0;
  }

  nextHealthy(exclude = new Set()) {
    const total = this.accounts.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      if (exclude.has(idx)) continue;
      const entry = this.accounts[idx];
      if (!entry.circuitBreaker.isOpen()) {
        this.currentIndex = (idx + 1) % total;
        return entry;
      }
    }
    return null;
  }

  async createSandbox(req) {
    const tried = new Set();
    const total = this.accounts.length;
    let lastError = null;

    while (tried.size < total) {
      const entry = this.nextHealthy(tried);
      if (!entry) break;
      const idx = this.accounts.indexOf(entry);
      tried.add(idx);

      try {
        const instance = await entry.provider.createSandbox(req);
        entry.circuitBreaker.recordSuccess();
        return { ...instance, provider: `${this.name}[${entry.id}]` };
      } catch (e) {
        entry.circuitBreaker.recordFailure();
        lastError = e;
      }
    }
    throw new Error(`All ${total} accounts of ${this.name} failed: ${lastError?.message}`);
  }

  async executeCommand(sandboxId, command, timeout) {
    for (const entry of this.accounts) {
      try {
        const result = await entry.provider.executeCommand(sandboxId, command, timeout);
        entry.circuitBreaker.recordSuccess();
        return result;
      } catch { continue; }
    }
    throw new Error(`Execute failed on all accounts of ${this.name}`);
  }

  async destroySandbox(sandboxId) {
    for (const entry of this.accounts) {
      try {
        const ok = await entry.provider.destroySandbox(sandboxId);
        if (ok) return true;
      } catch { continue; }
    }
    return false;
  }

  async listSandboxes() {
    const all = [];
    for (const entry of this.accounts) {
      try {
        const list = await entry.provider.listSandboxes();
        all.push(...list);
      } catch { continue; }
    }
    return all;
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────

function splitKeys(raw) {
  return raw.split(",").map(k => k.trim()).filter(Boolean);
}

const E2B_API_BASE = "https://api.e2b.app";

class E2BProvider {
  name = "e2b";
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sandboxes = new Map();
  }

  headers() {
    return { "X-API-Key": this.apiKey, "Content-Type": "application/json" };
  }

  async createSandbox(req) {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ templateID: req.image || "base", envVars: req.env_vars || {}, timeout: req.timeout || 120 }),
    });
    if (!resp.ok) throw new Error(`E2B create failed: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    this.sandboxes.set(data.sandboxID, { accessToken: data.envdAccessToken });
    return { id: data.sandboxID, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId, command, timeout) {
    const start = Date.now();
    const meta = this.sandboxes.get(sandboxId);
    const token = meta?.accessToken;

    const headers = { "Content-Type": "application/json", "Connect-Protocol-Version": "1" };
    if (token) headers["X-Access-Token"] = token;

    const resp = await fetch(`https://49983-${sandboxId}.e2b.app/process.Process/Start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ process: { cmd: "bash", args: ["-c", command], envs: {}, cwd: null } }),
    });
    if (!resp.ok) throw new Error(`E2B exec failed: ${resp.status}`);

    const text = await resp.text();
    const messages = text.split(/\r\n/).filter(Boolean);

    let exitCode = 0, stdout = "", stderr = "", error = "";

    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event;
        if (!event) continue;
        if (event.data) {
          if (event.data.stdout) stdout += atob(event.data.stdout);
          if (event.data.stderr) stderr += atob(event.data.stderr);
          if (event.data.pty) stdout += atob(event.data.pty);
        } else if (event.end) {
          const status = event.end.status || "";
          const exitMatch = status.match(/exit status (\d+)/);
          exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
          error = event.end.error || "";
        }
      } catch {}
    }
    return { exit_code: exitCode, stdout, stderr: stderr || error, duration_ms: Date.now() - start };
  }

  async destroySandbox(sandboxId) {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, { method: "DELETE", headers: this.headers() });
    this.sandboxes.delete(sandboxId);
    return resp.ok;
  }

  async listSandboxes() {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes`, { headers: this.headers() });
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = data.sandboxes || data || [];
    return items.map(s => ({ id: s.sandboxID, provider: this.name, state: s.state || "running" }));
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
    return Array.from(this.providers.entries()).map(([name, p]) => {
      const cb = this.circuitBreakers.get(name);
      const isMulti = p instanceof MultiAccountProvider;
      return {
        name,
        healthy: !cb.isOpen(),
        circuit_state: cb.state,
        failure_count: cb.failureCount,
        accounts: isMulti ? p.accounts.length : 1,
      };
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createRouter(env) {
  const router = new SandboxRouter();

  if (env.E2B_API_KEY) {
    const keys = splitKeys(env.E2B_API_KEY);
    const provider = keys.length > 1
      ? new MultiAccountProvider("e2b", keys.map(k => new E2BProvider(k)))
      : new E2BProvider(keys[0]);
    router.registerProvider("e2b", provider);
  }

  if (env.DAYTONA_API_KEY) {
    const keys = splitKeys(env.DAYTONA_API_KEY);
    const provider = keys.length > 1
      ? new MultiAccountProvider("daytona", keys.map(k => new DaytonaProvider(k, env.DAYTONA_API_URL)))
      : new DaytonaProvider(keys[0], env.DAYTONA_API_URL);
    router.registerProvider("daytona", provider);
  }

  if (env.MODAL_TOKEN_ID) {
    const keys = splitKeys(env.MODAL_TOKEN_ID);
    const provider = keys.length > 1
      ? new MultiAccountProvider("modal", keys.map(k => new ModalProvider(k)))
      : new ModalProvider(keys[0]);
    router.registerProvider("modal", provider);
  }

  if (env.DEFAULT_PROVIDER) router.defaultProvider = env.DEFAULT_PROVIDER;
  return router;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
