import type {
  HealLocationEntry,
  LayoutCellDecoded,
  ObjectEvent,
  Trigger,
  Warp,
} from '@rom-editor/shared';

export interface TileGrid {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<LayoutCellDecoded>;
}

export interface MapSceneOptions {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly layers: ReadonlySet<
    | 'tiles'
    | 'collision'
    | 'objects'
    | 'warps'
    | 'triggers'
    | 'healLocations'
    | 'visionCones'
  >;
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly warps: ReadonlyArray<Warp>;
  readonly triggers: ReadonlyArray<Trigger>;
  /** Phase O.47 - heal-location pins for this map. Each entry is one
   *  SPAWN_* destination; the MapEditor caller filters
   *  manifest.healLocations[] by destMapId === currentMapId before
   *  passing them here. */
  readonly healLocations?: ReadonlyArray<HealLocationEntry>;
  /** Real tile grid from a parsed layout binary. When null, scene falls back
   *  to the line-grid placeholder so the canvas is never blank. */
  readonly tileGrid: TileGrid | null;
  /** Phase UX-C.4 - per-metatile decoded RGBA pixels for binary-rom maps.
   *  When present, drawTileCells renders each cell as a real 16×16 tile
   *  image instead of an HSL-hash placeholder swatch. Map keys are
   *  metatile IDs; values are Uint32Array(256) of u32 RGBA in row-major
   *  order (matches Phase C.1's composeMetatile output). Cells whose
   *  metatileId isn't in the map fall back to the placeholder swatch. */
  readonly metatilePixels?: ReadonlyMap<number, Uint32Array> | null;
  readonly selectedId: string | null;
  readonly groupColor: string;
  readonly onSelect: (kind: 'objectEvent' | 'warp' | 'trigger' | 'healLocation', id: string) => void;
  /** Called on drag-end after snapping to the nearest tile coord. Backend
   *  validation runs server-side via `apiMoveEvent`; callers wire this to
   *  the move-event API + manifest rescan. */
  readonly onMove?: (
    kind: 'objectEvent' | 'warp' | 'trigger' | 'healLocation',
    id: string,
    x: number,
    y: number,
  ) => void;
  /** Phase UX-D - called on cell click in paint mode. (x, y) are
   *  metatile cell coords (already divided by tileSize). The callback
   *  receives the current metatile id at the cell + the active tool
   *  so the caller can route to pencil/fill/eyedropper handlers. */
  readonly onCellClick?: (x: number, y: number, currentMetatileId: number) => void;
  /** Phase UX-E - decoded RGBA bytes per sprite struct file offset
   *  (the OW sprite metadata file offset, exposed on ObjectEvent.
   *  metadata.spriteStructFileOffset by iter-102 cross-ref). When
   *  present, drawObjects renders the real sprite as a PixiJS texture
   *  at each NPC's marker position instead of the colored rectangle.
   *
   *  The Real Game Editor Push - paletteSource carries the backend's
   *  palette-fallback signal so the marker can overlay a "?" badge for
   *  sprites that fell back to the neutral sepia palette (the engine
   *  cross-ref didn't resolve the palette tag). 'detected' = real
   *  in-game colors; 'neutral' = sepia placeholder, user should know. */
  readonly objectEventSprites?: ReadonlyMap<
    number,
    {
      readonly width: number;
      readonly height: number;
      readonly rgba: Uint8ClampedArray;
      readonly paletteSource?: 'detected' | 'neutral';
    }
  > | null;
  /** Phase H-RC7 - when true, overlay each tile cell with its
   *  metatile id (small text label, top-left of the cell). Helps
   *  diagnose visual misalignment bugs by letting the operator
   *  pinpoint which metatile ID is at any given position. Driven by
   *  the "internal ids" toggle in the header. */
  readonly showMetatileIds?: boolean;
  /** Phase H-RC7 - fired on cell hover. (x, y) are metatile cell
   *  coords, `metatileId` is the byte at that cell. Used by the
   *  MapEditor toolbar to display a live "(x,y) → tile #N" readout
   *  for visual diagnosis. */
  readonly onCellHover?: (x: number, y: number, metatileId: number) => void;
  /** Layer-2 canvas-native agent invocation - fired on right-click
   *  (contextmenu DOM event). Receives tile coords (already divided
   *  by tileSize) plus the screen coords of the cursor so the caller
   *  can position a context menu under it. The default contextmenu
   *  is suppressed when this handler is wired. */
  readonly onContextMenu?: (tileX: number, tileY: number, screenX: number, screenY: number) => void;
  /** The Real Game Editor Push - communicates the metatile-pixel
   *  fetch state so the renderer can distinguish "still loading" from
   *  "loaded but a specific cell failed to compose" and "no real-tile
   *  rendering for this map (decomp / unsupported)". Drives the
   *  loading-pattern vs missing-pattern fallbacks instead of the old
   *  HSL-hashed colored swatches.
   *
   *  - 'loading': pixel fetch in flight; render a soft striped pattern.
   *  - 'partial': pixels loaded but at least one cell's metatileId is
   *    missing from the map → cells without textures render as red
   *    diagonals (visible diagnostic).
   *  - 'ready': pixels fully loaded; cells without textures still
   *    fall back to red diagonals so unexpected gaps are visible.
   *  - 'unavailable': this map doesn't get real-tile rendering (e.g.
   *    decomp path); cells render with a uniform neutral pattern,
   *    NOT HSL-hashed colored squares.
   */
  readonly loadingState?: 'loading' | 'partial' | 'ready' | 'unavailable';
}

const HEX = (s: string): number =>
  Number.parseInt(s.startsWith('#') ? s.slice(1) : s, 16);

const COLORS = {
  bg: HEX('1e1f23'),
  grid: HEX('2a2c33'),
  gridStrong: HEX('34363c'),
  collision: HEX('e25555'),
  objectEvent: HEX('b46aff'),
  trainer: HEX('e25555'),
  item: HEX('f0b429'),
  warp: HEX('4a9eff'),
  trigger: HEX('f0b429'),
  healLocation: HEX('50c878'), // Phase O.47 - green pin for heal locations
  visionCone: HEX('e25555'), // Phase O.62 - same red as trainer markers
  wanderBox: HEX('b46aff'), // Phase O.63 - purple-on-purple for wandering NPCs
  selected: HEX('ffffff'),
};

/**
 * Mounts a PixiJS canvas into `host` and renders the map scene per `options`.
 * Returns a teardown function the caller MUST call to destroy the renderer.
 * If PixiJS init fails (e.g. no GPU context in jsdom tests), the host is left
 * with a static fallback marker so React tests can still observe the panel.
 */
export async function renderMapScene(
  host: HTMLDivElement,
  options: MapSceneOptions,
): Promise<() => void> {
  // Lazy-import pixi.js so that the module only loads when the editor actually
  // mounts - keeps cold-start cost off Maps/Project views.
  let pixi: typeof import('pixi.js');
  try {
    pixi = await import('pixi.js');
  } catch (e) {
    return mountFallback(host, `PixiJS unavailable: ${stringifyError(e)}`);
  }

  const { Application, Graphics, Container } = pixi;

  // Phase I.3.3 - size the canvas to the HOST element rather than the
  // map's natural pixel dimensions. Previously a 20×20 map produced a
  // 320×320 canvas inside a much larger column → the user saw lots of
  // wasted space and zooming felt confined. Now the canvas fills the
  // host; we use stage.scale + stage.position to fit the map content
  // initially (and the wheel handler below lets the user zoom past
  // that fit factor in either direction).
  const hostRect = host.getBoundingClientRect();
  const canvasWidth = Math.max(200, Math.floor(hostRect.width));
  const canvasHeight = Math.max(200, Math.floor(hostRect.height));

  const app = new Application();
  try {
    await app.init({
      width: canvasWidth,
      height: canvasHeight,
      background: COLORS.bg,
      antialias: true,
      autoDensity: true,
    });
  } catch (e) {
    return mountFallback(host, `Canvas init failed: ${stringifyError(e)}`);
  }

  host.innerHTML = '';
  host.appendChild(app.canvas);
  // Style the canvas to fill its container so CSS resize is smooth.
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';
  app.canvas.style.display = 'block';

  const world = new Container();
  app.stage.addChild(world);

  // Initial fit-to-canvas: compute the scale that makes the entire map
  // visible with a small margin, center the world container.
  const mapPxW = Math.max(1, options.width);
  const mapPxH = Math.max(1, options.height);
  const fitScale = Math.min(canvasWidth / mapPxW, canvasHeight / mapPxH) * 0.95;
  const initialScale = Math.max(0.25, Math.min(4, fitScale));
  app.stage.scale.set(initialScale, initialScale);
  app.stage.position.set(
    (canvasWidth - mapPxW * initialScale) / 2,
    (canvasHeight - mapPxH * initialScale) / 2,
  );

  // ResizeObserver: when the host element changes size (window resize,
  // sidebar toggle, etc.), resize the Pixi renderer to match and
  // re-fit the world to the new canvas dimensions.
  const resizeObserver = new ResizeObserver(() => {
    const rect = host.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(200, Math.floor(rect.height));
    app.renderer.resize(w, h);
    // Re-fit the world but preserve the user's zoom if they've already
    // wheel-zoomed away from the initial fit. We only re-center.
    app.stage.position.set(
      (w - mapPxW * app.stage.scale.x) / 2,
      (h - mapPxH * app.stage.scale.y) / 2,
    );
  });
  resizeObserver.observe(host);

  if (options.layers.has('tiles')) {
    if (options.tileGrid) {
      // The Real Game Editor Push - drawRealTileCells is now the
      // canonical tile-drawing path. It handles all four loading-state
      // cases:
      //   - 'loading'    → soft striped pattern (no metatilePixels yet)
      //   - 'partial' /
      //     'ready'      → real tile sprites; per-cell red diagonals
      //                    for missing metatile composition
      //   - 'unavailable'→ uniform neutral pattern (decomp path)
      // Replaces the old branch that fell back to HSL-hashed colored
      // swatches when metatilePixels was empty.
      await drawRealTileCells(world, options, pixi);
    } else {
      drawGrid(world, options, Graphics);
    }
  }

  // Phase UX-D - paint-mode cell click handler. Hooked to the canvas
  // DOM element rather than a PixiJS stage event so it fires even when
  // the click lands on a (non-pickable) tile texture. Markers register
  // their own pointerdown handlers + stopPropagation so paint clicks
  // don't fire when the user clicks an event marker.
  if (options.onCellClick && options.tileGrid) {
    const cellClickHandler = (evt: MouseEvent) => {
      // Only fire for left clicks; ignore middle/right (reserved for
      // future selection-rectangle / context-menu features).
      if (evt.button !== 0) return;
      const rect = app.canvas.getBoundingClientRect();
      // Convert browser coords → canvas coords → world coords (Phase
      // I.3.3 - account for stage scale + position now that the canvas
      // fills the host and the world is transformed inside it) → cell coords.
      const cx = evt.clientX - rect.left;
      const cy = evt.clientY - rect.top;
      const canvasScaleX = app.canvas.width / rect.width;
      const canvasScaleY = app.canvas.height / rect.height;
      const stageScale = app.stage.scale.x || 1;
      const worldX = (cx * canvasScaleX - app.stage.position.x) / stageScale;
      const worldY = (cy * canvasScaleY - app.stage.position.y) / stageScale;
      const tileX = Math.floor(worldX / options.tileSize);
      const tileY = Math.floor(worldY / options.tileSize);
      if (
        tileX < 0 ||
        tileY < 0 ||
        tileX >= options.tileGrid!.width ||
        tileY >= options.tileGrid!.height
      ) {
        return;
      }
      const cell = options.tileGrid!.cells[tileY * options.tileGrid!.width + tileX];
      const metatileId = cell?.metatileId ?? 0;
      options.onCellClick!(tileX, tileY, metatileId);
    };
    app.canvas.addEventListener('click', cellClickHandler);
    // Cache the handler for teardown via a stage __cellClickHandler ref.
    (app.canvas as unknown as { __cellClickHandler?: typeof cellClickHandler }).__cellClickHandler =
      cellClickHandler;
  }

  // Layer 2 - right-click → onContextMenu(tileX, tileY, screenX, screenY).
  // Mirrors the coord-conversion math from the click handler so the menu
  // anchors on the tile the user actually clicked, and uses clientX/Y so
  // the caller can render a position:fixed popover at the cursor.
  if (options.onContextMenu && options.tileGrid) {
    const contextHandler = (evt: MouseEvent) => {
      const rect = app.canvas.getBoundingClientRect();
      const cx = evt.clientX - rect.left;
      const cy = evt.clientY - rect.top;
      const canvasScaleX = app.canvas.width / rect.width;
      const canvasScaleY = app.canvas.height / rect.height;
      const stageScale = app.stage.scale.x || 1;
      const worldX = (cx * canvasScaleX - app.stage.position.x) / stageScale;
      const worldY = (cy * canvasScaleY - app.stage.position.y) / stageScale;
      const tileX = Math.floor(worldX / options.tileSize);
      const tileY = Math.floor(worldY / options.tileSize);
      if (
        tileX < 0 ||
        tileY < 0 ||
        tileX >= options.tileGrid!.width ||
        tileY >= options.tileGrid!.height
      ) {
        return;
      }
      // Suppress the browser's default context menu only when the click
      // lands inside the map - outside, let the browser menu open normally
      // (e.g. for inspect-element in dev).
      evt.preventDefault();
      options.onContextMenu!(tileX, tileY, evt.clientX, evt.clientY);
    };
    app.canvas.addEventListener('contextmenu', contextHandler);
    (app.canvas as unknown as { __contextMenuHandler?: typeof contextHandler }).__contextMenuHandler =
      contextHandler;
  }

  // Phase H-RC7 - pointer-move handler that reports the hovered cell
  // + its metatile id. Coordinates derived the same way as the click
  // handler. Cached on the canvas for teardown via __cellHoverHandler.
  //
  // Phase I.0.1 - flicker fix: pointermove fires on every pixel of
  // motion, but the readout only changes when the cursor crosses into
  // a new metatile cell. Diff against the last-reported cell here so
  // React state only updates on actual cell changes - this also stops
  // PixiScene's parent from re-rendering on every mouse pixel.
  if (options.onCellHover && options.tileGrid) {
    let lastTileX = -1;
    let lastTileY = -1;
    const cellHoverHandler = (evt: MouseEvent) => {
      const rect = app.canvas.getBoundingClientRect();
      const cx = evt.clientX - rect.left;
      const cy = evt.clientY - rect.top;
      // Account for canvas CSS scaling and Pixi stage zoom.
      const stageScale = app.stage.scale.x || 1;
      const stageOffsetX = app.stage.position.x || 0;
      const stageOffsetY = app.stage.position.y || 0;
      const scaleX = app.canvas.width / rect.width;
      const scaleY = app.canvas.height / rect.height;
      const worldX = (cx * scaleX - stageOffsetX) / stageScale;
      const worldY = (cy * scaleY - stageOffsetY) / stageScale;
      const tileX = Math.floor(worldX / options.tileSize);
      const tileY = Math.floor(worldY / options.tileSize);
      if (
        tileX < 0 ||
        tileY < 0 ||
        tileX >= options.tileGrid!.width ||
        tileY >= options.tileGrid!.height
      ) {
        return;
      }
      if (tileX === lastTileX && tileY === lastTileY) return;
      lastTileX = tileX;
      lastTileY = tileY;
      const cell = options.tileGrid!.cells[tileY * options.tileGrid!.width + tileX];
      const metatileId = cell?.metatileId ?? 0;
      options.onCellHover!(tileX, tileY, metatileId);
    };
    app.canvas.addEventListener('pointermove', cellHoverHandler);
    (app.canvas as unknown as { __cellHoverHandler?: typeof cellHoverHandler }).__cellHoverHandler =
      cellHoverHandler;
  }

  // Phase I.0.3 - mouse-wheel zoom anchored to the cursor's world
  // position. Without this the only way to see fine tile detail is to
  // resize the browser window. The wheel listener scales `app.stage`
  // and adjusts its position so the cursor stays on the same world
  // pixel pre- and post-zoom. Bounded [0.25, 4] so users can't lose the
  // map by zooming too far in or out.
  const wheelHandler = (evt: WheelEvent) => {
    evt.preventDefault();
    const oldScale = app.stage.scale.x || 1;
    const factor = evt.deltaY > 0 ? 1 / 1.1 : 1.1;
    const newScale = Math.max(0.25, Math.min(4, oldScale * factor));
    if (newScale === oldScale) return;
    const rect = app.canvas.getBoundingClientRect();
    const canvasScaleX = app.canvas.width / rect.width;
    const canvasScaleY = app.canvas.height / rect.height;
    const cx = (evt.clientX - rect.left) * canvasScaleX;
    const cy = (evt.clientY - rect.top) * canvasScaleY;
    const worldX = (cx - app.stage.position.x) / oldScale;
    const worldY = (cy - app.stage.position.y) / oldScale;
    app.stage.scale.set(newScale, newScale);
    app.stage.position.set(cx - worldX * newScale, cy - worldY * newScale);
  };
  app.canvas.addEventListener('wheel', wheelHandler, { passive: false });
  (app.canvas as unknown as { __wheelHandler?: typeof wheelHandler }).__wheelHandler =
    wheelHandler;

  if (options.layers.has('collision')) {
    if (options.tileGrid) {
      drawCollisionFromCells(world, options, Graphics);
    } else {
      drawCollisionPlaceholder(world, options, Graphics);
    }
  }

  if (options.layers.has('objects')) {
    drawObjects(world, options, pixi);
  }

  if (options.layers.has('warps')) {
    drawWarps(world, options, Graphics);
  }

  if (options.layers.has('triggers')) {
    drawTriggers(world, options, Graphics);
  }

  if (options.layers.has('healLocations')) {
    drawHealLocations(world, options, Graphics);
  }

  if (options.layers.has('visionCones')) {
    drawVisionCones(world, options, Graphics);
  }

  return () => {
    try {
      resizeObserver.disconnect();
      const handler = (app.canvas as unknown as { __cellClickHandler?: (e: MouseEvent) => void })
        .__cellClickHandler;
      if (handler) app.canvas.removeEventListener('click', handler);
      const hoverHandler = (
        app.canvas as unknown as { __cellHoverHandler?: (e: MouseEvent) => void }
      ).__cellHoverHandler;
      if (hoverHandler) app.canvas.removeEventListener('pointermove', hoverHandler);
      const wheelHandlerRef = (
        app.canvas as unknown as { __wheelHandler?: (e: WheelEvent) => void }
      ).__wheelHandler;
      if (wheelHandlerRef) app.canvas.removeEventListener('wheel', wheelHandlerRef);
      const ctxHandler = (
        app.canvas as unknown as { __contextMenuHandler?: (e: MouseEvent) => void }
      ).__contextMenuHandler;
      if (ctxHandler) app.canvas.removeEventListener('contextmenu', ctxHandler);
      app.destroy(true, { children: true });
    } catch {
      /* renderer may already be torn down */
    }
    host.innerHTML = '';
  };
}

type PixiContainer = import('pixi.js').Container;

function drawGrid(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const g = new GraphicsCtor();
  const { width, height, tileSize } = opts;
  // Fine grid every tile, strong grid every 8 tiles for orientation.
  for (let x = 0; x <= width; x += tileSize) {
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke({
      color: x % (tileSize * 8) === 0 ? COLORS.gridStrong : COLORS.grid,
      width: 1,
    });
  }
  for (let y = 0; y <= height; y += tileSize) {
    g.moveTo(0, y);
    g.lineTo(width, y);
    g.stroke({
      color: y % (tileSize * 8) === 0 ? COLORS.gridStrong : COLORS.grid,
      width: 1,
    });
  }
  world.addChild(g);
}

function drawCollisionPlaceholder(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const g = new GraphicsCtor();
  g.rect(0, 0, opts.width, opts.height);
  g.stroke({ color: COLORS.collision, width: 2, alpha: 0.3 });
  world.addChild(g);
}

/**
 * Phase UX-C.4 + The Real Game Editor Push - real tile rendering. For
 * each unique metatile id in the tile grid, builds an offscreen-canvas
 * RGBA bitmap from the provided 256-pixel Uint32Array, wraps it as a
 * PixiJS Texture, then places one Sprite per cell.
 *
 * Per-cell fallbacks (no longer HSL-hashed colored swatches):
 *  - 'loading' state with no metatilePixels → soft striped pattern
 *    indicating "fetching tile graphics" (entire grid)
 *  - 'unavailable' (decomp / no real-tile rendering supported here) →
 *    uniform neutral pattern with cell boundaries
 *  - 'partial' / 'ready' with a specific metatile id missing from the
 *    pixel cache → red diagonals so the operator can SEE the gap
 *    instead of seeing a plausible-looking colored square that hides
 *    a real composition failure
 */
async function drawRealTileCells(
  world: PixiContainer,
  opts: MapSceneOptions,
  pixi: typeof import('pixi.js'),
): Promise<void> {
  const grid = opts.tileGrid!;
  const pixels = opts.metatilePixels ?? null;
  const { tileSize } = opts;
  const { Sprite, Texture, Graphics } = pixi;
  const loadingState = opts.loadingState ?? (pixels && pixels.size > 0 ? 'ready' : 'loading');

  // Whole-grid pattern modes: when we have no metatile pixels at all
  // (decomp 'unavailable' OR pixel fetch still 'loading'), short-circuit
  // to a uniform pattern rendered once instead of per-cell sprites.
  if (loadingState === 'loading' || loadingState === 'unavailable' || pixels === null || pixels.size === 0) {
    drawWholeGridPattern(world, opts, Graphics, loadingState);
    return;
  }

  // Build per-metatile textures once, indexed by metatile id. PixiJS 8
  // accepts a CanvasSource; we draw the 16×16 pixels into an offscreen
  // canvas + wrap it.
  const textureByMetatileId = new Map<number, import('pixi.js').Texture>();
  const seenIds = new Set<number>();
  for (const cell of grid.cells) {
    if (!cell) continue;
    seenIds.add(cell.metatileId);
  }
  for (const metatileId of seenIds) {
    const px = pixels.get(metatileId);
    if (!px) continue;
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const imageData = ctx.createImageData(16, 16);
    // px is Uint32Array(256) in little-endian RGBA - copy via a Uint8 view.
    const u8 = new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
    imageData.data.set(u8);
    ctx.putImageData(imageData, 0, 0);
    const texture = Texture.from(canvas);
    // Pixel-art look - no filtering, crisp scaling.
    texture.source.scaleMode = 'nearest';
    textureByMetatileId.set(metatileId, texture);
  }

  // Draw each cell.
  const missingG = new Graphics();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells[y * grid.width + x];
      if (!cell) continue;
      const tex = textureByMetatileId.get(cell.metatileId);
      if (tex) {
        const sprite = new Sprite(tex);
        sprite.x = x * tileSize;
        sprite.y = y * tileSize;
        sprite.width = tileSize;
        sprite.height = tileSize;
        world.addChild(sprite);
      } else {
        // The Real Game Editor Push - visible red diagonals for
        // missing metatile composition. No more HSL-hashed colored
        // swatches that masked real bugs as "decorative tiles".
        drawMissingPattern(missingG, x * tileSize, y * tileSize, tileSize);
      }
    }
  }
  // Always add the missing-pattern graphics layer - its child geometry
  // only gets non-empty when a cell's metatileId was missing from the
  // pixel cache, but adding the empty container is harmless.
  world.addChild(missingG);

  // Thin grid overlay for tile boundaries.
  const overlay = new Graphics();
  for (let x = 0; x <= grid.width; x++) {
    overlay.moveTo(x * tileSize, 0);
    overlay.lineTo(x * tileSize, grid.height * tileSize);
  }
  for (let y = 0; y <= grid.height; y++) {
    overlay.moveTo(0, y * tileSize);
    overlay.lineTo(grid.width * tileSize, y * tileSize);
  }
  overlay.stroke({ color: COLORS.grid, width: 1, alpha: 0.25 });
  world.addChild(overlay);

  // Phase H-RC7 (semantic-world plan §H.7) - when the operator
  // toggled "internal ids" on, overlay each cell with its metatile
  // ID + a stronger grid. Lets the user pinpoint visual misalignment
  // bugs (e.g. the "tree fragment out of place" the user reported)
  // by reading off the offending tile's ID. PixiJS doesn't ship a
  // lightweight text helper, so we render the IDs via an HTML
  // overlay rendered alongside the canvas in MapEditor.tsx instead
  // of inside the WebGL scene. (Drawing N×M Text objects per tile
  // would crater perf on large maps.) The strong grid is cheap and
  // helps eyeball alignment.
  if (opts.showMetatileIds) {
    const strongGrid = new Graphics();
    for (let x = 0; x <= grid.width; x++) {
      strongGrid.moveTo(x * tileSize, 0);
      strongGrid.lineTo(x * tileSize, grid.height * tileSize);
    }
    for (let y = 0; y <= grid.height; y++) {
      strongGrid.moveTo(0, y * tileSize);
      strongGrid.lineTo(grid.width * tileSize, y * tileSize);
    }
    strongGrid.stroke({ color: COLORS.gridStrong, width: 1, alpha: 0.55 });
    world.addChild(strongGrid);
  }
}

/** The Real Game Editor Push - replaces the old HSL-hashed colored
 *  swatches with a uniform whole-grid fallback. Two modes:
 *    - 'loading' / null pixels: soft diagonal stripes (gentle, indicates
 *      "fetching", not "broken").
 *    - 'unavailable' (decomp / no real-tile rendering path): uniform
 *      neutral grid (charcoal) with thin cell boundaries.
 *  Replaces drawTileCells entirely so no map ever shows HSL-hashed
 *  rainbow placeholders again. */
function drawWholeGridPattern(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
  mode: 'loading' | 'partial' | 'ready' | 'unavailable',
): void {
  const grid = opts.tileGrid!;
  const { tileSize } = opts;
  const totalW = grid.width * tileSize;
  const totalH = grid.height * tileSize;

  // Background fill - slightly different tones for loading vs unavailable
  // so the operator can tell them apart at a glance.
  const bg = new GraphicsCtor();
  bg.rect(0, 0, totalW, totalH);
  bg.fill({
    color: mode === 'loading' ? HEX('1a1d24') : HEX('22252c'),
    alpha: 1,
  });
  world.addChild(bg);

  // For 'loading', overlay soft diagonal stripes so it reads as a
  // progress indicator rather than a finished render. Stripes spaced
  // every 12px at 45° with low opacity.
  if (mode === 'loading') {
    const stripes = new GraphicsCtor();
    const spacing = 12;
    const stripeColor = HEX('2f343d');
    for (let d = -totalH; d < totalW; d += spacing) {
      stripes.moveTo(d, 0);
      stripes.lineTo(d + totalH, totalH);
      stripes.stroke({ color: stripeColor, width: 4, alpha: 0.55 });
    }
    world.addChild(stripes);
  }

  // Thin cell-boundary grid so the operator can still tell tile coords
  // apart even when no real tiles are rendered.
  const overlay = new GraphicsCtor();
  for (let x = 0; x <= grid.width; x++) {
    overlay.moveTo(x * tileSize, 0);
    overlay.lineTo(x * tileSize, totalH);
  }
  for (let y = 0; y <= grid.height; y++) {
    overlay.moveTo(0, y * tileSize);
    overlay.lineTo(totalW, y * tileSize);
  }
  overlay.stroke({ color: COLORS.grid, width: 1, alpha: 0.4 });
  world.addChild(overlay);
}

/** The Real Game Editor Push - visible red diagonal hatching for a
 *  cell whose metatile composition failed. Renders inside the per-cell
 *  "missing" graphics layer in drawRealTileCells.
 *
 *  The hatching is intentionally loud: the operator should immediately
 *  notice that a cell didn't render. Previously these cells got HSL-
 *  hashed colored squares that looked like decorative tile variety,
 *  hiding real composition bugs in plain sight. */
function drawMissingPattern(
  g: import('pixi.js').Graphics,
  x: number,
  y: number,
  size: number,
): void {
  // Dark red background so the diagonals read clearly.
  g.rect(x, y, size, size);
  g.fill({ color: HEX('3a1416'), alpha: 0.9 });
  // Two diagonal red strokes (X shape) - small and dense so the cell
  // pattern reads as "warning" not "decoration".
  g.moveTo(x, y);
  g.lineTo(x + size, y + size);
  g.stroke({ color: HEX('e25555'), width: 2, alpha: 0.95 });
  g.moveTo(x + size, y);
  g.lineTo(x, y + size);
  g.stroke({ color: HEX('e25555'), width: 2, alpha: 0.95 });
}

function drawCollisionFromCells(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const grid = opts.tileGrid!;
  const { tileSize } = opts;
  const g = new GraphicsCtor();
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = grid.cells[y * grid.width + x];
      if (!cell || cell.collision === 0) continue;
      // Stronger red tint for higher-collision cells.
      const alpha = 0.25 + (cell.collision / 3) * 0.45;
      g.rect(x * tileSize, y * tileSize, tileSize, tileSize);
      g.fill({ color: COLORS.collision, alpha });
    }
  }
  world.addChild(g);
}


/** Phase L - extract the numeric graphics id from an object event's
 *  graphicsId string (`gfx_5` → 5). Used by the marker fallback to
 *  render the id inside the marker so the user can distinguish NPCs
 *  even when the OW sprite decoder hasn't fired. */
function graphicsIdNumber(o: import('@rom-editor/shared').ObjectEvent): number | null {
  if (!o.graphicsId) return null;
  const m = /^gfx_(\d+)$/.exec(o.graphicsId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** Phase L - small pixel-art silhouette per object-event kind. Renders
 *  inside the marker so the user gets a visual hint of what kind of
 *  entity is here even when the real sprite hasn't decoded.
 *
 *  NPC: humanoid (round head + body trapezoid)
 *  Trainer: NPC + sword diagonal (small line)
 *  Item: filled circle (Poké Ball-ish) */
function drawKindSilhouette(
  g: import('pixi.js').Graphics,
  kind: import('@rom-editor/shared').ObjectEventKind,
  tileSize: number,
): void {
  const cx = tileSize / 2;
  const headR = tileSize * 0.18;
  const headY = tileSize * 0.32;
  if (kind === 'item') {
    // Filled circle (Pokéball-style)
    g.circle(cx, tileSize / 2, tileSize * 0.32);
    g.fill({ color: 0xffffff, alpha: 0.85 });
    g.moveTo(tileSize * 0.16, tileSize / 2);
    g.lineTo(tileSize * 0.84, tileSize / 2);
    g.stroke({ color: 0x000000, alpha: 0.6, width: 1 });
    return;
  }
  // Humanoid silhouette for NPC + trainer
  g.circle(cx, headY, headR);
  g.fill({ color: 0xffffff, alpha: 0.9 });
  g.moveTo(cx - tileSize * 0.22, tileSize * 0.85);
  g.lineTo(cx - tileSize * 0.12, headY + headR);
  g.lineTo(cx + tileSize * 0.12, headY + headR);
  g.lineTo(cx + tileSize * 0.22, tileSize * 0.85);
  g.closePath();
  g.fill({ color: 0xffffff, alpha: 0.85 });
  if (kind === 'trainer') {
    // Sword: diagonal line bottom-right
    g.moveTo(cx + tileSize * 0.16, tileSize * 0.5);
    g.lineTo(cx + tileSize * 0.38, tileSize * 0.78);
    g.stroke({ color: 0x000000, alpha: 0.7, width: 1 });
  }
}

function drawObjects(
  world: PixiContainer,
  opts: MapSceneOptions,
  pixi: typeof import('pixi.js'),
): void {
  const { tileSize, objectEvents, selectedId, onSelect, objectEventSprites } = opts;
  const { Graphics, Sprite, Text, Texture, Container } = pixi;
  for (const o of objectEvents) {
    // Phase UX-E - prefer rendering the real OW sprite when we have
    // its decoded pixels for this object event (keyed by the
    // structFileOffset stashed on metadata by iter-102 cross-ref).
    const spriteStructFileOffset = typeof o.metadata['spriteStructFileOffset'] === 'number'
      ? (o.metadata['spriteStructFileOffset'] as number)
      : null;
    const sprite =
      spriteStructFileOffset !== null && objectEventSprites
        ? objectEventSprites.get(spriteStructFileOffset)
        : null;
    if (sprite) {
      // Build an offscreen-canvas Texture from the RGBA pixels, then
      // place a Sprite at the marker's coord. Anchor at (0.5, 1.0) so
      // the sprite's feet land on the metatile cell (Gen-3 OW sprites
      // are drawn "feet at coord" - the tile is the floor under them).
      const canvas = document.createElement('canvas');
      canvas.width = sprite.width;
      canvas.height = sprite.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imageData = ctx.createImageData(sprite.width, sprite.height);
        imageData.data.set(sprite.rgba);
        ctx.putImageData(imageData, 0, 0);
        const texture = Texture.from(canvas);
        texture.source.scaleMode = 'nearest';
        const pixiSprite = new Sprite(texture);
        pixiSprite.anchor.set(0.5, 1);
        pixiSprite.x = o.coord.x * tileSize + tileSize / 2;
        // Y at the bottom of the metatile so feet land on the cell.
        pixiSprite.y = (o.coord.y + 1) * tileSize;
        // Scale to keep sprites at a sensible size - render at 1×
        // (native pixel size). If sprites look too small at large
        // canvas zooms, the existing tile-size scaling kicks in.
        // PixiJS sprites are pickable for the marker click handler.
        wireMarker(pixiSprite, opts, 'objectEvent', o.id, o.coord.x, o.coord.y, onSelect);
        // Selection highlight: small outline rect around the marker cell.
        if (o.id === selectedId) {
          const outline = new Graphics();
          outline.rect(0, 0, tileSize, tileSize);
          outline.stroke({ color: COLORS.selected, width: 2 });
          outline.x = o.coord.x * tileSize;
          outline.y = o.coord.y * tileSize;
          world.addChild(outline);
        }
        world.addChild(pixiSprite);
        // Phase O.59 - trainer badge: tiny red sword icon in the
        // top-right of the cell when this NPC is a trainer. The
        // decoded-sprite path renders the actual character, so
        // without this overlay the operator can't tell a trainer
        // from a regular NPC at a glance. The fallback colored-
        // marker path already distinguishes them via COLORS.trainer
        // - this brings parity to the happy path.
        if (o.kind === 'trainer') {
          const badge = new Graphics();
          const bx = (o.coord.x + 1) * tileSize - tileSize * 0.3;
          const by = o.coord.y * tileSize + tileSize * 0.05;
          // Small filled red triangle pointing down + a thin sword
          // line - enough to read at the typical map zoom level.
          badge.moveTo(bx, by);
          badge.lineTo(bx + tileSize * 0.25, by);
          badge.lineTo(bx + tileSize * 0.125, by + tileSize * 0.22);
          badge.closePath();
          badge.fill({ color: COLORS.trainer, alpha: 0.95 });
          badge.stroke({ color: 0xffffff, width: 1, alpha: 0.7 });
          world.addChild(badge);
        }
        // Phase O.60 - item badge: tiny yellow diamond (star-like
        // sparkle) in the top-right when this object event is an
        // item (Poké Ball, hidden Itemfinder spot). Mirrors O.59's
        // trainer badge so all three ObjectEventKind values
        // (npc / trainer / item) get a visible cue on the decoded-
        // sprite path. NPC kind gets no badge - it's the default.
        if (o.kind === 'item') {
          const badge = new Graphics();
          const cxBadge =
            (o.coord.x + 1) * tileSize - tileSize * 0.18;
          const cyBadge = o.coord.y * tileSize + tileSize * 0.18;
          const r = tileSize * 0.13;
          // Diamond: 4-point star approximation.
          badge.moveTo(cxBadge, cyBadge - r);
          badge.lineTo(cxBadge + r, cyBadge);
          badge.lineTo(cxBadge, cyBadge + r);
          badge.lineTo(cxBadge - r, cyBadge);
          badge.closePath();
          badge.fill({ color: COLORS.item, alpha: 0.95 });
          badge.stroke({ color: 0xffffff, width: 1, alpha: 0.7 });
          world.addChild(badge);
        }
        // The Real Game Editor Push - "?" badge in the top-LEFT corner
        // when the sprite rendered with the neutral sepia palette
        // because the engine couldn't resolve its palette tag. Tells
        // the user "these colors are a guess" instead of silently
        // showing a sepia silhouette as if it were the real sprite.
        if (sprite.paletteSource === 'neutral') {
          const qx = o.coord.x * tileSize + tileSize * 0.06;
          const qy = o.coord.y * tileSize + tileSize * 0.06;
          const qr = tileSize * 0.18;
          const qBg = new Graphics();
          qBg.circle(qx + qr, qy + qr, qr);
          qBg.fill({ color: HEX('1e1f23'), alpha: 0.9 });
          qBg.stroke({ color: HEX('f0b429'), width: 1.5, alpha: 0.95 });
          world.addChild(qBg);
          try {
            const qText = new Text({
              text: '?',
              style: {
                fontFamily: 'monospace',
                fontSize: Math.max(8, tileSize * 0.36),
                fontWeight: 'bold',
                fill: HEX('f0b429'),
              },
            });
            qText.x = qx + qr * 0.55;
            qText.y = qy - qr * 0.05;
            world.addChild(qText);
          } catch {
            // Text rendering failures (e.g. headless test env) are
            // harmless - the circle by itself still conveys the
            // "palette unknown" status.
          }
        }
        continue;
      }
    }
    // Fallback when no decoded sprite pixels are available: render a
    // colored marker with a per-kind silhouette + graphicsId label
    // (Phase L). The user can still distinguish NPCs / trainers /
    // items + tell at a glance which sprite each uses even before the
    // OW sprite decoder has run.
    const g = new Graphics();
    const color =
      o.kind === 'trainer'
        ? COLORS.trainer
        : o.kind === 'item'
          ? COLORS.item
          : COLORS.objectEvent;
    // Background pill - rounded marker rather than square so it reads
    // as "this is a thing you can click" rather than "data field".
    g.roundRect(1, 1, tileSize - 2, tileSize - 2, 3);
    g.fill({ color, alpha: 0.85 });
    drawKindSilhouette(g, o.kind, tileSize);
    if (o.id === selectedId) {
      g.roundRect(0, 0, tileSize, tileSize, 3);
      g.stroke({ color: COLORS.selected, width: 2 });
    }
    g.x = o.coord.x * tileSize;
    g.y = o.coord.y * tileSize;
    wireMarker(g, opts, 'objectEvent', o.id, o.coord.x, o.coord.y, onSelect);
    world.addChild(g);

    // graphicsId label (tiny text in the marker's top-left corner).
    const gid = graphicsIdNumber(o);
    if (gid !== null) {
      try {
        const label = new Text({
          text: String(gid),
          style: {
            fontFamily: 'monospace',
            fontSize: 8,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
          },
        });
        label.x = o.coord.x * tileSize + 1;
        label.y = o.coord.y * tileSize + 0;
        label.eventMode = 'none'; // never intercept clicks
        world.addChild(label);
      } catch {
        // Text constructor unavailable in older Pixi or jsdom - silently
        // skip the label rather than blocking the whole marker render.
      }
    }
  }
  // Suppress unused-Container warning - kept in destructure for future
  // grouping use without changing the import surface.
  void Container;
}

function drawWarps(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const { tileSize, warps, selectedId, onSelect } = opts;
  for (const w of warps) {
    const g = new GraphicsCtor();
    // Diamond shape for warps to distinguish from object squares.
    const cx = tileSize / 2;
    const cy = tileSize / 2;
    const r = tileSize / 2 - 2;
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r, cy);
    g.lineTo(cx, cy + r);
    g.lineTo(cx - r, cy);
    g.closePath();
    g.fill({ color: COLORS.warp, alpha: 0.85 });
    if (w.id === selectedId) {
      g.stroke({ color: COLORS.selected, width: 2 });
    }
    g.x = w.fromCoord.x * tileSize;
    g.y = w.fromCoord.y * tileSize;
    wireMarker(g, opts, 'warp', w.id, w.fromCoord.x, w.fromCoord.y, onSelect);
    world.addChild(g);
  }
}

function drawTriggers(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const { tileSize, triggers, selectedId, onSelect } = opts;
  for (const t of triggers) {
    if (!t.coord) continue;
    const g = new GraphicsCtor();
    const cx = tileSize / 2;
    const cy = tileSize / 2;
    const r = tileSize / 2 - 3;
    g.circle(cx, cy, r);
    g.fill({ color: COLORS.trigger, alpha: 0.7 });
    if (t.id === selectedId) {
      g.stroke({ color: COLORS.selected, width: 2 });
    }
    g.x = t.coord.x * tileSize;
    g.y = t.coord.y * tileSize;
    wireMarker(g, opts, 'trigger', t.id, t.coord.x, t.coord.y, onSelect);
    world.addChild(g);
  }
}

/** Phase O.62 - draws trainer vision cones + wander bboxes (O.63).
 *
 *  Trainer cones: for each `kind === 'trainer'` object event with
 *  movementType ∈ {FACE_DOWN/UP/LEFT/RIGHT} AND trainerSight > 0,
 *  render a translucent red rectangle extending `sight` tiles in
 *  the facing direction. Helps operators see at a glance which
 *  path a trainer will spot the player from.
 *
 *  Wander boxes: for each NPC (any kind) with movementType ∈
 *  {WANDER_AROUND / _LEFT_AND_RIGHT / _UP_AND_DOWN / single-direction
 *  WANDER_UP / DOWN / LEFT / RIGHT / slow variants} render a purple
 *  bbox showing the (range × 2 + 1) tiles the NPC drifts into.
 *  Movement range bytes (high nibble x / low nibble y) come from
 *  metadata.movementRangeXY (lifted in O.62).
 *
 *  Read-only - no edit affordance on the overlay itself. Range +
 *  movement-type editing happens via the NPC inspector. */
function drawVisionCones(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const { tileSize, objectEvents } = opts;
  // Movement-type IDs per pret/pokefirered include/constants/event_object_movement.h.
  const WANDER_BOTH_AXES = new Set([2, 57]); // WANDER_AROUND + slow variant
  const WANDER_X_ONLY = new Set([3, 7, 8, 59]); // LEFT_AND_RIGHT + single-dir + slow
  const WANDER_Y_ONLY = new Set([4, 5, 6]); // UP_AND_DOWN + UP + DOWN
  for (const o of objectEvents) {
    const mt =
      typeof o.movementType === 'string'
        ? parseInt(o.movementType.replace(/^movement_/, ''), 10)
        : 0;

    // ── Trainer vision cone ────────────────────────────────────────
    if (o.kind === 'trainer') {
      const sight =
        typeof o.metadata['trainerSightOrBerryTreeId'] === 'number'
          ? (o.metadata['trainerSightOrBerryTreeId'] as number)
          : 0;
      if (sight > 0) {
        let dx = 0;
        let dy = 0;
        if (mt === 9) dy = 1; // FACE_DOWN
        else if (mt === 10) dy = -1; // FACE_UP
        else if (mt === 11) dx = -1; // FACE_LEFT
        else if (mt === 12) dx = 1; // FACE_RIGHT
        if (dx !== 0 || dy !== 0) {
          const g = new GraphicsCtor();
          const startX = (o.coord.x + dx) * tileSize;
          const startY = (o.coord.y + dy) * tileSize;
          const widthPx = dx === 0 ? tileSize : sight * tileSize;
          const heightPx = dy === 0 ? tileSize : sight * tileSize;
          const rectX = dx < 0 ? startX - (sight - 1) * tileSize : startX;
          const rectY = dy < 0 ? startY - (sight - 1) * tileSize : startY;
          g.rect(rectX, rectY, widthPx, heightPx);
          g.fill({ color: COLORS.visionCone, alpha: 0.25 });
          g.stroke({ color: COLORS.visionCone, alpha: 0.6, width: 1 });
          world.addChild(g);
        }
      }
    }

    // ── Wander bbox ────────────────────────────────────────────────
    const rangeXY =
      typeof o.metadata['movementRangeXY'] === 'number'
        ? (o.metadata['movementRangeXY'] as number)
        : 0;
    if (rangeXY === 0) continue;
    const rangeX = (rangeXY >> 4) & 0x0f;
    const rangeY = rangeXY & 0x0f;
    let useX = 0;
    let useY = 0;
    if (WANDER_BOTH_AXES.has(mt)) {
      useX = rangeX;
      useY = rangeY;
    } else if (WANDER_X_ONLY.has(mt)) {
      useX = rangeX;
    } else if (WANDER_Y_ONLY.has(mt)) {
      useY = rangeY;
    } else {
      continue; // not a wandering NPC
    }
    if (useX === 0 && useY === 0) continue;
    const g = new GraphicsCtor();
    // bbox: (cx - rangeX) .. (cx + rangeX), (cy - rangeY) .. (cy + rangeY).
    // Width in tiles = useX*2 + 1, height = useY*2 + 1.
    const rectX = (o.coord.x - useX) * tileSize;
    const rectY = (o.coord.y - useY) * tileSize;
    const widthPx = (useX * 2 + 1) * tileSize;
    const heightPx = (useY * 2 + 1) * tileSize;
    g.rect(rectX, rectY, widthPx, heightPx);
    g.fill({ color: COLORS.wanderBox, alpha: 0.12 });
    g.stroke({ color: COLORS.wanderBox, alpha: 0.5, width: 1 });
    world.addChild(g);
  }
}

/** Phase O.47 - draws a green map-pin shape (downward triangle inside
 *  a circle) at each heal-location's (x, y) tile.
 *
 *  Phase O.55 - marker is now interactive: clicking opens the entry in
 *  the Heal Locations sidebar tab, dragging snaps to a new tile and
 *  fires onMove with kind='healLocation' so the parent can persist via
 *  editBinaryRomHealLocation. Mirrors the wireMarker pattern used by
 *  every other entity marker. */
function drawHealLocations(
  world: PixiContainer,
  opts: MapSceneOptions,
  GraphicsCtor: typeof import('pixi.js').Graphics,
): void {
  const { tileSize, healLocations, onSelect } = opts;
  if (!healLocations || healLocations.length === 0) return;
  for (const h of healLocations) {
    const g = new GraphicsCtor();
    const cx = tileSize / 2;
    const cy = tileSize / 2;
    const r = tileSize / 2 - 2;
    // Pin head: circle at the top, downward triangle at the bottom.
    g.circle(cx, cy - r / 3, r * 0.55);
    g.fill({ color: COLORS.healLocation, alpha: 0.85 });
    g.stroke({ color: COLORS.selected, width: 1, alpha: 0.6 });
    // Pin tip: small triangle pointing down.
    g.moveTo(cx - r * 0.35, cy + r * 0.15);
    g.lineTo(cx + r * 0.35, cy + r * 0.15);
    g.lineTo(cx, cy + r);
    g.closePath();
    g.fill({ color: COLORS.healLocation, alpha: 0.85 });
    g.x = h.x * tileSize;
    g.y = h.y * tileSize;
    wireMarker(g, opts, 'healLocation', h.id, h.x, h.y, onSelect);
    world.addChild(g);
  }
}

/** Wires a marker for both click-to-select and drag-to-move (when `onMove`
 *  is provided). Drag uses globalpointermove on the marker itself so the
 *  cursor doesn't need to stay over it. On pointerup the new world position
 *  is snapped to the nearest tile and `onMove` is called with tile coords.
 *  A trivial drag (no tile-position change) falls back to a click → onSelect.
 */
// Accept any PixiJS Container (Graphics or Sprite) since both support
// the events/cursor/x/y/parent surface used here.
function wireMarker(
  g: import('pixi.js').Container,
  opts: MapSceneOptions,
  kind: 'objectEvent' | 'warp' | 'trigger' | 'healLocation',
  id: string,
  origTileX: number,
  origTileY: number,
  onSelect: MapSceneOptions['onSelect'],
): void {
  g.eventMode = 'static';
  g.cursor = opts.onMove ? 'grab' : 'pointer';

  let dragging = false;
  let pressOffsetX = 0;
  let pressOffsetY = 0;
  let movedDuringPress = false;

  g.on('pointerdown', (e: import('pixi.js').FederatedPointerEvent) => {
    if (!opts.onMove) {
      // No drag support - pointerdown still acts as click via pointertap.
      return;
    }
    // pixi.js types `parent` as nullable: a graphic that has been removed
    // from the scene has nothing to measure against, so it cannot be dragged.
    const parent = g.parent;
    if (!parent) return;
    dragging = true;
    movedDuringPress = false;
    g.cursor = 'grabbing';
    const local = e.getLocalPosition(parent);
    pressOffsetX = local.x - g.x;
    pressOffsetY = local.y - g.y;
    e.stopPropagation();
  });

  g.on('globalpointermove', (e: import('pixi.js').FederatedPointerEvent) => {
    if (!dragging) return;
    const parent = g.parent;
    if (!parent) return;
    const local = e.getLocalPosition(parent);
    const nextX = local.x - pressOffsetX;
    const nextY = local.y - pressOffsetY;
    if (nextX !== g.x || nextY !== g.y) movedDuringPress = true;
    g.x = nextX;
    g.y = nextY;
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    g.cursor = opts.onMove ? 'grab' : 'pointer';
    if (!movedDuringPress) {
      // Counts as a click - select.
      onSelect(kind, id);
      return;
    }
    const tileX = Math.max(0, Math.round(g.x / opts.tileSize));
    const tileY = Math.max(0, Math.round(g.y / opts.tileSize));
    if (tileX === origTileX && tileY === origTileY) {
      // Settled back where it started - treat as click + reset for sanity.
      onSelect(kind, id);
      return;
    }
    opts.onMove?.(kind, id, tileX, tileY);
  };

  g.on('pointerup', endDrag);
  g.on('pointerupoutside', endDrag);

  // Plain click handler when drag isn't supported.
  if (!opts.onMove) {
    g.on('pointertap', () => onSelect(kind, id));
  }
}

function mountFallback(host: HTMLDivElement, message: string): () => void {
  host.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'map-editor__canvas-fallback';
  div.setAttribute('data-testid', 'map-editor-canvas-fallback');
  div.textContent = message;
  host.appendChild(div);
  return () => {
    host.innerHTML = '';
  };
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
