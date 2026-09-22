#!/usr/bin/env node
/**
 * 分块并行上传 Release 附件 —— 面向「国际上行被限流」的 gh 替代方案。
 *
 * 为什么需要它：
 *   本机到 uploads.github.com 的实测值是【单条 TCP 流 ~6.7 KB/s、聚合闸门 ~44 KB/s】
 *   （2026-09-20 实测；对 Cloudflare 同样是 6.7 KB/s，说明不是 GitHub 的问题，
 *    而是国际上行整体被限）。而 GitHub 的附件上传【不支持断点续传】——
 *   只有一个裸 POST，没有 Content-Range。两者叠加的后果：单流传 127 MB 的安装包
 *   约需 5.7 小时，且中途一断就从零重来。
 *
 * 本脚本的做法：
 *   把文件切成固定大小的块，每块作为【独立 asset】并行上传。
 *   - 并行把总吞吐从 6.7 KB/s 提到闸门上限（实测 4 条 27~44 KB/s，12 条不再涨）；
 *   - 每块可独立重传，等于把「不可续传」变成「变相可续传」；
 *   - 重跑时大小一致的块直接跳过，不重复消耗链路。
 *   代价是 Release 里会出现若干 .partNNNN 分块文件，测试者需要合并 ——
 *   本脚本在结尾会直接打印合并命令和合并后的 SHA-256。
 *
 * 用法：
 *   node ./scripts/upload-release-chunked.js <tag> [文件...] [选项]
 *
 *   node ./scripts/upload-release-chunked.js v0.1.0 dist/Aidy-Setup-v0.1.0.exe
 *   node ./scripts/upload-release-chunked.js v0.1.0 dist/Aidy-Setup-v0.1.0.exe --chunk-mb=4 --concurrency=8
 *   node ./scripts/upload-release-chunked.js v0.1.0 dist/Aidy-Setup-v0.1.0.exe --dry-run
 *
 * 选项：
 *   --chunk-mb=N      每块大小，默认 8
 *   --concurrency=N   并行块数，默认 8
 *   --dry-run         只打印切块计划，不上传
 *
 * 令牌来源：优先 GH_TOKEN / GITHUB_TOKEN，否则 `git credential fill`。
 * 仓库来源：环境变量 RELEASE_REPO，默认 strangeyu911-tech/aidy。
 *
 * 注意：Node 的 https 默认直连，不会读 http_proxy 等环境变量；
 *       本机那个沙箱代理是国内出口，对 GitHub 无法使用，因此必须直连。
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const API = "api.github.com";
const UPLOADS = "uploads.github.com";
const PROGRESS_MS = 15000;
const STALL_MS = 180000; // 单块进度停滞 3 分钟判定卡死
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

function parseArgs(argv) {
  const opts = { chunkMb: 8, concurrency: 8, dryRun: false };
  const files = [];
  let tag = "";
  for (const raw of argv) {
    if (raw === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    const chunk = raw.match(/^--chunk-mb=(\d+)$/);
    if (chunk) {
      opts.chunkMb = Number.parseInt(chunk[1], 10);
      continue;
    }
    const conc = raw.match(/^--concurrency=(\d+)$/);
    if (conc) {
      opts.concurrency = Number.parseInt(conc[1], 10);
      continue;
    }
    if (!tag) {
      tag = raw;
      continue;
    }
    files.push(raw);
  }
  return { tag, files, opts };
}

function planParts(filePath, chunkBytes, srcHash) {
  const size = fs.statSync(filePath).size;
  const parts = [];
  for (let start = 0, index = 1; start < size; start += chunkBytes, index += 1) {
    const end = Math.min(start + chunkBytes, size) - 1;
    parts.push({
      index,
      // 块名里带源文件哈希前缀。续传只按名字+大小比对，而两次构建的分块大小
      // 往往一模一样（每块都是 8 MB），只用大小判断会把【上一次构建】的块当成
      // 已完成而跳过，合并出来的安装包就是新旧字节的混合体 —— 必然损坏。
      // 把哈希写进名字后：同一构建可续传，换了构建绝不会误跳过。
      name: `${path.basename(filePath)}.${srcHash.slice(0, 8)}.part${String(index).padStart(4, "0")}`,
      start,
      end,
      bytes: end - start + 1,
    });
  }
  return { size, parts };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function makeAgent(concurrency) {
  return new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: concurrency + 4 });
}

function api(agent, token, method, pathname, bodyObj) {
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

// 草稿 Release 不出现在 /releases/tags/{tag}（该端点对草稿返回 404），只能走列表
async function findRelease(agent, token, tag) {
  const all = await api(agent, token, "GET", `/repos/${REPO}/releases?per_page=100`);
  const hit = (all || []).find((r) => r.tag_name === tag);
  if (!hit) throw new Error(`未找到 tag=${tag} 的 release（列表返回 ${(all || []).length} 条）`);
  return hit;
}

async function listAssets(agent, token, releaseId) {
  const assets = await api(agent, token, "GET", `/repos/${REPO}/releases/${releaseId}/assets?per_page=100`);
  return assets || [];
}

async function deleteAsset(agent, token, assetId) {
  await api(agent, token, "DELETE", `/repos/${REPO}/releases/assets/${assetId}`);
}

function uploadPart(agent, token, releaseId, filePath, part, onProgress) {
  return new Promise((resolve, reject) => {
    let sent = 0;
    let lastProgressAt = Date.now();
    let finished = false;

    const rs = fs.createReadStream(filePath, {
      start: part.start,
      end: part.end,
      highWaterMark: 512 * 1024,
    });

    rs.on("data", (chunk) => {
      sent += chunk.length;
      lastProgressAt = Date.now();
      onProgress(0);
    });

    const req = https.request(
      {
        host: UPLOADS,
        method: "POST",
        path: `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(part.name)}`,
        headers: {
          Authorization: `token ${token}`,
          "User-Agent": "aidy-release-uploader",
          "Content-Type": "application/octet-stream",
          "Content-Length": part.bytes,
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
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
          else reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        });
      }
    );

    const ticker = setInterval(() => {
      if (Date.now() - lastProgressAt > STALL_MS && !finished) {
        finished = true;
        clearInterval(ticker);
        rs.destroy();
        req.destroy();
        reject(new Error(`停滞超过 ${STALL_MS / 1000}s`));
      }
    }, 5000);

    const fail = (e) => {
      if (finished) return;
      finished = true;
      clearInterval(ticker);
      rs.destroy();
      req.destroy();
      reject(e);
    };
    req.on("error", fail);
    rs.on("error", fail);

    rs.pipe(req);
  });
}

async function runPool(tasks, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const mine = cursor++;
      if (mine >= tasks.length) return;
      await tasks[mine]();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const { tag, files, opts } = parseArgs(process.argv.slice(2));
  const token = resolveToken();

  if (!tag || !files.length) {
    console.error("用法: node ./scripts/upload-release-chunked.js <tag> <文件...> [--chunk-mb=8] [--concurrency=8] [--dry-run]");
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

  const chunkBytes = Math.max(1, opts.chunkMb) * 1024 * 1024;

  const plans = files.map((f) => {
    const srcHash = sha256(f);
    return { filePath: f, srcHash, ...planParts(f, chunkBytes, srcHash) };
  });
  const totalBytes = plans.reduce((s, p) => s + p.size, 0);
  const totalParts = plans.reduce((s, p) => s + p.parts.length, 0);

  console.log(`=== ${REPO} @ ${tag} ===`);
  console.log(`文件 ${plans.length} 个，合计 ${(totalBytes / 1048576).toFixed(1)} MB`);
  console.log(`切块 ${opts.chunkMb} MB x ${totalParts} 块，并行 ${opts.concurrency}`);
  for (const p of plans) {
    console.log(`  ${path.basename(p.filePath)}: ${p.size} bytes -> ${p.parts.length} 块`);
  }
  console.log(`预计耗时: ${((totalBytes / 1024) / 44 / 60).toFixed(0)} 分钟（按实测闸门 44 KB/s）`);

  if (opts.dryRun) {
    console.log("\n--dry-run：仅打印计划，未上传。");
    process.exit(0);
  }

  const agent = makeAgent(opts.concurrency);
  const release = await findRelease(agent, token, tag);
  console.log(`\nrelease id=${release.id}  draft=${release.draft}  已有附件=${release.assets.length}`);

  const existing = await listAssets(agent, token, release.id);
  const byName = new Map(existing.map((a) => [a.name, a]));

  const tasks = [];
  const skipped = [];
  for (const plan of plans) {
    for (const part of plan.parts) {
      tasks.push({ plan, part });
    }
  }

  let doneBytes = 0;
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = doneBytes / 1024 / elapsed;
    const pct = ((doneBytes / totalBytes) * 100).toFixed(1);
    const remain = (totalBytes - doneBytes) / 1024 / Math.max(1, rate) / 60;
    console.log(
      `  [进度] ${(doneBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB (${pct}%)` +
        `  速率 ${rate.toFixed(1)} KB/s  预计剩余 ${remain.toFixed(0)} 分钟`
    );
  }, PROGRESS_MS);

  const failures = [];
  const jobs = tasks.map(({ plan, part }) => async () => {
    const prior = byName.get(part.name);
    if (prior && prior.size === part.bytes) {
      skipped.push(part.name);
      doneBytes += part.bytes;
      return;
    }
    if (prior) {
      console.log(`  删除大小不符的旧块 ${part.name} (${prior.size} != ${part.bytes})`);
      await deleteAsset(agent, token, prior.id);
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // 失败的那次尝试几乎总会在服务端留下一个同名的 starter 状态僵尸 asset
      // （连接被重置时 GitHub 已经登记了文件名，但内容没传完）。
      // 同名再传必然 422 already_exists，所以每次重试前先把它清掉。
      const stale = (await listAssets(agent, token, release.id)).find((a) => a.name === part.name);
      if (stale) {
        console.log(`  ${part.name} 清理上一轮留下的 ${stale.state} 残留 (id=${stale.id})`);
        await deleteAsset(agent, token, stale.id);
      }
      try {
        await uploadPart(agent, token, release.id, plan.filePath, part, () => {});
        doneBytes += part.bytes;
        byName.set(part.name, { name: part.name, size: part.bytes });
        return;
      } catch (e) {
        lastErr = e;
        console.log(`  ${part.name} 第 ${attempt}/${MAX_ATTEMPTS} 次失败: ${e.code || e.message}`);
      }
    }
    failures.push({ name: part.name, error: lastErr.message });
  });

  await runPool(jobs, opts.concurrency);
  clearInterval(ticker);

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n完成 ${tasks.length - failures.length}/${tasks.length} 块${skipped.length ? `（跳过已存在 ${skipped.length} 块）` : ""}`);
  console.log(`耗时 ${(elapsed / 60).toFixed(1)} 分钟，平均 ${(doneBytes / 1024 / elapsed).toFixed(1)} KB/s`);

  // 用服务端记录复核，不看上传器的自述
  console.log("\n=== 服务端记录 ===");
  const after = await findRelease(agent, token, tag);
  const names = new Set(tasks.map((t) => t.part.name));
  let verifiedBytes = 0;
  let mismatch = 0;
  for (const a of after.assets) {
    if (!names.has(a.name)) continue;
    verifiedBytes += a.size;
    const expect = tasks.find((t) => t.part.name === a.name).part.bytes;
    if (a.size !== expect) {
      mismatch += 1;
      console.log(`  ${a.name}  大小不符! 服务端=${a.size} 期望=${expect}`);
    }
  }
  console.log(`  服务端已确认 ${verifiedBytes} / ${totalBytes} bytes${mismatch ? `，${mismatch} 块大小不符` : "，全部一致"}`);

  const digest = sha256(files[0]);
  console.log("\n=== 合并说明 ===");
  for (const p of plans) {
    const base = path.basename(p.filePath);
    console.log(`  ${base}  sha256=${sha256(p.filePath)}  bytes=${p.size}`);
    console.log(`    块名前缀: ${base}.${p.srcHash.slice(0, 8)}.part*`);
    console.log(`    bash:       cat ${base}.*.part* > ${base}`);
    console.log(
      `    PowerShell: $out=[IO.File]::Create('${base}'); Get-ChildItem '${base}.*.part*' | Sort-Object Name | %{ $s=[IO.File]::OpenRead($_.FullName); $s.CopyTo($out); $s.Close() }; $out.Close()`
    );
  }
  console.log(`\n合并后请核对上表第二列的完整 sha256（首个文件为 ${digest.slice(0, 12)}...）。`);

  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("致命错误:", e.message);
  process.exit(1);
});
