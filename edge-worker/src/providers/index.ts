import type { Env } from "../types";
import type { SandboxProvider } from "./base";
import { E2BProvider } from "./e2b";
import { DaytonaProvider } from "./daytona";
import { ModalProvider } from "./modal";
import { CloudflareSandboxProvider } from "./cloudflare";
import { EdgeOneProvider } from "./edgeone";

export { SandboxProvider } from "./base";
export { E2BProvider } from "./e2b";
export { DaytonaProvider } from "./daytona";
export { ModalProvider } from "./modal";
export { CloudflareSandboxProvider } from "./cloudflare";
export { EdgeOneProvider } from "./edgeone";

export function createProviders(env: Env): Map<string, SandboxProvider> {
  const providers = new Map<string, SandboxProvider>();

  if (env.E2B_API_KEY) providers.set("e2b", new E2BProvider(env.E2B_API_KEY));
  if (env.DAYTONA_API_KEY) providers.set("daytona", new DaytonaProvider(env.DAYTONA_API_KEY, env.DAYTONA_API_URL));
  if (env.MODAL_TOKEN_ID) providers.set("modal", new ModalProvider(env.MODAL_TOKEN_ID));
  if (env.CLOUDFLARE_SANDBOX_BASE_URL && env.CLOUDFLARE_API_TOKEN) {
    providers.set("cloudflare", new CloudflareSandboxProvider(env.CLOUDFLARE_SANDBOX_BASE_URL, env.CLOUDFLARE_API_TOKEN));
  }
  if (env.EDGEONE_FUNCTION_URL) {
    providers.set("edgeone", new EdgeOneProvider(env.EDGEONE_FUNCTION_URL, env.EDGEONE_API_TOKEN));
  }

  return providers;
}
