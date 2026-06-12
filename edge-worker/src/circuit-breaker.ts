export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOpts {
  failureThreshold?: number;
  recoveryTimeout?: number;
  successThreshold?: number;
}

export class CircuitBreaker {
  state: CircuitState = "closed";
  failureCount = 0;
  successCount = 0;
  lastFailureTime = 0;

  private failureThreshold: number;
  private recoveryTimeout: number;
  private successThreshold: number;

  constructor(opts?: CircuitBreakerOpts) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.recoveryTimeout = (opts?.recoveryTimeout ?? 60) * 1000;
    this.successThreshold = opts?.successThreshold ?? 2;
  }

  isOpen(): boolean {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeout) {
        this.state = "half_open";
        this.successCount = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "closed";
        this.failureCount = 0;
      }
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "half_open" || this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.successCount = 0;
    }
  }
}
