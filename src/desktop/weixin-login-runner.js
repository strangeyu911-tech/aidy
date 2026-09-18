const { runLoginFlow } = require("../adapters/channel/weixin/login");

const QR_MODULE_SIZE_PX = 5;
const QR_QUIET_ZONE_MODULES = 2;
const MAX_QR_REFRESH_COUNT = 3;

// The login flow lives in the WeChat adapter and cannot know anything about the
// desktop product, so its machine codes are translated into the user's language
// here instead of leaking developer instructions such as "Run login again".
const LOGIN_ERROR_MESSAGES = {
  WECHAT_LOGIN_QR_EXPIRED: "二维码连续过期了，请重新点一次「连接微信」。",
  WECHAT_LOGIN_TIMEOUT: "等待扫码超时了，请重新点一次「连接微信」。",
  WECHAT_LOGIN_INCOMPLETE: "微信已确认，但服务端没有返回完整凭据，请重新试一次。",
  WECHAT_LOGIN_CANCELLED: "已取消登录。",
};

function resolveLoginErrorMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (LOGIN_ERROR_MESSAGES[code]) return LOGIN_ERROR_MESSAGES[code];
  const message = String(error?.message || "").trim();
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket|EAI_AGAIN/i.test(message)) {
    return "获取微信二维码失败，请检查网络后重试。";
  }
  return message ? `连接微信失败：${message.slice(0, 160)}` : "连接微信失败，请重试。";
}

/**
 * Renders a QR payload as a standalone SVG.
 *
 * The QR encoder is the one `qrcode-terminal` already vendors and that the CLI
 * login path already uses, so the desktop window and the terminal produce the
 * same code. A QR code must stay dark-on-light to remain scannable, so this
 * deliberately ignores the application theme.
 */
function buildQrSvg(text, { moduleSize = QR_MODULE_SIZE_PX, quietZone = QR_QUIET_ZONE_MODULES } = {}) {
  const payload = String(text || "").trim();
  if (!payload) return "";
  let qr;
  try {
    const QRCode = require("qrcode-terminal/vendor/QRCode");
    const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
    qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(payload);
    qr.make();
  } catch {
    return "";
  }
  const moduleCount = qr.getModuleCount();
  const dimension = (moduleCount + quietZone * 2) * moduleSize;
  const segments = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!qr.isDark(row, column)) continue;
      const x = (column + quietZone) * moduleSize;
      const y = (row + quietZone) * moduleSize;
      segments.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" width="${dimension}" height="${dimension}" role="img" aria-label="微信登录二维码">`,
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`,
    `<path d="${segments.join("")}" fill="#000000"/>`,
    "</svg>",
  ].join("");
}

function idleLoginState() {
  return {
    active: false,
    status: "idle",
    message: "",
    qrUrl: "",
    qrSvg: "",
    scanned: false,
    refreshCount: 0,
    maxRefreshCount: MAX_QR_REFRESH_COUNT,
    error: "",
    errorCode: "",
    startedAt: "",
    finishedAt: "",
  };
}

/**
 * Owns the WeChat QR login inside the desktop process.
 *
 * It used to be a detached `cmd /k npm run login` window, which meant the user
 * saw a black terminal running a developer command and, because the child ran
 * with `stdio: "ignore"`, no reason at all when it failed.
 */
class WeixinLoginRunner {
  constructor({ config, onUpdate, loginFlow } = {}) {
    this.config = config;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : () => {};
    // Injectable so the login flow can be driven by a fake in tests.
    this.loginFlow = typeof loginFlow === "function" ? loginFlow : runLoginFlow;
    this.abortController = null;
    this.running = false;
    this.state = idleLoginState();
  }

  snapshot() {
    return { ...this.state };
  }

  start() {
    if (this.running) {
      return {
        started: false,
        alreadyRunning: true,
        message: "二维码已经打开了，请直接用微信扫码。",
        wechatLogin: this.snapshot(),
      };
    }
    this.running = true;
    this.abortController = new AbortController();
    this.update({
      ...idleLoginState(),
      active: true,
      status: "starting",
      message: "正在获取二维码…",
      startedAt: new Date().toISOString(),
    });
    void this.run();
    return { started: true, message: "请用微信扫描二维码。", wechatLogin: this.snapshot() };
  }

  cancel() {
    if (!this.running) {
      return { ok: true, wechatLogin: this.snapshot() };
    }
    this.abortController?.abort();
    this.update({ message: "正在取消…" });
    return { ok: true, wechatLogin: this.snapshot() };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.onUpdate(this.snapshot());
  }

  async run() {
    try {
      await this.loginFlow(this.config, {
        silent: true,
        onEvent: (event) => this.handleLoginEvent(event),
        signal: this.abortController.signal,
      });
      this.update({
        active: false,
        status: "connected",
        message: "微信已连接。",
        qrUrl: "",
        qrSvg: "",
        scanned: false,
        error: "",
        errorCode: "",
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.code === "WECHAT_LOGIN_CANCELLED") {
        this.update({ ...idleLoginState(), message: "已取消登录。" });
      } else {
        this.update({
          active: false,
          status: "error",
          message: "",
          qrUrl: "",
          qrSvg: "",
          scanned: false,
          error: resolveLoginErrorMessage(error),
          errorCode: typeof error?.code === "string" ? error.code : "WECHAT_LOGIN_FAILED",
          finishedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.onUpdate(this.snapshot());
    }
  }

  handleLoginEvent(event) {
    switch (event?.type) {
      case "qr":
        this.update({
          active: true,
          status: "waiting",
          qrUrl: String(event.url || ""),
          qrSvg: buildQrSvg(event.url),
          scanned: false,
          refreshCount: Number(event.refreshCount) || 0,
          maxRefreshCount: Number(event.maxRefreshCount) || MAX_QR_REFRESH_COUNT,
          message: event.reason === "initial" ? "请用微信扫描二维码。" : "二维码已刷新，请扫描新的二维码。",
          error: "",
          errorCode: "",
        });
        break;
      case "scanned":
        this.update({ status: "scanned", scanned: true, message: "已扫码，请在微信里确认登录。" });
        break;
      case "confirmed":
        this.update({ status: "confirmed", message: "已确认，正在保存连接…", qrSvg: "", qrUrl: "" });
        break;
      default:
        break;
    }
  }
}

module.exports = { WeixinLoginRunner, buildQrSvg, resolveLoginErrorMessage };
