# omp-run-timer

OMP extension that shows per-run elapsed time in the interactive working line and the final run duration in the footer status area.

## What it does

- Shows a live elapsed timer while the main agent is running
- Keeps the latest tool intent visible until a newer intent-bearing tool replaces it
- Pauses the timer while the `ask` tool is waiting for user input, then resumes without counting that wait time
- Shows the final duration as `Last run` after the run ends

## Current display behavior

### Working line

Examples:

- `Working… · 12.3s (esc to interrupt)`
- `Reading config · 1m 0s (esc to interrupt)`
- `Searching files · 1hr 0m 0s (esc to interrupt)`

### Final status line

Example:

- `⏱  Last run · 2.3s`

## Time format

- Under 60 seconds: `12.3s`
- 60 seconds to under 60 minutes: `1m 0s`
- 60 minutes and above: `1hr 0m 0s`

Minute-boundary rounding is handled so values such as `59.95s` roll to `1m 0s` instead of showing `60.0s`.

## Install

### Local development

```bash
omp plugin link C:/Users/Anton/.omp/agent/extensions/omp-run-timer
```

If OMP is already running, restart OMP after linking or updating the extension.

### Marketplace install

Add the GitHub repo as a marketplace:

```bash
omp plugin marketplace add anton1615/omp-run-timer
```

Install the plugin from that marketplace:

```bash
omp plugin install omp-run-timer@omp-run-timer
```

## Development

Run the extension tests locally:

```bash
bun test index.test.ts
```

## Implementation notes

- The extension uses OMP public extension events only:
  - `agent_start`
  - `agent_end`
  - `tool_execution_start`
  - `tool_execution_end`
  - `session_start`
  - `session_switch`
- It updates only when `ctx.hasUI === true`
- It deduplicates working-line updates so the line is redrawn only when the visible string changes
- `ask` pauses are tracked and excluded from both live elapsed time and `Last run`

## Known limitations

These are current OMP public API limits, not accidental bugs in this plugin.

1. `Last run` is shown on the extension status line below the built-in usage line.
   - The plugin cannot inject a custom segment into the built-in token/cache usage row.

2. The `Last run` line cannot keep custom ANSI color styling.
   - OMP sanitizes extension status text before rendering.
   - If ANSI color codes are passed through `setStatus(...)`, they are stripped or can degrade into visible control fragments.
   - Because of that, this plugin uses plain text for `Last run`.

3. The `Last run` line cannot keep true leading whitespace for left padding.
   - OMP trims extension status text during sanitization, so leading spaces are removed.

4. The plugin cannot append a timer onto the exact current core working message.
   - OMP public API does not expose the current core working message for read/append.
   - The plugin therefore manages its own working-line text.

5. Minor redraw competition with the core working line may still be possible.
   - The extension now deduplicates updates to reduce flicker substantially.
   - But the core and the extension still share the same working-line surface, so perfect zero-conflict rendering is not guaranteed by the current API.

6. Pause/resume currently targets `ask` tool waits specifically.
   - If some future interaction path waits for the user without going through the `ask` tool lifecycle, this plugin will not automatically pause for it until explicit handling is added.

## Repository layout

This repo is intentionally both:

- the plugin repo root, and
- the marketplace repo root

Relevant files:

- `package.json` — OMP plugin manifest
- `index.ts` — extension implementation
- `index.test.ts` — tests
- `.claude-plugin/marketplace.json` — marketplace catalog pointing to `./`
