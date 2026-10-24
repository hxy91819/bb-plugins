import type {
  ComposerDraftReplacement,
  ComposerDraftSnapshot,
} from "@get-bb/plugin-sdk/app";

export function quoteRanges(text: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  let offset = 0;
  let current: { from: number; to: number } | null = null;
  for (const line of text.split("\n")) {
    if (line === ">" || line.startsWith("> ")) {
      if (current === null) {
        current = { from: offset, to: offset + line.length };
        ranges.push(current);
      } else {
        current.to = offset + line.length;
      }
    } else {
      current = null;
    }
    offset += line.length + 1;
  }
  return ranges;
}

export function removeQuote(
  draft: ComposerDraftSnapshot,
  index: number,
): ComposerDraftReplacement {
  const range = quoteRanges(draft.text)[index];
  if (!range) return draft;
  let { from, to } = range;
  if (draft.text.slice(to, to + 2) === "\n\n") to += 2;
  else if (draft.text[to] === "\n") to += 1;
  if (to === draft.text.length) {
    if (draft.text.slice(Math.max(0, from - 2), from) === "\n\n") from -= 2;
    else if (draft.text[from - 1] === "\n") from -= 1;
  }
  const removed = to - from;
  return {
    text: draft.text.slice(0, from) + draft.text.slice(to),
    mentions: draft.mentions.flatMap((mention) => {
      if (mention.to <= from) return [mention];
      if (mention.from < to) return [];
      return [
        {
          ...mention,
          from: mention.from - removed,
          to: mention.to - removed,
        },
      ];
    }),
    attachments: draft.attachments,
  };
}
