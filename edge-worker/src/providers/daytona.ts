import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

const DAYTONA_API_BASE = "https://app.daytona.io/api";

export class DaytonaProvider extends SandboxProvider {
  name = "daytona";
  private apiKey: string;
  private sandboxes: Map<string, { toolboxUrl: string }> = new Map();

  constructor(apiKey: string, _baseUrl?: string) {
    super();
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${DAYTONA_API_BASE}/sandbox`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        snapshot: req.image || "daytona-small",
        env: req.env_vars || {},
        labels: req.labels || {},
      }),
    });
    if (!resp.ok) throw new Error(`Daytona create failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;

    const toolboxUrl = data.toolboxProxyUrl || "";
    this.sandboxes.set(data.id, { toolboxUrl });

    return {
      id: data.id,
      provider: this.name,
      state: "running",
      labels: req.labels,
    };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const meta = this.sandboxes.get(sandboxId);
    if (!meta?.toolboxUrl) throw new Error(`Daytona sandbox ${sandboxId} not found`);

    const resp = await fetch(`${meta.toolboxUrl}/process/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ command }),
    });

    if (!resp.ok) throw new Error(`Daytona exec failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;

    return {
      exit_code: data.exitCode ?? 0,
      stdout: data.result ?? "",
      stderr: data.error ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${DAYTONA_API_BASE}/sandbox/${sandboxId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    this.sandboxes.delete(sandboxId);
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch(`${DAYTONA_API_BASE}/sandbox`, {
      headers: this.headers(),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const items = Array.isArray(data) ? data : data.items || [];
    return items.map((s: any) => ({
      id: s.id,
      provider: this.name,
      state: s.state || "running",
      labels: s.labels || {},
    }));
  }
}
