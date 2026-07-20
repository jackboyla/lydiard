import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./monitor.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const port = Number.parseInt(process.env.GPU_MONITOR_PORT ?? "8789", 10);
const cacheDurationMs = Number.parseInt(process.env.GPU_MONITOR_CACHE_MS ?? "1500", 10);
const assets = new Map();
let cachedSnapshot = null;
let snapshotPromise = null;

const assetTypes = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

for (const [route, [filename, contentType]] of Object.entries(assetTypes)) {
  assets.set(route, { body: await readFile(path.join(publicDirectory, filename)), contentType });
}

function findTailscaleIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && /^100\.(6[4-9]|[78]\d|9[0-9]|1[01]\d|12[0-7])\./.test(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

export function configuredHosts() {
  if (process.env.GPU_MONITOR_HOSTS) {
    return [...new Set(process.env.GPU_MONITOR_HOSTS.split(",").map((host) => host.trim()).filter(Boolean))];
  }
  return [...new Set(["127.0.0.1", findTailscaleIpv4()].filter(Boolean))];
}

async function getSnapshot() {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.timestamp < cacheDurationMs) return cachedSnapshot.value;
  if (!snapshotPromise) {
    snapshotPromise = collectSnapshot()
      .then((value) => {
        cachedSnapshot = { timestamp: Date.now(), value };
        return value;
      })
      .finally(() => {
        snapshotPromise = null;
      });
  }
  return snapshotPromise;
}

function applyHeaders(response, contentType) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://monitor.local");
  if (request.method !== "GET") {
    applyHeaders(response, "application/json; charset=utf-8");
    response.writeHead(405, { Allow: "GET" });
    response.end(JSON.stringify({ error: "Read-only service: GET requests only." }));
    return;
  }

  if (url.pathname === "/healthz") {
    applyHeaders(response, "application/json; charset=utf-8");
    response.writeHead(200, { "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: true, host: os.hostname() }));
    return;
  }

  if (url.pathname === "/api/snapshot") {
    applyHeaders(response, "application/json; charset=utf-8");
    try {
      const snapshot = await getSnapshot();
      response.writeHead(200, { "Cache-Control": "no-store" });
      response.end(JSON.stringify(snapshot));
    } catch (error) {
      response.writeHead(503, { "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "Unable to collect GPU state.", detail: error.message }));
    }
    return;
  }

  const asset = assets.get(url.pathname);
  if (asset) {
    applyHeaders(response, asset.contentType);
    response.writeHead(200, { "Cache-Control": url.pathname === "/" ? "no-cache" : "public, max-age=300" });
    response.end(asset.body);
    return;
  }

  applyHeaders(response, "text/plain; charset=utf-8");
  response.writeHead(404);
  response.end("Not found");
}

const servers = configuredHosts().map((host) => {
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
    });
  });
  server.listen(port, host, () => console.log(`GPU monitor listening at http://${host}:${port}`));
  return server;
});

function shutdown() {
  Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))).finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
