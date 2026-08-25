"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const DEFAULT_MAX_BODY_BYTES = 4 * 1024;

class BridgeControlServer {
  constructor({ app, token, port, host = "127.0.0.1", maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
    if (!app || typeof app.getBridgeControlStatus !== "function") {
      throw new TypeError("BridgeControlServer requires a CyberbossApp control interface.");
    }
    if (!normalizeText(token)) throw new TypeError("BridgeControlServer requires an authentication token.");
    this.app = app;
    this.token = normalizeText(token);
    this.port = normalizePort(port, 0);
    this.host = host;
    this.maxBodyBytes = Math.max(1, Number(maxBodyBytes) || DEFAULT_MAX_BODY_BYTES);
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) writeJson(response, error?.statusCode || 500, {
          error: { code: error?.code || "BRIDGE_CONTROL_ERROR", message: error?.message || "Bridge control failed." },
        });
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.address();
  }

  address() {
    return this.server?.address?.() || null;
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async handle(request, response) {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      writeJson(response, 403, { error: { code: "LOOPBACK_REQUIRED", message: "Bridge control accepts loopback clients only." } });
      return;
    }
    if (!tokenMatches(request.headers.authorization, this.token)) {
      writeJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Bridge control authentication failed." } });
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, this.app.getBridgeControlStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/drain") {
      const body = await readJsonBody(request, this.maxBodyBytes);
      writeJson(response, 200, await this.app.drainForSwitch({ deadlineAt: body.deadlineAt }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/abort") {
      const body = await readJsonBody(request, this.maxBodyBytes);
      writeJson(response, 200, await this.app.abortActiveTurns(normalizeText(body.reason) || "runtime profile switch"));
      return;
    }
    writeJson(response, 404, { error: { code: "UNKNOWN_ACTION", message: "Unknown bridge control action." } });
  }
}

function readJsonBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let rejected = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        rejected = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.on("end", () => {
      if (rejected) {
        reject(Object.assign(new Error("Bridge control request body is too large."), { code: "BODY_TOO_LARGE", statusCode: 413 }));
        return;
      }
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error("Bridge control request body must be JSON."), { code: "INVALID_JSON", statusCode: 400 }));
      }
    });
  });
}

function writeJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  response.end(payload);
}

function tokenMatches(header, expected) {
  const supplied = normalizeText(header).replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackAddress(value) {
  const address = normalizeText(value).toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { BridgeControlServer, isLoopbackAddress };
