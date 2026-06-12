import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class EdgeOneProvider extends SandboxProvider {
  name = "edgeone";
  private workerUrl: string;

  constructor(workerUrl: string) {
    super();
    this.workerUrl = workerUrl.replace(/\/$/, "");
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${this.workerUrl}/api/sandbox/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: req.image,
        image: req.image,
        labels: req.labels || {},
        env_vars: req.env_vars || {},
        timeout: req.timeout,
      }),
    });
    if (!resp.ok) throw new Error(`EdgeOne create failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return {
      id: data.id || "",
      provider: `edgeone/${data._provider || "unknown"}`,
      state: "running",
      labels: req.labels,
    };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const resp = await fetch(`${this.workerUrl}/api/sandbox/${sandboxId}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, timeout }),
    });
    if (!resp.ok) throw new Error(`EdgeOne exec failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as any;
    return {
      exit_code: data.exit_code ?? 0,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      duration_ms: data.duration_ms ?? Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${this.workerUrl}/api/sandbox/${sandboxId}`, {
      method: "DELETE",
    });
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    return [];
  }
}
