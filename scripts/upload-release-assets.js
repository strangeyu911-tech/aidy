#!/usr/bin/env node
/**
 * 把 Release 附件上传到 GitHub —— 面向「链路劣化」场景的 gh 替代品。
 *
 * 为什么不用 `gh release upload`：
 *   1. gh 用 Go 的 http.Transport，其 TLSHandshakeTimeout 默认 10s。国内访问 GitHub 时
 *      新建 TLS 握手常达 10~25s，gh 会直接判为 `net/http: TLS handshake timeout`。
 *   2. 握手成功但吞吐极低时，gh **没有任何超时保护**，会静默挂住（实测盲等 1.5 小时且零产出）。
 *   3. gh 上传**不打印任何进度**，无法区分「正在慢慢传」和「已经死了」。
 *
 * 本脚本的对应措施：
 *   - 用 Node 的 https（对慢握手比 Go 宽容），keepAlive 复用连接；
 *   - 上传前先对 uploads.github.com 预建连接，把最贵的握手成本前置并留在连接池里；
 *   - 每 10s 打印进度；进度停滞超过 STALL_MS 即判定卡死并重试；
 *   - 结束后用 API 复核**服务端记录**的大小，不采信上传器的自述。
 *
 * 注意：GitHub 的 Release 附件上传**不支持断点续传**（官方文档只有裸 POST，无 Content-Range），
 * 因此中断就必须从 0 重来 —— 这是本脚本坚持在「卡死」而非「慢」时重试的原因。
 * 另外同名附件会导致 422，所以每次上传前先删掉同名旧附件。
 *
 * 用法：
 *   node ./scripts/upload-release-assets.js <tag> [文件...]
 *   node ./scripts/upload-release-assets.js v0.1.0 dist/Aidy-Setup-v0.1.0.exe
 *
 * 令牌来源：优先环境变量 GH_TOKEN / GITHUB_TOKEN，否则用 `git credential fill` 取。
 * 仓库来源：环境变量 RELEASE_REPO，默认 strangeyu911-tech/aidy。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const API = "api.github.com";
const UPLOADS = "uploads.github.com";
const STALL_MS = 180000; // 进度停滞 3 分钟即判定卡死
const PROGRESS_MS = 10000;
const MAX_ATTEMPTS = 3;

const REPO = process.env.RELEASE_REPO || "strangeyu911-tech/aidy";

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length) : "";
  } catch {
    return "";
  }
}

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 2 });

function api(token, method, pathname, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      Authorization: `token ${token}`,
      "User-Agent": "aidy-release-uploader",
      Accept: "application/vnd.github+json",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request({ host: API, method, path: pathname, headers, agent }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!buf) return resolve(null);
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        } else {
          reject(new Error(`API ${method} ${pathname} -> ${res.statusCode} ${buf.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

// 预建连接：把最贵的握手成本挪到这里，并让它留在 keepAlive 池里供后续复用
function warmUp() {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request({ host: UPLOADS, port: 443, path: "/", method: "HEAD", agent }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: true, ms: Date.now() - started, status: res.statusCode }));
    });
    req.on("error", (e) => resolve({ ok: false, ms: Date.now() - started, err: e.code || e.message }));
    req.end();
  });
}

// 取 release 不能用 /releases/tags/{tag} —— 该端点对**草稿** Release 返回 404。
// 草稿只出现在列表接口里（已认证时）。
async function findRelease(token, tag) {
  const all = await api(token, "GET", `/repos/${REPO}/releases?per_page=100`);
  const hit = (all || []).find((r) => r.tag_name === tag);
  if (!hit) throw new Error(`未找到 tag=${tag} 的 release（列表返回 ${(all || []).length} 条）`);
  return hit;
}

async function deleteSameNameAssets(token, releaseId, name) {
  const assets = await api(token, "GET", `/repos/${REPO}/releases/${releaseId}/assets?per_page=100`);
  const hits = (assets || []).filter((a) => a.name === name);
  for (const a of hits) {
    console.log(`  删除同名旧附件: ${a.name} (id=${a.id}, state=${a.state})`);
    await api(token, "DELETE", `/repos/${REPO}/releases/assets/${a.id}`);
  }
}

function uploadOnce(token, releaseId, filePath) {
  const name = path.basename(filePath);
  const size = fs.statSync(filePath).size;

  return new Promise((resolve, reject) => {
    let sent = 0;
    let lastProgressAt = Date.now();
    let finished = false;

    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    rs.on("data", (chunk) => {
      sent += chunk.length;
      lastProgressAt = Date.now();
    });

    const req = https.request(
      {
        host: UPLOADS,
        method: "POST",
        path: `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        headers: {
          Authorization: `token ${token}`,
          "User-Agent": "aidy-release-uploader",
          "Content-Type": "application/octet-stream",
          "Content-Length": size,
        },
        agent,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (finished) return;
          finished = true;
          clearInterval(ticker);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: buf });
          else reject(new Error(`上传失败 ${res.statusCode}: ${buf.slice(0, 300)}`));
        });
      }
    );

    const ticker = setInterval(() => {
      const mb = (sent / 1048576).toFixed(1);
      const totalMb = (size / 1048576).toFixed(1);
      const pct = ((sent / size) * 100).toFixed(1);
      const stalledFor = Date.now() - lastProgressAt;
      console.log(
        `    ${name}: ${mb}/${totalMb} MB (${pct}%)${stalledFor > 30000 ? `  停滞 ${(stalledFor / 1000) | 0}s` : ""}`
      );
      if (stalledFor > STALL_MS && !finished) {
        finished = true;
        clearInterval(ticker);
        rs.destroy();
        req.destroy();
        reject(new Error(`上传停滞超过 ${STALL_MS / 1000}s，判定卡死`));
      }
    }, PROGRESS_MS);

    req.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      rs.destroy();
      reject(e);
    });
    rs.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      req.destroy();
      reject(e);
    });

    rs.pipe(req);
  });
}

async function main() {
  const [tag, ...files] = process.argv.slice(2);
  const token = resolveToken();

  if (!tag || !files.length) {
    console.error("用法: node ./scripts/upload-release-assets.js <tag> <文件...>");
    process.exit(2);
  }
  if (!token) {
    console.error("取不到 GitHub 令牌。请设置 GH_TOKEN，或先确保 git 凭据里存有 github.com 的 token。");
    process.exit(2);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`文件不存在: ${f}`);
      process.exit(2);
    }
  }

  console.log(`=== ${REPO} @ ${tag} ===`);
  console.log(`待上传 ${files.length} 个文件，合计 ${(files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576).toFixed(1)} MB`);

  const release = await findRelease(token, tag);
  console.log(`release id=${release.id}  draft=${release.draft}  已有附件=${release.assets.length}`);

  let failed = 0;
  for (const f of files) {
    const name = path.basename(f);
    console.log(`\n--- ${name} (${fs.statSync(f).size} bytes) ---`);

    await deleteSameNameAssets(token, release.id, name);

    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`  第 ${attempt}/${MAX_ATTEMPTS} 次尝试`);
      const warm = await warmUp();
      console.log(`  预建连接 ${UPLOADS}: ${warm.ok ? `OK ${warm.status} ${warm.ms}ms` : `ERR ${warm.err} ${warm.ms}ms`}`);
      try {
        const r = await uploadOnce(token, release.id, f);
        console.log(`  上传成功 (HTTP ${r.status})`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.log(`  失败: ${e.code || e.message}`);
      }
    }
    if (lastErr) {
      failed++;
      console.log(`  !! ${name} 在 ${MAX_ATTEMPTS} 次尝试后仍失败: ${lastErr.message}`);
    }
  }

  // 用服务端记录复核，不看上传器的自述
  console.log("\n=== 服务端记录 ===");
  const after = await findRelease(token, tag);
  if (!after.assets.length) console.log("  (无附件)");
  for (const a of after.assets) {
    const localPath = files.find((f) => path.basename(f) === a.name);
    const localSize = localPath ? fs.statSync(localPath).size : null;
    const verdict = localSize === null ? "(非本次上传)" : localSize === a.size ? "大小一致 OK" : `大小不符! 本地=${localSize}`;
    console.log(`  ${a.name}  size=${a.size}  state=${a.state}  ${verdict}`);
  }
  console.log(`\ndraft=${after.draft}  附件 ${after.assets.length} 个`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("致命错误:", e.message);
  process.exit(1);
});
