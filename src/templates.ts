// Page chrome lives in templates/. `{{name}}` is HTML-escaped, `{{{name}}}` inserts trusted
// markup as is, and a placeholder without a value throws, so a typo fails at boot.

import { readFileSync } from "node:fs";
import { encode } from "html-entities";

const TEMPLATE_DIR = new URL("../templates/", import.meta.url);

const PLACEHOLDER = /\{\{\{\s*(\w+)\s*\}\}\}|\{\{\s*(\w+)\s*\}\}/g;

export const readTemplate = (fileName: string): string =>
  readFileSync(new URL(fileName, TEMPLATE_DIR), "utf8");

// Strips comments and every line break with the indentation after it, so a space that
// matters must sit inside a line, never at its end.
export const readHtmlTemplate = (fileName: string): string =>
  readTemplate(fileName)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*/g, "");

export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_placeholder, rawName?: string, name?: string) => {
    const key = (rawName ?? name)!;
    const value = values[key];
    if (value === undefined) throw new Error(`template has no value for "${key}"`);
    return rawName === undefined ? encode(value) : value;
  });
}
