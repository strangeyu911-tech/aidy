"use strict";

const http = require("node:http");

class BridgeControlClient {
  constructor({ port, token, host = "127.0.0.1", timeoutMs = 0 } = {}) {
    this.port = normalizePort(port);
    this.token = normalizeText(token);
    this.host = host;
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0);
    if (!this.port || !this.token) throw new TypeError("BridgeControlClient requires a loopback port and token.");
  }

  health() {
    return this.request("GET", "/health");
  }

  drain({ deadlineAt } = {}) {
    return this.request("POST", "/drain", { deadlineAt });
  }

  abort(reason) {
    return this.request("POST", "/abort", { reason });
  }

  request(method, requestPath, body = null) {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: this.host,
        port: this.port,
        path: requestPath,
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(Object.assign(new Error(parsed?.error?.message || `Bridge control returned HTTP ${response.statusCode}.`), {
              code: parsed?.error?.code || "BRIDGE_CONTROL_FAILED",
              statusCode: response.statusCode,
            }));
            return;
          }
          resolve(parsed);
        });
      });
      request.once("error", reject);
      if (this.timeoutMs > 0) request.setTimeout(this.timeoutMs, () => request.destroy(Object.assign(new Error("Bridge control timed out."), { code: "BRIDGE_CONTROL_TIMEOUT" })));
      if (payload) request.write(payload);
      request.end();
    });
  }
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { BridgeControlClient };
