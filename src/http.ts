// The only place untrusted input reaches a response. Six routes of our own; the rest is
// BotKit's, whose HTML pages pages.ts rewrites on the way out.

import { readFile } from "node:fs/promises";
import { getLogger } from "@logtape/logtape";
import { AVATAR_PATH, AVATAR_PNG } from "./avatar.ts";
import { cfg } from "./config.ts";
import type { Db } from "./db.ts";
import { LOGO_PATH, LOGO_SVG } from "./footer.ts";
import { rewritePage } from "./pages.ts";

const logger = getLogger(["wrapped", "http"]);

/** Lower-case hex only, exact group lengths: no traversal. */
const IMAGE_PATH = /^\/i\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.png$/;

const CANONICAL = new URL(cfg.origin);

// Pins the request URL to ORIGIN: BotKit derives every URI from it, and a proxy without
// X-Forwarded-Proto would make the identity permanently http://. hostAllowed() ran first.
async function canonicalise(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (url.protocol === CANONICAL.protocol && url.host === CANONICAL.host) return request;
  url.protocol = CANONICAL.protocol;
  url.host = CANONICAL.host;
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return new Request(url, init);
}

// ORIGIN's host only, from X-Forwarded-Host or the URL, compared raw: a comma list is
// rejected, never split. A forwarded plain http request is rejected too.
function hostAllowed(request: Request): boolean {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = (forwardedHost ?? new URL(request.url).host).toLowerCase();
  if (host.includes(",")) return false;
  if (host !== cfg.canonicalHost) return false;
  const proto = request.headers.get("x-forwarded-proto");
  if (proto != null && proto.toLowerCase() !== "https") return false;
  return true;
}

export function createFetchHandler(
  db: Db,
  federationFetch: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Before the host check: the probe hits 127.0.0.1. Never tie it to queue depth, since
    // Coolify gates deploys on health and a restart loses queued work.
    if (url.pathname === "/healthz") {
      try {
        await db.ping();
        return new Response("ok\n", { headers: { "content-type": "text/plain" } });
      } catch (error) {
        logger.error("health check failed: {error}", { error });
        return new Response("db unavailable\n", { status: 503 });
      }
    }

    if (!hostAllowed(request)) {
      return new Response("misdirected request\n", { status: 421 });
    }

    // AGPL section 13: network users must be able to get the source.
    if (url.pathname === "/source") {
      return Response.redirect(cfg.sourceUrl, 302);
    }
    if (url.pathname === "/privacy") {
      return Response.redirect(`${cfg.sourceUrl}/blob/main/PRIVACY.md`, 302);
    }

    if (url.pathname === LOGO_PATH) {
      return new Response(new Uint8Array(LOGO_SVG), {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }

    if (url.pathname === AVATAR_PATH) {
      return new Response(new Uint8Array(AVATAR_PNG), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }

    const match = IMAGE_PATH.exec(url.pathname);
    if (match?.[1] != null) {
      const id = match[1];
      if (!(await db.imageExists(id))) return new Response("not found\n", { status: 404 });
      try {
        const png = await readFile(`${cfg.imageDir}/${id}.png`);
        return new Response(new Uint8Array(png), {
          headers: {
            "content-type": "image/png",
            // The id is the only secret guarding a DM-requested wrapped, like Mastodon media.
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "x-robots-tag": "noindex",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      } catch {
        return new Response("not found\n", { status: 404 });
      }
    }

    const response = await federationFetch(await canonicalise(request));
    return await rewritePage(response, url.pathname, request.method);
  };
}
