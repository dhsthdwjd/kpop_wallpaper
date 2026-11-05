const test = require("node:test");
const assert = require("node:assert");
const {yesterdayKst, weekOf, buildItems, buildArchive, mergeIndex} = require("./kpop_rankings");

test("yesterday uses the KST date", () => {
  assert.strictEqual(yesterdayKst(Date.UTC(2026, 10, 1, 15, 10)), "20261101");
  assert.strictEqual(yesterdayKst(Date.UTC(2026, 10, 1, 14, 50)), "20261031");
});

test("week runs Monday to Sunday with ISO id", () => {
  const week = weekOf("20261108");
  assert.strictEqual(week.id, "2026-W45");
  assert.strictEqual(week.dates[0], "20261102");
  assert.strictEqual(week.dates[6], "20261108");
  assert.strictEqual(weekOf("20261102").id, "2026-W45");
  assert.strictEqual(weekOf("20210103").id, "2020-W53");
});

const group = (groupId) => ({groupId, name: groupId, nameKor: groupId});

test("ties share a rank and the next rank skips", () => {
  const items = buildItems([group("a"), group("b"), group("c"), group("d")],
      {a: 5, b: 5, c: 1}, {c: 1});
  assert.deepStrictEqual(items.map((i) => [i.groupId, i.rank]),
      [["a", 1], ["b", 1], ["c", 3], ["d", 4]]);
  assert.strictEqual(items[2].prevRank, 1);
});

test("archive keeps top ten with votes", () => {
  const groups = Array.from({length: 12}, (_, i) => group(`g${String(i).padStart(2, "0")}`));
  const votes = Object.fromEntries(groups.map((g, i) => [g.groupId, i === 11 ? 0 : 20 - i]));
  const archive = buildArchive(weekOf("20261108"), buildItems(groups, votes));
  assert.strictEqual(archive.items.length, 10);
  assert.ok(archive.items.every((i) => i.votes > 0));
});

test("re-merging a week does not duplicate it", () => {
  const week = weekOf("20261108");
  const once = mergeIndex({}, week);
  assert.strictEqual(mergeIndex(once, week).weeks.length, 1);
});
