import type { Env } from "./types";
import { handleRequest } from "./handlers";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
