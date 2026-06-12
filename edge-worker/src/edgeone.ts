import { handleRequest } from "./handlers";

export async function onRequest(context: any): Promise<Response> {
  return handleRequest(context.request, context.env);
}
