import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Account, type Coverage, computeStats, type Post } from "../src/stats.ts";

const account: Account = {
  handle: "a@example.test",
  followers: 10,
  accountSince: "2020-01-01",
};
const NOW = new Date("2026-09-18T12:00:00Z");

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    from: new Date(NOW.getTime() - 365 * 24 * 3600 * 1000),
    to: NOW,
    timeZone: "Europe/Berlin",
    tzExplicit: true,
    ...over,
  };
}

function post(over: Partial<Post> = {}): Post {
  return {
    createdAt: NOW,
    kind: "post",
    tags: [],
    mentions: [],
    attachments: 0,
    attachmentsWithAlt: 0,
    hasCw: false,
    chars: 10,
    words: 2,
    likes: null,
    shares: null,
    link: null,
    ...over,
  };
}

async function* feed(posts: Post[]): AsyncIterable<Post> {
  for (const post of posts) yield post;
}

const run = (posts: Post[], over: Partial<Coverage> = {}) =>
  computeStats(feed(posts), account, coverage(over));

describe("computeStats", () => {
  it("produces no NaN or Infinity for an empty account", async () => {
    const stats = await run([]);
    assert.equal(stats.posts, 0);
    assert.equal(stats.longestPost, 0);
    assert.equal(stats.longestStreak, 0);
    assert.equal(stats.activeDays, 0);
    assert.equal(stats.busiestMonth, null);
    for (const value of [
      stats.posts,
      stats.characters,
      stats.longestPost,
      stats.longestStreak,
    ]) {
      assert.ok(Number.isFinite(value), "every numeric stat must be finite");
    }
  });

  it("counts boosts separately and never as posts", async () => {
    const stats = await run([post(), post({ kind: "boost" }), post({ kind: "boost" })]);
    assert.equal(stats.posts, 1);
    assert.equal(stats.boosts, 2);
  });

  it("counts a reply as both a post and a reply", async () => {
    const stats = await run([post({ kind: "reply" })]);
    assert.equal(stats.posts, 1);
    assert.equal(stats.replies, 1);
  });

  it("reports engagement only when EVERY post carried a count", async () => {
    // One post in three thousand happening to have a count must not be
    // presented as the account's total.
    const posts = [post({ likes: 17, shares: 3 }), post(), post()];
    const stats = await run(posts);
    assert.equal(stats.likesReceived, null);
    assert.equal(stats.boostsReceived, null);
    assert.equal(stats.engagementKnown, 1);

    const full = await run([post({ likes: 2, shares: 1 }), post({ likes: 3, shares: 0 })]);
    assert.equal(full.likesReceived, 5);
    assert.equal(full.boostsReceived, 1);
  });

  it("keeps a streak intact across the European DST change", async () => {
    // 2026-03-29 is the spring-forward night in Europe/Berlin. Local calendar
    // days must still be exactly one apart.
    const days = ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"];
    const stats = await run(
      days.map((day) => post({ createdAt: new Date(`${day}T12:00:00Z`) })),
    );
    assert.equal(stats.activeDays, 5);
    assert.equal(stats.longestStreak, 5);
  });

  it("breaks a streak on a missing day", async () => {
    const stats = await run(
      ["2026-01-01", "2026-01-02", "2026-01-04"].map((day) =>
        post({ createdAt: new Date(`${day}T12:00:00Z`) }),
      ),
    );
    assert.equal(stats.longestStreak, 2);
  });

  it("keys the busiest month by year so two Septembers never merge", async () => {
    const posts = [
      ...Array.from({ length: 3 }, () => post({ createdAt: new Date("2025-09-10T12:00:00Z") })),
      ...Array.from({ length: 2 }, () => post({ createdAt: new Date("2026-09-10T12:00:00Z") })),
      ...Array.from({ length: 4 }, () => post({ createdAt: new Date("2026-01-10T12:00:00Z") })),
    ];
    const stats = await run(posts);
    assert.deepEqual(stats.busiestMonth, { key: "2026-01", count: 4 });
  });

  it("folds hashtag casing but displays the most common spelling", async () => {
    const stats = await run([
      post({ tags: ["Fediverse"] }),
      post({ tags: ["fediverse"] }),
      post({ tags: ["fediverse"] }),
    ]);
    assert.deepEqual(stats.topHashtags, [{ tag: "fediverse", count: 3 }]);
    assert.equal(stats.distinctHashtags, 1);
  });

  it("breaks hashtag ties deterministically", async () => {
    const stats = await run([post({ tags: ["b"] }), post({ tags: ["a"] })]);
    assert.deepEqual(
      stats.topHashtags.map((hashtag) => hashtag.tag),
      ["a", "b"],
    );
  });

  it("keeps a longer hashtag ranking for the cloud, in the same order", async () => {
    const tags = Array.from(
      { length: 40 },
      (_value, index) => `tag${String(index).padStart(2, "0")}`,
    );
    const stats = await run(tags.map((tag) => post({ tags: [tag] })));
    assert.equal(stats.topHashtags.length, 4);
    assert.equal(stats.cloudHashtags.length, 30);
    assert.deepEqual(stats.cloudHashtags.slice(0, 4), stats.topHashtags);
  });

  it("finds the linkable post with the most favourites plus boosts", async () => {
    const stats = await run([
      post({ likes: 5, shares: 1, link: "https://x.test/1" }),
      post({ likes: 40, shares: 2, link: "https://x.test/2" }),
      // More reach but not linkable (unlisted or a reply): never the one linked.
      post({ likes: 90, shares: 9, link: null }),
    ]);
    assert.deepEqual(stats.topPost, { link: "https://x.test/2", likes: 40, shares: 2 });
  });

  it("breaks a top post tie towards more boosts, then the newer post", async () => {
    const older = new Date("2026-01-01T12:00:00Z");
    const newer = new Date("2026-02-01T12:00:00Z");
    const byBoosts = await run([
      post({ likes: 8, shares: 2, link: "https://x.test/likes" }),
      post({ likes: 5, shares: 5, link: "https://x.test/boosts" }),
    ]);
    assert.equal(byBoosts.topPost?.link, "https://x.test/boosts");
    const byDate = await run([
      post({ createdAt: newer, likes: 3, shares: 1, link: "https://x.test/newer" }),
      post({ createdAt: older, likes: 3, shares: 1, link: "https://x.test/older" }),
    ]);
    assert.equal(byDate.topPost?.link, "https://x.test/newer");
  });

  it("has no top post without reach or without complete counts", async () => {
    const quiet = await run([post({ likes: 0, shares: 0, link: "https://x.test/1" })]);
    assert.equal(quiet.topPost, null, "a post nobody reacted to is no hit");
    // Beside a missing sum, the tile cannot show it, so the reply must not link it either.
    const partial = await run([
      post({ likes: 9, shares: 3, link: "https://x.test/1" }),
      post(),
    ]);
    assert.equal(partial.topPost, null);
  });

  it("places a Berlin-midnight post on the right local day and hour", async () => {
    // 22:30 UTC is 00:30 the NEXT day in Berlin summer time.
    const stats = await run([post({ createdAt: new Date("2026-07-01T22:30:00Z") })]);
    assert.equal(stats.postsByHour[0], 1, "hour must be 00 local, not 22 UTC");
    assert.equal(stats.activeDays, 1);
  });

  it("indexes weekdays Monday-first", async () => {
    // 2026-09-14 is a Monday.
    const stats = await run([post({ createdAt: new Date("2026-09-14T12:00:00Z") })]);
    assert.equal(stats.postsByWeekday[0], 1);
    assert.equal(stats.postsByWeekday.length, 7);
  });

  it("counts distinct mentioned accounts without keeping any handle", async () => {
    const stats = await run([
      post({ mentions: ["a@x.test", "b@x.test"] }),
      post({ mentions: ["a@x.test"] }),
    ]);
    assert.equal(stats.distinctAccountsMentioned, 2);
    assert.equal(JSON.stringify(stats).includes("a@x.test"), false, "no handle may survive");
  });

  it("never awards a clock archetype without an explicit timezone", async () => {
    const night = Array.from({ length: 40 }, (_value, index) =>
      post({ createdAt: new Date(`2026-0${(index % 9) + 1}-01T23:30:00Z`) }),
    );
    const withTz = await run(night, { tzExplicit: true });
    const withoutTz = await run(night, { tzExplicit: false });
    assert.equal(withTz.archetype, "nightOwl");
    assert.notEqual(withoutTz.archetype, "nightOwl");
    assert.notEqual(withoutTz.archetype, "earlyBird");
    assert.notEqual(withoutTz.archetype, "weekendVoice");
  });

  it("never reports a low alt-text rate as a fun fact", async () => {
    const posts = Array.from({ length: 40 }, (_value, index) =>
      post({
        attachments: 1,
        attachmentsWithAlt: index < 2 ? 1 : 0,
        createdAt: new Date(`2026-01-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`),
        chars: 5,
      }),
    );
    const stats = await run(posts);
    assert.notEqual(
      stats.funFact?.id,
      "altTextRate",
      "5% alt text must never be printed at someone",
    );
  });

  it("measures the longest post in code points", async () => {
    const stats = await run([post({ chars: 5000 }), post({ chars: 10 })]);
    assert.equal(stats.longestPost, 5000);
    assert.equal(stats.characters, 5010);
  });

  it("keeps a null follower count null rather than zero", async () => {
    const stats = await computeStats(
      feed([post()]),
      { handle: "a@example.test", followers: null, accountSince: null },
      coverage(),
    );
    assert.equal(stats.followers, null);
    assert.equal(stats.accountSince, null);
  });
});
