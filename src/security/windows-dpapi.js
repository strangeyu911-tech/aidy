const childProcess = require("node:child_process");

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$utf8=[Text.UTF8Encoding]::new($false)",
  "[Console]::InputEncoding=$utf8",
  "[Console]::OutputEncoding=$utf8",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$cipher=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))",
].join(";");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$utf8=[Text.UTF8Encoding]::new($false)",
  "[Console]::InputEncoding=$utf8",
  "[Console]::OutputEncoding=$utf8",
  "$encoded=[Console]::In.ReadToEnd()",
  "$cipher=[Convert]::FromBase64String($encoded)",
  "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
].join(";");

function createWindowsDpapi({
  platform = process.platform,
  spawn = childProcess.spawn,
  command = "powershell.exe",
  timeoutMs = 30_000,
  maxOutputBytes = 8 * 1024 * 1024,
} = {}) {
  async function run(script, input, operation) {
    if (platform !== "win32") {
      throw makeError("DPAPI is available only for the current Windows user.", "DPAPI_UNAVAILABLE");
    }
    if (typeof input !== "string") {
      throw makeError("DPAPI input must be text.", "DPAPI_INVALID_INPUT");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn(command, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-Command", script,
        ], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(wrapError(error, operation));
        return;
      }

      const timer = setTimeout(() => {
        child.kill();
        finish(makeError("DPAPI operation timed out.", "DPAPI_TIMEOUT"));
      }, Math.max(1, timeoutMs));
      timer.unref?.();

      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }

      function collect(current, chunk) {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
          child.kill();
          finish(makeError("DPAPI output exceeded its safety limit.", "DPAPI_OUTPUT_TOO_LARGE"));
        }
        return next;
      }

      child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
      child.once("error", (error) => finish(wrapError(error, operation)));
      child.once("close", (code) => {
        if (code !== 0) {
          finish(makeError(`DPAPI ${operation} failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`, "DPAPI_OPERATION_FAILED"));
          return;
        }
        finish(null, operation === "protect" ? stdout.trim() : stdout);
      });
      child.stdin.once("error", (error) => finish(wrapError(error, operation)));
      child.stdin.end(input, "utf8");
    });
  }

  return {
    protectText(text) {
      return run(PROTECT_SCRIPT, text, "protect");
    },
    unprotectText(ciphertext) {
      return run(UNPROTECT_SCRIPT, ciphertext, "unprotect");
    },
  };
}

function makeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function wrapError(error, operation) {
  const wrapped = makeError(`DPAPI ${operation} failed.`, "DPAPI_OPERATION_FAILED");
  wrapped.cause = error;
  return wrapped;
}

const defaultDpapi = createWindowsDpapi();

module.exports = {
  createWindowsDpapi,
  protectText: defaultDpapi.protectText,
  unprotectText: defaultDpapi.unprotectText,
};
