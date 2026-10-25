// BotKit 0.5 has no options for these: add the footer before `</body>`, and unlink the Atom
// feed (still served at feed.xml) from the page head, the profile and the Link header.

import { footerFor } from "./footer.ts";

const ATOM = "application/atom+xml";

const FEED_HEAD_LINK = /<link\b[^>]*type="application\/atom\+xml"[^>]*>/g;
/** The profile's feed icon: an <a> around an <svg>, which holds no </a>. */
const FEED_ICON_LINK = /<a\b[^>]*type="application\/atom\+xml"[^>]*>.*?<\/a>/gs;

/** Drops the atom entry from a Link header and keeps the others as they are. */
function withoutFeed(link: string): string {
  return link
    .split(/,\s*(?=<)/)
    .filter((entry) => !entry.includes(ATOM))
    .join(", ");
}

export async function rewritePage(
  response: Response,
  pathname: string,
  method: string,
): Promise<Response> {
  const link = response.headers.get("link");
  const isPage = response.headers.get("content-type")?.startsWith("text/html") ?? false;
  if (link?.includes(ATOM) !== true && !isPage) return response;

  const headers = new Headers(response.headers);
  if (link != null) {
    const kept = withoutFeed(link);
    if (kept === "") headers.delete("link");
    else headers.set("link", kept);
  }
  // The GET body of a page changes below, so BotKit's length is wrong for HEAD too.
  if (isPage) headers.delete("content-length");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!isPage || method !== "GET" || response.body == null) {
    return new Response(response.body, init);
  }

  let html = (await response.text()).replace(FEED_HEAD_LINK, "").replace(FEED_ICON_LINK, "");
  const at = html.lastIndexOf("</body>");
  if (at !== -1) html = html.slice(0, at) + footerFor(pathname) + html.slice(at);
  return new Response(html, init);
}
