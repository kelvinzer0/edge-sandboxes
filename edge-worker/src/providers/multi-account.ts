import type { ExecutionResult, SandboxInstance, SandboxRequest } from "../types";
import { CircuitBreaker } from "../circuit-breaker";
import { SandboxProvider } from "./base";

interface AccountEntry {
  provider: SandboxProvider;
  circuitBreaker: CircuitBreaker;
  id: string;
}

export class MultiAccountProvider extends SandboxProvider {
  name: string;
  private accounts: AccountEntry[] = [];
  private currentIndex = 0;

  constructor(name: string, accounts: SandboxProvider[]) {
    super();
    this.name = name;
    for (let i = 0; i < accounts.length; i++) {
      this.accounts.push({
        provider: accounts[i],
        circuitBreaker: new CircuitBreaker(),
        id: String(i),
      });
    }
  }

  get accountCount(): number {
    return this.accounts.length;
  }

  private nextHealthy(exclude: Set<number> = new Set()): AccountEntry | null {
    const total = this.accounts.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.currentIndex + i) % total;
      if (exclude.has(idx)) continue;
      const entry = this.accounts[idx];
      if (!entry.circuitBreaker.isOpen()) {
        this.currentIndex = (idx + 1) % total;
        return entry;
      }
    }
    return null;
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance> {
    const tried = new Set<number>();
    const total = this.accounts.length;
    let lastError: Error | null = null;

    while (tried.size < total) {
      const entry = this.nextHealthy(tried);
      if (!entry) break;
      const idx = this.accounts.indexOf(entry);
      tried.add(idx);

      try {
        const instance = await entry.provider.createSandbox(req);
        entry.circuitBreaker.recordSuccess();
        return { ...instance, provider: `${this.name}[${entry.id}]` };
      } catch (e: any) {
        entry.circuitBreaker.recordFailure();
        lastError = e;
      }
    }
    throw new Error(`All ${total} accounts of ${this.name} failed: ${lastError?.message}`);
  }

  async executeCommand(sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    for (const entry of this.accounts) {
      try {
        const result = await entry.provider.executeCommand(sandboxId, command, timeout);
        entry.circuitBreaker.recordSuccess();
        return result;
      } catch {
        continue;
      }
    }
    throw new Error(`Execute failed on all accounts of ${this.name}`);
  }

  async destroySandbox(sandboxId: string): Promise<boolean> {
    for (const entry of this.accounts) {
      try {
        const ok = await entry.provider.destroySandbox(sandboxId);
        if (ok) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async listSandboxes(): Promise<SandboxInstance[]> {
    const all: SandboxInstance[] = [];
    for (const entry of this.accounts) {
      try {
        const list = await entry.provider.listSandboxes();
        all.push(...list);
      } catch {
        continue;
      }
    }
    return all;
  }
}
