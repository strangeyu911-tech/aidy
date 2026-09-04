"use strict";

const crypto = require("node:crypto");

const {
  PUBLIC_ROUTES,
  createSseMessageParser,
  decodeConnect,
  decodeHealth,
  encodeNewSessionParams,
  encodeResumeSessionParams,
  fingerprintAccountIdentity,
  protocolError,
} = require("./protocol-adapter");

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SSE_RESPONSE_BYTES = 2 * 1024 * 1024;

class CodeBuddyClient {
  constructor({
    endpoint,
    servicePassword,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    randomUUID = cryptoRandomUUID,
    logger = null,
    runtimeInstanceId = "",
    transportGenerationId = "",
    onLifecycle = null,
  } = {}) {
    this.endpoint = normalizeLoopbackEndpoint(endpoint);
    Object.defineProperty(this, "servicePassword", {
      value: requireText(servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy service password is required."),
      enumerable: false,
    });
    if (typeof fetchImpl !== "function") throw new TypeError("CodeBuddyClient requires fetch.");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.randomUUID = randomUUID;
    this.logger = logger;
    this.runtimeInstanceId = normalizeText(runtimeInstanceId) || cryptoRandomUUID();
    this.transportGenerationId = normalizeText(transportGenerationId) || cryptoRandomUUID();
    this.onLifecycle = typeof onLifecycle === "function" ? onLifecycle : null;
    this.connectionId = "";
    this.requestSequence = 0;
    this.hasConnected = false;
    this.activeRequests = new Set();
  }

  async probeCompatibility({ signal } = {}) {
    const body = await this.requestJson(PUBLIC_ROUTES.health, { method: "GET", signal });
    return decodeHealth(body);
  }

  async connect({ signal } = {}) {
    if (this.hasConnected && !this.connectionId) this.transportGenerationId = cryptoRandomUUID();
    const connected = decodeConnect(await this.requestJson(PUBLIC_ROUTES.acpConnect, { method: "POST", signal }));
    this.connectionId = connected.connectionId;
    this.hasConnected = true;
    this.notifyLifecycle({ type: "connected", generationId: this.transportGenerationId, connectionId: this.connectionId });
    return { connectionId: this.connectionId };
  }

  isConnected() {
    return Boolean(this.connectionId);
  }

  async initialize({ signal } = {}) {
    const response = await this.rpc("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "Aidy", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, { signal });
    if (Number(response.result?.protocolVersion) !== 1) {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP protocol version is incompatible.");
    }
    return response.result;
  }

  async getIdentityFingerprint({ signal } = {}) {
    const response = await this.rpc("_codebuddy.ai/getUserInfo", {}, { signal });
    return fingerprintAccountIdentity(response.result?.userInfo);
  }

  async newSession({ workingDirectory, signal, observability = {} } = {}) {
    const response = await this.rpc("session/new", encodeNewSessionParams({
      workingDirectory,
    }), { signal, observability });
    const sessionId = normalizeText(response.result?.sessionId);
    if (!sessionId) throw protocolError("CODEBUDDY_SESSION_FAILED", "CodeBuddy did not create a session.");
    return {
      sessionId,
      modelId: normalizeText(response.result?.models?.currentModelId),
      models: Array.isArray(response.result?.models?.availableModels)
        ? response.result.models.availableModels.map((model) => ({
          id: normalizeText(model?.modelId),
          name: normalizeText(model?.name),
        })).filter((model) => model.id)
        : [],
    };
  }

  async listModels({ workingDirectory, signal } = {}) {
    const session = await this.newSession({ workingDirectory, signal });
    return {
      models: session.models,
      currentModelId: session.modelId,
    };
  }

  async resumeSession({ sessionId, workingDirectory, signal, observability = {} } = {}) {
    await this.rpc("session/resume", encodeResumeSessionParams({
      sessionId,
      workingDirectory,
    }), { signal, observability });
    return { sessionId: requireText(sessionId, "CODEBUDDY_SESSION_FAILED", "CodeBuddy session is required.") };
  }

  async prompt({ sessionId, text, signal, onNotification, onRequest, observability = {} } = {}) {
    const response = await this.rpc("session/prompt", {
      sessionId: requireText(sessionId, "CODEBUDDY_SESSION_FAILED", "CodeBuddy session is required."),
      prompt: [{ type: "text", text: requireText(text, "CODEBUDDY_TURN_FAILED", "CodeBuddy prompt is required.") }],
    }, { signal, onNotification, onRequest, observability });
    const stopReason = normalizeText(response.result?.stopReason);
    if (!new Set(["end_turn", "cancelled"]).has(stopReason)) {
      throw protocolError("CODEBUDDY_TURN_FAILED", "CodeBuddy did not complete the verification turn.");
    }
    return {
      text: collectAgentText(response.notifications),
      notifications: response.notifications,
      stopReason,
      usage: response.result?.usage,
    };
  }

  async runTestOk({ workingDirectory, signal } = {}) {
    await this.connect({ signal });
    const initialized = await this.initialize({ signal });
    const identityFingerprint = await this.getIdentityFingerprint({ signal });
    const session = await this.newSession({ workingDirectory, signal });
    const reply = await this.prompt({
      sessionId: session.sessionId,
      text: "Respond with exactly TEST_OK and nothing else.",
      signal,
    });
    if (reply.text.trim() !== "TEST_OK") {
      throw protocolError("CODEBUDDY_TURN_FAILED", "CodeBuddy verification reply did not equal TEST_OK.");
    }
    return {
      ok: true,
      text: "TEST_OK",
      sessionId: session.sessionId,
      modelId: session.modelId,
      identityFingerprint,
      serverVersion: normalizeText(initialized?.serverInfo?.version),
    };
  }

  async runEchoToolVerification({ workingDirectory, toolName, token, signal } = {}) {
    const expectedTool = requireText(toolName, "CODEBUDDY_TURN_FAILED", "CodeBuddy verification tool is required.");
    const expectedToken = requireText(token, "CODEBUDDY_TURN_FAILED", "CodeBuddy verification token is required.");
    await this.connect({ signal });
    const initialized = await this.initialize({ signal });
    const identityFingerprint = await this.getIdentityFingerprint({ signal });
    const session = await this.newSession({ workingDirectory, signal });
    const reply = await this.prompt({
      sessionId: session.sessionId,
      text: `Call the MCP tool ${expectedTool} exactly once with value "${expectedToken}". After the tool result, respond with exactly TEST_OK.`,
      signal,
    });
    if (reply.text.trim() !== "TEST_OK" || !hasCompletedEchoTool(reply.notifications, expectedTool, expectedToken)) {
      throw protocolError("CODEBUDDY_TURN_FAILED", "CodeBuddy MCP echo verification failed.");
    }
    return {
      ok: true,
      text: "TEST_OK",
      toolVerified: true,
      sessionId: session.sessionId,
      modelId: session.modelId,
      identityFingerprint,
      serverVersion: normalizeText(initialized?.serverInfo?.version),
    };
  }

  async rpc(method, params, { signal, onNotification, onRequest, observability = {} } = {}) {
    if (!this.connectionId) throw protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy ACP is not connected.");
    const id = requireText(this.randomUUID(), "CODEBUDDY_API_INCOMPATIBLE", "ACP request ID is unavailable.");
    const observed = ["session/new", "session/resume", "session/prompt"].includes(method);
    const requestContext = observed ? {
      ...observability,
      correlationId: normalizeText(observability.correlationId || observability.turnCorrelation),
      method,
      requestId: id,
      requestSequenceId: id,
      requestSequence: ++this.requestSequence,
      sessionIdFingerprint: fingerprintIdentifier(params?.sessionId),
      connectionIdFingerprint: fingerprintIdentifier(this.connectionId),
      runtimeInstanceId: this.runtimeInstanceId,
      transportGenerationId: this.transportGenerationId,
      timestamp: new Date().toISOString(),
      monotonicMs: monotonicMs(),
      transport: { status: 0 },
    } : null;
    const trace = requestContext ? createAcpTrace(requestContext, this.timeoutMs) : null;
    if (trace) {
      this.logTrace(trace, "runtime.acp.request.prepared", { stage: "before_fetch" });
      this.logTrace(trace, "runtime.acp.request.started", { stage: "before_fetch" });
    }
    let transportStatus = 0;
    let messages;
    try {
      messages = await this.requestSse(PUBLIC_ROUTES.acp, {
        method: "POST",
        signal,
        headers: { "acp-connection-id": this.connectionId },
        body: { jsonrpc: "2.0", id, method, params },
        onResponse: (response) => { transportStatus = Number(response?.status) || 0; },
        onMessage: (message) => {
          if (!message?.method) return;
          if (message.id != null && typeof onRequest === "function") onRequest(message);
          else if (typeof onNotification === "function") onNotification(message);
        },
        trace,
      });
    } catch (error) {
      if (trace) this.logTrace(trace, "runtime.acp.response.error", {
        transport: { status: transportStatus },
        error: summarizeDiagnosticError(error),
      });
      throw error;
    }
    const response = messages.find((message) => String(message.id ?? "") === id);
    if (!response) {
      if (trace) trace.stage = "parse";
      const error = protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP response correlation failed.");
      if (trace) this.logTrace(trace, "runtime.acp.response.error", {
        transport: { status: transportStatus },
        error: summarizeDiagnosticError(error),
      });
      throw error;
    }
    if (response.error) {
      const code = method === "initialize" ? "CODEBUDDY_API_INCOMPATIBLE"
        : method === "_codebuddy.ai/getUserInfo" ? "CODEBUDDY_LOGIN_REQUIRED"
          : method === "session/new" ? "CODEBUDDY_SESSION_FAILED"
            : "CODEBUDDY_TURN_FAILED";
      const error = protocolError(code, `CodeBuddy ACP ${method} failed.`);
      Object.defineProperty(error, "diagnostic", {
        value: Object.freeze({
          method,
          upstreamCode: typeof response.error.code === "string" || typeof response.error.code === "number"
            ? response.error.code
            : null,
          upstreamMessage: sanitizeDiagnosticText(response.error.message),
        }),
        enumerable: false,
      });
      if (trace) this.logTrace(trace, "runtime.acp.response.error", {
        transport: { status: transportStatus },
        error: {
          class: "JsonRpcError",
          code: response.error.code ?? null,
          detail: sanitizeDiagnosticText(response.error.message),
        },
      });
      throw error;
    }
    if (trace) this.logTrace(trace, "runtime.acp.response.succeeded", {
      transport: { status: transportStatus },
      ...(method === "session/new" || method === "session/resume"
        ? { sessionId: normalizeText(response.result?.sessionId) || normalizeText(params?.sessionId) }
        : {}),
    });
    return { result: response.result || {}, notifications: messages.filter((message) => message !== response) };
  }

  logDiagnostic(event, data) {
    try {
      this.logger?.info?.(event, data);
    } catch {
      // Diagnostics must never affect protocol behavior.
    }
  }

  logTrace(trace, event, data = {}) {
    this.logDiagnostic(event, {
      ...trace.context,
      ...data,
    });
  }

  async respondPermission({ requestId, outcome, sessionId = "", signal, observability = {} } = {}) {
    const id = requireRpcId(requestId);
    const selected = requireText(outcome, "CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy permission outcome is required.");
    const trace = createAcpTrace({
      ...observability,
      correlationId: normalizeText(observability.correlationId || observability.turnCorrelation),
      method: "session/respond_permission",
      requestId: id,
      requestSequenceId: id,
      requestSequence: ++this.requestSequence,
      sessionIdFingerprint: fingerprintIdentifier(sessionId),
      connectionIdFingerprint: fingerprintIdentifier(this.connectionId),
      runtimeInstanceId: this.runtimeInstanceId,
      transportGenerationId: this.transportGenerationId,
      timestamp: new Date().toISOString(),
      monotonicMs: monotonicMs(),
      transport: { status: 0 },
    }, this.timeoutMs);
    this.logTrace(trace, "runtime.acp.request.prepared", { stage: "before_fetch" });
    this.logTrace(trace, "runtime.acp.request.started", { stage: "before_fetch" });
    try {
      await this.fetchProtected(PUBLIC_ROUTES.acp, {
        method: "POST",
        signal,
        headers: {
          "acp-connection-id": this.connectionId,
          ...(normalizeText(sessionId) ? { "acp-session-id": normalizeText(sessionId) } : {}),
        },
        body: { jsonrpc: "2.0", id, result: { outcome: selected } },
        readResponse: async (response) => {
          if ([202, 204].includes(Number(response.status))) return true;
          await readBoundedJson(response);
          return true;
        },
        trace,
      });
      this.logTrace(trace, "runtime.acp.response.succeeded", {
        transport: { status: trace.httpStatus || 0 },
      });
    } catch (error) {
      this.logTrace(trace, "runtime.acp.response.error", {
        transport: { status: trace.httpStatus || 0 },
        error: summarizeDiagnosticError(error),
      });
      throw error;
    }
    return { requestId: id, outcome: selected };
  }

  async disconnect({ signal } = {}) {
    const connectionId = this.connectionId;
    this.connectionId = "";
    if (!connectionId) return;
    try {
      await this.requestJson(PUBLIC_ROUTES.acp, {
        method: "DELETE",
        signal,
        headers: { "acp-connection-id": connectionId },
      });
    } finally {
      this.notifyLifecycle({ type: "disconnected", generationId: this.transportGenerationId });
    }
  }

  async requestJson(route, { method = "GET", body, signal, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, this.timeoutMs));
    try {
      const response = await this.fetchImpl(new URL(route, `${this.endpoint}/`).href, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-CodeBuddy-Request": "1",
          Authorization: `Bearer ${this.servicePassword}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) {
        throw protocolError("CODEBUDDY_AUTH_FAILED", "CodeBuddy rejected the managed gateway credentials.");
      }
      if (!response.ok) {
        throw protocolError("CODEBUDDY_CONNECTION_LOST", `CodeBuddy public API returned HTTP ${Number(response.status) || 0}.`);
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (controller.signal.reason?.code === "CODEBUDDY_CONNECTION_LOST") {
        throw controller.signal.reason;
      }
      if (error?.code) {
        if (error.code === "CODEBUDDY_CONNECTION_LOST") this.markDisconnected("connection_lost", error);
        throw error;
      }
      if (controller.signal.aborted) {
        throw protocolError("CODEBUDDY_START_TIMEOUT", "CodeBuddy public API did not become ready in time.");
      }
      const mapped = protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy public API is unavailable.");
      this.markDisconnected("connection_lost", mapped);
      throw mapped;
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(controller);
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  }

  async requestSse(route, {
    method = "POST", body, signal, timeoutMs = this.timeoutMs, headers = {}, onMessage, onResponse, trace,
  } = {}) {
    return this.fetchProtected(route, {
      method,
      body,
      signal,
      timeoutMs,
      headers: { Accept: "application/json, text/event-stream", ...headers },
      onResponse,
      readResponse: (response) => readSseMessages(response, MAX_SSE_RESPONSE_BYTES, onMessage, trace, this.logDiagnostic.bind(this)),
      trace,
    });
  }

  async fetchProtected(route, {
    method = "GET", body, signal, timeoutMs = this.timeoutMs, headers = {}, readResponse, onResponse, trace,
  } = {}) {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timeoutTriggered = false;
    const timeoutBudgetMs = positiveInteger(timeoutMs, this.timeoutMs);
    const forwardAbort = () => {
      if (trace && !timeoutTriggered) trace.abortSource = "caller_signal";
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      if (trace) {
        trace.abortSource = "client_timeout";
        trace.timeoutKind = trace.context.method === "session/prompt" ? "overall_turn" : "overall_request";
      }
      controller.abort();
    }, timeoutBudgetMs);
    try {
      if (trace) {
        trace.stage = "awaiting_headers";
        trace.fetchStartedAt = monotonicMs();
        this.logTrace(trace, "runtime.acp.fetch.started", {
          endpointCategory: "acp",
          timeoutBudgetMs,
        });
      }
      const response = await this.fetchImpl(new URL(route, `${this.endpoint}/`).href, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-CodeBuddy-Request": "1",
          Authorization: `Bearer ${this.servicePassword}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (trace) {
        trace.headersReceived = true;
        trace.headersAt = monotonicMs();
        trace.httpStatus = Number(response?.status) || 0;
        trace.contentType = response?.headers?.get?.("content-type") || "";
        trace.stage = "awaiting_first_sse";
        this.logTrace(trace, "runtime.acp.headers", {
          headersReceived: true,
          latencyToHeadersMs: trace.headersAt - trace.fetchStartedAt,
          httpStatus: trace.httpStatus,
          contentType: trace.contentType,
        });
      }
      onResponse?.(response);
      if (response.status === 401 || response.status === 403) throw protocolError("CODEBUDDY_AUTH_FAILED", "CodeBuddy rejected the managed gateway credentials.");
      if (!response.ok) throw protocolError("CODEBUDDY_CONNECTION_LOST", `CodeBuddy public API returned HTTP ${Number(response.status) || 0}.`);
      return typeof readResponse === "function" ? await readResponse(response) : response;
    } catch (error) {
      if (trace) {
        const aborted = controller.signal.aborted;
        if (!trace.headersReceived) {
          this.logTrace(trace, "runtime.acp.headers", {
            headersReceived: false,
            latencyToHeadersMs: trace.fetchStartedAt ? monotonicMs() - trace.fetchStartedAt : null,
            httpStatus: trace.httpStatus || 0,
            contentType: trace.contentType || "",
          });
        }
        if (aborted) {
          trace.stage = abortStage(trace);
          trace.abortSource = trace.abortSource || (
            controller.signal.reason?.code === "CODEBUDDY_CONNECTION_LOST"
              ? "transport_lifecycle"
              : timeoutTriggered ? "client_timeout" : "caller_signal"
          );
          this.logTrace(trace, "runtime.acp.request.aborted", {
            stage: trace.stage,
            elapsedMs: monotonicMs() - trace.startedAt,
            httpStatus: trace.httpStatus || 0,
            sseEventCount: trace.sseEventCount,
            timeSinceLastEventMs: trace.lastEventAt ? monotonicMs() - trace.lastEventAt : null,
            terminalEventSeen: trace.terminalEventSeen,
            abortSource: trace.abortSource,
            timeoutKind: trace.timeoutKind,
            lastEventType: trace.lastEventType,
            lastEventMethod: trace.lastEventMethod,
            lastSessionUpdate: trace.lastSessionUpdate,
            lastEventHasId: trace.lastEventHasId,
            lastEventMatchesRequest: trace.lastEventMatchesRequest,
          });
        }
      }
      if (controller.signal.reason?.code === "CODEBUDDY_CONNECTION_LOST") {
        throw controller.signal.reason;
      }
      if (timeoutTriggered) {
        const timeoutError = protocolError("CODEBUDDY_START_TIMEOUT", "CodeBuddy public API did not respond in time.");
        attachDiagnostic(timeoutError, traceTimeoutDiagnostic(trace));
        throw timeoutError;
      }
      if (error?.code) {
        if (error.code === "CODEBUDDY_CONNECTION_LOST") this.markDisconnected("connection_lost", error);
        throw error;
      }
      if (controller.signal.aborted) {
        const timeoutError = protocolError("CODEBUDDY_START_TIMEOUT", "CodeBuddy public API did not respond in time.");
        attachDiagnostic(timeoutError, traceTimeoutDiagnostic(trace));
        throw timeoutError;
      }
      const mapped = protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy public API is unavailable.");
      this.markDisconnected("connection_lost", mapped);
      throw mapped;
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(controller);
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  }

  markDisconnected(reason = "disconnected", error = null) {
    const hadConnection = Boolean(this.connectionId);
    this.connectionId = "";
    if (!hadConnection) return;
    const disconnectError = error?.code
      ? error
      : protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy ACP transport was disconnected.");
    for (const controller of this.activeRequests) {
      try { controller.abort(disconnectError); } catch {}
    }
    this.notifyLifecycle({
      type: reason,
      generationId: this.transportGenerationId,
      ...(disconnectError.code ? { code: disconnectError.code } : {}),
    });
  }

  notifyLifecycle(event) {
    try { this.onLifecycle?.(event); } catch {}
  }
}

async function readBoundedJson(response) {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy response exceeds the compatibility limit.");
    }
    try { return JSON.parse(text); } catch {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy returned malformed JSON.");
    }
  }
  if (typeof response.json === "function") return response.json();
  throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy returned no JSON body.");
}

async function readSseMessages(response, maxBytes, onMessage, trace, logDiagnostic) {
  const parser = createSseMessageParser({
    onMessage: (message) => {
      observeSseMessage(trace, message, logDiagnostic);
      onMessage?.(message);
    },
  });
  let totalBytes = 0;
  let protocolFailure = "";
  const append = (text, bytes = Buffer.byteLength(text, "utf8")) => {
    totalBytes += bytes;
    if (trace) trace.sseBytesReceived = totalBytes;
    if (totalBytes > maxBytes) {
      protocolFailure = "sse_response_limit";
      if (trace) trace.protocolFailure = protocolFailure;
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP response exceeds the compatibility limit.");
    }
    try {
      parser.push(text);
    } catch (error) {
      protocolFailure = "malformed_sse_json";
      if (trace) trace.protocolFailure = protocolFailure;
      throw error;
    }
  };
  const finish = () => {
    try {
      return parser.finish();
    } catch (error) {
      protocolFailure = "malformed_sse_json";
      if (trace) trace.protocolFailure = protocolFailure;
      throw error;
    }
  };
  const attachProtocolDiagnostic = (error) => attachDiagnostic(error, {
    ...(protocolFailure ? { protocolFailure } : {}),
    sseBytesReceived: totalBytes,
    sseEventCount: nonNegativeInteger(trace?.sseEventCount),
    lastEventType: normalizeText(trace?.lastEventType),
  });

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    if (trace) {
      trace.sseOpened = true;
      logTraceWith(trace, logDiagnostic, "runtime.acp.sse.opened", {});
    }
    let completed = false;
    let terminalDrainRequested = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk?.done) break;
        const bytes = chunk?.value instanceof Uint8Array
          ? chunk.value
          : Buffer.from(String(chunk?.value ?? ""), "utf8");
        append(decoder.decode(bytes, { stream: true }), bytes.byteLength);
        if (trace?.terminalEventSeen) {
          terminalDrainRequested = true;
          break;
        }
      }
      append(decoder.decode(), 0);
      const messages = finish();
      completed = true;
      if (terminalDrainRequested) {
        await Promise.resolve(reader.cancel?.()).catch(() => {});
        if (trace) {
          trace.readerCancelled = true;
          trace.streamEndReason = "terminal_cancel";
          trace.streamClosed = false;
        }
      } else if (trace) {
        trace.streamEndReason = "eof";
        trace.streamClosed = true;
      }
      if (trace) trace.stage = trace.terminalEventSeen ? "terminal_received" : "parse";
      return messages;
    } catch (error) {
      await Promise.resolve(reader.cancel?.()).catch(() => {});
      throw attachProtocolDiagnostic(error);
    } finally {
      if (trace) {
        trace.streamClosed = trace.streamClosed || (completed && !terminalDrainRequested);
        logTraceWith(trace, logDiagnostic, "runtime.acp.sse.closed", {
          ...traceSummary(trace),
          streamClosed: trace.streamClosed,
          readerCancelled: Boolean(trace?.readerCancelled || !completed),
        });
      }
      reader.releaseLock?.();
    }
  }

  if (typeof response.text !== "function") {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP returned no SSE body.");
  }
  if (trace) {
    trace.sseOpened = true;
    logTraceWith(trace, logDiagnostic, "runtime.acp.sse.opened", {});
  }
  let completed = false;
  try {
    const text = await response.text();
    append(text);
    const messages = finish();
    completed = true;
    if (trace) {
      trace.stage = trace.terminalEventSeen ? "terminal_received" : "parse";
      trace.streamEndReason = "eof";
      trace.streamClosed = true;
    }
    return messages;
  } catch (error) {
    throw attachProtocolDiagnostic(error);
  } finally {
    if (trace) {
      trace.streamClosed = trace.streamClosed || completed;
      logTraceWith(trace, logDiagnostic, "runtime.acp.sse.closed", {
        ...traceSummary(trace),
        streamClosed: trace.streamClosed,
        readerCancelled: false,
      });
    }
  }
}

function createAcpTrace(context, timeoutMs) {
  return {
    context: {
      ...context,
      timeoutBudgetMs: positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS),
    },
    startedAt: monotonicMs(),
    stage: "before_fetch",
    headersReceived: false,
    httpStatus: 0,
    contentType: "",
    sseOpened: false,
    sseEventCount: 0,
    sseBytesReceived: 0,
    sseEventTypeCounts: Object.create(null),
    firstSseEventReceived: false,
    lastEventAt: 0,
    lastEventTimestamp: "",
    terminalEventSeen: false,
    terminalSignal: "",
    jsonRpcResultSeen: false,
    jsonRpcErrorSeen: false,
    jsonRpcErrorCode: null,
    streamClosed: false,
    streamEndReason: "",
    readerCancelled: false,
    protocolFailure: "",
    abortSource: "",
    timeoutKind: context.method === "session/prompt" ? "overall_turn" : "overall_request",
    lastEventType: "",
    lastEventMethod: "",
    lastSessionUpdate: "",
    lastEventHasId: false,
    lastEventMatchesRequest: false,
  };
}

function observeSseMessage(trace, message, logDiagnostic) {
  if (!trace || !message || typeof message !== "object") return;
  const now = monotonicMs();
  const eventType = classifySseMessage(message);
  trace.sseEventCount += 1;
  trace.sseEventTypeCounts[eventType] = (trace.sseEventTypeCounts[eventType] || 0) + 1;
  trace.lastEventAt = now;
  trace.lastEventTimestamp = new Date().toISOString();
  trace.lastEventType = eventType;
  trace.lastEventMethod = normalizeText(message.method);
  trace.lastSessionUpdate = normalizeText(message.params?.update?.sessionUpdate);
  trace.lastEventHasId = message.id != null;
  trace.lastEventMatchesRequest = String(message.id ?? "") === String(trace.context.requestId ?? "");
  if (!trace.firstSseEventReceived) {
    trace.firstSseEventReceived = true;
    trace.stage = "streaming_nonterminal";
    logTraceWith(trace, logDiagnostic, "runtime.acp.sse.first_event", {
      eventType,
      eventByteLength: safeSerializedByteLength(message),
    });
  }
  if (!trace.lastEventMatchesRequest) return;
  trace.terminalEventSeen = true;
  trace.stage = "terminal_received";
  if (message.error && typeof message.error === "object") {
    trace.jsonRpcErrorSeen = true;
    trace.jsonRpcErrorCode = message.error.code ?? null;
    trace.terminalSignal = "jsonrpc_error";
    return;
  }
  if (message.result && typeof message.result === "object") {
    trace.jsonRpcResultSeen = true;
    trace.terminalSignal = normalizeText(message.result.stopReason) || "jsonrpc_result";
  }
}

function classifySseMessage(message) {
  if (message.error && typeof message.error === "object") return "jsonrpc_error";
  if (message.result && typeof message.result === "object") return "jsonrpc_result";
  const update = message.method === "session/update" && message.params?.update;
  const sessionUpdate = normalizeText(update?.sessionUpdate).toLowerCase();
  if (sessionUpdate.includes("thought")) return "thought";
  if (sessionUpdate.includes("agent_message") || sessionUpdate.includes("assistant")) return "assistant";
  return "other";
}

function abortStage(trace) {
  if (!trace.headersReceived) return "awaiting_headers";
  if (!trace.firstSseEventReceived) return "awaiting_first_sse";
  if (!trace.terminalEventSeen) return "streaming_nonterminal";
  return "terminal_received";
}

function traceSummary(trace) {
  return {
    headersReceived: trace.headersReceived,
    httpStatus: trace.httpStatus || 0,
    contentType: trace.contentType || "",
    firstSseEventReceived: trace.firstSseEventReceived,
    sseEventCount: trace.sseEventCount,
    sseBytesReceived: trace.sseBytesReceived,
    sseEventTypeCounts: { ...trace.sseEventTypeCounts },
    lastEventTimestamp: trace.lastEventTimestamp,
    terminalEventSeen: trace.terminalEventSeen,
    terminalSignal: trace.terminalSignal || "",
    jsonRpcResultSeen: trace.jsonRpcResultSeen,
    jsonRpcErrorSeen: trace.jsonRpcErrorSeen,
    abortSource: trace.abortSource || "",
    timeoutKind: trace.timeoutKind || "",
    streamEndReason: trace.streamEndReason || "",
    lastEventType: trace.lastEventType || "",
    lastEventMethod: trace.lastEventMethod || "",
    lastSessionUpdate: trace.lastSessionUpdate || "",
    lastEventHasId: trace.lastEventHasId,
    lastEventMatchesRequest: trace.lastEventMatchesRequest,
    ...(trace.jsonRpcErrorSeen ? { jsonRpcErrorCode: trace.jsonRpcErrorCode } : {}),
    ...(trace.protocolFailure ? { protocolFailure: trace.protocolFailure } : {}),
  };
}

function logTraceWith(trace, logDiagnostic, event, data = {}) {
  try {
    logDiagnostic?.(event, {
      ...trace.context,
      timestamp: new Date().toISOString(),
      monotonicMs: monotonicMs(),
      ...data,
    });
  } catch {
    // Diagnostics must never affect protocol behavior.
  }
}

function safeSerializedByteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return 0; }
}

function fingerprintIdentifier(value) {
  const normalized = normalizeText(value);
  return normalized
    ? `sha256:${crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`
    : "";
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function collectAgentText(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const update = message?.method === "session/update" ? message.params?.update : null;
    if (update?.sessionUpdate !== "agent_message_chunk") return "";
    if (update.content?.type === "text" && typeof update.content.text === "string") return update.content.text;
    return typeof update.text === "string" ? update.text : "";
  }).join("");
}

function hasCompletedEchoTool(messages, toolName, token) {
  let namedCallSeen = false;
  let completedEchoSeen = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    const update = message?.method === "session/update" ? message.params?.update : null;
    if (!update || !new Set(["tool_call", "tool_call_update"]).has(update.sessionUpdate)) continue;
    const serialized = safeSerialize(update);
    if (serialized.includes(toolName)) namedCallSeen = true;
    if (normalizeText(update.status).toLowerCase() === "completed" && serialized.includes(token)) completedEchoSeen = true;
  }
  return namedCallSeen && completedEchoSeen;
}

function safeSerialize(value) {
  try { return JSON.stringify(value); } catch { return ""; }
}

function normalizeLoopbackEndpoint(value) {
  let parsed;
  try { parsed = new URL(requireText(value, "CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy endpoint is required.")); } catch (error) {
    if (error?.code) throw error;
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy endpoint is invalid.");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname.toLowerCase())) {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "Managed CodeBuddy must use a loopback HTTP endpoint.");
  }
  return parsed.origin;
}

function requireText(value, code, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw protocolError(code, message);
  return text;
}
function requireRpcId(value) {
  if (!(typeof value === "string" || typeof value === "number") || String(value).trim() === "") {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy permission request ID is required.");
  }
  return value;
}
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function summarizeDiagnosticError(error) {
  const diagnostic = error?.diagnostic && typeof error.diagnostic === "object" ? error.diagnostic : {};
  const code = diagnostic.upstreamCode ?? (normalizeText(error?.code) || null);
  const detail = normalizeText(diagnostic.upstreamMessage);
  return {
    class: normalizeText(error?.name) || "Error",
    ...(code == null || code === "" ? {} : { code }),
    ...(detail ? { detail: sanitizeDiagnosticText(detail) } : {}),
    ...(diagnostic.timeoutKind ? { timeoutKind: normalizeText(diagnostic.timeoutKind) } : {}),
    ...(diagnostic.abortSource ? { abortSource: normalizeText(diagnostic.abortSource) } : {}),
    ...(Number.isSafeInteger(diagnostic.sseEventCount) ? { sseEventCount: diagnostic.sseEventCount } : {}),
    ...(Number.isSafeInteger(diagnostic.sseBytesReceived) ? { sseBytesReceived: diagnostic.sseBytesReceived } : {}),
    ...(typeof diagnostic.terminalEventSeen === "boolean" ? { terminalEventSeen: diagnostic.terminalEventSeen } : {}),
    ...(diagnostic.lastEventType ? { lastEventType: normalizeText(diagnostic.lastEventType) } : {}),
    ...(diagnostic.protocolFailure ? { protocolFailure: normalizeText(diagnostic.protocolFailure) } : {}),
  };
}

function attachDiagnostic(error, diagnostic) {
  if (!error || !diagnostic || typeof diagnostic !== "object") return error;
  Object.defineProperty(error, "diagnostic", {
    value: Object.freeze({ ...diagnostic }),
    enumerable: false,
    configurable: true,
  });
  return error;
}

function traceTimeoutDiagnostic(trace) {
  if (!trace) return {};
  return {
    method: normalizeText(trace.context?.method),
    timeoutKind: normalizeText(trace.timeoutKind),
    abortSource: normalizeText(trace.abortSource),
    stage: normalizeText(trace.stage),
    sseEventCount: trace.sseEventCount,
    sseBytesReceived: trace.sseBytesReceived,
    terminalEventSeen: trace.terminalEventSeen,
    lastEventType: normalizeText(trace.lastEventType),
    lastEventMethod: normalizeText(trace.lastEventMethod),
    lastSessionUpdate: normalizeText(trace.lastSessionUpdate),
    lastEventHasId: trace.lastEventHasId,
    lastEventMatchesRequest: trace.lastEventMatchesRequest,
    ...(trace.protocolFailure ? { protocolFailure: normalizeText(trace.protocolFailure) } : {}),
  };
}
function sanitizeDiagnosticText(value) {
  return normalizeText(value).slice(0, 300).replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}
function cryptoRandomUUID() { return crypto.randomUUID(); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }

module.exports = { CodeBuddyClient };
