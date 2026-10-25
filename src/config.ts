// Every env var, validated once at boot into one frozen object; our own rules are plain
// validator functions in the @adonisjs/env schema. A bad value stops boot before federating.

import { fileURLToPath } from "node:url";
import { Env, errors } from "@adonisjs/env";

export type Locale = "de" | "en";
type Validator<Value> = (key: string, value?: string) => Value;

export function assertTimeZone(name: string, zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`${name} is not a valid IANA time zone: ${zone}`);
  }
  return zone;
}

const timeZone =
  (fallback: string): Validator<string> =>
  (key, value) =>
    assertTimeZone(key, value?.trim() || fallback);

/** A bot identifier is part of every actor URI and can never change. */
const identifier =
  (fallback: string): Validator<string> =>
  (key, value) => {
    const id = value?.trim() || fallback;
    if (!/^[a-z0-9_]{1,32}$/.test(id)) {
      throw new Error(`${key} must match /^[a-z0-9_]{1,32}$/, got: ${id}`);
    }
    return id;
  };

const int =
  (fallback: number, min: number, max: number): Validator<number> =>
  (key, value) => {
    const raw = value?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}, got: ${raw}`);
    }
    return parsed;
  };

const optionalText =
  (fallback = ""): Validator<string> =>
  (_key, value) =>
    value?.trim() || fallback;

const LEVELS = ["debug", "info", "warning", "error"] as const;

const rules = Env.rules({
  ORIGIN: Env.schema.string({ format: "url", protocol: true, tld: false }),
  PORT: int(8000, 1, 65535),

  BOT_DE_ID: identifier("fediwrapped_de"),
  BOT_EN_ID: identifier("fediwrapped_en"),
  BOT_DE_USERNAME: optionalText(),
  BOT_EN_USERNAME: optionalText(),
  BOT_DE_TIMEZONE: timeZone("Europe/Berlin"),
  BOT_EN_TIMEZONE: timeZone("UTC"),

  DATA_DIR: optionalText("./data"),
  // fileURLToPath, not .pathname: pathname stays percent-encoded, so a checkout
  // under "Meine Projekte" would look for "Meine%20Projekte" and find no fonts.
  FONT_DIR: optionalText(fileURLToPath(new URL("../fonts/", import.meta.url))),

  ACTOR_SALT: Env.schema.string(),
  RATE_LIMIT_TZ: timeZone("Europe/Berlin"),

  WORKERS: int(2, 1, 8),
  INBOX_CONCURRENCY: int(2, 1, 16),
  DELIVERY_CONCURRENCY: int(8, 1, 64),

  IMAGE_RETENTION_DAYS: int(180, 1, 3650),
  JOB_RETENTION_DAYS: int(30, 1, 3650),
  LEDGER_RETENTION_DAYS: int(60, 1, 3650),

  IMPRINT_URL: Env.schema.string.optional({ format: "url", protocol: true }),
  SOURCE_URL: Env.schema.string.optional({ format: "url", protocol: true }),

  LOG_LEVEL: Env.schema.enum.optional(LEVELS),
  FEDIFY_LOG_LEVEL: Env.schema.enum.optional(LEVELS),
  LOG_FORMAT: Env.schema.enum.optional(["json", "text"] as const),

  /** README › Testbetrieb: only DMs from accounts the bots follow, as "Closed Beta". */
  TESTING_MODE: Env.schema.boolean.optional(),
});

function validated(): ReturnType<typeof rules.validate> {
  try {
    return rules.validate(process.env);
  } catch (error) {
    // The per-variable messages are in `help`; the boot log must show them,
    // not just "validation failed".
    if (error instanceof errors.E_INVALID_ENV_VARIABLES) {
      throw new Error(`${error.message}\n${error.help}`);
    }
    throw error;
  }
}

const env = validated();

const origin = env.ORIGIN.replace(/\/+$/, "");
const originUrl = new URL(origin);
if (originUrl.protocol !== "https:" && originUrl.hostname !== "localhost") {
  throw new Error(`ORIGIN must be https:// (got ${originUrl.protocol}//)`);
}

export type BotConfig = {
  readonly locale: Locale;
  readonly identifier: string;
  readonly username: string;
  readonly timeZone: string;
};

const bots: readonly BotConfig[] = [
  {
    locale: "de",
    identifier: env.BOT_DE_ID,
    username: env.BOT_DE_USERNAME || env.BOT_DE_ID,
    timeZone: env.BOT_DE_TIMEZONE,
  },
  {
    locale: "en",
    identifier: env.BOT_EN_ID,
    username: env.BOT_EN_USERNAME || env.BOT_EN_ID,
    timeZone: env.BOT_EN_TIMEZONE,
  },
];

if (bots[0]?.identifier === bots[1]?.identifier) {
  throw new Error("BOT_DE_ID and BOT_EN_ID must differ");
}
if (bots[0]?.username === bots[1]?.username) {
  throw new Error("BOT_DE_USERNAME and BOT_EN_USERNAME must differ");
}

export const cfg = Object.freeze({
  origin,
  canonicalHost: originUrl.host.toLowerCase(),
  port: env.PORT,

  bots,

  appDbPath: `${env.DATA_DIR}/app.db`,
  botDbPath: `${env.DATA_DIR}/botkit.db`,
  imageDir: `${env.DATA_DIR}/img`,
  fontDir: env.FONT_DIR,

  actorSalt: env.ACTOR_SALT,
  rateLimitTimeZone: env.RATE_LIMIT_TZ,

  workers: env.WORKERS,
  inboxConcurrency: env.INBOX_CONCURRENCY,
  deliveryConcurrency: env.DELIVERY_CONCURRENCY,

  imageRetentionDays: env.IMAGE_RETENTION_DAYS,
  jobRetentionDays: env.JOB_RETENTION_DAYS,
  ledgerRetentionDays: env.LEDGER_RETENTION_DAYS,

  imprintUrl: env.IMPRINT_URL ?? "",
  sourceUrl: env.SOURCE_URL ?? "https://github.com/54GradSoftware/fediverse-wrapped",

  logLevel: env.LOG_LEVEL ?? "info",
  fedifyLogLevel: env.FEDIFY_LOG_LEVEL ?? "warning",
  logFormat: env.LOG_FORMAT ?? "json",

  userAgent: "FediverseWrapped/1.0",

  testingMode: env.TESTING_MODE ?? false,
});

export function localeFor(identifier: string): Locale {
  const bot = cfg.bots.find((candidate) => candidate.identifier === identifier);
  if (bot == null) throw new Error(`no bot configured for identifier ${identifier}`);
  return bot.locale;
}
