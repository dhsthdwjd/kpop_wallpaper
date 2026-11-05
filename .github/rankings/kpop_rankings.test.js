const test = require("node:test");
const assert = require("node:assert");
const {yesterdayKst, weekOf, monthOf, yearOf, votesCutoff, buildItems, requestKey} = require("./kpop_rankings");

test("yesterday uses the KST date", () => {
  assert.strictEqual(yesterdayKst(Date.UTC(2026, 10, 1, 15, 10)), "20261101");
  assert.strictEqual(yesterdayKst(Date.UTC(2026, 10, 1, 14, 50)), "20261031");
});

test("week runs Monday to Sunday with ISO id", () => {
  const week = weekOf("20261108");
  assert.strictEqual(week.id, "2026-W45");
  assert.strictEqual(week.dates[0], "20261102");
  assert.strictEqual(week.dates[6], "20261108");
  assert.strictEqual(weekOf("20210103").id, "2020-W53");
});

test("month and year cover their full ranges", () => {
  assert.strictEqual(monthOf("20260215").id, "2026-02");
  assert.strictEqual(monthOf("20260215").dates.length, 28);
  assert.strictEqual(monthOf("20261231").dates.at(-1), "20261231");
  assert.strictEqual(yearOf("20280301").dates.length, 366);
  assert.strictEqual(yearOf("20261105").dates[0], "20260101");
});

test("raw votes are kept for 30 days", () => {
  assert.strictEqual(votesCutoff("20260131"), "20260101");
});

const group = (groupId) => ({groupId, name: groupId, nameKor: groupId});

test("ties share a rank and the next rank skips", () => {
  const items = buildItems([group("a"), group("b"), group("c"), group("d")],
      {a: 5, b: 5, c: 1}, {c: 1});
  assert.deepStrictEqual(items.map((i) => [i.groupId, i.rank]),
      [["a", 1], ["b", 1], ["c", 3], ["d", 4]]);
  assert.strictEqual(items[2].prevRank, 1);
});

test("request names with different spacing and case share a key", () => {
  assert.strictEqual(requestKey(" All Day  Project "), "alldayproject");
  assert.strictEqual(requestKey("ALLDAY PROJECT"), "alldayproject");
});
