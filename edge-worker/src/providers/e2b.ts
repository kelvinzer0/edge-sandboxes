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

function encodeConnectEnvelope(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const header = new Uint8Array(5);
  header[0] = 0x00; // no compression
  header[1] = (json.length >>> 24) & 0xff;
  header[2] = (json.length >>> 16) & 0xff;
  header[3] = (json.length >>> 8) & 0xff;
  header[4] = json.length & 0xff;
  const result = new Uint8Array(5 + json.length);
  result.set(header);
  result.set(json, 5);
  return result;
}

function decodeConnectEnvelopes(buffer: Uint8Array): unknown[] {
  const messages: unknown[] = [];
  let pos = 0;
  while (pos + 5 <= buffer.length) {
    const msgLen = (buffer[pos + 1] << 24) | (buffer[pos + 2] << 16) | (buffer[pos + 3] << 8) | buffer[pos + 4];
    if (pos + 5 + msgLen > buffer.length) break;
    const jsonBytes = buffer.slice(pos + 5, pos + 5 + msgLen);
    try {
      messages.push(JSON.parse(new TextDecoder().decode(jsonBytes)));
    } catch {}
    pos += 5 + msgLen;
  }
  return messages;
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
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
    };
    if (token) headers["X-Access-Token"] = token;

    const body = encodeConnectEnvelope({
      process: {
        cmd: "bash",
        args: ["-c", command],
        envs: {},
        cwd: null,
      },
    });

    const resp = await fetch(`https://49983-${sandboxId}.e2b.app/process.Process/Start`, {
      method: "POST",
      headers,
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`E2B exec failed: ${resp.status} ${errText}`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const raw = new Uint8Array(arrayBuf);
    const messages = decodeConnectEnvelopes(raw);

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    let errorMsg = "";

    for (const msg of messages) {
      const event = (msg as any).event;
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
        errorMsg = event.end.error || "";
      }
    }

    return {
      exit_code: exitCode,
      stdout,
      stderr: stderr || errorMsg,
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
