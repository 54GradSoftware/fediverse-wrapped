// WCAG 2.2 AA for the tiles and the reply, checked from the same layout the picture is drawn
// from, so a colour or position change that breaks a ratio fails here.

import "./env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { link } from "@fedify/botkit";
import { type Box, overlaps } from "../src/decor.ts";
import { catalogues } from "../src/strings.ts";
import {
  ACCENT,
  BAR_REST_OPACITY,
  boxOf,
  buildTiles,
  INK,
  INK_MUTED,
  INK_SOFT,
  layoutTile,
  renderAlt,
  SURFACE,
  type TileLayout,
} from "../src/tiles.ts";
import { richStats } from "./helpers.ts";

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG 2.x relative luminance. */
function luminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(one: Rgb, other: Rgb): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((left, right) => right - left);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** `top` at `alpha` over an opaque `under`, as the rasteriser blends it. */
function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (index: 0 | 1 | 2) => top[index] * alpha + under[index] * (1 - alpha);
  return [mix(0), mix(1), mix(2)];
}

// Flat, and the cloud never reaches under text or a bar (checked below), so every text and
// bar sits on the bare surface.
const BACKGROUND = rgb(SURFACE);

async function fullSetLayouts(): Promise<{ id: string; layout: TileLayout }[]> {
  const stats = await richStats();
  return buildTiles(stats, "de").map((tile, index) => ({
    id: tile.id,
    layout: layoutTile(tile, stats, index, "de"),
  }));
}

describe("contrast (WCAG 1.4.3, 1.4.6, 1.4.11)", () => {
  it("holds every text to 4.5:1, and the smallest to 7:1, on the surface", async () => {
    // No large-text exemption: a 1080 px tile shows at about 400 px on a phone.
    for (const { id, layout } of await fullSetLayouts()) {
      for (const item of layout.texts) {
        const ratio = contrast(rgb(item.fill), BACKGROUND);
        const needed = item.small ? 7 : 4.5;
        assert.ok(
          ratio >= needed,
          `${id}: "${item.value}" at ${ratio.toFixed(2)}:1, needs ${needed}:1`,
        );
      }
    }
  });

  it("holds every accent, not only the ones this year happens to use", () => {
    for (const [id, accent] of Object.entries(ACCENT)) {
      assert.ok(contrast(rgb(accent), BACKGROUND) >= 4.5, `${id}: accent`);
    }
    assert.ok(contrast(rgb(INK), BACKGROUND) >= 7, "ink");
    assert.ok(contrast(rgb(INK_SOFT), BACKGROUND) >= 7, "soft ink");
    assert.ok(contrast(rgb(INK_MUTED), BACKGROUND) >= 4.5, "muted ink");
  });

  it("keeps every chart bar at 3:1 in every accent, the paler ones included", async () => {
    const rhythm = (await fullSetLayouts()).find((entry) => entry.id === "rhythm")!.layout;
    assert.equal(rhythm.bars.length, 7);
    // The rhythm tile changes accent with the set, so every accent has to carry the bars.
    for (const [id, accent] of Object.entries(ACCENT)) {
      for (const opacity of [1, BAR_REST_OPACITY]) {
        const shown = over(rgb(accent), opacity, BACKGROUND);
        const ratio = contrast(shown, BACKGROUND);
        assert.ok(ratio >= 3, `${id} bar at ${opacity}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
});

describe("decoration never covers content", () => {
  it("keeps cloud words off every text and every bar", async () => {
    let decorated = 0;
    for (const { id, layout } of await fullSetLayouts()) {
      const content: Box[] = [...layout.texts.map(boxOf), ...layout.bars.map((bar) => bar.box)];
      decorated += layout.cloud.length;
      for (const word of layout.cloud) {
        for (const box of content) {
          assert.equal(overlaps(word.box, box), false, `${id}: cloud word over text or a bar`);
        }
      }
    }
    assert.ok(decorated >= 3, "the check above must have something to check");
  });
});

describe("not by colour alone (WCAG 1.4.1)", () => {
  it("writes the busiest day's count above its bar", async () => {
    const rhythm = (await fullSetLayouts()).find((entry) => entry.id === "rhythm")!.layout;
    for (const bar of rhythm.bars.filter((candidate) => candidate.busiest)) {
      const centre = (bar.box.left + bar.box.right) / 2;
      const label = rhythm.texts.find(
        (item) => item.left === Math.round(centre) && item.baseline < bar.box.top,
      );
      assert.ok(label != null && /^\d/.test(label.value), "busiest bar has no count");
    }
  });
});

describe("alt text (WCAG 1.1.1)", () => {
  it("spells out every cloud word the picture places, without emoji", async () => {
    const stats = await richStats();
    for (const locale of ["de", "en"] as const) {
      const topics = buildTiles(stats, locale).find((model) => model.id === "topics")!;
      const { cloud } = layoutTile(topics, stats, 2, locale);
      const alt = renderAlt(topics, stats, locale);
      assert.ok(cloud.length > 0);
      for (const word of cloud) assert.ok(alt.includes(word.text), `${locale}: ${word.text}`);
      assert.equal(/\p{Extended_Pictographic}/u.test(alt), false, locale);
    }
  });

  it("names the top post's numbers in the language of the bot", async () => {
    const stats = await richStats();
    const expected = { de: "Top-Beitrag, Favoriten: 412", en: "Top post, favourites: 412" };
    for (const locale of ["de", "en"] as const) {
      const resonance = buildTiles(stats, locale).find((model) => model.id === "resonance")!;
      assert.ok(renderAlt(resonance, stats, locale).includes(expected[locale]), locale);
    }
  });
});

describe("link purpose (WCAG 2.4.4)", () => {
  it("links the top post with words, never with the bare address", async () => {
    const renderSession = {
      actorId: new URL("https://bot.test/ap/actor/x"),
      context: { origin: "https://bot.test" },
    } as never;
    for (const locale of ["de", "en"] as const) {
      const catalogue = catalogues[locale];
      const url = "https://example.test/@a/7";
      const block = catalogue.topPostLine(link(catalogue.topPostLinkLabel, url));
      let html = "";
      for await (const chunk of block.getHtml(renderSession)) html += chunk;
      const anchor = html.match(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/);
      assert.ok(anchor != null, `${locale}: no link in ${html}`);
      assert.equal(anchor[1], url);
      assert.equal(anchor[2], catalogue.topPostLinkLabel, locale);
    }
  });
});
