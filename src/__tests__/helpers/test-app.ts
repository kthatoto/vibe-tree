import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function createTestApp(router: Hono, basePath: string = "/") {
  const app = new Hono();

  // Use Hono's onError for duck-typed error handling
  // This avoids instanceof issues with mock.module
  app.onError((error, c) => {
    // Duck-type check for AppError (has statusCode property)
    if ("statusCode" in error) {
      const appErr = error as unknown as { statusCode: ContentfulStatusCode; message: string; code?: string };
      return c.json(
        { error: appErr.message, code: appErr.code ?? "APP_ERROR" },
        appErr.statusCode,
      );
    }

    // ValidationError check
    if (error.name === "ValidationError") {
      return c.json(
        { error: error.message, code: "VALIDATION_ERROR" },
        400,
      );
    }

    return c.json({ error: error.message, code: "INTERNAL_ERROR" }, 500);
  });

  app.route(basePath, router);
  return app;
}

export async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function putJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function patchJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteJson(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
