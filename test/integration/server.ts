import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// The server is CommonJS and is loaded by Node itself rather than through
// Vite, so what runs here is exactly what `node server.js` runs.
const require = createRequire(import.meta.url);

export type Response = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  // Response bodies are asserted field by field, so they stay untyped here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
};

export type Request = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type TestServer = {
  port: number;
  db: TestDb;
  request: (path: string, options?: Request) => Promise<Response>;
  stop: () => Promise<void>;
};

export type TestDb = {
  ready: Promise<void>;
  close: () => Promise<void>;
  createUser: (username: string, role?: string) => Promise<{ user: { id: string }; tempPassword: string }>;
  changePassword: (userId: string, current: string, next: string) => Promise<boolean>;
  deleteUser: (username: string) => Promise<boolean>;
};

export async function startServer(): Promise<TestServer> {
  const app = require("../../server.js");
  const db: TestDb = require("../../server/db");
  await db.ready;

  const server = await new Promise<http.Server>((resolve) => {
    const listening: http.Server = app.listen(0, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;

  // Raw http rather than fetch: fetch normalises the path, and the traversal
  // checks need to send `..` and its encodings exactly as written.
  const request = (path: string, options: Request = {}) =>
    new Promise<Response>((resolve, reject) => {
      const payload = options.body === undefined ? null : JSON.stringify(options.body);
      const headers: Record<string, string> = { ...options.headers };
      if (payload !== null) headers["Content-Type"] = "application/json";
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(body);
            } catch {
              // Not JSON: a page, a script, a redirect.
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
          });
        },
      );
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });

  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };

  return { port, db, request, stop };
}
