import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../../state';
import { useEmulatorStore } from '../../state/emulator';
import { startProjectBuild, getProjectBuildJob } from '../../api';
import type { EmulatorMemoryHost as EmulatorMemoryHostType } from '../../lib/emulatorMemory';
import { DebugMenu } from './DebugMenu';
import { SaveStateLibrary } from './SaveStateLibrary';
import type { SaveStateEmulatorHost } from './SaveStateLibrary';
import { SceneBootPicker } from './SceneBootPicker';
import type { SceneBootEmulatorHost } from './SceneBootPicker';
import { HudOverlay } from './HudOverlay';
import { MusicTimeline } from './MusicTimeline';
import './EmulatorHost.css';

/**
 * WP-B - Embedded mGBA-WASM emulator host.
 *
 * Boots the current project's ROM inside a <canvas>. Keyboard input is
 * mapped to GBA buttons (arrows, Z, X, A, S, Enter, Backspace). The
 * canvas is always 240×160 (GBA native resolution); CSS handles
 * upscaling.
 *
 * State machine:
 *   idle → booting → running ↔ paused → idle
 *
 * The mGBA-WASM module is dynamically imported so the ~2.5 MB WASM
 * payload only loads when the user hits Play, not on every page open.
 *
 * RAM access (the basis for WP-B's debug menu) goes through the
 * emscripten Module.HEAPU8 view exposed by mGBA-WASM. The DebugMenu
 * component (sibling) writes to per-game WRAM offsets (see
 * lib/savedataLayout.ts) to set flags / give items / heal party.
 */

type EmulatorState =
  | { kind: 'idle' }
  | { kind: 'building'; log: string }
  | { kind: 'loading-wasm' }
  | { kind: 'fetching-rom' }
  | { kind: 'booting' }
  | { kind: 'running' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string };

interface EmulatorInstance {
  buttonPress: (name: string) => void;
  buttonUnpress: (name: string) => void;
  pauseGame?: () => void;
  resumeGame?: () => void;
  // mGBA fires videoFrameEndedCallback once per emulated frame. We register it
  // to drive a visible heartbeat (fps) so a "frozen" preview can be diagnosed:
  // climbing fps ⇒ core runs (input/display issue); 0 fps ⇒ core/worker stalled.
  addCoreCallbacks?: (callbacks: { videoFrameEndedCallback?: () => void }) => void;
  resumeAudio?: () => void;
  // SDL2's Web Audio context. Created suspended by the browser's autoplay
  // policy; mGBA syncs the core to audio, so it must be resumed or the core
  // never steps. Exposed by emscripten's SDL2 backend as Module.SDL2.
  SDL2?: { audioContext?: AudioContext };
  saveState?: (slot: number) => boolean;
  loadState?: (slot: number) => boolean;
  // Phase 4.1A - exposed by mGBA-WASM 2.4.1 for the named save-state
  // library. The 3-slot saveState/loadState API above is now an
  // implementation detail of the library, kept here for legacy callers.
  forceAutoSaveState?: () => boolean;
  getAutoSaveState?: () => { autoSaveStateName: string; data: Uint8Array } | null;
  uploadAutoSaveState?: (name: string, data: Uint8Array) => Promise<void>;
  loadAutoSaveState?: () => boolean;
  HEAPU8?: Uint8Array;
}

// Keyboard → GBA button mapping. Standard convention used by GBA Studio
// + most browser emulators.
const KEY_TO_BUTTON: Readonly<Record<string, string>> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  z: 'B',
  Z: 'B',
  x: 'A',
  X: 'A',
  a: 'L',
  A: 'L',
  s: 'R',
  S: 'R',
  Enter: 'Start',
  Backspace: 'Select',
};

export function EmulatorHost(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const moduleRef = useRef<EmulatorInstance | null>(null);
  // Phase 9C - HUD overlay toggle. Default off; users opt in via the
  // toolbar Hud button. Persists across boot/pause cycles.
  const [hudEnabled, setHudEnabled] = useState(false);
  // Phase 9E - Music timeline toggle. Default off; users opt in via
  // the toolbar Music button. Independent of HUD; both can be on.
  const [musicEnabled, setMusicEnabled] = useState(false);
  const [state, setState] = useState<EmulatorState>({ kind: 'idle' });
  // Live emulation heartbeat - incremented per emulated frame via mGBA's
  // videoFrameEndedCallback. A 1 s sampler turns it into a visible fps so a
  // "frozen" preview is self-diagnosing (0 fps ⇒ core stalled, not input).
  const frameCountRef = useRef(0);
  const lastFrameSampleRef = useRef(0);
  const [fps, setFps] = useState<number | null>(null);
  // Watchdog: set when the core reports 0 fps for several consecutive seconds
  // while "running" - a stalled WASM runtime that a full page reload cures.
  const [frozenStall, setFrozenStall] = useState(false);
  const buildLogRef = useRef<HTMLPreElement | null>(null);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  // WP-B v2.3 - reactive emulator slice so the DebugMenu sibling can
  // subscribe without polling getActiveEmulatorModule(). State
  // transitions in boot/pause/resume/quit call these setters.
  const setEmulatorRunning = useEmulatorStore((s) => s.setRunning);
  const setEmulatorPaused = useEmulatorStore((s) => s.setPaused);
  const setEmulatorIdle = useEmulatorStore((s) => s.setIdle);
  const pendingBuildPlay = useEmulatorStore((s) => s.pendingBuildPlay);
  const consumeBuildPlay = useEmulatorStore((s) => s.consumeBuildPlay);

  // Keep the live build log scrolled to the newest output.
  useEffect(() => {
    if (state.kind === 'building' && buildLogRef.current) {
      buildLogRef.current.scrollTop = buildLogRef.current.scrollHeight;
    }
  }, [state]);

  /**
   * Resume mGBA's Web Audio context. The browser's autoplay policy creates it
   * suspended, and this mGBA build only auto-resumes when
   * `navigator.userActivation` is undefined (it's defined in modern Chrome), so
   * it otherwise stays suspended forever. Because mGBA syncs the emulator core
   * to the audio FIFO, a suspended context means the FIFO never drains and the
   * core never advances a single frame (total frames=0, "frozen"). Resume it
   * now (the Build/Play click is sticky user activation) and, as a fallback,
   * on the next pointer/key gesture until it's actually running.
   */
  const ensureAudioRunning = (emu: EmulatorInstance): void => {
    // The package exposes resumeAudio even when SDL2 is not exported.
    try { emu.resumeAudio?.(); } catch { /* best-effort native resume */ }
    const ctx = emu.SDL2?.audioContext;
    if (!ctx || typeof ctx.resume !== 'function') return;
    if (ctx.state === 'running') return;
    const handler = (): void => {
      void ctx.resume().then(
        () => {
          window.removeEventListener('pointerdown', handler, true);
          window.removeEventListener('keydown', handler, true);
        },
        () => {
          /* still blocked - a later gesture will retry */
        },
      );
      try {
        emu.resumeAudio?.();
      } catch {
        /* best-effort */
      }
    };
    handler(); // try immediately on the boot click's sticky activation
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
  };

  /**
   * Load the freshly-built ROM into an ALREADY-instantiated mGBA module: fetch
   * the latest bytes (cache-busted), upload to the emscripten FS, and loadGame.
   * Shared by first boot, Reload ROM, and Build & Play so the emscripten
   * factory runs at most once per page - a `-pthread` module (shared
   * WebAssembly.Memory + worker pool) can't be re-instantiated cleanly: the old
   * instance's worker and requestAnimationFrame loop survive and fight the new
   * one for the single <canvas>, which is what left the preview "frozen" after
   * a rebuild/reload.
   */
  const loadFreshRomIntoModule = async (emu: EmulatorInstance): Promise<void> => {
    if (!sessionId) {
      setState({ kind: 'error', message: 'Open a project first' });
      return;
    }
    setState({ kind: 'fetching-rom' });
    let romBytes: Uint8Array;
    try {
      // Cache-bust + no-store so Reload / Build & Play always fetch the
      // freshly-built .gba, never a copy the browser cached on a prior boot.
      const response = await fetch(
        `/api/projects/${encodeURIComponent(sessionId)}/rom-bytes?t=${String(Date.now())}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      romBytes = new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      setState({
        kind: 'error',
        message: `Failed to fetch ROM: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    setState({ kind: 'booting' });
    try {
      // Reset the heartbeat so fps reflects the newly-loaded game.
      frameCountRef.current = 0;
      lastFrameSampleRef.current = 0;
      const file = new File([romBytes as BlobPart], 'game.gba', {
        type: 'application/octet-stream',
      });
      await new Promise<void>((resolve, reject) => {
        try {
          const uploadRom = (emu as unknown as { uploadRom?: (f: File, cb?: () => void) => void })
            .uploadRom;
          if (typeof uploadRom !== 'function') {
            reject(new Error('uploadRom not exposed on Module'));
            return;
          }
          uploadRom.call(emu, file, () => resolve());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      const loadGame = (emu as unknown as { loadGame?: (p: string) => boolean }).loadGame;
      if (typeof loadGame === 'function') {
        const ok =
          loadGame.call(emu, '/data/games/game.gba') || loadGame.call(emu, 'game.gba');
        if (!ok) {
          setState({
            kind: 'error',
            message: 'mGBA could not load the uploaded ROM (try refreshing the page)',
          });
          return;
        }
      }
      // The core is created by loadGame. Register only after it exists, and
      // refresh the callback when replacing a ROM on the same runtime.
      emu.addCoreCallbacks?.({ videoFrameEndedCallback: () => { frameCountRef.current += 1; } });
      // When loadGame runs on a module that was already playing (Reload /
      // Build & Play reusing the runtime), mGBA can leave the core paused - 
      // the main loop stops and the canvas freezes on the last frame at 0 fps.
      // resumeGame is a no-op on a freshly-started core, so it's safe on first
      // boot too.
      if (typeof emu.resumeGame === 'function') {
        emu.resumeGame();
      }
      // CRITICAL: resume the (suspended) audio context, or the audio-synced
      // core never steps a frame. This is the actual fix for the 0-fps freeze.
      ensureAudioRunning(emu);
      setState({ kind: 'running' });
      setEmulatorRunning(emu as unknown as EmulatorMemoryHostType);
      // Focus the canvas so mGBA's SDL2/JSEvents input is live immediately.
      requestAnimationFrame(() => canvasRef.current?.focus());
    } catch (e) {
      setState({
        kind: 'error',
        message: `Boot failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      setEmulatorIdle();
    }
  };

  const boot = async (): Promise<void> => {
    if (!sessionId || !canvasRef.current) {
      setState({ kind: 'error', message: 'Open a project first' });
      return;
    }
    // mGBA-wasm is a pthreads build; its init blocks on a worker pool that
    // needs SharedArrayBuffer, which only exists when the page is cross-origin
    // isolated. Fail fast with an actionable message instead of hanging on
    // "Booting…" forever.
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
      setState({
        kind: 'error',
        message:
          'The emulator needs cross-origin isolation (SharedArrayBuffer is unavailable). ' +
          'Restart the Vite dev server so it serves the new COOP/COEP headers, then hard-refresh this page (Ctrl+Shift+R).',
      });
      return;
    }
    // Reuse an already-running runtime (Build & Play / Reload after a first
    // boot): just load the fresh ROM in. Re-running the factory would spawn a
    // second pthread runtime that fights the first for the canvas → frozen.
    if (moduleRef.current) {
      await loadFreshRomIntoModule(moduleRef.current);
      return;
    }
    setState({ kind: 'loading-wasm' });
    let mGBAFactory: unknown;
    try {
      // Load the emscripten engine from the BACKEND (Vite proxies /api → here
      // without running its module pipeline). mGBA re-loads its own glue inside
      // a pthread Worker via `new Worker(new URL('mgba.js', import.meta.url))`;
      // if Vite transforms that module the worker throws on init ("worker sent
      // an error"), and /public files can't be import()'d at all. The backend
      // serves the untouched file from a stable same-origin URL, so the worker
      // resolves mgba.js/.wasm relative to it. Indirect through a variable so
      // TS/Vite treat it as an opaque runtime URL.
      const enginePath = '/api/emulator-engine/mgba.js';
      const mod = (await import(/* @vite-ignore */ enginePath)) as unknown as {
        default?: (opts: { canvas: HTMLCanvasElement }) => Promise<EmulatorInstance>;
      };
      mGBAFactory =
        typeof mod === 'function' ? mod : mod?.default ?? (mod as unknown as { default?: unknown }).default;
    } catch (e) {
      setState({
        kind: 'error',
        message: `Failed to load emulator engine: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (typeof mGBAFactory !== 'function') {
      setState({ kind: 'error', message: 'mgba-wasm package missing default export' });
      return;
    }

    // First boot only: instantiate the emscripten runtime once, then hand off
    // to the shared loader (which fetches the ROM + uploads + loadGame).
    setState({ kind: 'booting' });
    try {
      // mGBA-WASM expects a real <canvas> already mounted. locateFile points
      // the emscripten glue at the Vite-served wasm URL so it doesn't fetch a
      // bad path (which returns index.html → WASM magic-word error).
      const factory = mGBAFactory as (opts: {
        canvas: HTMLCanvasElement;
        locateFile?: (path: string, scriptDirectory: string) => string;
      }) => Promise<EmulatorInstance>;
      const emu = await Promise.race([
        factory({
          canvas: canvasRef.current,
          locateFile: (path, scriptDirectory) =>
            path.endsWith('.wasm') ? '/api/emulator-engine/mgba.wasm' : scriptDirectory + path,
        }),
        new Promise<EmulatorInstance>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'Emulator engine did not initialize within 30s. ' +
                    'Check the browser console (F12) for the underlying error.',
                ),
              ),
            30_000,
          ),
        ),
      ]);
      moduleRef.current = emu;
      _emulatorModuleSingleton = emu;
      // Expose for console debugging: `__romEmu.SDL2.audioContext.state`,
      // `__romEmu.resumeAudio()`, etc.
      (window as unknown as { __romEmu?: EmulatorInstance }).__romEmu = emu;
      // Initialize emscripten's virtual filesystem (uses IDBFS).
      const initFs = (emu as unknown as { FSInit?: () => Promise<void> | void }).FSInit;
      if (typeof initFs === 'function') {
        await initFs();
      }
      // Fetch + upload + loadGame via the shared loader (also used by Reload
      // and Build & Play, so the factory is never re-run on this page).
      await loadFreshRomIntoModule(emu);
    } catch (e) {
      setState({
        kind: 'error',
        message: `Boot failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      setEmulatorIdle();
    }
  };

  /**
   * One-click "Build & Play": compile the decomp source to a fresh .gba via
   * the backend `make modern` job, streaming the live log, then boot it. This
   * closes the edit→ROM→play loop so the user never opens a terminal.
   */
  const buildAndPlay = async (): Promise<void> => {
    if (!sessionId) {
      setState({ kind: 'error', message: 'Open a project first' });
      return;
    }
    setState({ kind: 'building', log: 'Starting build…\n' });
    let jobId: string;
    try {
      const started = await startProjectBuild(sessionId);
      jobId = started.jobId;
    } catch (e) {
      setState({
        kind: 'error',
        message: `Could not start build: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    // Poll until the job finishes. The backend caps a build at 30 min and
    // flips it to error, so this loop always terminates.
    const deadline = Date.now() + 32 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      let status;
      try {
        status = await getProjectBuildJob(sessionId, jobId);
      } catch (e) {
        setState({
          kind: 'error',
          message: `Lost contact with the build: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      setState({ kind: 'building', log: status.log || '(building…)' });
      if (status.state === 'success') break;
      if (status.state === 'error') {
        setState({ kind: 'error', message: status.errorSummary ?? 'Build failed - see log.' });
        return;
      }
      if (Date.now() > deadline) {
        setState({ kind: 'error', message: 'Build timed out (30 min).' });
        return;
      }
    }
    // Fresh ROM is on disk; boot() fetches /rom-bytes and runs it.
    await boot();
  };

  // Consume a Build & Play request from the top-level header button. Using a
  // one-shot store flag (rather than a local click) means the action fires
  // even when the preview view mounts only after the click.
  useEffect(() => {
    if (!pendingBuildPlay) return;
    // Don't interrupt an in-flight build/boot; the flag stays set and this
    // effect re-runs when the state settles.
    if (
      state.kind === 'building' ||
      state.kind === 'loading-wasm' ||
      state.kind === 'fetching-rom' ||
      state.kind === 'booting'
    ) {
      return;
    }
    consumeBuildPlay();
    void buildAndPlay();
    // Deps are intentionally just the build-play request and the coarse
    // state kind; buildAndPlay is re-created every render.
  }, [pendingBuildPlay, state.kind]);

  const pause = (): void => {
    const emu = moduleRef.current;
    if (!emu) return;
    if (typeof emu.pauseGame === 'function') emu.pauseGame();
    setState({ kind: 'paused' });
    setEmulatorPaused(emu as unknown as EmulatorMemoryHostType);
  };

  const resume = (): void => {
    const emu = moduleRef.current;
    if (!emu) return;
    if (typeof emu.resumeGame === 'function') emu.resumeGame();
    setState({ kind: 'running' });
    setEmulatorRunning(emu as unknown as EmulatorMemoryHostType);
  };

  // Phase 4.1A - the legacy 3-slot save state UI has been replaced by
  // the named, persistent SaveStateLibrary component below. The library
  // talks to the same mGBA savestate APIs (forceAutoSaveState +
  // getAutoSaveState + uploadAutoSaveState + loadAutoSaveState).

  /** Full reset - drop the current emulator instance and re-boot. Used
   *  after the user edits the ROM via the inspector / visual scripter
   *  and wants the running game to pick up the new bytes. */
  const handleResetAndReload = async (): Promise<void> => {
    // Reload the freshly-built ROM into the LIVE runtime - do NOT drop and
    // re-create the module. A `-pthread` emscripten build can't be
    // re-instantiated on the same page: the old worker + requestAnimationFrame
    // loop survive and fight the new instance for the canvas, which is exactly
    // what left the preview frozen after a rebuild. loadGame swaps the cart
    // in-place on the running core.
    if (moduleRef.current) {
      await loadFreshRomIntoModule(moduleRef.current);
      return;
    }
    await boot();
  };

  // Heartbeat sampler - once per second, derive fps from the frame counter so
  // the toolbar shows whether the core is actually stepping. This is the single
  // signal that distinguishes a stalled core (0 fps) from an input/display
  // problem (≈60 fps but the user sees no change), so a "frozen" report can be
  // triaged without guessing.
  useEffect(() => {
    if (state.kind !== 'running') {
      setFps(null);
      setFrozenStall(false);
      return;
    }
    lastFrameSampleRef.current = frameCountRef.current;
    let loggedZero = false;
    let zeroStreak = 0;
    const id = setInterval(() => {
      const total = frameCountRef.current;
      const delta = total - lastFrameSampleRef.current;
      lastFrameSampleRef.current = total;
      setFps(delta);
      if (delta === 0) {
        zeroStreak += 1;
        if (!loggedZero) {
          loggedZero = true;
           
          console.warn(
            `[emulator] 0 fps - core is not stepping (frozen). total frames=${String(total)}, ` +
              `crossOriginIsolated=${String(globalThis.crossOriginIsolated)}. ` +
              'This is an emulation/worker stall, not a keyboard issue.',
          );
        }
        // 3 consecutive idle seconds ⇒ the runtime is wedged (a stale/leaked
        // mGBA instance). Surface a one-click page-reload recovery.
        if (zeroStreak >= 3) setFrozenStall(true);
      } else {
        zeroStreak = 0;
        loggedZero = false;
        setFrozenStall(false);
      }
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [state.kind]);

  // Keyboard handling - pipe pressed/released GBA-mapped keys to the
  // emulator. Listens only while running (so editing forms outside the
  // emulator don't get hijacked).
  useEffect(() => {
    if (state.kind !== 'running') return;
    const onDown = (e: KeyboardEvent): void => {
      const btn = KEY_TO_BUTTON[e.key];
      if (!btn) return;
      const emu = moduleRef.current;
      if (emu && typeof emu.buttonPress === 'function') {
        e.preventDefault();
        emu.buttonPress(btn);
      }
    };
    const onUp = (e: KeyboardEvent): void => {
      const btn = KEY_TO_BUTTON[e.key];
      if (!btn) return;
      const emu = moduleRef.current;
      if (emu && typeof emu.buttonUnpress === 'function') {
        e.preventDefault();
        emu.buttonUnpress(btn);
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [state.kind]);

  // WP-B v2.3 - clear the reactive emulator slice when this component
  // unmounts (e.g. user navigates away from the Play view) so any
  // mounted DebugMenu collapses to its empty state instead of holding
  // a dead module reference.
  useEffect(() => {
    return () => {
      // Stop the emulation loop when leaving the Play view so a detached
      // runtime doesn't keep stepping (and fighting a future instance) in the
      // background. Best-effort - pauseGame is a no-op if already paused.
      try {
        moduleRef.current?.pauseGame?.();
      } catch {
        /* best-effort */
      }
      setEmulatorIdle();
    };
  }, [setEmulatorIdle]);

  const stateLabel = useMemo(() => {
    switch (state.kind) {
      case 'idle':
        return 'Ready to boot';
      case 'building':
        return 'Building ROM…';
      case 'loading-wasm':
        return 'Loading emulator (one-time WASM download)…';
      case 'fetching-rom':
        return 'Loading ROM…';
      case 'booting':
        return 'Booting…';
      case 'running': {
        const beat =
          fps === null
            ? ''
            : fps === 0
              ? ' · ⚠ 0 fps (frozen - core not stepping)'
              : ` · ${String(fps)} fps`;
        return `Running${beat} · keyboard: arrows + Z/X (B/A) + A/S (L/R) + Enter/Backspace (Start/Select)`;
      }
      case 'paused':
        return 'Paused';
      case 'error':
        return `Error: ${state.message}`;
    }
  }, [state, fps]);

  return (
    <div className="emulator-host" data-testid="emulator-host">
      <header className="emulator-host__header">
        <div className="emulator-host__title">Live game preview</div>
        <div className="emulator-host__actions">
          {/* WP-B v2.3 - Debug menu overlay. Rendered before the Play
              button so the toggle sits leftmost in the toolbar. The
              menu gates itself on the emulator-state slice - when
              idle it shows a "Boot the game first" hint. */}
          <DebugMenu />
          {state.kind === 'idle' && (
            <>
              <button
                type="button"
                className="emulator-host__btn emulator-host__btn--primary"
                onClick={() => void buildAndPlay()}
                data-testid="emulator-host-build-play"
                disabled={!sessionId}
                title={
                  sessionId
                    ? 'Compile your edits to a fresh ROM, then boot it'
                    : 'Open a project first'
                }
              >
                🔨 Build &amp; Play
              </button>
              <button
                type="button"
                className="emulator-host__btn"
                onClick={() => void boot()}
                data-testid="emulator-host-play"
                disabled={!sessionId}
                title={
                  sessionId
                    ? 'Boot the last-built ROM without rebuilding'
                    : 'Open a project first'
                }
              >
                ▶ Play last build
              </button>
            </>
          )}
          {state.kind === 'building' && (
            <button
              type="button"
              className="emulator-host__btn"
              disabled
              data-testid="emulator-host-building"
            >
              ⏳ Building…
            </button>
          )}
          {state.kind === 'running' && (
            <button
              type="button"
              className="emulator-host__btn"
              onClick={pause}
              data-testid="emulator-host-pause"
            >
              ⏸ Pause
            </button>
          )}
          {state.kind === 'paused' && (
            <button
              type="button"
              className="emulator-host__btn emulator-host__btn--primary"
              onClick={resume}
              data-testid="emulator-host-resume"
            >
              ▶ Resume
            </button>
          )}
          {state.kind === 'error' && (
            <button
              type="button"
              className="emulator-host__btn"
              onClick={() => setState({ kind: 'idle' })}
              data-testid="emulator-host-reset"
            >
              Reset
            </button>
          )}
          {(state.kind === 'running' || state.kind === 'paused') && (
            <button
              type="button"
              className="emulator-host__btn"
              onClick={() => void handleResetAndReload()}
              data-testid="emulator-host-reload"
              title="Stop, re-fetch the ROM (picks up your edits), and re-boot"
            >
              ⟳ Reload ROM
            </button>
          )}
          {/* Phase 9C - HUD overlay toggle. Live for any state once
              we've booted; while idle/error it's hidden because the
              overlay has nothing to read. */}
          {(state.kind === 'running' || state.kind === 'paused') && (
            <button
              type="button"
              className={
                'emulator-host__btn' +
                (hudEnabled ? ' emulator-host__btn--primary' : '')
              }
              onClick={() => setHudEnabled((v) => !v)}
              data-testid="emulator-host-hud-toggle"
              title="Toggle the live battle HUD overlay (HP bars + level + species name)"
            >
              {hudEnabled ? '◉ HUD' : '○ HUD'}
            </button>
          )}
          {/* Phase 9E - Music timeline toggle. Same lifecycle as the
              HUD toggle; reads gMPlayInfo_BGM/SE1/SE2/SE3 from IWRAM
              every 500ms. */}
          {(state.kind === 'running' || state.kind === 'paused') && (
            <button
              type="button"
              className={
                'emulator-host__btn' +
                (musicEnabled ? ' emulator-host__btn--primary' : '')
              }
              onClick={() => setMusicEnabled((v) => !v)}
              data-testid="emulator-host-music-toggle"
              title="Toggle the music timeline overlay (current BGM + SE slot playback)"
            >
              {musicEnabled ? '◉ Music' : '○ Music'}
            </button>
          )}
        </div>
      </header>
      <div className="emulator-host__status" data-testid="emulator-host-status">
        {stateLabel}
      </div>
      {state.kind === 'building' && (
        <pre
          ref={buildLogRef}
          data-testid="emulator-host-build-log"
          style={{
            margin: '4px 0',
            padding: '8px',
            maxHeight: '180px',
            overflow: 'auto',
            fontSize: '11px',
            lineHeight: 1.4,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            background: 'var(--surface-sunken, #111)',
            color: 'var(--text-muted, #b8b8b8)',
            border: '1px solid var(--border-subtle, #2a2a2a)',
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {state.log}
        </pre>
      )}
      {/* Phase 4.1A - Named save-state library toolbar. Replaces the
          previous 3-slot "Slot 1 / 2 / 3" UI. The library shows up
          whenever a project is open (even before boot - capturing
          requires the emulator to be running, but loading/browsing
          the saved list does not). */}
      <div className="emulator-host__debug" data-testid="emulator-host-debug">
        <SaveStateLibrary
          sessionId={sessionId}
          host={moduleRef.current as SaveStateEmulatorHost | null}
          emulatorActive={state.kind === 'running' || state.kind === 'paused'}
        />
        <SceneBootPicker
          sessionId={sessionId}
          host={moduleRef.current as SceneBootEmulatorHost | null}
          emulatorActive={state.kind === 'running' || state.kind === 'paused'}
        />
      </div>
      <div className="emulator-host__canvas-wrap">
        <canvas
          ref={canvasRef}
          id="emulator-canvas"
          width={240}
          height={160}
          className="emulator-host__canvas"
          data-testid="emulator-host-canvas"
          tabIndex={0}
          // Click to (re)focus so mGBA's keyboard input receives keys. Without
          // focus the canvas-target SDL handler is dormant and the game ignores
          // input even though it's running.
          onClick={() => canvasRef.current?.focus()}
          onPointerDown={() => canvasRef.current?.focus()}
        />
        {frozenStall && state.kind === 'running' && (
          <div className="emulator-host__stall" data-testid="emulator-host-stall" role="alert">
            <div className="emulator-host__stall-card">
              <strong>Emulator runtime stalled (0 fps).</strong>
              <p>
                The mGBA WASM runtime can&apos;t restart on a live page. Reload the page for a
                clean runtime, then Build &amp; Play again.
              </p>
              <button
                type="button"
                className="emulator-host__btn emulator-host__btn--primary"
                onClick={() => window.location.reload()}
                data-testid="emulator-host-stall-reload"
              >
                ↻ Reload page
              </button>
            </div>
          </div>
        )}
        {/* Phase 9C - Battle HUD overlay layered over the canvas.
            Reads BattleMon structs from EWRAM every 500ms. Default
            off; user toggles via the toolbar Hud button. */}
        <HudOverlay
          host={moduleRef.current as EmulatorMemoryHostType | null}
          emulatorActive={state.kind === 'running' || state.kind === 'paused'}
          enabled={hudEnabled}
        />
        {/* Phase 9E - Music timeline. Same shape as the HUD overlay;
            sits at the bottom of the canvas-wrap so the two don't
            collide visually when both are on. */}
        <MusicTimeline
          host={moduleRef.current as EmulatorMemoryHostType | null}
          emulatorActive={state.kind === 'running' || state.kind === 'paused'}
          enabled={musicEnabled}
        />
      </div>
    </div>
  );
}

/** Exposed for the DebugMenu sibling component so it can write to the
 *  running emulator's WRAM (set flags, give items, etc.) without
 *  threading the module through React props/context. */
export function getActiveEmulatorModule(): EmulatorInstance | null {
  return _emulatorModuleSingleton;
}

let _emulatorModuleSingleton: EmulatorInstance | null = null;

export function _setEmulatorModuleForTests(emu: EmulatorInstance | null): void {
  _emulatorModuleSingleton = emu;
}
