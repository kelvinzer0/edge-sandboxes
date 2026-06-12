import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

const E2B_API_BASE = "https://api.e2b.app";

interface E2BSandboxResponse {
  sandboxID: string;
  templateID: string;
  clientID: string;
  envdVersion: string;
  envdAccessToken?: string | null;
}

export class E2BProvider extends SandboxProvider {
  name = "e2b";
  private apiKey: string;
  private sandboxes: Map<string, { accessToken?: string | null }> = new Map();

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        templateID: req.image || "base",
        envVars: req.env_vars || {},
        timeout: req.timeout || 120,
      }),
    });
    if (!resp.ok) throw new Error(`E2B create failed: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as E2BSandboxResponse;

    this.sandboxes.set(data.sandboxID, { accessToken: data.envdAccessToken });

    return {
      id: data.sandboxID,
      provider: this.name,
      state: "running",
      labels: req.labels,
    };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const meta = this.sandboxes.get(sandboxId);
    const token = meta?.accessToken;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    };
    if (token) headers["X-Access-Token"] = token;

    const resp = await fetch(`https://49983-${sandboxId}.e2b.app/process.Process/Start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        process: {
          cmd: "bash",
          args: ["-c", command],
          envs: {},
          cwd: null,
        },
      }),
    });

    if (!resp.ok) throw new Error(`E2B exec failed: ${resp.status}`);

    const text = await resp.text();

    // Connect protocol streaming: messages separated by \r\n
    const messages = text.split(/\r\n/).filter(Boolean);

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    let error = "";

    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg);
        const event = parsed.event;
        if (!event) continue;

        if (event.start) {
          // Process started
        } else if (event.data) {
          if (event.data.stdout) stdout += atob(event.data.stdout);
          if (event.data.stderr) stderr += atob(event.data.stderr);
          if (event.data.pty) stdout += atob(event.data.pty);
        } else if (event.end) {
          const status = event.end.status || "";
          const exitMatch = status.match(/exit status (\d+)/);
          exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
          error = event.end.error || "";
        }
      } catch {
        // Skip non-JSON messages
      }
    }

    return {
      exit_code: exitCode,
      stdout,
      stderr: stderr || error,
      duration_ms: Date.now() - start,
    };
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    this.sandboxes.delete(sandboxId);
    return resp.ok;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const resp = await fetch(`${E2B_API_BASE}/sandboxes`, {
      headers: this.headers(),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const items = data.sandboxes || data || [];
    return items.map((s: any) => ({
      id: s.sandboxID,
      provider: this.name,
      state: s.state || "running",
    }));
  }
}
