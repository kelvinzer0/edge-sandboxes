import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class DaytonaProvider extends SandboxProvider {
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
    const data = (await resp.json()) as any;
    const items = Array.isArray(data) ? data : data.items || [];
    return items.map((s: any) => ({
      id: s.id,
      provider: this.name,
      state: "running",
      labels: s.labels || {},
    }));
  }
}
