# BB ACP Profile Icons

A **BB-specific frontend plugin** that displays recognizable icons for ACP providers.

| Provider ID | Icon |
| --- | --- |
| `acp-amp` | Full Amp wordmark on a theme-aware square tile |
| `acp-devin` | Enlarged official Devin symbol on a theme-aware square tile |
| `acp-codexl` | OpenAI mark, white on gray to distinguish native Codex |
| `acp-kiro` | Kiro mark |
| `acp-agy` | Antigravity mark |
| `acp-copilot` | GitHub Copilot mark |
| `acp-codebuddy` | CodeBuddy cat mark |
| `acp-dsh` | DeepSeek whale mark |

Amp and Devin use BB’s theme foreground for their tiles and theme background for their marks, reversing their visual contrast across light and dark themes. Other ordinary marks inherit BB's foreground color; ACP Codex uses a gray tile with a white mark.

## Install

Requires BB 0.44 or newer and Plugin SDK 0.5.29 or newer. Install into the BB instance serving the UI:

```sh
bb plugin install https://github.com/hxy91819/bb-plugin-acp-profile-icons --yes
```

Plugin ID: **`acp-profile-icons`**. The install builds the plugin from source. No credentials, external image requests, or configuration are needed.

The plugin decorates existing providers; configure those providers separately. For the Amp adapter with Remote Dial support, use [`hxy91819/amp-acp`, branch `local/aggregate`](https://github.com/hxy91819/amp-acp/tree/local/aggregate).

If a local copy of `acp-profile-icons` is already installed, keep a backup of its customizations before replacing its source.

## Verify

```sh
bb plugin list --json
```

Check that `acp-profile-icons` is running, then open the model picker and confirm the icons appear. The extension overrides icons in the frontend: `bb provider list` may still report a generic glyph and `logoUrl: null`.

To restore the default icons:

```sh
bb plugin disable acp-profile-icons
```

## How it works

`app.tsx` registers inline SVG components with `app.slots.experimental_providerIcon` and `providerKind: "agent"`. The SVGs are bundled locally; Amp and Devin use theme-aware contrasting colors and ACP Codex uses a gray-and-white tile; other marks inherit BB's text color. The backend entry is empty; this plugin does not change authentication, models, or agent execution.

For BB 0.42's Provider Usage panel, a scoped content stylesheet supplies SVG masks (or a theme-colored tile and mark mask for Amp and Devin, or a two-color SVG image for ACP Codex). It leaves React-owned elements intact and removes the stylesheet on disable or reload. Newer BB versions may no longer need that selector; the model picker uses the provider-icon extension directly.

## Icon design and verification

This section is the authoritative visual specification for this plugin. The thresholds below are project design choices, not external standards.

### Artwork and visible size

Use the product's own asset or an attributable vector source, and record its source in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Preserve the complete recognizable mark, including its filled areas and cutouts. A host placeholder or a single-letter approximation is not a substitute for the brand mark.

Measure the **painted artwork**, not just the SVG viewBox. Trim empty source margins, preserve proportions, and center the visible mark optically. Inspect SVG cutouts before applying a mask so the mask retains the complete artwork.

Use **CSS pixels**, independently of screen pixel density or screenshot resolution. Measure the smallest actual provider surface; the current model picker displays icons at **16×16 CSS px**.

### When to use a tile

For icons displayed at **20 CSS px or less**, use a contrasting square tile when, after trimming empty margins:

- the painted mark's shorter bounding-box dimension is below **75%** of the icon box; or
- its wordmark, fine details, or overall shape remain hard to identify at the actual display size.

Size alone does not require a tile. Clear, well-proportioned symbols can remain monochrome. A tile improves contrast and visual weight; it does not replace fitting the artwork correctly.

Choose the treatment based on the smallest supported size, then keep it consistent across provider surfaces. This is a design decision for each provider, rather than an automatic switch at different sizes.

### Theme colors, proportions, and spacing

| Element | Target |
| --- | --- |
| Tile | Square in the 24×24 viewBox, with a consistent corner radius of 4 |
| Compact symbol | Longest painted dimension **80–85%** of the tile; approximately 2 viewBox units of padding per edge |
| Wide wordmark | Complete mark, up to **96%** of the tile width, with its original proportions |
| Theme tile color | BB's `--foreground` |
| Theme mark color | BB's `--background` |

The theme tokens produce dark tiles with light marks in light themes and reversed contrast in dark themes. Use the product's actual palette rather than fixed black, white, gray, or an unrelated brand color for new theme-aware tiles. Apply the same colors to both the provider-icon extension and any Provider Usage CSS fallback.

These proportions are starting points for visual review. Compare the icon beside BB's built-in icons at actual size, checking visual weight and balanced negative space. If a compact symbol feels crowded, reduce it within the target range instead of filling the tile edge to edge. If a wordmark remains unreadable, reconsider its display width or treatment rather than cropping it or stretching it.

Current treatments:

- **Amp:** complete wordmark on a theme-colored tile, with minimal horizontal padding.
- **Devin:** complete official symbol on the same theme-colored tile, optically centered at approximately **83%** of tile height. The initial 92% fit was too crowded.
- **ACP Codex:** retain its established gray tile and white OpenAI mark to distinguish it from native Codex.
- **Other providers:** retain theme-aware monochrome marks while they remain recognizable at the smallest display size.

### Visual verification

After an icon change, run `npm run typecheck`, `bb plugin build .`, and `bb plugin reload acp-profile-icons`. Confirm that the installed plugin uses the changed checkout or commit.

Inspect **16, 20 and 24 CSS px** sizes, including **1× pixel density** and the **actual model picker** in both light and dark themes. Capture screenshots and open them for visual inspection. Compare the complete provider row, not only a magnified standalone SVG.

Check all of the following before delivery:

- The complete mark is visible, with no clipped edges or hidden cutouts.
- The mark is recognizable at actual size and has balanced spacing inside its tile.
- Its visual weight fits the neighboring icons; neither excessive whitespace nor an oversized interior dominates the row.
- Tile and mark colors match the active product theme, and theme switching updates them immediately.
- The Provider Usage fallback matches the picker if its CSS path changed. If that provider has no visible Usage entry, report that limit and check the fallback styling separately.

Compilation and DOM checks support verification; a screenshot that has not been opened and inspected does not establish visual quality.

## Develop

```sh
git clone https://github.com/hxy91819/bb-plugin-acp-profile-icons.git
cd bb-plugin-acp-profile-icons
npm ci
npm run typecheck
bb plugin build .
bb plugin install . --yes
```

For an installed local checkout, rebuild and run `bb plugin reload acp-profile-icons` after changes. Use the target BB version's SDK declarations when adapting the experimental icon API.

## Attribution

Plugin code is MIT licensed. The Kiro, Antigravity, GitHub Copilot, and DeepSeek paths are adapted from [LobeHub lobe-icons](https://github.com/lobehub/lobe-icons) under its MIT license; the CodeBuddy cat path is adapted from the locally installed `@tencent-ai/codebuddy-code/dist/web-ui/pwa-icon.svg`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The CodexL mark comes from BB's Codex provider icon. Brand marks belong to their respective owners. This is an independent plugin, not an official product of those brands.
