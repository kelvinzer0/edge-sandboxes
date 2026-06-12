import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class CloudflareSandboxProvider extends SandboxProvider {
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
