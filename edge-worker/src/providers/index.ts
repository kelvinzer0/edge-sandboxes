import type { Env } from "../types";
import type { SandboxProvider } from "./base";
import { E2BProvider } from "./e2b";
import { DaytonaProvider } from "./daytona";
import { CloudflareNativeProvider } from "./cloudflare-native";
import { CloudflareSandboxProvider } from "./cloudflare";
import { EdgeOneProvider } from "./edgeone";
import { MultiAccountProvider } from "./multi-account";

export { SandboxProvider } from "./base";
export { E2BProvider } from "./e2b";
export { DaytonaProvider } from "./daytona";
export { CloudflareNativeProvider } from "./cloudflare-native";
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

function createDaytonaProvider(apiKey: string): SandboxProvider {
  const keys = splitKeys(apiKey);
  if (keys.length === 1) return new DaytonaProvider(keys[0]);
  return new MultiAccountProvider("daytona", keys.map(k => new DaytonaProvider(k)));
}

export function createProviders(env: Env): Map<string, SandboxProvider> {
  const providers = new Map<string, SandboxProvider>();

  // Cloudflare native — auto-detect if Sandbox binding exists
  if ((env as any).Sandbox) {
    providers.set("cloudflare", new CloudflareNativeProvider(env));
  }

  // Direct API providers
  if (env.E2B_API_KEY) providers.set("e2b", createE2BProvider(env.E2B_API_KEY));
  if (env.DAYTONA_API_KEY) providers.set("daytona", createDaytonaProvider(env.DAYTONA_API_KEY));

  // URL-based providers
  if (env.EDGEONE_WORKER_URL) providers.set("edgeone", new EdgeOneProvider(env.EDGEONE_WORKER_URL));
  if (env.CLOUDFLARE_WORKER_URL) providers.set("cloudflare", new CloudflareSandboxProvider(env.CLOUDFLARE_WORKER_URL));

  return providers;
}
