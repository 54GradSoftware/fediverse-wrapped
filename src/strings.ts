// Copy rules: German uses "du". Never first person, always "the bot" or "der Bot".
// Errors are always the bot's fault. At most one emoji per message

import { readFileSync } from "node:fs";
import { hashtag, text } from "@fedify/botkit";
import type { Text } from "@fedify/botkit/text";
import type { Actor } from "@fedify/vocab";
import { type MessageFormatElement, TYPE } from "@formatjs/icu-messageformat-parser";
import { IntlMessageFormat } from "intl-messageformat";
import type { Locale } from "./config.ts";
import { ARCHETYPE_IDS, type ArchetypeId, FUN_FACT_IDS, type FunFactId } from "./stats.ts";

export type Block = Text<"block", void>;
type Inline = Text<"inline", void>;

/** The campaign hashtag. Public replies and the profile only, never on a direct message. */
export const CAMPAIGN_TAG = "FediverseWrapped";

export type Catalogue = {
  readonly botName: string;
  /** The display name while TESTING_MODE is on. */
  readonly botNameBeta: string;
  readonly botSummary: (
    siblingHandle: string,
    contact: Inline,
    fedwerk: Inline,
    tag: Inline,
  ) => Block;
  readonly propLanguage: string;
  readonly propLanguageValue: string;
  readonly propAlsoIn: string;
  readonly propSource: string;
  readonly propOperator: string;
  readonly propPrivacy: string;
  readonly propImprint: string;

  // --- web page footer ---------------------------------------------------
  readonly pageProjectOf: string;
  readonly pageQuestions: string;
  readonly pageMailAt: string;
  readonly pageMailDot: string;

  // --- reply paths: every one keeps {u}, the real Mention, or a DM reaches nobody ---
  readonly ackQueued: (actor: Actor) => Block;
  readonly success: (actor: Actor, timeZone: string, tail: Block) => Block;
  readonly successStarter: (actor: Actor, tail: Block) => Block;
  readonly dailyLimitOk: (actor: Actor, previous: URL) => Block;
  readonly dailyLimitRetry: (actor: Actor) => Block;
  /** Second mention while the first wrapped is still queued or running. */
  readonly dailyLimitPending: (actor: Actor) => Block;
  readonly noPostsEver: (actor: Actor) => Block;
  readonly noPostsInWindow: (actor: Actor) => Block;
  readonly outboxForbidden: (actor: Actor) => Block;
  readonly outboxNotPublished: (actor: Actor, software: string) => Block;
  readonly outboxGone: (actor: Actor) => Block;
  readonly outboxUnreadable: (actor: Actor) => Block;
  readonly outboxUnavailable: (actor: Actor) => Block;
  readonly rateLimited: (actor: Actor) => Block;
  readonly hostUnavailable: (actor: Actor) => Block;
  readonly internalError: (actor: Actor, contact: Inline) => Block;
  /** Appended to a public success reply. */
  readonly shareTail: () => Block;
  /** Appended to a direct success reply instead of the hashtag. */
  readonly dmTail: () => Block;
  /** Second post when there are eight tiles. */
  readonly secondPost: (actor: Actor, tail: Block) => Block;
  /** Links the top post from the second post, which carries the resonance tile. */
  readonly topPostLine: (link: Inline) => Block;
  /** The link text itself, so a screen reader announces where it goes (WCAG 2.4.4). */
  readonly topPostLinkLabel: string;

  // --- extra lines woven into a success reply -----------------------------
  readonly partialLine: string;
  readonly engagementLine: string;
  readonly tzHintLine: string;

  // --- tiles: every title and row label carries an emoji; values stay emoji-free, so the
  // right column stays calm and numbers line up.
  readonly tileNumbers: string;
  readonly tileRhythm: string;
  readonly tileTopics: string;
  readonly tileType: string;
  readonly tileWords: string;
  readonly tileResonance: string;
  readonly tileMedia: string;
  readonly tileCommunity: string;
  readonly tileStarter: string;

  readonly labelPosts: string;
  readonly labelBoosts: string;
  readonly labelReplies: string;
  readonly labelWithMedia: string;
  readonly labelWithAlt: string;
  readonly labelAltRate: string;
  readonly labelWithCw: string;
  readonly labelLikesReceived: string;
  readonly labelBoostsReceived: string;
  readonly labelAvgLikes: string;
  readonly labelAvgBoosts: string;
  readonly labelBusiestWeekday: string;
  readonly labelBusiestHour: string;
  readonly labelBusiestMonth: string;
  readonly labelStreak: string;
  readonly labelActiveDays: string;
  readonly labelCharacters: string;
  readonly labelWords: string;
  readonly labelBookPages: string;
  readonly labelAvgWords: string;
  readonly labelLongestPost: string;
  readonly labelDistinctHashtags: string;
  readonly labelFollowers: string;
  readonly labelAccountSince: string;
  readonly labelMentioned: string;
  readonly labelFavouriteTag: string;
  readonly labelTopPostLikes: string;
  readonly labelTopPostBoosts: string;

  readonly hourValue: (hour: number) => string;
  readonly dayValue: (days: number) => string;
  readonly pagesValue: (pages: number) => string;
  readonly timesIn: (timeZone: string) => string;
  readonly starterLine: string;
  /** Footer, right: the year the tile covers, "18.09.2025 bis 18.09.2026". */
  readonly dateRange: (from: string, to: string) => string;

  readonly archetype: Readonly<Record<ArchetypeId, { name: string; line: string }>>;
  readonly funFact: Readonly<Record<FunFactId, (value: number) => string>>;

  /** Alt-text scaffolding: "<bot>, <tile>, <handle>: <rows>". */
  readonly altIntro: (tile: string, handle: string) => string;
  /** The faint background cloud, spelled out because its contrast is decorative only. */
  readonly altCloud: (tags: string) => string;
};

/** One locale file as parsed, before any checking. */
export type RawLocale = Readonly<Record<string, unknown>>;

export function loadLocale(locale: Locale): RawLocale {
  const path = new URL(`../locales/${locale}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${locale}.json: expected an object at the top level`);
  return parsed;
}

// Both files need the same keys in the same order, inside `archetype` and `funFact` too,
// so the two can be diffed side by side.
export function assertSameKeys(
  localeA: Locale,
  rawA: RawLocale,
  localeB: Locale,
  rawB: RawLocale,
): void {
  const compare = (path: string, left: unknown, right: unknown) => {
    if (!isRecord(left) || !isRecord(right)) return;
    const keysA = Object.keys(left);
    const keysB = Object.keys(right);
    for (let index = 0; index < Math.max(keysA.length, keysB.length); index++) {
      if (keysA[index] !== keysB[index]) {
        throw new Error(
          `${localeA}.json and ${localeB}.json disagree at ${path}#${index + 1}: "${keysA[index] ?? "(end)"}" vs "${keysB[index] ?? "(end)"}"`,
        );
      }
    }
    for (const key of keysA) compare(`${path}${key}.`, left[key], right[key]);
  };
  compare("", rawA, rawB);
}

/** Every argument name a message uses, plural and select branches included. */
function argumentNames(
  elements: readonly MessageFormatElement[],
  into = new Set<string>(),
): Set<string> {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
    into.add(element.value);
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) argumentNames(option.value, into);
    } else if (element.type === TYPE.tag) {
      argumentNames(element.children, into);
    }
  }
  return into;
}

/** Parses one template at boot and checks it uses exactly the listed names. */
function compile(
  locale: Locale,
  key: string,
  template: string,
  names: readonly string[],
): IntlMessageFormat {
  let message: IntlMessageFormat;
  try {
    message = new IntlMessageFormat(template, locale);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${locale}.json: "${key}" is not valid ICU MessageFormat: ${reason}`);
  }
  const used = argumentNames(message.getAst());
  for (const name of used) {
    if (!names.includes(name)) {
      const allowed =
        names.length === 0 ? "none" : names.map((allowedName) => `{${allowedName}}`).join(" ");
      throw new Error(
        `${locale}.json: "${key}" uses {${name}}; allowed placeholders: ${allowed}`,
      );
    }
  }
  for (const name of names) {
    if (!used.has(name)) throw new Error(`${locale}.json: "${key}" must contain {${name}}`);
  }
  return message;
}

type Values = Record<string, unknown>;

// Feeds BotKit's `text` tag as a literal would: the strings become the template and each
// object part (actor, hashtag, block) an interpolated value.
function renderBlock(message: IntlMessageFormat, values: Values): Block {
  const formatted: unknown = message.format(values as Record<string, never>);
  const literals: string[] = [""];
  const objects: unknown[] = [];
  for (const part of Array.isArray(formatted) ? formatted : [formatted]) {
    if (typeof part === "string") literals[literals.length - 1] += part;
    else {
      objects.push(part);
      literals.push("");
    }
  }
  return text(Object.assign(literals, { raw: [...literals] }), ...objects);
}

function renderLine(message: IntlMessageFormat, values: Values): string {
  const formatted: unknown = message.format(values as Record<string, never>);
  return Array.isArray(formatted) ? formatted.map(String).join("") : String(formatted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads every key and parses every template at boot, never lazily inside a reply. */
export function buildCatalogue(locale: Locale, raw: RawLocale): Catalogue {
  const used = new Set<string>();
  const str = (key: string): string => {
    used.add(key);
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${locale}.json: "${key}" must be a non-empty string`);
    }
    return value;
  };
  const named = (names: readonly string[], args: readonly unknown[]): Values =>
    Object.fromEntries(names.map((name, index) => [name, args[index]]));
  const block = (key: string, ...names: readonly string[]) => {
    const message = compile(locale, key, str(key), names);
    return (...args: unknown[]): Block => renderBlock(message, named(names, args));
  };
  const line = (key: string, ...names: readonly string[]) => {
    const message = compile(locale, key, str(key), names);
    return (...args: unknown[]): string => renderLine(message, named(names, args));
  };
  const table = <Id extends string>(key: string, ids: readonly Id[]): Record<Id, unknown> => {
    used.add(key);
    const value = raw[key];
    if (!isRecord(value)) throw new Error(`${locale}.json: "${key}" must be an object`);
    for (const id of Object.keys(value)) {
      if (!ids.includes(id as Id))
        throw new Error(`${locale}.json: "${key}.${id}" is not a known id`);
    }
    for (const id of ids) {
      if (!(id in value)) throw new Error(`${locale}.json: "${key}.${id}" is missing`);
    }
    return value as Record<Id, unknown>;
  };
  const nonEmpty = (key: string, value: unknown): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${locale}.json: "${key}" must be a non-empty string`);
    }
    return value;
  };

  const shareTail = block("shareTail", "tag");
  const archetypes = table("archetype", ARCHETYPE_IDS);
  const funFacts = table("funFact", FUN_FACT_IDS);

  const catalogue: Catalogue = {
    botName: str("botName"),
    botNameBeta: str("botNameBeta"),
    botSummary: block("botSummary", "siblingHandle", "contact", "fedwerk", "tag"),
    propLanguage: str("propLanguage"),
    propLanguageValue: str("propLanguageValue"),
    propAlsoIn: str("propAlsoIn"),
    propSource: str("propSource"),
    propOperator: str("propOperator"),
    propPrivacy: str("propPrivacy"),
    propImprint: str("propImprint"),
    pageProjectOf: str("pageProjectOf"),
    pageQuestions: str("pageQuestions"),
    pageMailAt: str("pageMailAt"),
    pageMailDot: str("pageMailDot"),

    ackQueued: block("ackQueued", "u"),
    success: block("success", "u", "timeZone", "tail"),
    successStarter: block("successStarter", "u", "tail"),
    dailyLimitOk: block("dailyLimitOk", "u", "previous"),
    dailyLimitRetry: block("dailyLimitRetry", "u"),
    dailyLimitPending: block("dailyLimitPending", "u"),
    noPostsEver: block("noPostsEver", "u"),
    noPostsInWindow: block("noPostsInWindow", "u"),
    outboxForbidden: block("outboxForbidden", "u"),
    outboxNotPublished: block("outboxNotPublished", "u", "software"),
    outboxGone: block("outboxGone", "u"),
    outboxUnreadable: block("outboxUnreadable", "u"),
    outboxUnavailable: block("outboxUnavailable", "u"),
    rateLimited: block("rateLimited", "u"),
    hostUnavailable: block("hostUnavailable", "u"),
    internalError: block("internalError", "u", "contact"),
    shareTail: () => shareTail(hashtag(CAMPAIGN_TAG)),
    dmTail: block("dmTail"),
    secondPost: block("secondPost", "u", "tail"),
    topPostLine: block("topPostLine", "link"),
    topPostLinkLabel: str("topPostLinkLabel"),

    partialLine: str("partialLine"),
    engagementLine: str("engagementLine"),
    tzHintLine: str("tzHintLine"),

    tileNumbers: str("tileNumbers"),
    tileRhythm: str("tileRhythm"),
    tileTopics: str("tileTopics"),
    tileType: str("tileType"),
    tileWords: str("tileWords"),
    tileResonance: str("tileResonance"),
    tileMedia: str("tileMedia"),
    tileCommunity: str("tileCommunity"),
    tileStarter: str("tileStarter"),

    labelPosts: str("labelPosts"),
    labelBoosts: str("labelBoosts"),
    labelReplies: str("labelReplies"),
    labelWithMedia: str("labelWithMedia"),
    labelWithAlt: str("labelWithAlt"),
    labelAltRate: str("labelAltRate"),
    labelWithCw: str("labelWithCw"),
    labelLikesReceived: str("labelLikesReceived"),
    labelBoostsReceived: str("labelBoostsReceived"),
    labelAvgLikes: str("labelAvgLikes"),
    labelAvgBoosts: str("labelAvgBoosts"),
    labelBusiestWeekday: str("labelBusiestWeekday"),
    labelBusiestHour: str("labelBusiestHour"),
    labelBusiestMonth: str("labelBusiestMonth"),
    labelStreak: str("labelStreak"),
    labelActiveDays: str("labelActiveDays"),
    labelCharacters: str("labelCharacters"),
    labelWords: str("labelWords"),
    labelBookPages: str("labelBookPages"),
    labelAvgWords: str("labelAvgWords"),
    labelLongestPost: str("labelLongestPost"),
    labelDistinctHashtags: str("labelDistinctHashtags"),
    labelFollowers: str("labelFollowers"),
    labelAccountSince: str("labelAccountSince"),
    labelMentioned: str("labelMentioned"),
    labelFavouriteTag: str("labelFavouriteTag"),
    labelTopPostLikes: str("labelTopPostLikes"),
    labelTopPostBoosts: str("labelTopPostBoosts"),

    hourValue: line("hourValue", "n"),
    dayValue: line("dayValue", "n"),
    pagesValue: line("pagesValue", "n"),
    timesIn: line("timesIn", "timeZone"),
    starterLine: str("starterLine"),
    dateRange: line("dateRange", "from", "to"),

    archetype: Object.fromEntries(
      ARCHETYPE_IDS.map((id) => {
        const entry = archetypes[id];
        if (!isRecord(entry))
          throw new Error(`${locale}.json: "archetype.${id}" must be an object`);
        return [
          id,
          {
            name: nonEmpty(`archetype.${id}.name`, entry.name),
            line: nonEmpty(`archetype.${id}.line`, entry.line),
          },
        ];
      }),
    ) as Record<ArchetypeId, { name: string; line: string }>,
    funFact: Object.fromEntries(
      FUN_FACT_IDS.map((id) => {
        const message = compile(
          locale,
          `funFact.${id}`,
          nonEmpty(`funFact.${id}`, funFacts[id]),
          ["n"],
        );
        return [id, (value: number) => renderLine(message, { n: value })];
      }),
    ) as Record<FunFactId, (value: number) => string>,

    altIntro: line("altIntro", "tile", "handle"),
    altCloud: line("altCloud", "tags"),
  };

  for (const key of Object.keys(raw)) {
    if (!used.has(key)) throw new Error(`${locale}.json: "${key}" is not a key the bot knows`);
  }
  return catalogue;
}

const rawDe = loadLocale("de");
const rawEn = loadLocale("en");
assertSameKeys("de", rawDe, "en", rawEn);

export const catalogues: Readonly<Record<Locale, Catalogue>> = {
  de: buildCatalogue("de", rawDe),
  en: buildCatalogue("en", rawEn),
};

export function catalogueFor(locale: Locale): Catalogue {
  return catalogues[locale];
}

function buildFormatters(locale: Locale) {
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const decimal = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const monthYear = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const weekdayName = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  const shortDate = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
  /** "2026-03" (as its 1st) or "2026-03-18" at UTC midnight; null if unreadable. */
  const utcDay = (iso: string): Date | null => {
    const at = new Date(`${iso.length === 7 ? `${iso}-01` : iso}T00:00:00Z`);
    return Number.isNaN(at.getTime()) ? null : at;
  };

  return {
    num: (value: number) => (value >= 100_000 ? compact.format(value) : number.format(value)),
    /** One decimal, in the reader's own convention: "5,2" on de, "5.2" on en. */
    dec: (value: number) => decimal.format(value),
    /** "2026-03" or "2026-03-18" -> "März 2026". */
    month: (iso: string) => {
      const at = utcDay(iso);
      return at == null ? iso : monthYear.format(at);
    },
    /** Monday-first index -> localized weekday name. */
    weekday: (index: number) =>
      // 2024-01-01 was a Monday, so index 0 maps onto it directly.
      weekdayName.format(new Date(Date.UTC(2024, 0, 1 + index))),
    /** ISO date -> "18.09.2026" on de, "09/18/2026" on en. */
    date: (iso: string) => {
      const at = utcDay(iso);
      return at == null ? iso : shortDate.format(at);
    },
  };
}

export type Formatters = ReturnType<typeof buildFormatters>;

const FORMATTERS: Readonly<Record<Locale, Formatters>> = {
  de: buildFormatters("de"),
  en: buildFormatters("en"),
};

/** Locale-aware formatters, built once per locale. */
export function formatters(locale: Locale): Formatters {
  return FORMATTERS[locale];
}
