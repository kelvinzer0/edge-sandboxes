import type { Env } from "../types";
import type { SandboxProvider } from "./base";
import { E2BProvider } from "./e2b";
import { DaytonaProvider } from "./daytona";
import { ModalProvider } from "./modal";
import { CloudflareSandboxProvider } from "./cloudflare";
import { EdgeOneProvider } from "./edgeone";
import { MultiAccountProvider } from "./multi-account";

export { SandboxProvider } from "./base";
export { E2BProvider } from "./e2b";
export { DaytonaProvider } from "./daytona";
export { ModalProvider } from "./modal";
export { CloudflareSandboxProvider } from "./cloudflare";
export { EdgeOneProvider } from "./edgeone";
export { MultiAccountProvider } from "./multi-account";

function splitKeys(raw: string): string[] {
  return raw.split(",").map(k => k.trim()).filter(Boolean);
}

function createE2BProvider(apiKey: string): SandboxProvider {
  const keys = splitKeys(apiKey);
  if (keys.length === 1) return new E2BProvider(keys[0]);
  return new MultiAccountProvider("e2b", keys.map(k => new E2BProvider(k)));
}

function createDaytonaProvider(apiKey: string, baseUrl?: string): SandboxProvider {
  const keys = splitKeys(apiKey);
  if (keys.length === 1) return new DaytonaProvider(keys[0], baseUrl);
  return new MultiAccountProvider("daytona", keys.map(k => new DaytonaProvider(k, baseUrl)));
}

function createModalProvider(token: string): SandboxProvider {
  const keys = splitKeys(token);
  if (keys.length === 1) return new ModalProvider(keys[0]);
  return new MultiAccountProvider("modal", keys.map(k => new ModalProvider(k)));
}

export function createProviders(env: Env): Map<string, SandboxProvider> {
  const providers = new Map<string, SandboxProvider>();

  if (env.E2B_API_KEY) providers.set("e2b", createE2BProvider(env.E2B_API_KEY));
  if (env.DAYTONA_API_KEY) providers.set("daytona", createDaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_API_URL));
  if (env.MODAL_TOKEN_ID) providers.set("modal", createModalProvider(env.MODAL_TOKEN_ID));
  if (env.CLOUDFLARE_SANDBOX_BASE_URL && env.CLOUDFLARE_API_TOKEN) {
    providers.set("cloudflare", new CloudflareSandboxProvider(env.CLOUDFLARE_SANDBOX_BASE_URL, env.CLOUDFLARE_API_TOKEN));
  }
  if (env.EDGEONE_FUNCTION_URL) {
    providers.set("edgeone", new EdgeOneProvider(env.EDGEONE_FUNCTION_URL, env.EDGEONE_API_TOKEN));
  }

  return providers;
}
