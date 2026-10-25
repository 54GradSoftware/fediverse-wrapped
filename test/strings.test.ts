import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashtag, link, text } from "@fedify/botkit";
import { type Actor, Person } from "@fedify/vocab";
import { ARCHETYPE_IDS, FUN_FACT_IDS } from "../src/stats.ts";
import {
  assertSameKeys,
  buildCatalogue,
  CAMPAIGN_TAG,
  catalogues,
  loadLocale,
  type RawLocale,
} from "../src/strings.ts";

// locales/*.json is edited by non-programmers and not type checked, so these tests check
// what types would, using the same functions that run at boot.
const de = loadLocale("de");
const en = loadLocale("en");
const actor = new Person({
  id: new URL("https://example.test/users/alice"),
  preferredUsername: "alice",
});
const session = {
  actorId: new URL("https://bot.test/ap/actor/x"),
  context: { origin: "https://bot.test" },
} as unknown as Parameters<ReturnType<typeof text>["getHtml"]>[0];

async function html(block: ReturnType<typeof text>): Promise<string> {
  let out = "";
  for await (const chunk of block.getHtml(session)) out += chunk;
  return out;
}

describe("locale files", () => {
  it("have the same keys in the same order", () => {
    assertSameKeys("de", de, "en", en);
    assert.deepEqual(Object.keys(de), Object.keys(en));
  });

  it("build without a gap in either language", () => {
    assert.ok(catalogues.de.botName);
    assert.ok(catalogues.en.botName);
  });

  it("name every archetype and fun fact", () => {
    for (const raw of [de, en]) {
      assert.deepEqual(Object.keys(raw.archetype as object), [...ARCHETYPE_IDS]);
      assert.deepEqual(Object.keys(raw.funFact as object), [...FUN_FACT_IDS]);
    }
  });

  it("never put a gendered German noun on a shareable image", () => {
    // The bot cannot know gender; "Die Bildermacherin" would assert one on an immutable
    // image bearing the handle. Neutral nouns or the inclusive *in form only.
    const archetypes = de.archetype as Record<string, { name: string }>;
    for (const [key, value] of Object.entries(archetypes)) {
      const gendered =
        /(^|\s)(Die|Der)\s/.test(value.name) || /erin$|erinnen$/.test(value.name);
      assert.equal(gendered, false, `de.archetype.${key} = "${value.name}" reads as gendered`);
    }
  });
});

describe("templates", () => {
  it("keep the mention on every reply, so a direct message reaches someone", async () => {
    for (const [locale, raw] of [
      ["de", de],
      ["en", en],
    ] as const) {
      const catalogue = catalogues[locale] as unknown as Record<string, unknown>;
      const replies = Object.entries(raw).filter(
        ([, value]) => typeof value === "string" && value.includes("{u}"),
      );
      assert.ok(replies.length >= 15, `${locale}: expected the reply keys to use {u}`);
      for (const [key] of replies) {
        const fn = catalogue[key];
        assert.equal(typeof fn, "function", `${locale}.${key}`);
        const block = (fn as (...args: unknown[]) => ReturnType<typeof text>)(
          actor,
          "x",
          text`tail`,
        );
        assert.ok(
          block.getCachedObjects().includes(actor),
          `${locale}.${key} lost the mention`,
        );
      }
    }
  });

  it("render paragraphs and escape values exactly like a template literal", async () => {
    // A string stands in for the actor: a real one would make BotKit look up
    // its handle over the network, and escaping is what this test is about.
    const fakeActor = "<a>" as unknown as Actor;
    const tail = text`TAIL`;
    const fromJson = await html(catalogues.en.secondPost(fakeActor, tail));
    const literal = await html(text`${fakeActor} …and part two 📸

${tail}`);
    assert.equal(fromJson, literal);
    assert.match(fromJson, /^<p>&lt;a&gt; …and part two 📸<\/p><p>TAIL<\/p>$/);
  });

  it("carry the campaign hashtag as a real tag", async () => {
    const rendered = await html(catalogues.de.shareTail());
    assert.match(rendered, /class="mention hashtag"/);
    assert.match(rendered, /#<span>FediverseWrapped<\/span>/);
  });

  it("put the campaign hashtag in the profile as a real tag", async () => {
    for (const locale of ["de", "en"] as const) {
      const summary = catalogues[locale].botSummary(
        "@sibling@example.com",
        link("contact", "https://example.test/contact"),
        link("FedWerk", "https://example.test/fedwerk"),
        hashtag(CAMPAIGN_TAG),
      );
      assert.match(await html(summary), /#<span>FediverseWrapped<\/span>/, locale);
    }
  });

  it("choose the plural form and the number format per language", () => {
    assert.equal(catalogues.de.dayValue(1), "1 Tag");
    assert.equal(catalogues.de.dayValue(3), "3 Tage");
    assert.equal(catalogues.en.pagesValue(1), "1 page");
    assert.equal(catalogues.en.pagesValue(0), "0 pages");
    assert.equal(catalogues.de.pagesValue(1234), "1.234 Seiten");
    assert.equal(
      catalogues.en.funFact.longPost(12345),
      "Your longest post ran to 12,345 characters.",
    );
  });

  it("treat apostrophes as text and only a quoted brace as a literal brace", () => {
    const raw = { ...de, timesIn: "it's '{'literal'}' in {timeZone}" } as RawLocale;
    assert.equal(buildCatalogue("de", raw).timesIn("UTC"), "it's {literal} in UTC");
  });

  it("substitute a placeholder every time it appears", () => {
    assert.equal(catalogues.en.timesIn("Europe/Vienna"), "Times in Europe/Vienna");
    assert.equal(catalogues.de.altIntro("Kachel", "@a@b"), "Fediverse Wrapped, Kachel, @a@b:");
    assert.equal(catalogues.en.funFact.altTextRate(87), "87% of your images had alt text.");
  });
});

describe("a broken locale file stops the bot", () => {
  const build = (patch: Record<string, unknown>) => () =>
    buildCatalogue("de", { ...de, ...patch } as RawLocale);

  it("on an unknown placeholder", () => {
    assert.throws(build({ outboxNotPublished: "{u} läuft mit {sofware}" }), /\{sofware\}/);
  });

  it("on a reply that dropped its mention", () => {
    assert.throws(build({ noPostsEver: "keine Beiträge gefunden" }), /must contain \{u\}/);
  });

  it("on broken ICU syntax", () => {
    assert.throws(
      build({ dayValue: "{n, plural, one {# Tag}" }),
      /"dayValue" is not valid ICU/,
    );
  });

  it("on a missing, empty or misspelt key", () => {
    const { labelPosts: _dropped, ...without } = de;
    assert.throws(() => buildCatalogue("de", without), /"labelPosts"/);
    assert.throws(build({ labelPosts: "  " }), /"labelPosts"/);
    assert.throws(build({ labelPost: "📝 Beiträge" }), /"labelPost" is not a key/);
  });

  it("on an archetype or fun fact the code does not know", () => {
    const archetype = { ...(de.archetype as object), nightowl: { name: "x", line: "y" } };
    assert.throws(build({ archetype }), /"archetype\.nightowl"/);
    const { regular: _gone, ...fewer } = de.archetype as Record<string, unknown>;
    assert.throws(build({ archetype: fewer }), /"archetype\.regular" is missing/);
  });

  it("when the two files drift apart", () => {
    const reordered = Object.fromEntries(Object.entries(en).reverse());
    assert.throws(() => assertSameKeys("de", de, "en", reordered), /disagree at #1/);
  });
});
