# FHNW Room Reservator

An interactive command-line application for FHNW students and staff to find, reserve, view, and cancel eligible room reservations. It signs in through the official [FHNW room reservation website](https://raum.fhnw.ch) and uses the associated Evento API.

## Requirements

- Node.js 18 or newer
- An FHNW account that can sign in at `raum.fhnw.ch`
- An internet connection

## Quick start

Clone or download this repository, then open a terminal in its folder.

> [!TIP]
> You can use an AI agent (like Claude or ChatGPT) after completing authentication and ask them to do a booking for you at a given location, time, day, and for how many people.

### Windows PowerShell

```powershell
npm.cmd install
npx.cmd playwright install chromium
npm.cmd start
```

If `npm` or `npx` is blocked by your local PowerShell execution policy, use `npm.cmd` and `npx.cmd` as shown above. This does not require changing the execution policy.

### Bash (macOS, Linux, Git Bash, or WSL)

```bash
npm install
npx playwright install chromium
npm start
```

On the first start, Chromium opens so that you can sign in with your FHNW account. After successful sign-in, return to the terminal and use the interactive menu.

## Using the application

The main menu lets you:

- **Reserve a room:** choose a campus, date, start time, and duration; then select an available room and confirm the reservation.
- **My reservations:** view upcoming reservations and cancel a reservation only when the FHNW service marks it as cancellable.
- **Exit:** close the application.

Creating and cancelling reservations changes real FHNW data. The application asks for confirmation before either action.

## Commands

Run these commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm start` | Start the interactive application from TypeScript. |
| `npm run login` | Open the browser login flow and refresh the saved sign-in session. |
| `npm run dev` | Start the application in watch mode for development. |
| `npm run build` | Type-check and compile the application to `dist/`. |
| `npm run sniff` | Developer tool: open the FHNW room website and record Evento API traffic for endpoint investigation. |

In PowerShell environments where `npm` is blocked, replace `npm` with `npm.cmd` (for example, `npm.cmd run build`).

`npm run sniff` can capture request headers and personal reservation data. Treat its output as sensitive and do not share or commit it.

## Install the `roomreserve` command locally

The project also provides a `roomreserve` command for local development. Build the project first, then link it with npm.

### Windows PowerShell

```powershell
npm.cmd run build
npm.cmd link
roomreserve
```

### Bash

```bash
npm run build
npm link
roomreserve
```

The command runs the compiled application in `dist/`. Run the build again after changing source files. To remove the local link later, run `npm unlink --global roomreservator`.

## Session data and privacy

To avoid requiring a browser login on every run, the application stores its sign-in session outside this repository:

- Windows: `%APPDATA%\\roomreservator`
- Other systems: `$HOME/.config/roomreservator`

These files can contain authentication tokens, browser cookies, and—when using the sniffer—API request and response data. Keep them private and never commit or share them.

## Development notes

- `npm run sniff` is intended for API investigation; the obsolete `discover` script was removed because its option was not implemented.
- The project has no automated test suite yet. After code changes, run `npm run build` at minimum.
