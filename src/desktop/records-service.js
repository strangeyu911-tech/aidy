const fs = require("fs");
const path = require("path");

class RecordsService {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.diaryDir = path.join(stateDir, "diary");
    this.reportsDir = path.join(stateDir, "reports");
    this.shotsDir = path.join(stateDir, "timeline", "shots");
  }

  listDiary({ query = "", limit = 100 } = {}) {
    if (!fs.existsSync(this.diaryDir)) return [];
    const normalizedQuery = String(query || "").trim().toLowerCase();
    return fs.readdirSync(this.diaryDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort().reverse()
      .map((name) => {
        const filePath = path.join(this.diaryDir, name);
        const content = fs.readFileSync(filePath, "utf8");
        return { date: name.slice(0, 10), filePath, content, preview: previewText(content) };
      })
      .filter((item) => !normalizedQuery || `${item.date}\n${item.content}`.toLowerCase().includes(normalizedQuery))
      .slice(0, limit);
  }

  listReports({ limit = 100 } = {}) {
    const metadata = this.readReportMetadata();
    const reportByDate = new Map(metadata.map((item) => [item.date, item]));
    for (const directory of [this.reportsDir, this.shotsDir]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        const date = name.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
        if (!date || reportByDate.has(date)) continue;
        const filePath = path.join(directory, name);
        if (!fs.statSync(filePath).isFile()) continue;
        reportByDate.set(date, { date, status: "generated", generatedAt: fs.statSync(filePath).mtime.toISOString(), filePath });
      }
    }
    return [...reportByDate.values()].sort((left, right) => right.date.localeCompare(left.date)).slice(0, limit);
  }

  readReportMetadata() {
    const filePath = path.join(this.reportsDir, "index.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed?.reports) ? parsed.reports.filter((item) => item?.date) : [];
    } catch {
      return [];
    }
  }
}

function previewText(content) {
  return String(content || "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 180);
}

module.exports = { RecordsService, previewText };
