"use strict";

const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

class RuntimeToolBridge {
  constructor({ projectToolHost, requestApproval, maxResultBytes = DEFAULT_MAX_RESULT_BYTES } = {}) {
    if (!projectToolHost || typeof projectToolHost.listTools !== "function" || typeof projectToolHost.invokeTool !== "function") {
      throw new TypeError("RuntimeToolBridge requires a ProjectToolHost-compatible object.");
    }
    this.projectToolHost = projectToolHost;
    this.requestApproval = typeof requestApproval === "function" ? requestApproval : null;
    this.maxResultBytes = positiveInteger(maxResultBytes, DEFAULT_MAX_RESULT_BYTES);
  }

  listTools() {
    return this.projectToolHost.listTools().map(publicToolDefinition).filter(Boolean);
  }

  async invoke({ call, context = {}, signal } = {}) {
    const normalizedCall = normalizeToolCall(call);
    const tool = this.listTools().find((candidate) => candidate.name === normalizedCall.name);
    if (!tool) throw bridgeError("TOOL_NOT_FOUND", `Unknown tool: ${normalizedCall.name}`);
    try {
      validateSchema(tool.inputSchema, normalizedCall.arguments, normalizedCall.name, "input");
    } catch (error) {
      throw bridgeError("TOOL_INPUT_INVALID", error.message);
    }
    throwIfAborted(signal);

    const approval = resolveApproval(this.projectToolHost, normalizedCall.name);
    if (approval === "ask") {
      if (!this.requestApproval) {
        throw bridgeError("TOOL_APPROVAL_REQUIRED", `Tool approval is required for ${normalizedCall.name}.`);
      }
      const response = await raceWithSignal(
        Promise.resolve(this.requestApproval({ call: normalizedCall, context, signal })),
        signal,
      );
      if (!isAcceptedApproval(response)) {
        throw bridgeError("TOOL_APPROVAL_DECLINED", `Tool approval was declined for ${normalizedCall.name}.`);
      }
    }

    const value = await raceWithSignal(
      Promise.resolve(this.projectToolHost.invokeTool(
        normalizedCall.name,
        normalizedCall.arguments,
        { ...context, signal },
      )),
      signal,
    );
    const serialized = serializeResult(value);
    if (Buffer.byteLength(serialized, "utf8") > this.maxResultBytes) {
      throw bridgeError("TOOL_RESULT_TOO_LARGE", `Tool result exceeds ${this.maxResultBytes} serialized bytes.`);
    }
    return value;
  }
}

function publicToolDefinition(tool) {
  const name = normalizeText(tool?.name);
  if (!name) return null;
  return {
    name,
    description: normalizeText(tool?.description),
    inputSchema: cloneSchema(tool?.inputSchema),
  };
}

function resolveApproval(host, toolName) {
  if (typeof host.getToolApproval === "function") {
    return host.getToolApproval(toolName) === "ask" ? "ask" : "auto";
  }
  const internal = host.listTools().find((tool) => tool?.name === toolName);
  return internal?.approval === "ask" ? "ask" : "auto";
}

function normalizeToolCall(call) {
  const name = normalizeText(call?.name);
  if (!name) throw bridgeError("TOOL_CALL_MALFORMED", "Tool call requires a name.");
  const args = call?.arguments;
  if (args == null) return { ...call, name, arguments: {} };
  if (!isRecord(args)) throw bridgeError("TOOL_CALL_MALFORMED", "Tool call arguments must be an object.");
  return { ...call, name, arguments: args };
}

function validateSchema(schema, value, toolName, location) {
  if (!isRecord(schema)) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${toolName} ${location} is not an allowed value.`);
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new Error(`${toolName} ${location} must be an object.`);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`${toolName} ${location}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(`${toolName} ${location}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateSchema(childSchema, value[key], toolName, `${location}.${key}`);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${toolName} ${location} must be an array.`);
    value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${location}[${index}]`));
    return;
  }
  if (schema.type === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${location} must be a string.`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${location} must be a boolean.`);
  }
  if (schema.type === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${location} must be an integer.`);
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${location} must be a number.`);
  }
}

function isAcceptedApproval(response) {
  const decision = normalizeText(response?.decision).toLowerCase();
  const action = normalizeText(response?.result?.action || response?.action).toLowerCase();
  return decision === "accept" || action === "accept";
}

function serializeResult(value) {
  try {
    const serialized = JSON.stringify(value === undefined ? null : value);
    if (typeof serialized !== "string") throw new Error("not serializable");
    return serialized;
  } catch {
    throw bridgeError("TOOL_RESULT_NOT_SERIALIZABLE", "Tool result is not JSON serializable.");
  }
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(bridgeError("CANCELLED", "The tool call was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw bridgeError("CANCELLED", "The tool call was cancelled.");
}

function cloneSchema(value) {
  return isRecord(value)
    ? JSON.parse(JSON.stringify(value))
    : { type: "object", properties: {} };
}

function bridgeError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  DEFAULT_MAX_RESULT_BYTES,
  RuntimeToolBridge,
};
