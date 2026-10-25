// Literal SVG with no line wrapping, so every value on a tile is short and length-capped.
// The handle goes in the header, not the footer: it must survive Mastodon's gallery crop.

import { readdirSync } from "node:fs";
import { renderAsync } from "@resvg/resvg-js";
import { encode } from "html-entities";
import type { Locale } from "./config.ts";
import { argmax, pickFunFact, type Stats } from "./stats.ts";
import { type Catalogue, catalogueFor, type Formatters, formatters } from "./strings.ts";

export const SIZE = 1080;
const MARGIN = 80;
const SURFACE = "#0f1115";
const INK = "#ffffff";
const INK_SOFT = "#c6c8cf";
const INK_MUTED = "#8b8f9a";
const HAIRLINE = "#262a33";

const ACCENT = {
  numbers: "#3987e5",
  rhythm: "#1baf7a",
  topics: "#9085e9",
  type: "#eb6834",
} as const;

/** Below this many posts a full four-tile set would be mostly empty rows. */
export const STARTER_THRESHOLD = 10;
/** From this many posts on, all eight tiles ship as two posts of four. */
export const FULL_SET_THRESHOLD = 100;
// Below the full set, this many book pages swaps the words tile in for topics. 40 pages is
// 10,000 words: out of reach for 99 posts of 500 characters, easy for ten long blog posts.
export const WORDS_TILE_PAGES = 40;
/** Mastodon lays out 1 attachment full-bleed and 4 as a clean 2x2. Never 2 or 3. */
export const TILES_PER_POST = 4;

// Vertical geometry in px, shared by buildTiles() and renderSvg() so the alt text can never
// promise a row the picture had to drop.
const FOOTER_RULE_Y = 936;
const FOOTER_TEXT_Y = 982;
const NOTES_BASELINE = 914;
const NOTE_LINE = 30;
const ROW_GAP = 58;
const CHART_BASELINE = 600;
const CHART_LABEL_Y = CHART_BASELINE + 32;
const ROWS_TOP_WITH_CHART = CHART_LABEL_Y + 62;
const ROWS_TOP_PLAIN = 600;

/** Baseline of the first note line, given how many there are. */
function notesTopOf(noteCount: number): number {
  return NOTES_BASELINE - Math.max(0, noteCount - 1) * NOTE_LINE;
}

/** How many rows fit above the notes and the footer. */
export function maxRowsFor(hasChart: boolean, noteCount: number): number {
  const rowsTop = hasChart ? ROWS_TOP_WITH_CHART : ROWS_TOP_PLAIN;
  const rowsBottom = (noteCount > 0 ? notesTopOf(noteCount) - 34 : NOTES_BASELINE) - 0;
  return Math.max(0, Math.floor((rowsBottom - rowsTop) / ROW_GAP) + 1);
}

export type TileRow = { readonly label: string; readonly value: string };

export type TileModel = {
  readonly id: string;
  readonly title: string;
  readonly accent: string;
  readonly hero: { readonly value: string; readonly label: string };
  readonly rows: readonly TileRow[];
  /** Seven Monday-first bars, drawn on the rhythm tile only. */
  readonly chart?: { readonly values: readonly number[]; readonly labels: readonly string[] };
  /** Honest disclosures; a tile can need two at once. */
  readonly notes: readonly string[];
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((segment) => segment.segment);
}

function truncate(value: string, max: number): string {
  const parts = graphemes(value);
  return parts.length <= max ? value : `${parts.slice(0, max - 1).join("")}…`;
}

export const escapeXml = (value: string): string => encode(value, { level: "xml" });

// The only way text gets into the document. Every interpolation is escaped,
// so there is no path from a remote string to raw SVG markup.
function svg(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index++) {
    out += escapeXml(String(values[index])) + (strings[index + 1] ?? "");
  }
  return out;
}

/** Marks a fragment as already-built markup, never remote text. */
function raw(parts: readonly string[]): string {
  return parts.join("");
}

// Fits a handle without font metrics: the username, which identifies the person, is never
// cut; a long domain is shortened from the middle.
export function fitHandle(handle: string): string {
  const at = handle.lastIndexOf("@");
  if (at <= 0) return truncate(handle, 30);
  const user = truncate(handle.slice(0, at), 20);
  const domain = handle.slice(at + 1);
  const parts = graphemes(domain);
  if (parts.length <= 18) return `${user}@${domain}`;
  const head = parts.slice(0, 10).join("");
  const tail = parts.slice(-5).join("");
  return `${user}@${head}…${tail}`;
}

/** Font size by length only, so it is deterministic and testable. */
function heroSize(value: string): number {
  const count = graphemes(value).length;
  if (count <= 4) return 190;
  if (count <= 8) return 140;
  if (count <= 13) return 96;
  if (count <= 20) return 66;
  return 48;
}

// Strips the leading emoji. In a row it is the visual anchor; a hero label sits under a
// 190px number and needs none.
function bare(label: string): string {
  return label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
}

function pushRow(rows: TileRow[], label: string, value: string | null): void {
  if (value != null) rows.push({ label, value });
}

export function buildTiles(stats: Stats, locale: Locale): TileModel[] {
  const catalogue = catalogueFor(locale);
  const format = formatters(locale);
  const notes: string[] = [];
  if (stats.partial) notes.push(catalogue.partialLine);

  // One, four or eight tiles, never a count Mastodon renders as tall crops. Membership never
  // depends on which stats exist, or a tile silently disappears and the alt text lies.
  if (stats.posts < STARTER_THRESHOLD) return [starterTile(stats, catalogue, format, notes)];

  // Blogs (WriteFreely, WordPress, Ghost) federate few, very long posts, so below the full set
  // the words tile replaces topics.
  const fullSet = stats.posts >= FULL_SET_THRESHOLD;
  const showsWords = fullSet || stats.bookPages >= WORDS_TILE_PAGES;
  // The words tile already prints the book pages; the fun fact says something else.
  const funFact = showsWords ? pickFunFact(stats, new Set(["bookPages"])) : stats.funFact;

  const numbers = numbersTile(stats, catalogue, format, notes);
  const rhythm = rhythmTile(stats, catalogue, format, notes);
  const topics = topicsTile(stats, catalogue, format, notes);
  const type = typeTile(stats, catalogue, format, notes, funFact);
  const words = wordsTile(stats, catalogue, format, notes);

  if (!fullSet) return [numbers, rhythm, showsWords ? words : topics, type];

  return [
    numbers,
    rhythm,
    topics,
    type,
    words,
    resonanceTile(stats, catalogue, format, notes),
    mediaTile(stats, catalogue, format, notes),
    communityTile(stats, catalogue, format, notes),
  ];
}

/** Splits the tiles into the posts they will be attached to. */
export function tilePosts<Item>(tiles: readonly Item[]): Item[][] {
  const posts: Item[][] = [];
  for (let index = 0; index < tiles.length; index += TILES_PER_POST) {
    posts.push(tiles.slice(index, index + TILES_PER_POST));
  }
  return posts;
}

function numbersTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const rows: TileRow[] = [];
  pushRow(rows, catalogue.labelBoosts, format.num(stats.boosts));
  pushRow(rows, catalogue.labelReplies, format.num(stats.replies));
  pushRow(rows, catalogue.labelWithMedia, format.num(stats.withMedia));
  pushRow(
    rows,
    catalogue.labelLikesReceived,
    stats.likesReceived == null ? null : format.num(stats.likesReceived),
  );
  pushRow(
    rows,
    catalogue.labelBoostsReceived,
    stats.boostsReceived == null ? null : format.num(stats.boostsReceived),
  );
  if (stats.withCw > 0) pushRow(rows, catalogue.labelWithCw, format.num(stats.withCw));

  const own = [...notes];
  // Tells "this server publishes no counts" apart from "you were never favourited".
  if (stats.engagementKnown < stats.posts) own.push(catalogue.engagementLine);

  const notesOut = own.slice(0, 2);
  return {
    id: "numbers",
    title: catalogue.tileNumbers,
    accent: ACCENT.numbers,
    hero: { value: format.num(stats.posts), label: bare(catalogue.labelPosts) },
    rows: rows.slice(0, maxRowsFor(false, notesOut.length)),
    notes: notesOut,
  };
}

function rhythmTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const busiestWeekday = argmax(stats.postsByWeekday);
  const busiestHour = argmax(stats.postsByHour);
  const rows: TileRow[] = [];
  pushRow(
    rows,
    catalogue.labelBusiestHour,
    busiestHour == null ? null : catalogue.hourValue(busiestHour),
  );
  pushRow(
    rows,
    catalogue.labelBusiestMonth,
    stats.busiestMonth == null ? null : format.month(stats.busiestMonth.key),
  );
  pushRow(rows, catalogue.labelStreak, catalogue.dayValue(stats.longestStreak));
  pushRow(rows, catalogue.labelActiveDays, format.num(stats.activeDays));
  const rhythmNotes = [...notes, catalogue.timesIn(stats.timeZone)].slice(0, 2);

  return {
    id: "rhythm",
    title: catalogue.tileRhythm,
    accent: ACCENT.rhythm,
    hero: {
      // Never empty in practice: this tile needs posts, so some weekday has one.
      value: busiestWeekday == null ? "" : format.weekday(busiestWeekday),
      label: bare(catalogue.labelBusiestWeekday),
    },
    rows: rows.slice(0, maxRowsFor(true, rhythmNotes.length)),
    chart: {
      values: stats.postsByWeekday,
      // Two letters is enough to read a bar chart and always fits.
      labels: stats.postsByWeekday.map((_value, index) =>
        graphemes(format.weekday(index)).slice(0, 2).join(""),
      ),
    },
    // The only tile whose numbers depend on the zone, so the only one that states it.
    notes: rhythmNotes,
  };
}

function topicsTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  // No hashtags still gets a full tile, so the four-up layout never collapses to three.
  if (stats.topHashtags.length === 0) {
    const rows: TileRow[] = [];
    pushRow(rows, catalogue.labelLongestPost, format.num(stats.longestPost));
    pushRow(rows, catalogue.labelWithMedia, format.num(stats.withMedia));
    pushRow(rows, catalogue.labelWithAlt, format.num(stats.withAltText));
    pushRow(rows, catalogue.labelWithCw, format.num(stats.withCw));
    return {
      id: "topics",
      title: catalogue.tileTopics,
      accent: ACCENT.topics,
      hero: { value: format.num(stats.characters), label: bare(catalogue.labelCharacters) },
      rows: rows.slice(0, maxRowsFor(false, Math.min(notes.length, 2))),
      notes: notes.slice(0, 2),
    };
  }

  const [first, ...rest] = stats.topHashtags;
  const rows: TileRow[] = rest.map((tag) => ({
    label: `#${truncate(tag.tag, 22)}`,
    value: `${format.num(tag.count)}×`,
  }));
  pushRow(rows, catalogue.labelDistinctHashtags, format.num(stats.distinctHashtags));

  return {
    id: "topics",
    title: catalogue.tileTopics,
    accent: ACCENT.topics,
    hero: {
      value: `#${truncate(first!.tag, 18)}`,
      label: `${format.num(first!.count)}× · ${bare(catalogue.labelFavouriteTag)}`,
    },
    rows: rows.slice(0, maxRowsFor(false, Math.min(notes.length, 2))),
    notes: notes.slice(0, 2),
  };
}

function typeTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
  funFact: Stats["funFact"],
): TileModel {
  const archetype = catalogue.archetype[stats.archetype];
  const rows: TileRow[] = [];
  pushRow(
    rows,
    catalogue.labelFollowers,
    stats.followers == null ? null : format.num(stats.followers),
  );
  pushRow(
    rows,
    catalogue.labelAccountSince,
    stats.accountSince == null ? null : format.month(stats.accountSince),
  );
  // A count, never handles: naming third parties in a boostable image needs their consent.
  pushRow(rows, catalogue.labelMentioned, format.num(stats.distinctAccountsMentioned));

  const own = [...notes];
  if (funFact != null) own.unshift(catalogue.funFact[funFact.id](funFact.value));
  const notesOut = own.slice(0, 2);

  return {
    id: "type",
    title: catalogue.tileType,
    accent: ACCENT.type,
    hero: { value: archetype.name, label: archetype.line },
    rows: rows.slice(0, maxRowsFor(false, notesOut.length)),
    notes: notesOut,
  };
}

function wordsTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const rows: TileRow[] = [];
  pushRow(rows, catalogue.labelBookPages, catalogue.pagesValue(stats.bookPages));
  pushRow(rows, catalogue.labelAvgWords, format.num(stats.avgWordsPerPost));
  pushRow(rows, catalogue.labelLongestPost, format.num(stats.longestPost));
  pushRow(rows, catalogue.labelCharacters, format.num(stats.characters));
  const notesOut = notes.slice(0, 2);
  return {
    id: "words",
    title: catalogue.tileWords,
    accent: ACCENT.topics,
    hero: { value: format.num(stats.words), label: bare(catalogue.labelWords) },
    rows: rows.slice(0, maxRowsFor(false, notesOut.length)),
    notes: notesOut,
  };
}

// Engagement counts exist on Mastodon and Hollo but not on Misskey or Pleroma,
// so this tile has a second shape rather than a shrinking row list.
function resonanceTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const known = stats.likesReceived != null && stats.boostsReceived != null;
  const rows: TileRow[] = [];
  const notesOut = [...notes];

  if (known) {
    const perPost = (total: number) => format.dec(stats.posts > 0 ? total / stats.posts : 0);
    pushRow(rows, catalogue.labelBoostsReceived, format.num(stats.boostsReceived ?? 0));
    pushRow(rows, catalogue.labelAvgLikes, perPost(stats.likesReceived ?? 0));
    pushRow(rows, catalogue.labelAvgBoosts, perPost(stats.boostsReceived ?? 0));
    pushRow(rows, catalogue.labelReplies, format.num(stats.replies));
  } else {
    notesOut.push(catalogue.engagementLine);
    pushRow(rows, catalogue.labelBoosts, format.num(stats.boosts));
    pushRow(rows, catalogue.labelMentioned, format.num(stats.distinctAccountsMentioned));
    pushRow(rows, catalogue.labelWithMedia, format.num(stats.withMedia));
  }

  const trimmed = notesOut.slice(0, 2);
  return {
    id: "resonance",
    title: catalogue.tileResonance,
    accent: ACCENT.type,
    hero: known
      ? {
          value: format.num(stats.likesReceived ?? 0),
          label: bare(catalogue.labelLikesReceived),
        }
      : { value: format.num(stats.replies), label: bare(catalogue.labelReplies) },
    rows: rows.slice(0, maxRowsFor(false, trimmed.length)),
    notes: trimmed,
  };
}

function mediaTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const rows: TileRow[] = [];
  pushRow(rows, catalogue.labelWithAlt, format.num(stats.withAltText));
  // Only shown once there is enough media for a rate to mean anything. An
  // unguarded "8%" on a shareable image scolds somebody who was trying.
  if (stats.withMedia >= 5) {
    pushRow(
      rows,
      catalogue.labelAltRate,
      `${Math.round((stats.withAltText / stats.withMedia) * 100)}%`,
    );
  }
  pushRow(rows, catalogue.labelWithCw, format.num(stats.withCw));
  pushRow(rows, catalogue.labelPosts, format.num(stats.posts));
  const notesOut = notes.slice(0, 2);
  return {
    id: "media",
    title: catalogue.tileMedia,
    accent: ACCENT.rhythm,
    hero: { value: format.num(stats.withMedia), label: bare(catalogue.labelWithMedia) },
    rows: rows.slice(0, maxRowsFor(false, notesOut.length)),
    notes: notesOut,
  };
}

function communityTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const rows: TileRow[] = [];
  pushRow(rows, catalogue.labelMentioned, format.num(stats.distinctAccountsMentioned));
  pushRow(rows, catalogue.labelReplies, format.num(stats.replies));
  pushRow(rows, catalogue.labelBoosts, format.num(stats.boosts));
  pushRow(
    rows,
    catalogue.labelAccountSince,
    stats.accountSince == null ? null : format.month(stats.accountSince),
  );
  const notesOut = notes.slice(0, 2);
  return {
    id: "community",
    title: catalogue.tileCommunity,
    accent: ACCENT.numbers,
    // A hidden follower collection publishes nothing; fall back rather than claim zero.
    hero:
      stats.followers == null
        ? { value: format.num(stats.replies), label: bare(catalogue.labelReplies) }
        : { value: format.num(stats.followers), label: bare(catalogue.labelFollowers) },
    rows: rows.slice(0, maxRowsFor(false, notesOut.length)),
    notes: notesOut,
  };
}

function starterTile(
  stats: Stats,
  catalogue: Catalogue,
  format: Formatters,
  notes: string[],
): TileModel {
  const rows: TileRow[] = [];
  pushRow(rows, catalogue.labelReplies, format.num(stats.replies));
  pushRow(rows, catalogue.labelBoosts, format.num(stats.boosts));
  pushRow(rows, catalogue.labelWithMedia, format.num(stats.withMedia));
  pushRow(rows, catalogue.labelActiveDays, format.num(stats.activeDays));
  pushRow(
    rows,
    catalogue.labelAccountSince,
    stats.accountSince == null ? null : format.month(stats.accountSince),
  );
  return {
    id: "starter",
    title: catalogue.tileStarter,
    accent: ACCENT.numbers,
    hero: { value: format.num(stats.posts), label: catalogue.labelPosts },
    rows: rows.slice(0, maxRowsFor(false, Math.min(notes.length + 1, 2))),
    // Never a percentage or a comparison: for someone just starting, it reads as an invitation.
    notes: [...notes, catalogue.starterLine].slice(0, 2),
  };
}

/** Walks the same model as the picture, so alt text never omits or invents a row. */
export function renderAlt(tile: TileModel, stats: Stats, locale: Locale): string {
  const catalogue = catalogueFor(locale);
  const parts = [`${tile.hero.value} ${tile.hero.label}`];
  for (const row of tile.rows) parts.push(`${row.label}: ${row.value}`);
  for (const note of tile.notes) parts.push(note);
  const sentence = `${catalogue.altIntro(tile.title, stats.handle)} ${parts.join(", ")}`;
  // Screen readers would announce emojis ("recycling symbol") before every number. Stripping
  // the whole sentence, not per field, keeps any new catalogue emoji out of the alt text.
  return sentence
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,:])/g, "$1")
    .trim();
}

function textNode(
  left: number,
  top: number,
  value: string,
  size: number,
  fill: string,
  options: { bold?: boolean; anchor?: "start" | "end" | "middle" } = {},
): string {
  const weight = options.bold === true ? 700 : 400;
  const anchor = options.anchor ?? "start";
  return svg`<text x="${left}" y="${top}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" xml:space="preserve">${value}</text>`;
}

export function renderSvg(
  tile: TileModel,
  stats: Stats,
  index: number,
  locale: Locale,
): string {
  const catalogue = catalogueFor(locale);
  const right = SIZE - MARGIN;
  const parts: string[] = [];

  parts.push(svg`<rect width="${SIZE}" height="${SIZE}" fill="${SURFACE}"/>`);

  // Header: handle and tile number, so a single boosted image still says whose year it is.
  parts.push(textNode(MARGIN, 108, fitHandle(stats.handle), 34, INK, { bold: true }));
  parts.push(
    textNode(right, 108, `${index + 1} · ${stats.to.slice(0, 4)}`, 30, INK_MUTED, {
      anchor: "end",
    }),
  );
  parts.push(
    svg`<rect x="${MARGIN}" y="140" width="${SIZE - MARGIN * 2}" height="2" fill="${HAIRLINE}"/>`,
  );

  parts.push(
    svg`<rect x="${MARGIN}" y="200" width="14" height="52" rx="7" fill="${tile.accent}"/>`,
  );
  parts.push(textNode(MARGIN + 34, 244, tile.title, 50, INK, { bold: true }));

  const size = heroSize(tile.hero.value);
  parts.push(
    textNode(MARGIN, 300 + size * 0.78, tile.hero.value, size, tile.accent, { bold: true }),
  );
  parts.push(textNode(MARGIN, 300 + size * 0.78 + 56, tile.hero.label, 38, INK_SOFT));

  if (tile.chart != null) {
    const max = Math.max(1, ...tile.chart.values);
    const slot = (SIZE - MARGIN * 2) / 7;
    const barWidth = slot * 0.56;
    const maxHeight = 110;
    for (let index = 0; index < 7; index++) {
      const value = tile.chart.values[index] ?? 0;
      const height = Math.max(3, Math.round((value / max) * maxHeight));
      const left = MARGIN + slot * index + (slot - barWidth) / 2;
      parts.push(
        svg`<rect x="${Math.round(left)}" y="${CHART_BASELINE - height}" width="${Math.round(barWidth)}" height="${height}" rx="6" fill="${tile.accent}" opacity="${value === max ? 1 : 0.45}"/>`,
      );
      parts.push(
        textNode(
          Math.round(left + barWidth / 2),
          CHART_LABEL_Y,
          tile.chart.labels[index] ?? "",
          26,
          INK_MUTED,
          { anchor: "middle" },
        ),
      );
    }
  }

  // buildTiles() already capped the rows to what fits, so there is no clamping here.
  const rowsTop = tile.chart != null ? ROWS_TOP_WITH_CHART : ROWS_TOP_PLAIN;
  tile.rows.forEach((row, index) => {
    const top = rowsTop + index * ROW_GAP;
    parts.push(textNode(MARGIN, top, truncate(row.label, 32), 36, INK_SOFT));
    parts.push(
      textNode(right, top, truncate(row.value, 20), 36, INK, { bold: true, anchor: "end" }),
    );
  });

  const notesTop = notesTopOf(tile.notes.length);
  tile.notes.forEach((note, index) => {
    parts.push(
      textNode(MARGIN, notesTop + index * NOTE_LINE, truncate(note, 64), 24, INK_MUTED),
    );
  });

  parts.push(
    svg`<rect x="${MARGIN}" y="${FOOTER_RULE_Y}" width="${SIZE - MARGIN * 2}" height="2" fill="${HAIRLINE}"/>`,
  );
  // The window in the reader's own date format; an ISO date reads as a machine artefact.
  const format = formatters(locale);
  parts.push(
    textNode(MARGIN, FOOTER_TEXT_Y, catalogue.footerTitle(stats.to.slice(0, 4)), 28, INK_MUTED),
  );
  parts.push(
    textNode(
      right,
      FOOTER_TEXT_Y,
      catalogue.dateRange(format.date(stats.from), format.date(stats.to)),
      26,
      INK_MUTED,
      {
        anchor: "end",
      },
    ),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${raw(parts)}</svg>`;
}

let fontFiles: string[] | null = null;

// Bundled static TTFs only, never host fonts: resvg 0.34 lacks variable-font support and
// would silently render one weight, flattening the hero-versus-row hierarchy.
function loadFontFiles(dir: string): string[] {
  if (fontFiles == null) {
    fontFiles = readdirSync(dir)
      .filter((name) => /\.(ttf|otf)$/i.test(name))
      .sort()
      .map((name) => `${dir.replace(/\/$/, "")}/${name}`);
  }
  return fontFiles;
}

export type RenderedTile = { png: Buffer; alt: string };

export async function renderTiles(
  stats: Stats,
  locale: Locale,
  fontDir: string,
): Promise<RenderedTile[]> {
  const files = loadFontFiles(fontDir);
  const out: RenderedTile[] = [];
  const tiles = buildTiles(stats, locale);
  for (const [index, tile] of tiles.entries()) {
    const markup = renderSvg(tile, stats, index, locale);
    // renderAsync rasterises on libuv's thread pool; the sync Resvg#render() would block the
    // event loop, stalling inbox deliveries and /healthz while a wrapped renders.
    const rendered = await renderAsync(markup, {
      font: { fontFiles: files, loadSystemFonts: false, defaultFontFamily: "Inter" },
      fitTo: { mode: "width", value: SIZE },
    });
    out.push({ png: Buffer.from(rendered.asPng()), alt: renderAlt(tile, stats, locale) });
  }
  return out;
}
