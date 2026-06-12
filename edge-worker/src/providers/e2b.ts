import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class E2BProvider extends SandboxProvider {
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
