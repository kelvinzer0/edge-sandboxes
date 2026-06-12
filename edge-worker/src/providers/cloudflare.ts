import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class CloudflareSandboxProvider extends SandboxProvider {
  name = "cloudflare";
  private workerUrl: string;

  constructor(workerUrl: string) {
    super();
    this.workerUrl = workerUrl.replace(/\/$/, "");
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${this.workerUrl}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: req.image,
        env: req.env_vars || {},
        labels: req.labels || {},
        timeout: req.timeout,
      }),
    });
    if (!resp.ok) throw new Error(`Cloudflare create failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return {
      id: data.id || data.sandboxId || "",
      provider: this.name,
      state: "running",
      labels: req.labels,
    };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`${this.workerUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId, command, timeout }),
    });
    if (!resp.ok) throw new Error(`Cloudflare exec failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exitCode ?? data.exit_code ?? 0,
      stdout: data.stdout ?? data.output ?? "",
      stderr: data.stderr ?? data.error ?? "",
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${this.workerUrl}/destroy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId }),
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch(`${this.workerUrl}/list`);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const items = data.sandboxes || data || [];
    return items.map((s: any) => ({
      id: s.id || s.sandboxId,
      provider: this.name,
      state: "running",
    }));
  }
}
