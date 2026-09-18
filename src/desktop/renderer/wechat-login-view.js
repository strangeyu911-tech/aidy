(function attachWechatLoginView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.cyberbossWechatLoginView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWechatLoginView() {
  "use strict";

  const STATUS_TEXT = {
    idle: "还没有开始连接。",
    starting: "正在获取二维码…",
    waiting: "请用微信扫描二维码。",
    scanned: "已扫码，请在微信里点「确认登录」。",
    confirmed: "已确认，正在保存连接…",
    connected: "微信已连接。",
  };

  /**
   * Turns a `WeixinLoginRunner` snapshot into what the dialog should show.
   *
   * Kept as a pure function so the states that are painful to reproduce by hand
   * (expired QR, cancelled login, a failed scan) can be tested directly.
   */
  function resolveLoginView(state) {
    const value = state && typeof state === "object" ? state : {};
    const status = normalizeText(value.status) || "idle";
    const failed = status === "error";
    const connected = status === "connected";
    // "confirmed" means the code has already been used; "error" and "connected"
    // mean it is dead. None of them may stay on screen, and this is enforced
    // here rather than trusting the caller to clear `qrSvg`.
    const usable = !failed && !connected && status !== "confirmed";
    const qrSvg = normalizeText(value.qrSvg);
    return {
      status,
      connected,
      failed,
      showQr: usable && qrSvg !== "",
      qrUrl: normalizeText(value.qrUrl),
      qrSvg,
      scanned: value.scanned === true || status === "scanned",
      message: normalizeText(value.message) || STATUS_TEXT[status] || "正在等待微信的确认…",
      error: failed ? normalizeText(value.error) || "连接微信失败，请重试。" : "",
      showRetry: failed,
      showDone: !failed,
    };
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  return { resolveLoginView, STATUS_TEXT };
});
