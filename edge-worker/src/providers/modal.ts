import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

export class ModalProvider extends SandboxProvider {
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
