export interface Env {
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  MODAL_TOKEN_ID?: string;
  HOPX_API_KEY?: string;
  VERCEL_TOKEN?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_TEAM_ID?: string;
  SPRITES_TOKEN?: string;
  CLOUDFLARE_SANDBOX_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  EDGEONE_FUNCTION_URL?: string;
  EDGEONE_API_TOKEN?: string;
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
