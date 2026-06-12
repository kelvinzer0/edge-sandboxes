import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";

export abstract class SandboxProvider {
  abstract name: string;
  abstract createSandbox(req: SandboxRequest): Promise<SandboxInstance>;
  abstract executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult>;
  abstract destroySandbox(sandboxId: string): Promise<boolean>;
  abstract listSandboxes(): Promise<SandboxInstance[]>;

  async healthCheck(): Promise<boolean> {
    try {
      await this.listSandboxes();
      return true;
    } catch {
      return false;
    }
  }
}
