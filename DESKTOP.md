# GBA ROM Hack IDE desktop

## Linux release

Download the versioned `GBA-ROM-Hack-IDE-0.3.0-linux-x86_64.AppImage`, `desktop-checksums-linux.txt`, source provenance and attestation from [v0.3.0](https://github.com/csnyder256/gba-rom-hack-ide/releases/tag/v0.3.0). Verify the SHA-256 and the signed build provenance before making the AppImage executable:

```sh
sha256sum -c desktop-checksums-linux.txt
gh attestation verify GBA-ROM-Hack-IDE-0.3.0-linux-x86_64.AppImage --repo csnyder256/gba-rom-hack-ide
chmod +x GBA-ROM-Hack-IDE-0.3.0-linux-x86_64.AppImage
./GBA-ROM-Hack-IDE-0.3.0-linux-x86_64.AppImage
```

Keep all checksum-listed assets together when using `sha256sum -c`. AppImage requires your distribution's FUSE support; extracting it with `--appimage-extract` is an alternative for systems without FUSE. Extracted-directory launches use manual upgrades. No separate Node.js installation is required for the desktop app. No ROMs are supplied. Decompilation builds still require the project's toolchain; the optional local agent still needs its separately installed CLI and account.

Linux delivery carries a cryptographically signed **build provenance attestation**. It is not Windows Authenticode or Apple Developer ID signing. Windows NSIS installers and macOS DMG/ZIP releases are published only when their owner-provided signing identities and OS verification gates succeed. Those identities are not bundled with the project.

## Updates

Supported release packages check the stable GitHub release channel at startup and every six hours. Open **Updates** or use the application menu to check immediately. Downloads are explicit and validated before the Restart action becomes available. A native confirmation asks you to save your work before installing. Automatic installation on ordinary quit is disabled. Prerelease versions and downgrades are refused.

Windows updates verify Authenticode against the release's signing publisher; macOS requires a signed app. Linux AppImage downloads use the update feed's SHA-512 over HTTPS. Verify the release's signed build attestation separately with the command above; the Linux updater does not validate that attestation itself. Extracted directories and source previews explain why automatic updates are unavailable. `GBA_DISABLE_UPDATE_CHECKS=1` disables checks for an offline session.

Project intake lives in the desktop application's user-data `projects` directory, outside installed resources. Upgrades retain it. Existing standalone projects remain where they were; open them through the picker. Workspace preferences use a saved local port so they survive restart; a port collision selects a free port while keeping projects intact. Keep project backups and the prior release for manual rollback. Version rollback is a deliberate reinstall, not a background downgrade.

## Runtime

The renderer uses a sandbox, context isolation and no Node access. A bundled utility process serves the actual editor/backend on loopback; every HTTP and websocket request requires an ephemeral session token, exact Host and same Origin. Tokens remain outside the renderer and are never saved. Native picker requests pass through the main process. Update IPC accepts only the application's main frame. Remote navigation, arbitrary windows and embedded frames are blocked. The backend operates with the user's filesystem permissions; open workspaces you trust, especially when running their build tools or plugins.

## Build from source

Use Node 22 for the source toolchain:

```sh
npm ci --prefix engine
npm run build --prefix engine
npm ci --prefix app
npm run build --prefix app
npm ci --prefix desktop
npm run stage --prefix desktop
npm test --prefix desktop
npm run verify --prefix desktop
npm run pack --prefix desktop
```

The stage contains production dependencies and real compiled assets, with workspace links materialized. It excludes user projects, private configuration and ROMs. Linux acceptance checks start their own isolated Xvfb display and require the `Xvfb` executable. `node desktop/verify-packaged.cjs` repeats the real journey against the packaged executable.

## Configure production signing

The `Signed desktop releases` workflow is disabled independently per platform until `WINDOWS_SIGNING_ENABLED=true` or `MACOS_SIGNING_ENABLED=true` is set. Configure secrets in the `desktop-signing` GitHub environment:

- Windows: `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` for the actual certificate/provider-compatible credential.
- macOS: `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for Developer ID and notarization.

Do not commit signing material. The preflight reports only missing input names. Production builds require signing; Windows checks `Get-AuthenticodeSignature`, and macOS verifies codesign, Gatekeeper and stapled notarization. Unsigned PR verification directories are temporary CI checks and are never uploaded as production installers. After configuring an identity, dispatch the signing workflow against an existing stable tag; it adds matching signed platform assets and update feeds to that release.

[Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [electron-builder signing](https://www.electron.build/docs/features/code-signing/) and [GitHub attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) describe the underlying trust mechanisms.

## Native project builds

Linux and macOS invoke native Bash and `make modern` with the installed project toolchain. Set `DEVKITARM` or configure the project Makefile as needed. Windows uses the configured devkitPro MSYS2 shell and cpp wrapper. Workspace paths are passed as positional arguments, including spaces and apostrophes. The installer does not bundle a compiler or third-party ROM.

### Emulator and virtual displays

Desktop CI exercises a small original homebrew ROM through the actual packaged core and asserts its green framebuffer, frame progression, and shared memory export. It uses `--use-angle=swiftshader` for software WebGL on the owned virtual display. A Linux desktop without a usable GPU backend can use the same launch flag. The installed application otherwise uses the platform renderer. The 2.5.1 compatibility step checks upstream JavaScript bytes before restoring the editor's existing HEAPU8 export; it does not change the compiled emulator.
