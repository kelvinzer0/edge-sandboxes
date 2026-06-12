/**
 * edge-sandboxes — Shared core logic for edge workers.
 *
 * Contains: types, circuit breaker, provider implementations, router,
 * request handlers. Used by both Cloudflare and EdgeOne adapters.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Env {
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  MODAL_TOKEN_ID?: string;
  HOPX_API_KEY?: string;
  VERCEL_TOKEN?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_TEAM_ID?: string;
  SPRITES_TOKEN?: string;
  CLOUDFLARE_SANDBOX_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  EDGEONE_FUNCTION_URL?: string;
  EDGEONE_API_TOKEN?: string;
  API_TOKEN?: string;
  DEFAULT_PROVIDER?: string;
}

export interface SandboxRequest {
  provider?: string;
  fallback?: string[];
  image?: string;
  labels?: Record<string, string>;
  env_vars?: Record<string, string>;
  timeout?: number;
}

export interface SandboxInstance {
  id: string;
  provider: string;
  state: string;
  labels?: Record<string, string>;
}

export interface ExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms?: number;
}

export interface ProviderHealth {
  name: string;
  healthy: boolean;
  circuit_state: "closed" | "open" | "half_open";
  failure_count: number;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export class CircuitBreaker {
  state: "closed" | "open" | "half_open" = "closed";
  failureCount = 0;
  successCount = 0;
  lastFailureTime = 0;
  failureThreshold: number;
  recoveryTimeout: number;
  successThreshold: number;

  constructor(opts?: { failureThreshold?: number; recoveryTimeout?: number; successThreshold?: number }) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.recoveryTimeout = (opts?.recoveryTimeout ?? 60) * 1000;
    this.successThreshold = opts?.successThreshold ?? 2;
  }

  isOpen(): boolean {
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

  recordSuccess(): void {
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

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "half_open" || this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.successCount = 0;
    }
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────

abstract class SandboxProvider {
  abstract name: string;
  abstract createSandbox(req: SandboxRequest): Promise<SandboxInstance>;
  abstract executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult>;
  abstract destroySandbox(sandboxId: string): Promise<boolean>;
  abstract listSandboxes(): Promise<SandboxInstance[]>;

  async healthCheck(): Promise<boolean> {
    try {
      await this.listSandboxes();
      return true;
    } catch {
      return false;
    }
  }
}

class E2BProvider extends SandboxProvider {
  name = "e2b";
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch("https://api.e2b.dev/sandboxes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        templateID: req.image || "base",
        envVars: req.env_vars || {},
        timeout: req.timeout || 120,
      }),
    });
    if (!resp.ok) throw new Error(`E2B create failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return { id: data.sandboxID, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}/commands`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, timeout: timeout || 30 }),
    });
    if (!resp.ok) throw new Error(`E2B exec failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exitCode ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch("https://api.e2b.dev/sandboxes", {
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((s: any) => ({
      id: s.sandboxID,
      provider: this.name,
      state: s.state || "running",
    }));
  }
}

class DaytonaProvider extends SandboxProvider {
  name = "daytona";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://app.daytona.io/api";
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: req.image || "daytonaio/ai-test:0.2.3",
        envVars: req.env_vars || {},
        labels: req.labels || {},
      }),
    });
    if (!resp.ok) throw new Error(`Daytona create failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return { id: data.id, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command }),
    });
    if (!resp.ok) throw new Error(`Daytona exec failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exitCode ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch(`${this.baseUrl}/sandboxes`, {
      headers: { "Authorization": `Bearer ${this.apiKey}` },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return (Array.isArray(data) ? data : data.items || []).map((s: any) => ({
      id: s.id,
      provider: this.name,
      state: "running",
      labels: s.labels || {},
    }));
  }
}

class ModalProvider extends SandboxProvider {
  name = "modal";
  private token: string;

  constructor(token: string) {
    super();
    this.token = token;
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch("https://api.modal.com/v1/sandboxes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image: req.image || "python:3.12-slim",
        env: req.env_vars || {},
        timeout: req.timeout || 120,
      }),
    });
    if (!resp.ok) throw new Error(`Modal create failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return { id: data.id, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, timeout: timeout || 30 }),
    });
    if (!resp.ok) throw new Error(`Modal exec failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exit_code ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`https://api.modal.com/v1/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch("https://api.modal.com/v1/sandboxes", {
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return data.map((s: any) => ({
      id: s.id,
      provider: this.name,
      state: s.state || "running",
    }));
  }
}

class CloudflareSandboxProvider extends SandboxProvider {
  name = "cloudflare";
  private baseUrl: string;
  private apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    super();
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${this.baseUrl}/api/session/create`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        env: req.env_vars || {},
        cwd: "/workspace",
        isolation: true,
      }),
    });
    if (!resp.ok) throw new Error(`Cloudflare create failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return { id: data.id || data.sessionId, provider: this.name, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`${this.baseUrl}/api/execute`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: sandboxId, command }),
    });
    if (!resp.ok) throw new Error(`Cloudflare exec failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exitCode ?? data.exit_code ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/api/process/kill-all?session=${sandboxId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${this.apiToken}` },
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch(`${this.baseUrl}/api/session/list`, {
      headers: { "Authorization": `Bearer ${this.apiToken}` },
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const sessions = data.sessions || [];
    return sessions.map((id: string) => ({
      id,
      provider: this.name,
      state: "running",
    }));
  }
}

class EdgeOneProvider extends SandboxProvider {
  name = "edgeone";
  private functionUrl: string;
  private apiToken: string;

  constructor(functionUrl: string, apiToken?: string) {
    super();
    this.functionUrl = functionUrl;
    this.apiToken = apiToken || "";
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${this.functionUrl}/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiToken ? { "Authorization": `Bearer ${this.apiToken}` } : {}),
      },
      body: JSON.stringify({
        provider: req.image,
        image: req.image,
        labels: req.labels || {},
        env_vars: req.env_vars || {},
        timeout: req.timeout,
      }),
    });
    if (!resp.ok) throw new Error(`EdgeOne create failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return { id: data.id, provider: `edgeone/${data._provider || "unknown"}`, state: "running", labels: req.labels };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`${this.functionUrl}/${sandboxId}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiToken ? { "Authorization": `Bearer ${this.apiToken}` } : {}),
      },
      body: JSON.stringify({ command, timeout }),
    });
    if (!resp.ok) throw new Error(`EdgeOne exec failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exit_code ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: data.duration_ms ?? Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${this.functionUrl}/${sandboxId}`, {
      method: "DELETE",
      headers: this.apiToken ? { "Authorization": `Bearer ${this.apiToken}` } : {},
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    return [];
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export class SandboxRouter {
  providers: Map<string, SandboxProvider> = new Map();
  circuitBreakers: Map<string, CircuitBreaker> = new Map();
  defaultProvider?: string;

  registerProvider(name: string, provider: SandboxProvider): void {
    this.providers.set(name, provider);
    this.circuitBreakers.set(name, new CircuitBreaker());
    if (!this.defaultProvider) this.defaultProvider = name;
  }

  private resolveChain(provider?: string, fallback?: string[]): string[] {
    const chain: string[] = [];
    if (provider) chain.push(provider);
    if (fallback) chain.push(...fallback);
    if (!chain.length && this.defaultProvider) chain.push(this.defaultProvider);
    return chain.filter((name) => {
      const p = this.providers.get(name);
      const cb = this.circuitBreakers.get(name);
      return p && (!cb || !cb.isOpen());
    });
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance & { _provider: string }> {
    const chain = this.resolveChain(req.provider, req.fallback);
    if (!chain.length) throw new Error("No healthy providers available");
    let lastError: Error | null = null;
    for (const name of chain) {
      const provider = this.providers.get(name)!;
      const cb = this.circuitBreakers.get(name)!;
      try {
        const instance = await provider.createSandbox(req);
        cb.recordSuccess();
        return { ...instance, _provider: name };
      } catch (e: any) {
        cb.recordFailure();
        lastError = e;
      }
    }
    throw new Error(`All providers failed: ${lastError?.message}`);
  }

  async executeCommand(provider: string, sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`Provider '${provider}' not found`);
    return p.executeCommand(sandboxId, command, timeout);
  }

  async destroySandbox(provider: string, sandboxId: string): Promise<boolean> {
    const p = this.providers.get(provider);
    if (!p) return false;
    return p.destroySandbox(sandboxId);
  }

  getHealthStatus(): ProviderHealth[] {
    return Array.from(this.providers.entries()).map(([name]) => {
      const cb = this.circuitBreakers.get(name)!;
      return {
        name,
        healthy: !cb.isOpen(),
        circuit_state: cb.state,
        failure_count: cb.failureCount,
      };
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRouter(env: Env): SandboxRouter {
  const router = new SandboxRouter();

  if (env.E2B_API_KEY) router.registerProvider("e2b", new E2BProvider(env.E2B_API_KEY));
  if (env.DAYTONA_API_KEY) router.registerProvider("daytona", new DaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_API_URL));
  if (env.MODAL_TOKEN_ID) router.registerProvider("modal", new ModalProvider(env.MODAL_TOKEN_ID));
  if (env.CLOUDFLARE_SANDBOX_BASE_URL && env.CLOUDFLARE_API_TOKEN) {
    router.registerProvider("cloudflare", new CloudflareSandboxProvider(env.CLOUDFLARE_SANDBOX_BASE_URL, env.CLOUDFLARE_API_TOKEN));
  }
  if (env.EDGEONE_FUNCTION_URL) {
    router.registerProvider("edgeone", new EdgeOneProvider(env.EDGEONE_FUNCTION_URL, env.EDGEONE_API_TOKEN));
  }

  if (env.DEFAULT_PROVIDER) router.defaultProvider = env.DEFAULT_PROVIDER;
  return router;
}

// ─── Request Handler ────────────────────────────────────────────────────────

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
      const body = (await request.json()) as { command: string; provider: string; timeout?: number };
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
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}
