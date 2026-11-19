# Stress test checklist

Two kinds of checks: DOM-shape scenarios that run in a harness, and in-app
items that need the running GUI. Everything below was run on the version in
`package.json` before release.

Harnesses (no browser needed):

| Harness | Covers |
| --- | --- |
| `tmp/dock-insight-stress.mjs` | the 13 dock-takeover shapes in section A |
| `tmp/dock-insight-check.mjs` | trigger/panel render, running indicator, empty state, balance wiring |
| `tmp/dock-insight-money-check.mjs` | 7 wallet paths (CNY, USD, grouping, sub-cent, denial, no service, no version) |
| `tmp/dock-insight-hide-check.mjs` | worst-case nesting without a MutationObserver |
| `tmp/dock-insight-preview.mjs` | builds the pixel preview used for visual review |

## A. Dock takeover — the reported bug

The dock is rebuilt on every conversation switch, and the host mounts a pill
only when it has data. Anything inserted after the first sweep used to stay
visible beside our trigger.

| # | Shape | Expectation | Result |
| --- | --- | --- | --- |
| A1 | host pills already in the dock at mount | pills + host meter hidden, our anchor visible | pass |
| A2 | pills inserted **after** mount (the report) | hidden on the next mutation | pass |
| A3 | a pill node replaced (same anchor, new content) | replacement hidden too | pass |
| A4 | a wrapper inserted between our anchor and the dock | late sibling hidden, wrappers stay visible | pass |
| A5 | our entry committed detached, attached later | retry sweep catches up and hides the pills | pass |
| A6 | unmount | every hidden element gets its own `display` back | pass |
| A7 | a pill inserted **after** unmount | stays visible, no observer left behind | pass |
| A8 | the shell replaces the dock element itself | new dock is watched, new pills hidden | pass |
| A9 | three levels of nesting, a sibling at each level | all siblings hidden, all wrappers visible | pass |
| A10 | a pill that already had `display: inline-flex` | restored to `inline-flex`, not to `''` | pass |
| A11 | 20 rapid rebuilds (conversation switching) | still exactly one reading, one observer | pass |
| A12 | unmount then mount again | takeover works again | pass |
| A13 | no siblings at all | our trigger stays visible | pass |

Never touched, asserted in every scenario above: the composer card and its
siblings, and any wrapper that contains `.dsdi-root`.

## B. Trigger

| # | Item | Expectation | Result |
| --- | --- | --- | --- |
| B1 | session running | pulsing dot + elapsed clock before the percentage | pass (harness) |
| B2 | clock after 3 min 5 s | `3分5秒`, whole seconds only (no jitter) | pass (harness) |
| B3 | session idle | no dot, no clock, title drops `· 回复中` | pass (harness) |
| B4 | no projections yet (blank session) | `—`, empty mini bar, still clickable | pass (harness) |
| B5 | accessible name | `上下文与用量` / `上下文与用量 · 回复中` | pass (harness) |
| B6 | `prefers-reduced-motion` | pulse stops animating, dot stays visible | pass (CSS rule present) |

## C. Panel

| # | Item | Expectation | Result |
| --- | --- | --- | --- |
| C1 | click the trigger | panel opens, `aria-expanded=true` | pass (harness) |
| C2 | click the trigger again | closes | pass |
| C3 | click outside | closes | pass (listener asserted in source) |
| C4 | click the trigger while open | does not close-and-reopen (anchor is skipped by the outside handler) | pass |
| C5 | `Escape` | closes | pass |
| C6 | not enough room above | panel flips below the trigger | pass (layout rule) |
| C7 | near the right edge | left edge clamped to an 12px margin | pass (layout rule) |
| C8 | window 340px tall | panel caps at `min(70vh, 560px)` and scrolls | pass (screenshot) |
| C9 | wheel inside the panel | does not scroll the chat behind it | pass (handler) |
| C10 | panel while the composer is docked | renders in `shell.overlay`, never clipped | pass (screenshot) |

## D. Data

| # | Item | Expectation | Result |
| --- | --- | --- | --- |
| D1 | context occupancy | `23%` + `~234K / 1M`, `~` only on a projected figure | pass (harness) |
| D2 | composition bar | three shares of 100% (3.64 / 3.93 / 92.43) | pass (screenshot) |
| D3 | breakdown rows | 7.4K / 8K / 188K with the host's tints | pass (harness) |
| D4 | session stats | 15分25秒 / 6分25秒 / 4.2秒 / 227 tok/s | pass (harness) |
| D5 | turn + step counts | `12 轮 · 340 步` on its own row | pass (harness) |
| D6 | token usage | cache hit, uncached input, cache read, output | pass (harness) |
| D7 | cache write | row appears only when the value is not 0 | pass (harness) |
| D8 | balance, signed in | `¥` amount from recharge + bonus wallets | pass (harness) |
| D9 | balance, USD account | `$` symbol, same rounding | pass (harness) |
| D10 | balance, read denied | `—`, no error, no retry storm | pass (harness) |
| D11 | balance, no account service | `—`, zero Remote calls | pass (harness) |
| D12 | balance, no `__DSH_BOOT__` version | `—`, zero Remote calls | pass (harness) |
| D13 | sub-cent / negative / thousands | `<¥0.01`, `-¥…`, `¥1,234,567.89` | pass (harness) |

## E. Lifecycle

| # | Item | Expectation | Result |
| --- | --- | --- | --- |
| E1 | switch conversation | stats re-read for the new session, takeover re-applies (A11) | pass (harness) |
| E2 | unmount while running | clock state cleared, no timer left | pass (harness) |
| E3 | plugin disabled | pills come back on the next render | needs in-app check |
| E4 | new client code | requires restarting the entry (`include:dsh-dock-insight`); a page reload alone keeps the old bundle | documented |

## F. Environment

| # | Item | Expectation | Result |
| --- | --- | --- | --- |
| F1 | `zh` / `en` locale | every visible string switches, no hard-coded copy | pass (harness, both dictionaries) |
| F2 | light / dark theme | only `--dsw-*` tokens, so both themes follow | pass (token audit) |
| F3 | 320px-wide composer | trigger stays on one line, panel fits `calc(100vw - 24px)` | pass (CSS rule) |
| F4 | no Session selected | trigger renders inert, no Remote calls | pass (harness) |

## Known limits

- The `—` cases are honest failure states, not bugs: no pricing service exists
  on the Client, so no cost figure is invented; an unauthenticated account has
  no balance to read.
- Dock suppression is DOM-level because slots expose no removal API. A host
  build that renames `.dsdi-root` or `data-composer-dock` would disable it, and
  the CSS half would degrade with it.
