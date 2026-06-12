import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { SandboxProvider } from "./base";

/**
 * Cloudflare native sandbox provider using @cloudflare/sandbox.
 * Only works when deployed on Cloudflare Workers with Durable Objects.
 *
 * Detects CF runtime via globalThis.Sandbox or env.Sandbox binding.
 */
export class CloudflareNativeProvider extends SandboxProvider {
  name = "cloudflare";
  private env: any;

  constructor(env: any) {
    super();
    this.env = env;
  }

  private async getSandbox(id: string) {
    // Dynamic import — only works on Cloudflare Workers runtime
    const mod = await import("@cloudflare/sandbox" as string);
    return mod.getSandbox(this.env.Sandbox, id);
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const id = req.labels?.session || req.labels?.name || `sbx-${Date.now()}`;
    const sandbox = await this.getSandbox(id);

    if (req.env_vars) {
      for (const [key, val] of Object.entries(req.env_vars)) {
        await sandbox.exec(`export ${key}="${val}"`);
      }
    }

    return {
      id,
      provider: this.name,
      state: "running",
      labels: req.labels,
    };
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const start = Date.now();
    const sandbox = await this.getSandbox(sandboxId);

    try {
      const result = await sandbox.exec(command, {
        timeout: timeout ? timeout * 1000 : undefined,
      });
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: Date.now() - start,
      };
    } catch (e: any) {
      return {
        exit_code: 1,
        stdout: "",
        stderr: e.message || String(e),
        duration_ms: Date.now() - start,
      };
    }
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    try {
      const sandbox = await this.getSandbox(sandboxId);
      await sandbox.destroy();
    } catch {}
    return true;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    return [];
  }
}
