// Both bots' profile picture: ⁂ above "wrapped". PNG, since Mastodon rejects SVG avatars;
// static/avatar.svg is its source. Everything sits inside the circle, for round crops.

import { readFileSync } from "node:fs";
import { Image } from "@fedify/botkit";
import { cfg } from "./config.ts";

/** Served by us, like the footer logo: remote servers fetch and cache their own copy. */
export const AVATAR_PATH = "/avatar.png";
export const AVATAR_PNG = readFileSync(new URL("../static/avatar.png", import.meta.url));

export const avatar = (): Image =>
  new Image({
    mediaType: "image/png",
    url: new URL(AVATAR_PATH, cfg.origin),
    width: 512,
    height: 512,
  });
