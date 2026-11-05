// Daily K-pop vote aggregation. Run after 00:10 KST with the pages repo checked out:
//   KPOP_PAGES_DIR=<pages repo> node functions/kpop_rankings.js [YYYYMMDD]
// Re-running a date is safe: the daily count document is overwritten, never added to.
const fs = require("fs");
const path = require("path");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_SIZE = 10;

const toUtc = (date) => Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

function yesterdayKst(now = Date.now()) {
  return fromUtc(Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - DAY_MS);
}

/** Dates of the Monday-Sunday week containing date, with its ISO week id. */
function weekOf(date) {
  const ms = toUtc(date);
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  const dates = Array.from({length: 7}, (_, i) => fromUtc(monday + i * DAY_MS));
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  const label = (d) => `${d.slice(4, 6)}/${d.slice(6, 8)}`;
  return {
    id: `${year}-W${String(week).padStart(2, "0")}`,
    label: `${label(dates[0])}-${label(dates[6])}`,
    dates,
  };
}

/** Sorted items; equal votes share a rank. prevRanks is {groupId: rank}. */
function buildItems(groups, votesByGroup, prevRanks = {}) {
  const sorted = groups
      .map((group) => ({group, votes: votesByGroup[group.groupId] || 0}))
      .sort((a, b) => b.votes - a.votes || a.group.groupId.localeCompare(b.group.groupId));
  let rank = 0;
  return sorted.map(({group, votes}, index) => {
    if (index === 0 || sorted[index - 1].votes !== votes) rank = index + 1;
    return {
      rank,
      prevRank: prevRanks[group.groupId] || null,
      groupId: group.groupId,
      name: group.name,
      nameKor: group.nameKor,
      votes,
    };
  });
}

function buildArchive(week, items) {
  return {
    schemaVersion: 1,
    period: week.id,
    label: week.label,
    items: items.filter((item) => item.votes > 0 && item.rank <= ARCHIVE_SIZE),
  };
}

function mergeIndex(index, week) {
  const weeks = (index.weeks || []).filter((entry) => entry.id !== week.id);
  weeks.unshift({id: week.id, label: week.label});
  weeks.sort((a, b) => b.id.localeCompare(a.id));
  return {schemaVersion: 1, weeks};
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

async function main() {
  const {cert, initializeApp} = require("firebase-admin/app");
  const {getFirestore} = require("firebase-admin/firestore");
  const pagesDir = process.env.KPOP_PAGES_DIR;
  if (!pagesDir) throw new Error("KPOP_PAGES_DIR is required");
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  initializeApp({credential: cert(serviceAccount), projectId: serviceAccount.project_id});
  const db = getFirestore();

  const date = process.argv[2] || yesterdayKst();
  const groups = readJson(path.join(pagesDir, "catalog.json"), {groups: []}).groups;
  if (!groups.length) throw new Error("catalog.json has no groups");

  const counts = {};
  await Promise.all(groups.map(async ({groupId}) => {
    const snapshot = await db.collection("kpopVotes")
        .where("date", "==", date).where("groupId", "==", groupId).count().get();
    counts[groupId] = snapshot.data().count;
  }));
  await db.collection("kpopDailyCounts").doc(date).set({date, counts});

  const week = weekOf(date);
  const refs = week.dates.filter((d) => d <= date).map((d) => db.collection("kpopDailyCounts").doc(d));
  const totals = {};
  for (const doc of await db.getAll(...refs)) {
    for (const [groupId, count] of Object.entries((doc.exists && doc.data().counts) || {})) {
      totals[groupId] = (totals[groupId] || 0) + count;
    }
  }

  const weeklyPath = path.join(pagesDir, "rankings", "weekly.json");
  const previous = readJson(weeklyPath, {});
  const prevRanks = previous.period === week.id ?
    Object.fromEntries(previous.items.map((item) => [item.groupId, item.rank])) : {};
  const items = buildItems(groups, totals, prevRanks);
  writeJson(weeklyPath, {
    schemaVersion: 1,
    period: week.id,
    label: week.label,
    updatedAt: new Date().toISOString(),
    items,
  });

  if (date === week.dates[6]) {
    const archiveDir = path.join(pagesDir, "rankings", "archive");
    writeJson(path.join(archiveDir, `${week.id}.json`), buildArchive(week, items));
    const indexPath = path.join(archiveDir, "index.json");
    writeJson(indexPath, mergeIndex(readJson(indexPath, {}), week));
  }
  console.log(`Aggregated ${date} into ${week.id}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {yesterdayKst, weekOf, buildItems, buildArchive, mergeIndex};
