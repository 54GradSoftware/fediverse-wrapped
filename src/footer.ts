// The fedw.eu footer under every BotKit page: BotKit has no chrome hook, so CSS goes via
// `pages.css` and pages.ts splices the markup before `</body>`. No rel="me" (not one identity).

import { readFileSync } from "node:fs";
import { cfg, type Locale } from "./config.ts";
import { catalogueFor } from "./strings.ts";
import { fill, readHtmlTemplate, readTemplate } from "./templates.ts";

/** Served by us, not hotlinked: a bot page makes no third-party requests. */
export const LOGO_PATH = "/fedwerk.svg";
export const LOGO_SVG = readFileSync(new URL("../static/fedwerk.svg", import.meta.url));

// Colours are fedw.eu's, fixed in dark mode too. Negative margins cancel body.bk-page's
// padding to run edge to edge; the values mirror botkit.css.
export const FOOTER_CSS = readTemplate("footer.css");

/** Where questions and problems go; also named in each bot's description. */
export const QUESTIONS_URL = "https://hachyderm.io/@sabrinkmann";
export const QUESTIONS_HANDLE = "@sabrinkmann@hachyderm.io";

/** The operator's own account; also the "Betrieben von" field on each bot. */
export const OPERATOR_URL = "https://norden.social/@54gradsoftware";
export const OPERATOR_HANDLE = "@54gradsoftware@norden.social";

export const fedwerkUrl = (locale: Locale): string => `https://fedw.eu/${locale}/`;
const FALLBACK_IMPRINT = "https://54gradsoftware.de/impressum";

/** A bot's own pages follow its language; the roster and the rest are German. */
function localeOfPage(pathname: string): Locale {
  for (const bot of cfg.bots) {
    const base = `/@${bot.handle}`;
    if (pathname === base || pathname.startsWith(`${base}/`)) return bot.locale;
  }
  return "de";
}

// As on fedw.eu, the mail address is assembled in the browser: people read "[ät]",
// screen readers and scrapers get only the word.
const FOOTER_HTML = readHtmlTemplate("footer.html");
const LANGUAGE_HTML = readHtmlTemplate("footer-language.html");

function render(locale: Locale): string {
  const catalogue = catalogueFor(locale);
  const home = fedwerkUrl(locale);
  const languages = cfg.bots
    .map((bot) =>
      fill(LANGUAGE_HTML, {
        username: bot.handle,
        locale: bot.locale,
        label: catalogueFor(bot.locale).propLanguageValue,
      }),
    )
    .join(" · ");
  return fill(FOOTER_HTML, {
    locale,
    home,
    logoPath: LOGO_PATH,
    projectOf: catalogue.pageProjectOf,
    mailAt: catalogue.pageMailAt,
    mailDot: catalogue.pageMailDot,
    operatorUrl: OPERATOR_URL,
    operatorHandle: OPERATOR_HANDLE,
    questions: catalogue.pageQuestions,
    questionsUrl: QUESTIONS_URL,
    questionsHandle: QUESTIONS_HANDLE,
    imprintUrl: cfg.imprintUrl === "" ? FALLBACK_IMPRINT : cfg.imprintUrl,
    imprint: catalogue.propImprint,
    privacy: catalogue.propPrivacy,
    languages,
  });
}

/** Rendered once per language at boot; nothing in it depends on the request. */
const FOOTERS: Readonly<Record<Locale, string>> = { de: render("de"), en: render("en") };

export const footerFor = (pathname: string): string => FOOTERS[localeOfPage(pathname)];
