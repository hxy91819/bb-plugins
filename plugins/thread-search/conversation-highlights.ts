const name = "bb-thread-search";
export const conversationHighlightStyle = `::highlight(${name}) { background-color: color-mix(in oklab, var(--primary) 30%, transparent); }`;

const bodySelector = "[data-thread-search-text]";
const blockSelector = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, div";
const excludedSelector =
  'button, [role="button"], [hidden], [aria-hidden="true"], [contenteditable="true"]';
const graphemes = new Intl.Segmenter();

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();
}

function* textGroups(body: Element) {
  const walk = body.ownerDocument.createTreeWalker(body, 4);
  let group: Text[] = [];
  let block: Element | null = null;
  let node = walk.nextNode();
  while (node instanceof Text) {
    const parent = node.parentElement;
    if (parent && !parent.closest(excludedSelector)) {
      const nextBlock = parent.closest(blockSelector);
      if (block !== nextBlock && group.length) {
        yield group;
        group = [];
      }
      block = nextBlock;
      group.push(node);
    }
    node = walk.nextNode();
  }
  if (group.length) yield group;
}

function* findRanges(body: Element, query: string) {
  for (const nodes of textGroups(body)) {
    const text = nodes.map((node) => node.data).join("");
    const normalized = normalize(text);
    let index = normalized.indexOf(query);
    if (index < 0) continue;
    const spans: { start: number; end: number }[] = [];
    for (const { segment, index } of graphemes.segment(text)) {
      for (let i = 0; i < normalize(segment).length; i++) {
        spans.push({ start: index, end: index + segment.length });
      }
    }
    let offset = 0;
    const ends = nodes.map((node) => (offset += node.length));
    const locate = (position: number) => {
      let low = 0;
      let high = nodes.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (position > ends[middle]) low = middle + 1;
        else high = middle;
      }
      return { node: nodes[low], offset: position - (ends[low - 1] ?? 0) };
    };
    while (index >= 0) {
      const start = locate(spans[index].start);
      const end = locate(spans[index + query.length - 1].end);
      const range = body.ownerDocument.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      yield range;
      index = normalized.indexOf(query, index + query.length);
    }
  }
}

export function highlightConversation(
  panel: HTMLElement,
  threadId: string,
  term: string,
  visible: () => boolean,
) {
  const registry = globalThis.CSS?.highlights;
  const query = normalize(term);
  if (!registry || typeof Highlight === "undefined" || !query) return;

  const doc = panel.ownerDocument;
  const target = `[data-thread-window="${CSS.escape(threadId)}"]`;
  const highlight = registry.get(name) ?? new Highlight();
  registry.set(name, highlight);
  let ranges: Range[] = [];
  let frame: number | undefined;

  const clear = () => {
    for (const range of ranges) highlight.delete(range);
    ranges = [];
  };
  const refresh = () => {
    frame = undefined;
    clear();
    if (!visible()) return;
    for (const body of Array.from(doc.querySelectorAll(`${target} ${bodySelector}`))) {
      if (body.closest("[data-thread-window]")?.matches(target) !== true) continue;
      for (const range of findRanges(body, query)) {
        ranges.push(range);
        highlight.add(range);
      }
    }
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(refresh);
  };
  const content = new MutationObserver((records) => {
    if (
      records.some((record) => {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (element?.closest(target)) return true;
        return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
          (node) => node instanceof Element && (node.matches(target) || node.querySelector(target)),
        );
      })
    )
      schedule();
  });
  content.observe(doc.body, { childList: true, characterData: true, subtree: true });
  const visibility = new MutationObserver(schedule);
  for (let ancestor: HTMLElement | null = panel; ancestor; ancestor = ancestor.parentElement) {
    visibility.observe(ancestor, {
      attributes: true,
      attributeFilter: ["inert", "aria-hidden", "hidden", "style", "class"],
    });
  }
  schedule();
  return () => {
    content.disconnect();
    visibility.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    clear();
  };
}
