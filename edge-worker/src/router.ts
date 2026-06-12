import type { ExecutionResult, ProviderHealth, SandboxInstance, SandboxRequest } from "./types";
import { CircuitBreaker } from "./circuit-breaker";
import type { SandboxProvider } from "./providers/base";

export class SandboxRouter {
  private providers: Map<string, SandboxProvider> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  defaultProvider?: string;

  registerProvider(name: string, provider: SandboxProvider): void {
    this.providers.set(name, provider);
    this.circuitBreakers.set(name, new CircuitBreaker());
    if (!this.defaultProvider) this.defaultProvider = name;
  }

  private resolveChain(provider?: string, fallback?: string[]): string[] {
    const chain: string[] = [];
    if (provider) chain.push(provider);
    if (fallback) chain.push(...fallback);
    if (!chain.length && this.defaultProvider) chain.push(this.defaultProvider);

    return chain.filter((name) => {
      const p = this.providers.get(name);
      const cb = this.circuitBreakers.get(name);
      return p && (!cb || !cb.isOpen());
    });
  }

  async createSandbox(req: SandboxRequest): Promise<SandboxInstance & { _provider: string }> {
    const chain = this.resolveChain(req.provider, req.fallback);
    if (!chain.length) throw new Error("No healthy providers available");

    let lastError: Error | null = null;
    for (const name of chain) {
      const provider = this.providers.get(name)!;
      const cb = this.circuitBreakers.get(name)!;
      try {
        const instance = await provider.createSandbox(req);
        cb.recordSuccess();
        return { ...instance, _provider: name };
      } catch (e: any) {
        cb.recordFailure();
        lastError = e;
      }
    }
    throw new Error(`All providers failed: ${lastError?.message}`);
  }

  async executeCommand(provider: string, sandboxId: string, command: string, timeout?: number): Promise<ExecutionResult> {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`Provider '${provider}' not found`);
    return p.executeCommand(sandboxId, command, timeout);
  }

  async destroySandbox(provider: string, sandboxId: string): Promise<boolean> {
    const p = this.providers.get(provider);
    if (!p) return false;
    return p.destroySandbox(sandboxId);
  }

  getHealthStatus(): ProviderHealth[] {
    return Array.from(this.providers.entries()).map(([name]) => {
      const cb = this.circuitBreakers.get(name)!;
      return {
        name,
        healthy: !cb.isOpen(),
        circuit_state: cb.state,
        failure_count: cb.failureCount,
      };
    });
  }
}
