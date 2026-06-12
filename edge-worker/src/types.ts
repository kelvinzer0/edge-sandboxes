export interface Env {
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  EDGEONE_WORKER_URL?: string;
  CLOUDFLARE_WORKER_URL?: string;
  API_TOKEN?: string;
  DEFAULT_PROVIDER?: string;
}

export interface SandboxRequest {
  provider?: string;
  fallback?: string[];
  image?: string;
  labels?: Record<string, string>;
  env_vars?: Record<string, string>;
  timeout?: number;
}

export interface SandboxInstance {
  id: string;
  provider: string;
  state: string;
  labels?: Record<string, string>;
}

export interface ExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms?: number;
}

export interface ProviderHealth {
  name: string;
  healthy: boolean;
  circuit_state: "closed" | "open" | "half_open";
  failure_count: number;
}
