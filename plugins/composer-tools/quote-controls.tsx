import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { quoteRanges, removeQuote } from "./draft";

interface QuotePosition {
  index: number;
  left: number;
  top: number;
}

export function QuoteControls() {
  const composer = useComposer();
  const anchor = useRef<HTMLSpanElement>(null);
  const schedule = useRef<(() => void) | null>(null);
  const [owner, setOwner] = useState<HTMLElement | null>(null);
  const [positions, setPositions] = useState<QuotePosition[]>([]);

  useLayoutEffect(() => {
    const root = anchor.current?.closest<HTMLElement>("[data-app-composer]");
    if (root) setOwner(root);
  }, [composer.key]);

  useLayoutEffect(() => {
    if (!owner) return;
    const root = owner;
    const mobile = window.matchMedia(
      "(max-width: 767px) and (pointer: coarse)",
    );
    let frame: number | null = null;
    let observedEditor: HTMLElement | null = null;
    let observedViewport: HTMLElement | null = null;
    const resize = new ResizeObserver(queueMeasure);
    resize.observe(root);

    function queueMeasure() {
      if (frame === null) frame = requestAnimationFrame(measure);
    }

    function measure() {
      frame = null;
      const editor = Array.from(
        root.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable]'),
      ).find((element) => element.closest("[data-app-composer]") === root);
      const viewport =
        editor?.closest<HTMLElement>("[data-promptbox-editor-scroll]") ?? null;
      if (editor !== observedEditor) {
        if (observedEditor) resize.unobserve(observedEditor);
        observedEditor = editor ?? null;
        if (observedEditor) resize.observe(observedEditor);
      }
      if (viewport !== observedViewport) {
        if (observedViewport) resize.unobserve(observedViewport);
        observedViewport = viewport;
        if (viewport) resize.observe(viewport);
      }
      const next: QuotePosition[] = [];
      if (
        mobile.matches &&
        composer.layout !== "compact" &&
        !composer.isSubmitting &&
        editor?.isContentEditable &&
        viewport &&
        editor.getClientRects().length > 0 &&
        getComputedStyle(editor).visibility === "visible"
      ) {
        const bounds = viewport.getBoundingClientRect();
        const quotes = Array.from(editor.querySelectorAll("blockquote"));
        if (quotes.length === quoteRanges(composer.text).length) {
          quotes.forEach((quote, index) => {
            const rect = quote.getBoundingClientRect();
            if (rect.top - 6 < bounds.top || rect.top + 38 > bounds.bottom)
              return;
            next.push({
              index,
              left:
                Math.min(rect.right + 2, bounds.right - 44) + window.scrollX,
              top: rect.top - 6 + window.scrollY,
            });
          });
        }
      }
      setPositions((previous) =>
        previous.length === next.length &&
        previous.every((position, index) => {
          const candidate = next[index]!;
          return (
            position.index === candidate.index &&
            position.left === candidate.left &&
            position.top === candidate.top
          );
        })
          ? previous
          : next,
      );
    }

    const mutations = new MutationObserver(queueMeasure);
    mutations.observe(root, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "contenteditable"],
      subtree: true,
    });
    mobile.addEventListener("change", queueMeasure);
    window.addEventListener("resize", queueMeasure);
    window.addEventListener("scroll", queueMeasure, true);
    window.visualViewport?.addEventListener("resize", queueMeasure);
    window.visualViewport?.addEventListener("scroll", queueMeasure);
    schedule.current = queueMeasure;
    measure();
    return () => {
      schedule.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      mobile.removeEventListener("change", queueMeasure);
      window.removeEventListener("resize", queueMeasure);
      window.removeEventListener("scroll", queueMeasure, true);
      window.visualViewport?.removeEventListener("resize", queueMeasure);
      window.visualViewport?.removeEventListener("scroll", queueMeasure);
    };
  }, [composer, owner]);

  useLayoutEffect(() => {
    schedule.current?.();
  }, [composer.text, composer.layout, composer.isSubmitting]);

  return (
    <>
      {owner === null ? <span ref={anchor} hidden /> : null}
      {positions.length > 0
        ? createPortal(
            <div
              data-bb-plugin="composer-tools"
              data-bb-plugin-root=""
              data-composer-quote-controls={composer.key}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: 0,
                height: 0,
                zIndex: 40,
                pointerEvents: "none",
              }}
            >
              {positions.map((position) => (
                <button
                  key={position.index}
                  type="button"
                  className="composer-tools-quote-remove"
                  aria-label={`Remove quote ${position.index + 1}`}
                  title="Remove quote"
                  style={{ left: position.left, top: position.top }}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    composer.replace((current) =>
                      removeQuote(current, position.index),
                    );
                    composer.focus();
                  }}
                >
                  <span aria-hidden="true">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
