// Daily K-pop vote aggregation. Run after 00:10 KST with the pages repo checked out:
//   KPOP_PAGES_DIR=<pages repo> node functions/kpop_rankings.js [YYYYMMDD]
// Re-running a date is safe: the daily count document is overwritten, never added to.
const fs = require("fs");
const path = require("path");

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_VOTE_DAYS = 30;
const DELETE_BATCH = 400;
const REQUEST_LIST_SIZE = 50;

const toUtc = (date) => Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

function yesterdayKst(now = Date.now()) {
  return fromUtc(Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - DAY_MS);
}

/** Monday-Sunday week containing date. */
function weekOf(date) {
  const ms = toUtc(date);
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  const dates = Array.from({length: 7}, (_, i) => fromUtc(monday + i * DAY_MS));
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return {file: "weekly", id: `${year}-W${String(week).padStart(2, "0")}`, dates};
}

function datesBetween(startMs, endMs) {
  const dates = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) dates.push(fromUtc(ms));
  return dates;
}

function monthOf(date) {
  const year = +date.slice(0, 4);
  const month = +date.slice(4, 6);
  return {
    file: "monthly",
    id: `${year}-${String(month).padStart(2, "0")}`,
    dates: datesBetween(Date.UTC(year, month - 1, 1), Date.UTC(year, month, 0)),
  };
}

function yearOf(date) {
  const year = +date.slice(0, 4);
  return {
    file: "yearly",
    id: String(year),
    dates: datesBetween(Date.UTC(year, 0, 1), Date.UTC(year, 11, 31)),
  };
}

function votesCutoff(date) {
  return fromUtc(toUtc(date) - RAW_VOTE_DAYS * DAY_MS);
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

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

async function deleteQuery(db, query) {
  for (;;) {
    const snapshot = await query.limit(DELETE_BATCH).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

function requestKey(name) {
  return name.toLowerCase().replace(/[\s/]+/g, "");
}

/** Counts each user once per group; re-running a date adds nothing thanks to the voter documents. */
async function aggregateRequests(db, date, pagesDir) {
  const entries = await db.collection("kpopRequestEntries").where("date", "==", date).get();
  for (const entry of entries.docs) {
    const {uid, name} = entry.data();
    const key = requestKey(name);
    if (!key) continue;
    const ref = db.collection("kpopRequests").doc(key);
    await db.runTransaction(async (tx) => {
      const request = await tx.get(ref);
      const target = request.exists && request.data().mergedInto ?
        db.collection("kpopRequests").doc(request.data().mergedInto) : ref;
      const voter = target.collection("voters").doc(uid);
      const [targetDoc, voterDoc] = await Promise.all([tx.get(target), tx.get(voter)]);
      if (voterDoc.exists) return;
      tx.create(voter, {date});
      if (targetDoc.exists) tx.update(target, {count: (targetDoc.data().count || 0) + 1});
      else tx.create(target, {name: name.trim(), status: "pending", count: 1, createdAt: date});
    });
  }
  const approved = await db.collection("kpopRequests").where("status", "==", "approved").get();
  // Counts stay private: users only see names and a stage badge.
  const score = (doc) => (doc.data().count || 0) + (doc.data().bonus || 0);
  const isDone = (doc) => doc.data().stage === "done";
  const sorted = approved.docs.sort((a, b) => score(b) - score(a));
  // Added artists stay listed below open requests and never count against the limit.
  const items = sorted.filter((doc) => !isDone(doc)).slice(0, REQUEST_LIST_SIZE)
      .concat(sorted.filter(isDone))
      .map((doc) => ({
        key: doc.id,
        name: doc.data().name,
        nameKor: doc.data().nameKor || "",
        stage: doc.data().stage || "received",
      }));
  writeJson(path.join(pagesDir, "rankings", "requests.json"), {schemaVersion: 1, items});
  await deleteQuery(db, db.collection("kpopRequestEntries").where("date", "<", votesCutoff(date)));
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
  const catalog = readJson(path.join(pagesDir, "catalog.json"), []);
  const groups = (Array.isArray(catalog) ? catalog : catalog.groups).map((g) => ({
    groupId: g.id || g.groupId,
    name: g.name,
    nameKor: g.name_kor || g.nameKor,
  }));
  if (!groups.length) throw new Error("catalog.json has no groups");

  const counts = {};
  await Promise.all(groups.map(async ({groupId}) => {
    const votes = db.collection("kpopVotes").where("date", "==", date);
    // Votes cast before multi-select stored a single groupId.
    const [multi, single] = await Promise.all([
      votes.where("groupIds", "array-contains", groupId).count().get(),
      votes.where("groupId", "==", groupId).count().get(),
    ]);
    counts[groupId] = multi.data().count + single.data().count;
  }));
  await db.collection("kpopDailyCounts").doc(date).set({date, counts});

  const dailyCollection = db.collection("kpopDailyCounts");
  const yearDates = yearOf(date).dates.filter((d) => d <= date);
  const docs = await db.getAll(...yearDates.map((d) => dailyCollection.doc(d)));
  const daily = Object.fromEntries(docs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data().counts]));

  for (const period of [weekOf(date), monthOf(date), yearOf(date)]) {
    const totals = {};
    for (const day of period.dates) {
      for (const [groupId, count] of Object.entries(daily[day] || {})) {
        totals[groupId] = (totals[groupId] || 0) + count;
      }
    }
    const file = path.join(pagesDir, "rankings", `${period.file}.json`);
    const previous = readJson(file, {});
    const prevRanks = previous.period === period.id ?
      Object.fromEntries(previous.items.map((item) => [item.groupId, item.rank])) : {};
    writeJson(file, {
      schemaVersion: 1,
      period: period.id,
      updatedAt: new Date().toISOString(),
      items: buildItems(groups, totals, prevRanks),
    });
  }

  // Keep the current year's totals and 30 days of raw votes; the first run of a new year
  // still needs last year's totals to close that year, so only older years are removed.
  await deleteQuery(db, dailyCollection.where("date", "<", `${date.slice(0, 4)}0101`));
  await deleteQuery(db, db.collection("kpopVotes").where("date", "<", votesCutoff(date)));
  await aggregateRequests(db, date, pagesDir);
  console.log(`Aggregated ${date}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {yesterdayKst, weekOf, monthOf, yearOf, votesCutoff, buildItems, requestKey};
