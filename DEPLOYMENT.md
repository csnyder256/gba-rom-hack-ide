# Install and update ROM Hack IDE

## Prebuilt local application

Download the `v0.2.0-prebuilt` ZIP or tarball from [Releases](https://github.com/csnyder256/gba-rom-hack-ide/releases). Verify SHA-256 against `checksums.txt`. Extract it, install **Node.js 22**, then run from the extracted folder:

```sh
npm ci --prefix engine
npm ci --prefix app
node scripts/start-release.mjs
```

Open <http://127.0.0.1:5173>. The bundle contains compiled engine, backend, shared library and frontend; no TypeScript compilation is needed. Dependencies download on the first install; Node is not bundled. Both services bind to loopback. The production preview includes the cross-origin isolation headers needed by the mGBA worker and forwards API and WebSocket requests to the local backend. Ctrl+C stops the app.

Bring your own legally obtained ROM; releases include no ROMs, private API keys, projects or saves. Optional agent providers require your own configuration; the local editor can start without them. Tile-server functionality uses the optional Docker services documented in README.

## Developer install

Clone the repository and follow README's source-build instructions, or use the existing `start.mjs` launcher. This route rebuilds the workspace for active development.

## Upgrade

Stop both services before backing up projects, ROM copies, save files and private provider configuration. Extract a new release into a separate directory and install its locked dependencies again. Retain the old folder; open existing project folders from the new app. Keep the data backup and old app together for rollback. Do not store personal ROMs inside a release archive.
