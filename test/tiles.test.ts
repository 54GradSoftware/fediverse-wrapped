import "./env.ts";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { overlaps } from "../src/decor.ts";
import { type Account, type Coverage, computeStats, type Post } from "../src/stats.ts";
import { catalogues } from "../src/strings.ts";
import {
  buildTiles,
  escapeXml,
  FULL_SET_THRESHOLD,
  fitHandle,
  graphemes,
  layoutTile,
  maxRowsFor,
  renderAlt,
  renderSvg,
  renderTiles,
  SIZE,
  STARTER_THRESHOLD,
  SURFACE,
  tilePosts,
  WORDS_TILE_PAGES,
} from "../src/tiles.ts";
import { richStats } from "./helpers.ts";

const FONTS = fileURLToPath(new URL("../fonts/", import.meta.url));
const fontFilesOf = (dir: string) =>
  readdirSync(dir)
    .filter((fileName) => /\.(ttf|otf)$/i.test(fileName))
    .sort()
    .map((fileName) => `${dir}${fileName}`);
const NOW = new Date("2026-09-18T12:00:00Z");

async function statsFor(count: number, over: Partial<Post> = {}, handle = "a@example.test") {
  const posts: Post[] = Array.from({ length: count }, (_value, index) => ({
    createdAt: new Date(NOW.getTime() - index * 36 * 3600 * 1000),
    kind: index % 5 === 0 ? "reply" : "post",
    tags: index % 3 === 0 ? ["fediverse"] : [],
    mentions: [],
    attachments: index % 4 === 0 ? 1 : 0,
    attachmentsWithAlt: index % 4 === 0 ? 1 : 0,
    hasCw: false,
    chars: 100 + index,
    words: 20 + (index % 30),
    likes: 2,
    shares: 1,
    link: null,
    ...over,
  }));
  async function* feed() {
    for (const post of posts) yield post;
  }
  const account: Account = { handle, followers: 42, accountSince: "2021-05-01" };
  const coverage: Coverage = {
    from: new Date(NOW.getTime() - 365 * 24 * 3600 * 1000),
    to: NOW,
    timeZone: "Europe/Berlin",
    tzExplicit: true,
  };
  return { ...(await computeStats(feed(), account, coverage)), partial: false };
}

describe("tile set", () => {
  it("is exactly one, four or eight tiles — never a count Mastodon mangles", async () => {
    // Mastodon renders one attachment full-bleed and four as a clean 2x2, but
    // two, three or five become tall crops that butcher a square tile.
    assert.equal(buildTiles(await statsFor(0), "en").length, 1);
    assert.equal(buildTiles(await statsFor(3), "de").length, 1);
    assert.equal(buildTiles(await statsFor(STARTER_THRESHOLD), "de").length, 4);
    assert.equal(buildTiles(await statsFor(50), "de").length, 4);
    assert.equal(buildTiles(await statsFor(FULL_SET_THRESHOLD), "de").length, 8);
    assert.equal(buildTiles(await statsFor(647), "de").length, 8);
  });

  it("splits tiles into posts of at most four", async () => {
    assert.deepEqual(tilePosts([1]), [[1]]);
    assert.deepEqual(tilePosts([1, 2, 3, 4]), [[1, 2, 3, 4]]);
    assert.deepEqual(tilePosts([1, 2, 3, 4, 5, 6, 7, 8]), [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    for (const count of [1, 4, 8]) {
      for (const group of tilePosts(Array.from({ length: count }, (_value, index) => index))) {
        assert.ok(group.length === 1 || group.length === 4, `group of ${group.length}`);
      }
    }
  });

  it("gives every tile a unique id so none silently duplicates", async () => {
    const ids = buildTiles(await statsFor(647), "de").map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(", "));
  });

  it("never lays out more rows than fit above the notes and footer", async () => {
    for (const count of [0, 3, 12, 200]) {
      for (const locale of ["de", "en"] as const) {
        for (const tile of buildTiles(await statsFor(count), locale)) {
          const budget = maxRowsFor(tile.chart != null, tile.notes.length);
          assert.ok(
            tile.rows.length <= budget,
            `${tile.id} has ${tile.rows.length} rows but only ${budget} fit`,
          );
          assert.ok(tile.notes.length <= 2);
        }
      }
    }
  });

  it("renders a tile for an account with no hashtags at all", async () => {
    const stats = await statsFor(50, { tags: [] });
    const tiles = buildTiles(stats, "de");
    assert.equal(tiles.length, 4, "the four-up layout must never collapse to three");
    const topics = tiles.find((model) => model.id === "topics");
    assert.ok(topics);
    assert.ok(topics.rows.length > 0);
  });
});

describe("alt text", () => {
  it("says exactly what the picture shows, and always names the account", async () => {
    const stats = await statsFor(200);
    for (const [index, tile] of buildTiles(stats, "de").entries()) {
      const alt = renderAlt(tile, stats, "de");
      assert.ok(alt.includes(stats.handle), "alt text must identify whose year this is");
      assert.ok(alt.length > 20 && alt.length < 1500);
      for (const row of tile.rows) {
        // The alt text drops the leading emoji on purpose; the wording stays.
        const wording = row.label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
        assert.ok(alt.includes(wording), `alt text omits the row "${wording}"`);
        assert.ok(alt.includes(row.value), `alt text omits the value "${row.value}"`);
        assert.equal(
          /\p{Extended_Pictographic}/u.test(alt),
          false,
          "alt text must not read emoji aloud",
        );
      }
      for (const note of tile.notes) {
        // Notes can carry an emoji too (the partial-analysis line has one), so
        // compare against the stripped wording the alt text actually uses.
        const plain = note
          .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
          .replace(/\s+/g, " ")
          .trim();
        assert.ok(alt.includes(plain), `alt text omits the disclosure "${plain}"`);
      }
      assert.ok(index >= 0);
    }
  });

  it("keeps a partial-analysis disclosure that carries an emoji", async () => {
    const base = await statsFor(647);
    const stats = { ...base, partial: true };
    for (const tile of buildTiles(stats, "de")) {
      const alt = renderAlt(tile, stats, "de");
      assert.ok(alt.includes("Mindestwerte"), `${tile.id} drops the partial disclosure`);
      assert.equal(/\p{Extended_Pictographic}/u.test(alt), false);
    }
  });

  it("carries the engagement disclosure when the server published no counts", async () => {
    const stats = await statsFor(50, { likes: null, shares: null });
    const numbers = buildTiles(stats, "de").find((model) => model.id === "numbers");
    assert.ok(numbers);
    const alt = renderAlt(numbers, stats, "de");
    assert.ok(alt.includes("ActivityPub"), "must say WHY the favourite count is missing");
  });
});

describe("svg safety", () => {
  it("escapes every interpolation", () => {
    assert.equal(escapeXml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("cannot be broken out of by a hostile hashtag", async () => {
    const stats = await statsFor(50, { tags: ["</text><script>alert(1)</script>"] });
    const tile = buildTiles(stats, "de").find((model) => model.id === "topics")!;
    const svg = renderSvg(tile, stats, 0, "de");
    assert.equal(svg.includes("<script>"), false);
    assert.ok(svg.includes("&lt;"));
  });

  it("produces a well-formed document of the right size", async () => {
    const stats = await statsFor(200);
    const svg = renderSvg(buildTiles(stats, "de")[0]!, stats, 0, "de");
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.endsWith("</svg>"));
    assert.ok(svg.includes(`width="${SIZE}"`));
    assert.equal((svg.match(/<text /g) ?? []).length > 5, true);
  });
});

describe("design", () => {
  it("paints every tile on the flat dark surface, without gradient or confetti", async () => {
    const stats = await richStats();
    for (const [index, tile] of buildTiles(stats, "de").entries()) {
      const markup = renderSvg(tile, stats, index, "de");
      assert.ok(markup.includes(`fill="${SURFACE}"`), tile.id);
      assert.equal(/Gradient|<circle|<polygon/.test(markup), false, tile.id);
    }
  });

  it("renders the same picture every time", async () => {
    const stats = await richStats();
    for (const [index, tile] of buildTiles(stats, "en").entries()) {
      assert.equal(renderSvg(tile, stats, index, "en"), renderSvg(tile, stats, index, "en"));
    }
  });
});

describe("hashtag cloud", () => {
  it("draws the tags after the foreground four, inside the tile, never on each other", async () => {
    const stats = await richStats();
    const topics = buildTiles(stats, "de").find((model) => model.id === "topics")!;
    const foreground = new Set(stats.topHashtags.map((tag) => `#${tag.tag}`));
    const { cloud } = layoutTile(topics, stats, 2, "de");
    assert.ok(cloud.length >= 3, `only ${cloud.length} cloud words placed`);
    for (const [index, word] of cloud.entries()) {
      assert.equal(foreground.has(word.text), false, `${word.text} is drawn twice`);
      assert.ok(word.box.left >= 0 && word.box.right <= SIZE, word.text);
      assert.ok(word.box.top >= 150 && word.box.bottom <= 936, word.text);
      for (const other of cloud.slice(index + 1)) {
        assert.equal(overlaps(word.box, other.box), false, `${word.text} / ${other.text}`);
      }
    }
  });

  it("is left out below five hashtags, so a sparse tile stays calm", async () => {
    const stats = await statsFor(200);
    const topics = buildTiles(stats, "de").find((model) => model.id === "topics")!;
    assert.equal(topics.cloud, undefined);
  });

  it("cannot be broken out of by a hostile hashtag", async () => {
    const stats = await richStats(["</text><script>alert(1)</script>"]);
    const topics = buildTiles(stats, "de").find((model) => model.id === "topics")!;
    assert.ok(
      topics.cloud?.some((word) => word.text.includes("<script>")),
      "not in the cloud",
    );
    const markup = renderSvg(topics, stats, 2, "de");
    assert.equal(markup.includes("<script>"), false);
  });
});

describe("top post", () => {
  it("is on the resonance tile when the year has one", async () => {
    const stats = await richStats();
    assert.ok(stats.topPost != null);
    for (const locale of ["de", "en"] as const) {
      const catalogue = catalogues[locale];
      const resonance = buildTiles(stats, locale).find((model) => model.id === "resonance")!;
      assert.deepEqual(resonance.rows.slice(0, 2), [
        { label: catalogue.labelTopPostLikes, value: "412" },
        { label: catalogue.labelTopPostBoosts, value: "133" },
      ]);
    }
  });

  it("is not on the resonance tile when no post can be linked", async () => {
    const stats = await statsFor(200);
    assert.equal(stats.topPost, null);
    const resonance = buildTiles(stats, "de").find((model) => model.id === "resonance")!;
    const labels = resonance.rows.map((row) => row.label);
    assert.equal(labels.includes(catalogues.de.labelTopPostLikes), false);
  });
});

describe("handles", () => {
  it("keeps the username whole and shortens the domain", () => {
    const long = "someone@a-really-very-long-domain-name.example.test";
    const fitted = fitHandle(long);
    assert.ok(fitted.startsWith("someone@"));
    assert.ok(graphemes(fitted).length <= 40);
    assert.ok(fitted.includes("…"));
  });

  it("leaves a normal handle untouched", () => {
    assert.equal(fitHandle("a@x.test"), "a@x.test");
  });
});

describe("rendering", () => {
  it("produces eight 1080x1080 PNGs for a full year", async () => {
    const stats = await statsFor(647);
    const tiles = await renderTiles(stats, "de", FONTS);
    assert.equal(tiles.length, 8);
    for (const tile of tiles) {
      assert.equal(tile.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
      assert.equal(tile.png.readUInt32BE(16), SIZE);
      assert.equal(tile.png.readUInt32BE(20), SIZE);
      assert.ok(tile.alt.length > 20);
    }
  });

  it("renders bold and regular as visibly different weights", async () => {
    // Catches an accidental variable font: resvg 0.34 predates variable-font
    // support and would silently render every weight identically.
    const stats = await statsFor(200);
    const [tile] = await renderTiles(stats, "de", FONTS);
    const bold = renderSvg(buildTiles(stats, "de")[0]!, stats, 0, "de");
    assert.ok(bold.includes('font-weight="700"'));
    assert.ok(bold.includes('font-weight="400"'));
    assert.ok(tile!.png.length > 1000);
  });

  it("actually rasterises the emojis instead of drawing empty boxes", async () => {
    // Inter has no emoji glyphs; without the bundled Noto Emoji, resvg silently draws boxes,
    // so only a change in the rendered bytes catches it.
    const stats = await statsFor(647);
    const tile = buildTiles(stats, "de")[0]!;
    const withEmoji = renderSvg(tile, stats, 0, "de");
    const withoutEmoji = withEmoji.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
    assert.notEqual(withEmoji, withoutEmoji, "the tile should contain emojis at all");

    const render = (markup: string) =>
      new Resvg(markup, {
        font: {
          fontFiles: fontFilesOf(FONTS),
          loadSystemFonts: false,
          defaultFontFamily: "Inter",
        },
      })
        .render()
        .asPng().length;
    assert.notEqual(
      render(withEmoji),
      render(withoutEmoji),
      "emoji glyphs must reach the raster, not fall back to a box",
    );
  });

  it("renders a CJK hashtag without throwing", async () => {
    const stats = await statsFor(50, { tags: ["日本語"] });
    const tiles = await renderTiles(stats, "en", FONTS);
    assert.equal(tiles.length, 4);
  });
});

describe("footer and words", () => {
  it("names the service host in the footer and the year in the header", async () => {
    const stats = await statsFor(200);
    const svg = renderSvg(buildTiles(stats, "de")[0]!, stats, 0, "de");
    assert.ok(svg.includes("wrapped.example.test"), "footer must carry the host");
    assert.ok(svg.includes("1 · 2026"), "header must carry the year");
  });

  it("shows the words tile second and the rhythm tile fifth", async () => {
    const ids = buildTiles(await statsFor(647), "de").map((model) => model.id);
    assert.deepEqual(ids.slice(0, 5), ["numbers", "words", "topics", "type", "rhythm"]);
  });

  it("writes the date range in the reader's own format, not ISO", async () => {
    const stats = await statsFor(200);
    const de = renderSvg(buildTiles(stats, "de")[0]!, stats, 0, "de");
    assert.ok(de.includes("18.09.2026"), "German dates are dd.mm.yyyy");
    assert.equal(de.includes("2026-09-18"), false, "no ISO date on a shareable card");
    const en = renderSvg(buildTiles(stats, "en")[0]!, stats, 0, "en");
    assert.ok(en.includes("09/18/2026"));
  });

  it("uses the reader's decimal separator on the resonance tile", async () => {
    const stats = await statsFor(647);
    const de = buildTiles(stats, "de").find((model) => model.id === "resonance")!;
    const en = buildTiles(stats, "en").find((model) => model.id === "resonance")!;
    const perPost = (tile: typeof de) =>
      tile.rows.find((row) => /pro Beitrag|per post/.test(row.label))!.value;
    assert.match(perPost(de), /^\d+,\d$/, "German uses a comma");
    assert.match(perPost(en), /^\d+\.\d$/, "English uses a point");
  });

  it("has a words tile with pages and an average", async () => {
    const stats = await statsFor(647);
    const words = buildTiles(stats, "de").find((model) => model.id === "words");
    assert.ok(words, "a full year must include the words tile");
    const alt = renderAlt(words, stats, "de");
    assert.ok(alt.includes("Buchseiten"));
    assert.ok(alt.includes("Wörter pro Beitrag"));
    assert.ok(stats.words > 0 && stats.avgWordsPerPost > 0 && stats.bookPages > 0);
  });

  it("gives a blog with few but long posts the words tile instead of topics", async () => {
    const blog = await statsFor(STARTER_THRESHOLD, { words: 1000 });
    assert.ok(blog.bookPages >= WORDS_TILE_PAGES);
    const ids = buildTiles(blog, "de").map((model) => model.id);
    assert.deepEqual(ids, ["numbers", "words", "rhythm", "type"]);

    // 99 posts at the 500-character limit stay under the cutoff.
    const toots = await statsFor(FULL_SET_THRESHOLD - 1, { words: 80 });
    assert.ok(toots.bookPages < WORDS_TILE_PAGES);
    assert.deepEqual(
      buildTiles(toots, "de").map((model) => model.id),
      ["numbers", "rhythm", "topics", "type"],
    );
  });

  it("does not repeat the book pages as a fun fact next to the words tile", async () => {
    const full = await statsFor(200);
    assert.equal(full.funFact?.id, "bookPages", "precondition: it would be the fun fact");
    const type = buildTiles(full, "en").find((model) => model.id === "type")!;
    assert.equal(
      type.notes.some((note) => /book pages/.test(note)),
      false,
    );

    // Without a words tile the fun fact is the only place the pages appear.
    const short = await statsFor(50, { words: 100 });
    const ids = buildTiles(short, "en").map((model) => model.id);
    assert.equal(ids.includes("words"), false);
    const shortType = buildTiles(short, "en").find((model) => model.id === "type")!;
    assert.ok(shortType.notes.some((note) => /book pages/.test(note)));
  });

  it("puts an emoji on every tile title and row label", async () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const locale of ["de", "en"] as const) {
      for (const tile of buildTiles(await statsFor(647), locale)) {
        assert.ok(emoji.test(tile.title), `${tile.id}: title has no emoji`);
        for (const row of tile.rows) {
          assert.ok(emoji.test(row.label), `${tile.id}: row "${row.label}" has no emoji`);
        }
      }
    }
  });
});
