# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full agent guide (architecture, API contract, auth/privacy rules, conventions, commit message format) lives in `AGENTS.md` and is imported here:

@AGENTS.md

`/Users/alperen/dev/CLAUDE.md` (parent directory) describes an unrelated Next.js portfolio site. Ignore it in this repository.

## Commands

```sh
npm start          # run the interactive CLI via tsx
npm run login      # force browser login and refresh saved auth
npm run dev        # tsx watch mode
npm run build      # tsc type-check + compile src/ → dist/ (the only automated check)
npm run sniff      # dev tool: record Evento API traffic from raum.fhnw.ch
npm run build && npm link && roomreserve   # try the packaged CLI
```

There is no linter and no test suite, so there is no single-test command. `npm run build` is the verification step after every change. Never smoke-test by creating or cancelling reservations, because they hit the live FHNW service. The same goes for "Send test message" and any booking with a webhook configured: they post into a real Teams group chat. Test `src/notify.ts` against a local HTTP server, with `HOME` pointed at a temporary folder so the real `notify.json` stays untouched.

## Where AGENTS.md is out of date

Where these notes disagree with `AGENTS.md` or `README.md`, the code (and these notes) win:

- `bin/roomreserve.js` exists. It just `require`s `../dist/index.js`, so the `roomreserve` command needs a fresh `npm run build`.
- The `discover` script is still in `package.json` even though the README says it was removed. `--discover` is still ignored. Only `--login` is handled in `main()`.
- Time rules in `src/ui.ts` (`getTimeRange` / `parseEndTimeOrDuration`):
  - Start time must fall on a 15-minute step. The default is the next quarter hour.
  - The third prompt accepts either an end time (`HH:mm`, 5-minute steps, rolls over to the next day if it is not after the start) or a duration (`90m`, `1h 30m`, `1.5h`, `1,5h`).
  - The result must be 5 minutes to 16 hours in 5-minute steps. The old `0–16 hours` message is gone.
  - Keep validation and the final parse on the same function so the two stay in sync.
- Every list prompt goes through the local `select()` wrapper in `src/ui.ts`, not Inquirer's `select` directly. The wrapper temporarily prepends a stdin `keypress` listener that re-emits `w`/`s` as `up`/`down`, and removes it in `finally`. Use this wrapper for any new menu, and don't apply the remapping to `input` prompts, where `w`/`s` must stay typeable.

## Repo gotchas

- `.gitignore` ignores `*.js` everywhere except `src/**` and `bin/roomreserve.js`. Any new plain-JS file elsewhere needs a matching `!` exception or it will be silently untracked.
- `package.json` is `"type": "commonjs"` and lists every package (including `typescript`, `tsx`, `@types/node`) under `dependencies`. `chalk`, `ora`, and `dotenv` are installed but not currently imported.
- The auth token's `expiresAt` comes from the JWT `exp` claim (fallback: 10 minutes). With a saved `browser-session.json`, re-login runs headless with a 15s timeout and falls back to an interactive browser.
