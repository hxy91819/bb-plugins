import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComposerDraftSnapshot } from "@get-bb/plugin-sdk/app";
import { removeQuote } from "./draft";

for (const { text, index, expected } of [
  { text: "> first\n\nmy reply", index: 0, expected: "my reply" },
  { text: "my reply\n\n> last\n\n", index: 0, expected: "my reply" },
  {
    text: "> first\n>\n> continuation\n\n> second\n\nmy reply",
    index: 0,
    expected: "> second\n\nmy reply",
  },
  {
    text: "> first\n\n> second\n\nmy reply",
    index: 1,
    expected: "> first\n\nmy reply",
  },
  { text: "before\n\n> quote\n\nafter", index: 0, expected: "before\n\nafter" },
  { text: "> quote\n\n", index: 0, expected: "" },
  { text: ">\n\n", index: 0, expected: "" },
  {
    text: "own > text\n>not a quote",
    index: 0,
    expected: "own > text\n>not a quote",
  },
]) {
  test(`removes quote ${index + 1} from ${JSON.stringify(text)} without losing other text`, () => {
    assert.equal(
      removeQuote({ text, mentions: [], attachments: [] }, index).text,
      expected,
    );
  });
}

test("preserves and rebases mentions around a removed Unicode quote and retains attachment ownership", () => {
  const text = "@before\n\n> 😀 @quoted\n\n@after";
  const draft: ComposerDraftSnapshot = {
    text,
    mentions: [
      { kind: "project", projectId: "p1", label: "before", from: 0, to: 7 },
      { kind: "thread", threadId: "t1", label: "quoted", from: 14, to: 21 },
      { kind: "project", projectId: "p2", label: "after", from: 23, to: 29 },
    ],
    attachments: [
      {
        type: "localFile",
        path: "notes.txt",
        name: "notes.txt",
        sourceProjectId: "original",
      },
    ],
  };
  const removed = removeQuote(draft, 0);
  assert.equal(removed.text, "@before\n\n@after");
  assert.deepEqual(removed.mentions, [
    { kind: "project", projectId: "p1", label: "before", from: 0, to: 7 },
    { kind: "project", projectId: "p2", label: "after", from: 9, to: 15 },
  ]);
  assert.equal(removed.attachments, draft.attachments);
  assert.equal(draft.text, text);
});
