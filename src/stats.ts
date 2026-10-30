// Posts -> tile numbers. Deliberately PURE: no config, clock, I/O or project imports,
// so the test suite runs without booting the bot. Keep it that way.

/** One item read out of a remote outbox, already normalised by src/outbox.ts. */
export type Post = {
  readonly createdAt: Date;
  readonly kind: "post" | "reply" | "boost";
  /** Hashtags in their original display casing, deduplicated within this post. */
  readonly tags: readonly string[];
  /** Mentioned handles, lower-cased, deduplicated within this post. */
  readonly mentions: readonly string[];
  readonly attachments: number;
  readonly attachmentsWithAlt: number;
  readonly hasCw: boolean;
  /** Code points of the plain-text content, counted BEFORE any truncation. */
  readonly chars: number;
  /** Whitespace-separated words of the plain-text content, before truncation. */
  readonly words: number;
  /** null when the server does not publish the count (Misskey, Pleroma, …). */
  readonly likes: number | null;
  readonly shares: number | null;
  /**
   * Same-origin https address of a top-level post with Public in its own `to`, else null.
   * Unlisted posts and replies never get one: a public reply must not widen their reach.
   */
  readonly link: string | null;
};

export type Account = {
  readonly handle: string;
  readonly followers: number | null;
  /** ISO date of the actor's `published`, when the server publishes one. */
  readonly accountSince: string | null;
};

export type Coverage = {
  readonly from: Date;
  readonly to: Date;
  readonly timeZone: string;
  /** True only when the user actually wrote tz=; gates the clock archetypes. */
  readonly tzExplicit: boolean;
};

/** Every archetype the tiles can award; `locales/*.json` must name each one. */
export const ARCHETYPE_IDS = [
  "altTextHero",
  "marathoner",
  "nightOwl",
  "earlyBird",
  "weekendVoice",
  "conversationalist",
  "pictureMaker",
  "hashtagGardener",
  "regular",
] as const;
export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

/** Every fun fact the tiles can show; `locales/*.json` must name each one. */
export const FUN_FACT_IDS = [
  "bookPages",
  "activeDays",
  "altTextRate",
  "boostedMore",
  "longPost",
  "everyOtherDay",
] as const;
export type FunFactId = (typeof FUN_FACT_IDS)[number];

export type Stats = {
  readonly handle: string;
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
  readonly tzExplicit: boolean;
  // True when a budget stopped the walk, so every count is a LOWER BOUND.
  // Known only after the walk, so the caller adds it to computeStats' result.
  readonly partial: boolean;

  readonly posts: number;
  readonly replies: number;
  readonly boosts: number;

  readonly withMedia: number;
  /** Of the posts with media, those whose every attachment had alt text. */
  readonly withAltText: number;
  readonly withCw: number;

  readonly characters: number;
  readonly words: number;
  /** Rounded, 0 when there are no posts, never NaN. */
  readonly avgWordsPerPost: number;
  /** Rounded; 250 words to a page, the figure mastodon-wraps uses. */
  readonly bookPages: number;
  readonly longestPost: number;

  readonly activeDays: number;
  readonly longestStreak: number;
  /** Length 7, index 0 = Monday. */
  readonly postsByWeekday: readonly number[];
  /** Length 24. */
  readonly postsByHour: readonly number[];
  readonly busiestMonth: { readonly key: string; readonly count: number } | null;

  readonly topHashtags: readonly { readonly tag: string; readonly count: number }[];
  /** The same ranking as topHashtags, longer, for the background cloud. */
  readonly cloudHashtags: readonly { readonly tag: string; readonly count: number }[];
  readonly distinctHashtags: number;

  readonly followers: number | null;
  readonly likesReceived: number | null;
  readonly boostsReceived: number | null;
  /** How many posts carried engagement counts. Sums are non-null only when === posts. */
  readonly engagementKnown: number;
  /** The linkable post with the most favourites plus boosts; null unless every count is known. */
  readonly topPost: {
    readonly link: string;
    readonly likes: number;
    readonly shares: number;
  } | null;

  /** A COUNT, never handles: naming third parties in a boostable image is not ours to do. */
  readonly distinctAccountsMentioned: number;
  readonly accountSince: string | null;

  readonly archetype: ArchetypeId;
  readonly funFact: { readonly id: FunFactId; readonly value: number } | null;
};

/** What the archetype and the fun fact are picked from. */
type Counts = Omit<Stats, "archetype" | "funFact" | "partial">;

/** Words to a printed page, as in the sibling web app. */
const WORDS_PER_PAGE = 250;
/** Enough tags to fill the background of the topics tile. */
const CLOUD_HASHTAGS = 30;

function bump<Key>(map: Map<Key, number>, key: Key): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Argmax over a dense array; ties go to the LOWEST index, deterministically. */
export function argmax(counts: readonly number[]): number | null {
  let best = -1;
  let max = 0;
  for (let index = 0; index < counts.length; index++) {
    if (counts[index]! > max) {
      max = counts[index]!;
      best = index;
    }
  }
  return best < 0 ? null : best;
}

/** Longest run of consecutive calendar days that carry at least one post. */
function longestStreakOf(dayKeys: Iterable<string>): number {
  let longest = 0;
  let run = 0;
  let previous: Temporal.PlainDate | null = null;
  // Plain calendar dates, so a DST change in the middle cannot break a run.
  for (const day of [...dayKeys].sort().map((key) => Temporal.PlainDate.from(key))) {
    run = previous?.add({ days: 1 }).equals(day) ? run + 1 : 1;
    previous = day;
    if (run > longest) longest = run;
  }
  return longest;
}

function pickArchetype(counts: Counts): ArchetypeId {
  const busiestWeekday = argmax(counts.postsByWeekday);
  const busiestHour = argmax(counts.postsByHour);
  const altRate = counts.withMedia > 0 ? counts.withAltText / counts.withMedia : 0;

  if (counts.withMedia >= 10 && altRate >= 0.9) return "altTextHero";
  if (counts.longestStreak >= 60) return "marathoner";
  // Clock labels are identity claims on a shareable image: only with an explicit tz=, else
  // "Night Owl" just measures the gap between their zone and our default.
  if (counts.tzExplicit && busiestHour != null && (busiestHour >= 22 || busiestHour < 5)) {
    return "nightOwl";
  }
  if (counts.tzExplicit && busiestHour != null && busiestHour >= 5 && busiestHour < 9) {
    return "earlyBird";
  }
  if (counts.tzExplicit && busiestWeekday != null && busiestWeekday >= 5) return "weekendVoice";
  if (counts.posts > 0 && counts.replies / counts.posts >= 0.6) return "conversationalist";
  if (counts.posts > 0 && counts.withMedia / counts.posts >= 0.4) return "pictureMaker";
  if (counts.distinctHashtags >= 30) return "hashtagGardener";
  return "regular";
}

// First match wins. Every fact is an award, never a scold: an unguarded alt-text rate
// would print "5% of your images had alt text" on someone who was trying.
export function pickFunFact(
  counts: Counts,
  exclude: ReadonlySet<FunFactId> = new Set(),
): { id: FunFactId; value: number } | null {
  const altRate = counts.withMedia > 0 ? counts.withAltText / counts.withMedia : 0;
  if (counts.bookPages >= 10 && !exclude.has("bookPages")) {
    return { id: "bookPages", value: counts.bookPages };
  }
  if (counts.activeDays >= 180) return { id: "activeDays", value: counts.activeDays };
  if (counts.withMedia >= 5 && altRate >= 0.5) {
    return { id: "altTextRate", value: Math.round(altRate * 100) };
  }
  if (
    counts.boostsReceived != null &&
    counts.likesReceived != null &&
    counts.boostsReceived > counts.likesReceived
  ) {
    return { id: "boostedMore", value: counts.boostsReceived };
  }
  if (counts.longestPost >= 1000) return { id: "longPost", value: counts.longestPost };
  if (counts.activeDays >= 120) return { id: "everyOtherDay", value: counts.activeDays };
  return null;
}

export async function computeStats(
  posts: AsyncIterable<Post>,
  account: Account,
  coverage: Coverage,
): Promise<Omit<Stats, "partial">> {
  const postsByWeekday = new Array<number>(7).fill(0);
  const postsByHour = new Array<number>(24).fill(0);
  const days = new Set<string>();
  const months = new Map<string, number>();
  // tagCounts is keyed lower-case so #Fediverse and #fediverse are one tag;
  // tagDisplay remembers the casing the author used most often.
  const tagCounts = new Map<string, number>();
  const tagDisplay = new Map<string, Map<string, number>>();
  const mentioned = new Set<string>();

  let ownPosts = 0;
  let replies = 0;
  let boosts = 0;
  let withMedia = 0;
  let withAltText = 0;
  let withCw = 0;
  let characters = 0;
  let words = 0;
  let longestPost = 0;
  let likesReceived = 0;
  let boostsReceived = 0;
  let engagementKnown = 0;
  let topPost: Stats["topPost"] = null;
  let topPostAt = 0;

  for await (const post of posts) {
    if (post.kind === "boost") {
      boosts++;
      continue;
    }
    ownPosts++;
    if (post.kind === "reply") replies++;

    const local = Temporal.Instant.fromEpochMilliseconds(
      post.createdAt.getTime(),
    ).toZonedDateTimeISO(coverage.timeZone);
    const date = local.toPlainDate();
    days.add(date.toString()); // YYYY-MM-DD
    bump(months, date.toPlainYearMonth().toString()); // YYYY-MM
    postsByHour[local.hour] = (postsByHour[local.hour] ?? 0) + 1;
    // Temporal counts Monday as 1, which makes index 0 Monday.
    const weekday = local.dayOfWeek - 1;
    postsByWeekday[weekday] = (postsByWeekday[weekday] ?? 0) + 1;

    if (post.attachments > 0) {
      withMedia++;
      if (post.attachmentsWithAlt === post.attachments) withAltText++;
    }
    if (post.hasCw) withCw++;

    characters += post.chars;
    words += post.words;
    if (post.chars > longestPost) longestPost = post.chars;

    for (const tag of post.tags) {
      const key = tag.toLowerCase();
      bump(tagCounts, key);
      let casings = tagDisplay.get(key);
      if (casings == null) {
        casings = new Map();
        tagDisplay.set(key, casings);
      }
      bump(casings, tag);
    }
    for (const handle of post.mentions) mentioned.add(handle);

    if (post.likes != null || post.shares != null) {
      engagementKnown++;
      likesReceived += post.likes ?? 0;
      boostsReceived += post.shares ?? 0;
    }

    // Boosts are the reach, so a tie in the sum goes to more boosts, then to the newer post.
    if (post.link != null && post.likes != null && post.shares != null) {
      const score = post.likes + post.shares;
      const at = post.createdAt.getTime();
      const best = topPost == null ? 0 : topPost.likes + topPost.shares;
      const wins =
        topPost == null
          ? score > 0
          : score > best ||
            (score === best &&
              (post.shares > topPost.shares ||
                (post.shares === topPost.shares && at > topPostAt)));
      if (wins) {
        topPost = { link: post.link, likes: post.likes, shares: post.shares };
        topPostAt = at;
      }
    }
  }

  // A sum over SOME posts is not a total, so partial coverage collapses to null
  // and the tile omits the row.
  const fullEngagement = ownPosts > 0 && engagementKnown === ownPosts;

  const rankedHashtags = [...tagCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, CLOUD_HASHTAGS)
    .map(([key, count]) => {
      const casings = tagDisplay.get(key);
      let display = key;
      let best = 0;
      if (casings != null) {
        for (const [text, uses] of casings) {
          if (uses > best) {
            best = uses;
            display = text;
          }
        }
      }
      return { tag: display, count };
    });

  let busiestMonth: Stats["busiestMonth"] = null;
  for (const [key, count] of [...months.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (busiestMonth == null || count > busiestMonth.count) busiestMonth = { key, count };
  }

  const base = {
    handle: account.handle,
    from: coverage.from.toISOString().slice(0, 10),
    to: coverage.to.toISOString().slice(0, 10),
    timeZone: coverage.timeZone,
    tzExplicit: coverage.tzExplicit,

    posts: ownPosts,
    replies,
    boosts,

    withMedia,
    withAltText,
    withCw,

    characters,
    words,
    // An account with only boosts has no own posts; never NaN on a shareable image.
    avgWordsPerPost: ownPosts > 0 ? Math.round(words / ownPosts) : 0,
    bookPages: Math.round(words / WORDS_PER_PAGE),
    longestPost,

    activeDays: days.size,
    longestStreak: longestStreakOf(days),
    postsByWeekday,
    postsByHour,
    busiestMonth,

    topHashtags: rankedHashtags.slice(0, 4),
    cloudHashtags: rankedHashtags,
    distinctHashtags: tagCounts.size,

    // A hidden follower collection publishes no totalItems; 0 would be a wrong claim,
    // so null travels to the tile, which omits the row.
    followers: account.followers,
    likesReceived: fullEngagement ? likesReceived : null,
    boostsReceived: fullEngagement ? boostsReceived : null,
    engagementKnown,
    // Shown only beside complete sums, so the tile and the reply link always agree.
    topPost: fullEngagement ? topPost : null,

    distinctAccountsMentioned: mentioned.size,
    accountSince: account.accountSince,
  } satisfies Counts;

  return { ...base, archetype: pickArchetype(base), funFact: pickFunFact(base) };
}
