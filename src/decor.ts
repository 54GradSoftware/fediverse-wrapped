// Placement for the hashtag cloud. Pure, so a tile renders the same every time. The cloud
// only goes where no text is (WCAG 1.4.3): every text box is estimated up front, padded, and
// kept clear.

export type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export function overlaps(one: Box, other: Box, padding = 0): boolean {
  return (
    one.left < other.right + padding &&
    other.left < one.right + padding &&
    one.top < other.bottom + padding &&
    other.top < one.bottom + padding
  );
}

function inside(box: Box, area: Box): boolean {
  return (
    box.left >= area.left &&
    box.right <= area.right &&
    box.top >= area.top &&
    box.bottom <= area.bottom
  );
}

// No font metrics in resvg's JS API, so widths are estimated per grapheme, a little wide on
// purpose: an estimate that errs large keeps decoration further from the text, never closer.
const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function textWidth(value: string, size: number, bold: boolean): number {
  let width = 0;
  for (const { segment } of segmenter.segment(value)) {
    width += size * (WIDE.test(segment) ? 1.05 : bold ? 0.66 : 0.6);
  }
  return width;
}

/** The box a single-line `<text>` covers, from its baseline and anchor. */
export function textBox(
  left: number,
  baseline: number,
  value: string,
  size: number,
  bold: boolean,
  anchor: "start" | "end" | "middle",
): Box {
  const width = textWidth(value, size, bold);
  const start = anchor === "start" ? left : anchor === "end" ? left - width : left - width / 2;
  return {
    left: start,
    top: baseline - size * 0.82,
    right: start + width,
    bottom: baseline + size * 0.26,
  };
}

export type CloudWord = {
  readonly text: string;
  readonly size: number;
  /** 0 for the rarest word in the cloud, 1 for the most used. */
  readonly weight: number;
  readonly left: number;
  readonly baseline: number;
  readonly box: Box;
};

/** Spiral placement from the centre; a word that finds no free spot is left out. */
export function layoutCloud(
  words: readonly { readonly text: string; readonly count: number }[],
  keepClear: readonly Box[],
  area: Box,
): CloudWord[] {
  const placed: CloudWord[] = [];
  const max = Math.max(1, ...words.map((word) => word.count));
  const min = Math.min(max, ...words.map((word) => word.count));
  const centreX = (area.left + area.right) / 2;
  const centreY = (area.top + area.bottom) / 2;
  for (const word of words) {
    const size = Math.round(28 + 68 * Math.sqrt(word.count / max));
    const weight = max === min ? 1 : (word.count - min) / (max - min);
    // Measured once at the origin; the spiral only moves it.
    const shape = textBox(0, 0, word.text, size, true, "start");
    for (let step = 0; step < 2400; step++) {
      const angle = step * 0.37;
      const radius = step * 0.45;
      const left = centreX + radius * Math.cos(angle) - shape.right / 2;
      const baseline = centreY + radius * Math.sin(angle) * 0.9;
      const box = {
        left,
        top: baseline + shape.top,
        right: left + shape.right,
        bottom: baseline + shape.bottom,
      };
      if (!inside(box, area)) continue;
      if (keepClear.some((other) => overlaps(box, other, 14))) continue;
      if (placed.some((other) => overlaps(box, other.box, 10))) continue;
      placed.push({ text: word.text, size, weight, left, baseline, box });
      break;
    }
  }
  return placed;
}
