import "./env.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { testDb } from "./helpers.ts";

const dir = mkdtempSync(`${tmpdir()}/wrapped-http-`);
process.env.DATA_DIR = dir;

const { cfg } = await import("../src/config.ts");
const { createFetchHandler } = await import("../src/http.ts");

// main.ts creates this at boot; the handler only reads from it.
mkdirSync(cfg.imageDir, { recursive: true });

const db = await testDb();
let federationCalls = 0;
const handler = createFetchHandler(db, async () => {
  federationCalls++;
  return new Response("federation", { status: 200 });
});

const HOST = cfg.canonicalHost;
const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`https://${HOST}${path}`, { headers }));

describe("health", () => {
  it("answers before the host check, because the probe uses 127.0.0.1", async () => {
    const response = await handler(new Request("http://127.0.0.1:8000/healthz"));
    assert.equal(response.status, 200);
  });
});

describe("host pinning", () => {
  // One name only; behind the proxy it arrives in X-Forwarded-Host.
  it("accepts the canonical host", async () => {
    const response = await get("/anything", { "x-forwarded-host": HOST });
    assert.equal(response.status, 200);
  });

  it("is case-insensitive about the host", async () => {
    const response = await get("/anything", { "x-forwarded-host": HOST.toUpperCase() });
    assert.equal(response.status, 200);
  });

  it("rejects a foreign host", async () => {
    const response = await get("/anything", { "x-forwarded-host": "evil.example" });
    assert.equal(response.status, 421);
  });

  it("rejects ANY comma rather than splitting the header", async () => {
    // x-forwarded-fetch puts the raw value into url.host, which accepts "a,b", so checking
    // only the first element would validate something other than what BotKit uses.
    for (const value of [`${HOST},evil.example`, `evil.example,${HOST}`, `${HOST}, ${HOST}`]) {
      const response = await get("/anything", { "x-forwarded-host": value });
      assert.equal(response.status, 421, `must reject ${value}`);
    }
  });

  it("rejects a downgrade to http", async () => {
    const response = await get("/anything", {
      "x-forwarded-host": HOST,
      "x-forwarded-proto": "http",
    });
    assert.equal(response.status, 421);
  });
});

describe("image route", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("serves a recorded image with no-index and no-sniff headers", async () => {
    writeFileSync(`${cfg.imageDir}/${id}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await db.recordImage(id, "hash", Date.now());
    const response = await get(`/i/${id}.png`, { "x-forwarded-host": HOST });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("404s an id that is not in the index", async () => {
    const response = await get("/i/ffffffff-ffff-ffff-ffff-ffffffffffff.png", {
      "x-forwarded-host": HOST,
    });
    assert.equal(response.status, 404);
  });

  it("refuses anything that is not exactly a lower-case uuid", async () => {
    const bad = [
      "/i/../../etc/passwd.png",
      `/i/${id.toUpperCase()}.png`,
      "/i/1111.png",
      `/i/${id}.png/extra`,
      `/i/${id}.PNG`,
    ];
    for (const path of bad) {
      const before = federationCalls;
      const response = await get(path, { "x-forwarded-host": HOST });
      // A 404 from us or a pass to BotKit is fine; a read outside the image dir never is.
      assert.ok(response.status === 404 || federationCalls === before + 1, `leaked on ${path}`);
    }
  });
});

describe("origin pinning", () => {
  it("rewrites an http request onto the configured https origin", async () => {
    // A tunnel or proxy may omit X-Forwarded-Proto; BotKit would then mint http:// actor
    // URIs, which remote servers refuse and which can never change after federating.
    let seen: string | null = null;
    const pinned = createFetchHandler(db, async (request) => {
      seen = request.url;
      return new Response("ok");
    });
    await pinned(new Request(`http://${HOST}/ap/actor/fediwrapped_de`));
    assert.equal(seen, `${cfg.origin}/ap/actor/fediwrapped_de`);
  });

  it("preserves the body of a POST while rewriting the origin", async () => {
    let body: string | null = null;
    const pinned = createFetchHandler(db, async (request) => {
      body = await request.text();
      return new Response("ok");
    });
    await pinned(
      new Request(`http://${HOST}/ap/actor/fediwrapped_de/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: '{"type":"Create"}',
      }),
    );
    assert.equal(body, '{"type":"Create"}');
  });
});

describe("source route", () => {
  it("redirects to the repository, satisfying AGPL section 13", async () => {
    const response = await get("/source", { "x-forwarded-host": HOST });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), cfg.sourceUrl);
  });
});

describe("footer", () => {
  const page = "<html><body><main>bot</main></body></html>";
  const paged = createFetchHandler(
    db,
    async () => new Response(page, { headers: { "content-type": "text/html; charset=UTF-8" } }),
  );
  const fetchPage = async (path: string, method = "GET") =>
    await (await paged(new Request(`https://${HOST}${path}`, { method }))).text();
  const [de, en] = cfg.bots;

  it("puts the FedWerk footer in front of </body>", async () => {
    const html = await fetchPage("/");
    assert.match(html, /<\/main><footer class="fw-footer" lang="de">.*<\/script><\/body>/);
    assert.match(html, /href="https:\/\/fedw\.eu\/de\/"/);
    assert.match(
      html,
      /Fragen oder Probleme\? <a href="https:\/\/hachyderm\.io\/@sabrinkmann">/,
    );
  });

  it("speaks the language of the bot whose page it is", async () => {
    assert.match(await fetchPage(`/@${de!.username}`), /lang="de"/);
    const html = await fetchPage(`/@${en!.username}/feed`);
    assert.match(html, /<footer class="fw-footer" lang="en">/);
    assert.match(html, /href="https:\/\/fedw\.eu\/en\/"/);
    assert.match(html, /Questions or problems\?/);
  });

  it("never claims the linked accounts as the bot's identity", async () => {
    assert.doesNotMatch(await fetchPage("/"), /rel="me"/);
  });

  it("leaves anything that is not an HTML page alone", async () => {
    const response = await get("/ap/actor/fediwrapped_de", { "x-forwarded-host": HOST });
    assert.equal(await response.text(), "federation");
    assert.doesNotMatch(await fetchPage("/", "HEAD"), /fw-footer/);
  });

  it("serves the logo itself instead of hotlinking it", async () => {
    const response = await get("/fedwerk.svg", { "x-forwarded-host": HOST });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(await response.text(), /<svg/);
  });
});

describe("atom feed", () => {
  // BotKit 0.5 links its always-on feed from every profile; the feed stays, the links go.
  const profile =
    '<html><head><link rel="alternate" type="application/atom+xml" href="https://x/@a/feed.xml" title="Atom feed"/></head>' +
    '<body><a class="bk-feed-link" href="/@a/feed.xml" rel="alternate" type="application/atom+xml"><svg><path/></svg></a><b>2</b></body></html>';
  const botkit = createFetchHandler(
    db,
    async () =>
      new Response(profile, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          link: '<https://x/ap/actor/a>; rel="alternate"; type="application/activity+json", <https://x/@a/feed.xml>; rel="alternate"; type="application/atom+xml"',
        },
      }),
  );
  const fetchPage = (path: string, method = "GET") =>
    botkit(new Request(`https://${HOST}${path}`, { method }));

  it("is still served as BotKit renders it", async () => {
    const feed = createFetchHandler(
      db,
      async () =>
        new Response("<feed/>", { headers: { "content-type": "application/atom+xml" } }),
    );
    const response = await feed(new Request(`https://${HOST}/@fediwrapped_de/feed.xml`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<feed/>");
  });

  it("is not linked from the page or its headers", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetchPage("/@a", method);
      assert.equal(
        response.headers.get("link"),
        '<https://x/ap/actor/a>; rel="alternate"; type="application/activity+json"',
      );
    }
    const html = await (await fetchPage("/@a")).text();
    assert.doesNotMatch(html, /atom|feed\.xml|bk-feed-link/);
    assert.match(html, /<b>2<\/b><footer/);
  });
});
