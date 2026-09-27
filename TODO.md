# TODO

## Teams notifications

- [ ] Write the real booking message in `formatBookingLines()` (`src/notify.ts`, marked `TODO(you)`). It currently shows only room and time. Decide on:
  - language and wording;
  - which fields to show (title, number of persons);
  - what to show when `reservationId` is `0` (ID unknown);
  - whether to say who booked (all posts arrive via Workflows).

  Bookings resent via "Share" have no building/floor, so the text must work without them.
- [ ] Check that a booking already in progress is still shared, e.g. run `npm run share` during a booked slot. The reservation list is queried from midnight for this, but it hasn't been verified yet.
- [ ] Check the Teams chat-link fallback (used without a webhook, or when posting fails):
  - does it open the existing "day ones" chat or start a new group chat;
  - do line breaks survive in the pre-filled message?

## Repository cleanup

- [ ] `ARCHITECTURE.md` is untracked and outdated. It still lists the launcher and `setup.bat` as missing and doesn't mention notifications or sharing. Update and commit it, or delete it.
- [ ] `package-lock.json` has an uncommitted change from `npm install`. Commit it or discard it.
- [ ] Bring `AGENTS.md` up to date (existing launcher, 15/5-minute time rules, `select()` w/s wrapper, no `setup.bat`). Then drop the "Where AGENTS.md is out of date" section from `CLAUDE.md`.
- [ ] Remove the ignored `discover` script from `package.json`; the README already says it's gone.
- [ ] Remove the unused dependencies `chalk`, `ora` and `dotenv`.
- [ ] Decide whether the `CLAUDE.md` line about `/Users/alperen/dev/CLAUDE.md` (machine-specific) should move to an untracked `CLAUDE.local.md`.
