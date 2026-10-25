// Asks a server which software it runs, only after a walk found no posts, so a Pixelfed or
// Lemmy user hears the real reason. Fedify's NodeInfo client refuses private addresses.

import { getNodeInfo } from "@fedify/fedify/nodeinfo";

// Software whose posts are missing from the outbox, measured live (see README.md). Keys are
// lowercased NodeInfo `software.name` values; values are the names used in replies.
export const WITHOUT_OUTBOX: Readonly<Record<string, string>> = {
  pixelfed: "Pixelfed",
  loops: "Loops",
  gotosocial: "GoToSocial",
  lemmy: "Lemmy",
  piefed: "PieFed",
  wordpress: "WordPress",
  wafrn: "wafrn",
};

type Lookup = (
  origin: string,
  userAgent: string,
) => Promise<{ software?: { name?: string } } | undefined>;

const viaFedify: Lookup = (origin, userAgent) =>
  getNodeInfo(origin, { parse: "best-effort", userAgent });

/** The lowercased NodeInfo `software.name` of `origin`, or null when unknown. */
export async function softwareOf(
  origin: string,
  userAgent: string,
  lookup: Lookup = viaFedify,
): Promise<string | null> {
  try {
    const name = (await lookup(origin, userAgent))?.software?.name;
    return typeof name === "string" && name.trim() !== "" ? name.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}
