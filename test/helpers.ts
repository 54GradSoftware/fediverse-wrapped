import { after } from "node:test";
import { type Db, openDb } from "../src/db.ts";
import { computeStats, type Post, type Stats } from "../src/stats.ts";

// Lucid's open pool would keep the test process alive; close every database made here.
const opened: Db[] = [];
after(() => Promise.all(opened.map((db) => db.close())));

export async function testDb(salt = "salt"): Promise<Db> {
  const db = await openDb(":memory:", salt);
  opened.push(db);
  await db.migrate();
  return db;
}

const RICH_TAGS = [
  "Fediverse",
  "Mastodon",
  "ActivityPub",
  "OpenSource",
  "TypeScript",
  "Accessibility",
  "Kaffee",
  "Berlin",
  "Photography",
  "Linux",
  "Rust",
  "Fedify",
  "Webdev",
  "Climate",
  "Books",
  "Music",
];

/**
 * A full year (eight tiles) with a long hashtag tail and one clear top post, so the cloud
 * and the top-post rows are both on screen. `extraTags` go on every tenth post, which ranks
 * them past the four foreground hashtags and into the cloud.
 */
export async function richStats(extraTags: readonly string[] = []): Promise<Stats> {
  const now = new Date("2026-09-18T12:00:00Z");
  const posts: Post[] = Array.from({ length: 300 }, (_value, index) => ({
    createdAt: new Date(now.getTime() - index * 26 * 3600 * 1000),
    kind: index % 6 === 0 ? "reply" : "post",
    // Tag n is used about 1/n as often, which gives the cloud a real spread of sizes.
    tags: [
      ...RICH_TAGS.filter((_tag, tagIndex) => index % (tagIndex + 1) === 0),
      ...(index % 10 === 0 ? extraTags : []),
    ],
    mentions: [],
    attachments: index % 4 === 0 ? 1 : 0,
    attachmentsWithAlt: index % 4 === 0 ? 1 : 0,
    hasCw: false,
    chars: 120 + (index % 200),
    words: 20 + (index % 30),
    likes: index === 7 ? 412 : index % 5,
    shares: index === 7 ? 133 : index % 2,
    link: index % 6 === 0 ? null : `https://example.test/@a/${index}`,
  }));
  async function* feed() {
    for (const post of posts) yield post;
  }
  const stats = await computeStats(
    feed(),
    { handle: "a@example.test", followers: 321, accountSince: "2022-11-01" },
    {
      from: new Date(now.getTime() - 365 * 24 * 3600 * 1000),
      to: now,
      timeZone: "Europe/Berlin",
      tzExplicit: true,
    },
  );
  return { ...stats, partial: false };
}
