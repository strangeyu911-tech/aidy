const crypto = require("crypto");
const path = require("path");

const { AtomicJsonStore } = require("../../core/atomic-json-store");
const { shouldSupersede } = require("../../core/supervision-policy");

class ZhijiantimeSyncService {
  constructor({ stateDir, client, desktopStateStore, planStore, notify = async () => {}, logger, intervalMs = 5 * 60_000, now = () => new Date(), onStatus = () => {} } = {}) {
    this.client = client;
    this.desktopStateStore = desktopStateStore;
    this.planStore = planStore;
    this.notify = notify;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.now = now;
    this.onStatus = onStatus;
    this.timer = null;
    this.syncing = false;
    this.status = { state: client?.isConfigured?.() ? "idle" : "not_configured", lastSyncAt: "", error: null };
    this.linkStore = new AtomicJsonStore({
      filePath: path.join(stateDir, "zhijiantime-links.json"),
      defaultValue: { schemaVersion: 1, links: {}, mutations: {} },
      normalize: normalizeLinkState,
    });
  }

  snapshot() { return { ...this.status }; }

  start() {
    if (this.timer || !this.client?.isConfigured?.()) return;
    this.timer = setInterval(() => this.sync().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    this.sync().catch(() => {});
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.client?.close?.();
  }

  async sync() {
    if (this.syncing || this.desktopStateStore.get().desiredState === "stopped") return this.snapshot();
    this.syncing = true;
    this.status = { ...this.status, state: "syncing", error: null };
    this.onStatus(this.snapshot());
    try {
      const date = formatLocalDate(this.now());
      const [schedules, todos] = await Promise.all([this.client.listSchedules(date), this.client.listTodos(date)]);
      const items = [...normalizeItems(schedules?.items, "schedule"), ...normalizeItems(todos?.items, "todo")];
      await this.writeBackExplicitArrangements(items);
      await this.adoptExternalItems(items);
      this.status = { state: "connected", lastSyncAt: new Date().toISOString(), error: null };
      this.onStatus(this.snapshot());
      this.logger?.info("zhijiantime.synced", { count: items.length });
      return this.snapshot();
    } catch (error) {
      this.status = {
        state: "error",
        lastSyncAt: this.status.lastSyncAt,
        error: { category: error.category || "third-party", code: error.code || "ZHIJIANTIME_SYNC_FAILED", summary: error.message || "指尖时光同步失败。", repairAction: "重试同步" },
      };
      this.onStatus(this.snapshot());
      this.logger?.error("zhijiantime.sync_failed", { code: this.status.error.code });
      return this.snapshot();
    } finally {
      this.syncing = false;
    }
  }

  async writeBackExplicitArrangements(items) {
    const pending = this.planStore.list({ state: "pending", includeRandom: false }).filter((item) => item.source === "conversation" && !item.sourceRef);
    for (const checkpoint of pending) {
      const matches = matchExternalItems(checkpoint, items);
      if (matches.length !== 1) continue;
      const item = matches[0];
      const parts = toLocalParts(new Date(checkpoint.dueAt));
      const payload = { id: item.id, date: parts.date, start_time: parts.time };
      const existingDuration = item.end && item.start ? Date.parse(item.end) - Date.parse(item.start) : 0;
      if (item.end && item.start) {
        if (existingDuration > 0) payload.end_time = toLocalParts(new Date(Date.parse(checkpoint.dueAt) + existingDuration)).time;
      }
      await this.client.updateItem(item.kind, payload);
      item.start = checkpoint.dueAt;
      item.date = parts.date;
      if (payload.end_time) {
        item.end = Number.isFinite(existingDuration) && existingDuration > 0
          ? new Date(Date.parse(checkpoint.dueAt) + existingDuration).toISOString()
          : item.end;
      }
      const fingerprint = externalFingerprint(item);
      this.linkStore.update((state) => ({
        ...state,
        links: { ...state.links, [checkpoint.id]: `${item.kind}:${item.id}` },
        mutations: { ...state.mutations, [`${item.kind}:${item.id}`]: fingerprint },
      }));
      this.planStore.update(checkpoint.id, {
        sourceRef: `${item.kind}:${item.id}`,
        link: `zhijiantime://${item.kind}/${item.id}`,
        mutationFingerprint: fingerprint,
      });
    }
  }

  async adoptExternalItems(items) {
    const linkState = this.linkStore.read();
    for (const item of items) {
      const dueAt = chooseDueAt(item, this.now());
      if (!dueAt || item.completed || item.allDay) continue;
      const sourceRef = `${item.kind}:${item.id}`;
      const fingerprint = externalFingerprint(item);
      const existing = this.planStore.list({ includeRandom: false }).find((checkpoint) => checkpoint.sourceRef === sourceRef || linkState.links[checkpoint.id] === sourceRef);
      if (!existing) {
        this.planStore.add({
          canonicalTaskId: `zhijiantime:${sourceRef}`,
          title: item.title,
          source: "zhijiantime",
          sourceRef,
          dueAt,
          link: `zhijiantime://${item.kind}/${item.id}`,
          mutationFingerprint: fingerprint,
          prompt: `指尖时光中的“${item.title}”已到计划时间，请自然地询问用户进展。`,
        });
        continue;
      }
      const timeChanged = Math.abs(Date.parse(existing.dueAt) - Date.parse(dueAt)) >= 60_000;
      const ownEcho = linkState.mutations[sourceRef] === fingerprint;
      if (timeChanged && !ownEcho) {
        this.planStore.update(existing.id, { dueAt, title: item.title, mutationFingerprint: fingerprint, outcome: "external_rescheduled" });
        await this.notify(`指尖时光把“${item.title}”调整到了${formatNoticeTime(dueAt)}。我先按这个新时间来，不对的话告诉我。`);
      }
      if (ownEcho) {
        this.linkStore.update((state) => {
          const mutations = { ...state.mutations };
          delete mutations[sourceRef];
          return { ...state, mutations };
        });
      }
    }
  }
}

function normalizeItems(items, fallbackKind) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ""),
    kind: item?.kind === "todo" ? "todo" : item?.kind === "schedule" ? "schedule" : fallbackKind,
    title: String(item?.title || "（无标题）").trim(),
    date: item?.date || null,
    start: item?.start || null,
    end: item?.end || null,
    allDay: Boolean(item?.allDay),
    completed: Boolean(item?.completed),
  })).filter((item) => item.id);
}

function chooseDueAt(item, now) {
  const candidate = item.start || item.end;
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return "";
  const timestamp = Date.parse(candidate);
  if (timestamp < now.getTime() && !item.end) return new Date(now.getTime() + 60_000).toISOString();
  return new Date(timestamp).toISOString();
}

function matchExternalItems(checkpoint, items) {
  const checkpointTitle = normalizeTitle(checkpoint.title);
  const dueDate = toLocalParts(new Date(checkpoint.dueAt)).date;
  return items.filter((item) => {
    const itemTitle = normalizeTitle(item.title);
    const titleMatch = checkpointTitle === itemTitle || (checkpointTitle.length >= 3 && (checkpointTitle.includes(itemTitle) || itemTitle.includes(checkpointTitle)));
    return titleMatch && (!item.date || item.date === dueDate);
  });
}

function externalFingerprint(item) {
  return crypto.createHash("sha256").update([item.kind, item.id, item.title, item.date, item.start, item.end].join("\u0000")).digest("hex");
}
function normalizeLinkState(value) { return { schemaVersion: 1, links: objectValue(value?.links), mutations: objectValue(value?.mutations) }; }
function objectValue(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function normalizeTitle(value) { return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""); }
function formatLocalDate(date) { return toLocalParts(date).date; }
function toLocalParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
function formatNoticeTime(value) { const parts = toLocalParts(new Date(value)); return `${parts.date.slice(5).replace("-", "月")}日 ${parts.time}`; }

module.exports = { ZhijiantimeSyncService, chooseDueAt, externalFingerprint, matchExternalItems, normalizeItems, toLocalParts };
