import type {
  AgentHealthResponse,
  AgentPatchProposal,
  BuildArtifactsResponse,
  BuildRunRequest,
  BuildRunResponse,
  DirectoryListing,
  HealthResponse,
  LayoutData,
  MechanicConfigResponse,
  MechanicId,
  ModernizeAttribution,
  ModernizeResponse,
  PatchGenerationRequest,
  PatchGenerationResponse,
  PluginsResponse,
  ProjectErrorCode,
  ProjectErrorResponse,
  ProjectOpenResponse,
  SaveStateCreateRequest,
  SaveStateCreateResponse,
  SaveStateListResponse,
  SaveStateRecord,
  SaveStateUpdateRequest,
  SaveStateUpdateResponse,
  SceneBootCreateRequest,
  SceneBootCreateResponse,
  SceneBootListResponse,
  SceneBootRecipe,
  SceneBootUpdateRequest,
  SceneBootUpdateResponse,
  ScanResponse,
  SearchResponse,
  SharePackageRequest,
  SharePackageResponse,
} from '@rom-editor/shared';

export type { HealthResponse };

export type BackendStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'connected'; readonly service: string; readonly version: string }
  | { readonly state: 'disconnected'; readonly error: string };

export class ProjectApiError extends Error {
  constructor(
    public readonly code: ProjectErrorCode | 'http_error' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectApiError';
  }
}

async function readError(response: Response): Promise<ProjectApiError> {
  try {
    const body = (await response.json()) as ProjectErrorResponse;
    if (body?.error?.code) {
      return new ProjectApiError(body.error.code, body.error.message);
    }
    return new ProjectApiError('http_error', `HTTP ${response.status} ${response.statusText}`);
  } catch {
    return new ProjectApiError('http_error', `HTTP ${response.status} ${response.statusText}`);
  }
}

// ── Decomp expansion trainer-party editing (src/data/trainers.party) ──
export interface DecompPartyMon {
  species: string;
  heldItem: string | null;
  level: number | null;
  ivs: string | null;
  evs: string | null;
  ability: string | null;
  nature: string | null;
  moves: string[];
  extraLines: string[];
}
export interface DecompTrainer {
  id: string;
  name: string | null;
  className: string | null;
  headerLines: string[];
  party: DecompPartyMon[];
}
export interface DecompTrainerResolveResult {
  resolved: boolean;
  trainerId: string | null;
  trainer: DecompTrainer | null;
}

/** Resolve the trainer an NPC battles (by its script label) + parsed party. */
export async function getDecompTrainer(
  sessionId: string,
  query: { script?: string; mapId?: string; trainerId?: string },
): Promise<DecompTrainerResolveResult> {
  const qs = new URLSearchParams();
  if (query.script) qs.set('script', query.script);
  if (query.mapId) qs.set('mapId', query.mapId);
  if (query.trainerId) qs.set('trainerId', query.trainerId);
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-trainer?${qs.toString()}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as DecompTrainerResolveResult;
}

/** Persist an edited party to src/data/trainers.party. */
export async function editDecompTrainerParty(
  sessionId: string,
  trainerId: string,
  party: DecompPartyMon[],
): Promise<{ ok: boolean; trainerId: string }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-trainer/${encodeURIComponent(trainerId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ party }),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as { ok: boolean; trainerId: string };
}

/** Canonical name lists for trainer-team autocomplete (from decomp source). */
export interface DecompNames {
  species: string[];
  moves: string[];
  items: string[];
  abilities: string[];
}

/** Fetch the valid species/move/item/ability names for this project. */
export async function getDecompNames(sessionId: string): Promise<DecompNames> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-names`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as DecompNames;
}

// ── One-click decomp build ("Build & Play") ──
export interface BuildJobStatus {
  jobId: string;
  state: 'running' | 'success' | 'error';
  exitCode: number | null;
  log: string;
  romRelPath: string | null;
  errorSummary: string | null;
  startedAtUtc: string;
  endedAtUtc: string | null;
}

/** Kick off an async `make modern` build; returns a jobId to poll. */
export async function startProjectBuild(
  sessionId: string,
): Promise<{ jobId: string; state: string }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/build/start`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as { jobId: string; state: string };
}

/** Poll a build job for live log + completion. */
export async function getProjectBuildJob(
  sessionId: string,
  jobId: string,
): Promise<BuildJobStatus> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/build/job/${encodeURIComponent(jobId)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BuildJobStatus;
}

// ── Decomp Game-Data engine: Species (A1) ──
export interface DecompSpeciesListItem {
  id: string;
  name: string;
  type1: string;
  type2: string;
  bst: number;
}
export interface DecompSpeciesEnums {
  types: string[];
  abilities: string[];
  growthRates: string[];
  bodyColors: string[];
  eggGroups: string[];
}
export interface DecompSpeciesDetail {
  id: string;
  name: string;
  sourceRel: string;
  baseHP: number;
  baseAttack: number;
  baseDefense: number;
  baseSpeed: number;
  baseSpAttack: number;
  baseSpDefense: number;
  type1: string;
  type2: string;
  abilities: [string, string, string];
  eggGroup1: string;
  eggGroup2: string;
  catchRate: number;
  eggCycles: number;
  height: number;
  weight: number;
  growthRate: string;
  bodyColor: string;
  friendship: string;
  speciesName: string;
  categoryName: string;
  description: string;
  genderRatio: string;
  expYield: string;
  evolutions: string;
}
export type DecompSpeciesEdit = Partial<
  Omit<DecompSpeciesDetail, 'id' | 'name' | 'sourceRel' | 'genderRatio' | 'expYield' | 'evolutions'>
>;

export async function getDecompSpeciesList(sessionId: string): Promise<DecompSpeciesListItem[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-species`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return ((await r.json()) as { species: DecompSpeciesListItem[] }).species;
}

export async function getDecompSpecies(
  sessionId: string,
  speciesId: string,
): Promise<{ detail: DecompSpeciesDetail; enums: DecompSpeciesEnums }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-species/${encodeURIComponent(speciesId)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { detail: DecompSpeciesDetail; enums: DecompSpeciesEnums };
}

export async function editDecompSpecies(
  sessionId: string,
  speciesId: string,
  edit: DecompSpeciesEdit,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-species/${encodeURIComponent(speciesId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Moves (A2) ──
export interface DecompMoveListItem {
  id: string;
  name: string;
  type: string;
  power: number;
  category: string;
}
export interface DecompMoveEnums {
  types: string[];
  categories: string[];
  targets: string[];
  effects: string[];
}
export interface DecompMoveDetail {
  id: string;
  name: string;
  power: number;
  type: string;
  accuracy: number;
  pp: number;
  priority: number;
  category: string;
  target: string;
  effect: string;
  makesContact: boolean;
  description: string;
}
export type DecompMoveEdit = Partial<Omit<DecompMoveDetail, 'id'>>;

export async function getDecompMovesList(sessionId: string): Promise<DecompMoveListItem[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-moves`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return ((await r.json()) as { moves: DecompMoveListItem[] }).moves;
}

export async function getDecompMove(
  sessionId: string,
  moveId: string,
): Promise<{ detail: DecompMoveDetail; enums: DecompMoveEnums }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-moves/${encodeURIComponent(moveId)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { detail: DecompMoveDetail; enums: DecompMoveEnums };
}

export async function editDecompMove(
  sessionId: string,
  moveId: string,
  edit: DecompMoveEdit,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-moves/${encodeURIComponent(moveId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Abilities (A6) ──
export interface DecompAbility {
  id: string;
  name: string;
  description: string;
  aiRating: number;
}
export async function getDecompAbilities(sessionId: string): Promise<DecompAbility[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-abilities`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return ((await r.json()) as { abilities: DecompAbility[] }).abilities;
}
export async function editDecompAbility(
  sessionId: string,
  abilityId: string,
  edit: Partial<Pick<DecompAbility, 'name' | 'description' | 'aiRating'>>,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-abilities/${encodeURIComponent(abilityId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Items (A5) ──
export interface DecompItem {
  id: string;
  name: string;
  description: string;
  price: string;
  pocket: string;
}
export async function getDecompItems(
  sessionId: string,
): Promise<{ items: DecompItem[]; pockets: string[] }> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-items`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { items: DecompItem[]; pockets: string[] };
}
export async function editDecompItem(
  sessionId: string,
  itemId: string,
  edit: Partial<Pick<DecompItem, 'name' | 'description' | 'price' | 'pocket'>>,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Wild encounters (A4) ──
// Read side comes through manifest.encounterTables (scan/encounters.ts). This
// edits one slot's species / level range in src/data/wild_encounters.json.
export async function editDecompEncounterSlot(
  sessionId: string,
  tableId: string,
  slotIndex: number,
  edit: { speciesId?: string; minLevel?: number; maxLevel?: number },
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-encounters/${encodeURIComponent(tableId)}/${String(slotIndex)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Level-up learnsets (A3) ──
export interface DecompLearnsetMove {
  level: number;
  move: string;
}
export interface DecompLearnset {
  id: string;
  name: string;
  moves: DecompLearnsetMove[];
}
export async function getDecompLearnsets(sessionId: string): Promise<DecompLearnset[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-learnsets`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return ((await r.json()) as { learnsets: DecompLearnset[] }).learnsets;
}
export async function editDecompLearnsetMove(
  sessionId: string,
  learnsetId: string,
  entryIndex: number,
  edit: { level?: number; move?: string },
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-learnsets/${encodeURIComponent(learnsetId)}/${String(entryIndex)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edit }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp Game-Data engine: Type chart (A8) ──
export interface DecompTypeChart {
  types: string[];
  matrix: Array<Array<number | null>>;
}
export async function getDecompTypeChart(sessionId: string): Promise<DecompTypeChart> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-typechart`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as DecompTypeChart;
}
export async function editDecompTypeChartCell(
  sessionId: string,
  attacker: string,
  defenderIndex: number,
  multiplier: number,
): Promise<{ ok: boolean }> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/decomp-typechart/${encodeURIComponent(attacker)}/${String(defenderIndex)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ multiplier }),
    },
  );
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean };
}

// ── Decomp: add a new NPC (ObjectEvent) to a map (appends to map.json) ──
export interface NewDecompObjectEvent {
  x: number;
  y: number;
  graphicsId?: string;
  movementType?: string;
  elevation?: number;
  trainerType?: string;
  trainerSightRange?: number;
  flag?: string;
  script?: string;
}
export async function addDecompObjectEvent(
  sessionId: string,
  mapId: string,
  event: NewDecompObjectEvent,
): Promise<{ ok: boolean; newIndex: number; x: number; y: number; graphicsId: string }> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-map-object-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ mapId, ...event }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean; newIndex: number; x: number; y: number; graphicsId: string };
}

// ── Decomp: create scripts + bind to NPCs (talk / trainer) ──
export async function addDecompTalkNpc(
  sessionId: string,
  mapId: string,
  args: { x: number; y: number; message: string; name?: string },
): Promise<{ ok: boolean; scriptLabel: string; boundExisting: boolean }> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-script-talk-npc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ mapId, ...args }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean; scriptLabel: string; boundExisting: boolean };
}
export async function makeDecompTrainer(
  sessionId: string,
  mapId: string,
  args: { x: number; y: number; trainerName?: string; species?: string; level?: number; intro?: string; defeat?: string },
): Promise<{ ok: boolean; scriptLabel: string; trainerId: string; boundExisting: boolean }> {
  const r = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/decomp-make-trainer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ mapId, ...args }),
  });
  if (!r.ok) throw await readError(r);
  return (await r.json()) as { ok: boolean; scriptLabel: string; trainerId: string; boundExisting: boolean };
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Backend health check failed with status ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

export async function openProject(projectRoot: string): Promise<ProjectOpenResponse> {
  const response = await fetch('/api/projects/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ projectRoot }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ProjectOpenResponse;
}

export type PickKind = 'folder' | 'rom-or-archive';

export interface PickResult {
  readonly kind: PickKind;
  readonly path: string | null;
  readonly error?: 'platform_not_supported' | 'picker_failed';
  readonly message?: string;
}

export async function pickFile(kind: PickKind): Promise<PickResult> {
  const response = await fetch('/api/dialogs/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ kind }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as PickResult;
}

export interface IntakeOpenResponse extends ProjectOpenResponse {
  readonly intake: {
    readonly kind: 'rom' | 'archive';
    readonly originalPath: string;
    readonly sha1: string;
  };
}

export async function openProjectFromFile(filePath: string): Promise<IntakeOpenResponse> {
  const response = await fetch('/api/projects/open-from-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ filePath }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as IntakeOpenResponse;
}

export async function fetchListing(
  sessionId: string,
  relativePath: string,
): Promise<DirectoryListing> {
  const qs = relativePath ? `?path=${encodeURIComponent(relativePath)}` : '';
  const response = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/listing${qs}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as DirectoryListing;
}

export async function scanProject(sessionId: string): Promise<ScanResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/scan`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ScanResponse;
}

export async function moveEvent(
  sessionId: string,
  kind: 'objectEvent' | 'warp' | 'trigger',
  eventId: string,
  x: number,
  y: number,
): Promise<{
  entityKind: string;
  entityId: string;
  mapId: string;
  previous: { x: number; y: number };
  next: { x: number; y: number };
  mapJsonPath: string;
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/events/${kind}/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ x, y }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function patchEventFields(
  sessionId: string,
  kind: 'objectEvent' | 'warp' | 'trigger',
  eventId: string,
  fields: Record<string, string | number | boolean | null>,
): Promise<{
  entityKind: string;
  entityId: string;
  mapId: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  mapJsonPath: string;
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/events/${kind}/${encodeURIComponent(eventId)}/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ fields }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function editDialogueText(
  sessionId: string,
  label: string,
  text: string,
): Promise<{
  label: string;
  sourcePath: string;
  previousLines: string[];
  nextLines: string[];
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/dialogue/${encodeURIComponent(label)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ text }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function replaceAssetPng(
  sessionId: string,
  assetId: string,
  pngBase64: string,
): Promise<{
  assetId: string;
  relativePath: string;
  width: number;
  height: number;
  bitDepth: number;
  bytesWritten: number;
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pngBase64 }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function stageTemplate(
  sessionId: string,
  templateId: string,
  params: Record<string, string>,
  materialization: Record<string, unknown>,
): Promise<{ sessionId: string; stagedPath: string; stagedAtUtc: string; templateId: string }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/templates/${encodeURIComponent(templateId)}/stage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ params, materialization }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function fetchProjectPlugins(
  sessionId: string,
): Promise<PluginsResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/plugins`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as PluginsResponse;
}

export type OpKind =
  | 'move_event'
  | 'patch_event_fields'
  | 'edit_dialogue'
  | 'replace_asset'
  | 'import_asset'
  | 'stage_template'
  | 'patch_mechanic_config';

export interface OpLogEntry {
  readonly entryId: string;
  readonly atUtc: string;
  readonly sessionId: string;
  readonly op: OpKind;
  readonly payload: Record<string, unknown>;
}

export interface OpLogResponse {
  readonly sessionId: string;
  readonly logPath: string;
  readonly totalLines: number;
  readonly entries: ReadonlyArray<OpLogEntry>;
  readonly parseErrors: ReadonlyArray<{
    readonly lineNumber: number;
    readonly raw: string;
    readonly message: string;
  }>;
}

export async function fetchOpLog(sessionId: string, limit?: number): Promise<OpLogResponse> {
  const qs = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/op-log${qs}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as OpLogResponse;
}

export interface UndoStateResponse {
  readonly sessionId: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly nextUndoTargetId: string | null;
  readonly nextUndoOp: OpKind | null;
  readonly nextRedoTargetId: string | null;
  readonly nextRedoOp: OpKind | null;
}

export async function fetchUndoState(sessionId: string): Promise<UndoStateResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/undo-state`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as UndoStateResponse;
}

export async function undoLastOp(sessionId: string): Promise<{ undoEntryId: string; reversedOp: OpKind }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/undo`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as { undoEntryId: string; reversedOp: OpKind };
}

export async function redoLastOp(sessionId: string): Promise<{ redoEntryId: string; reappliedOp: OpKind }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/redo`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as { redoEntryId: string; reappliedOp: OpKind };
}

export async function fetchMechanicConfig(
  sessionId: string,
): Promise<MechanicConfigResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/mechanic-config`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as MechanicConfigResponse;
}

export async function patchMechanicConfig(
  sessionId: string,
  mechanicId: MechanicId,
  patch: Record<string, unknown>,
): Promise<MechanicConfigResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/mechanic-config/${encodeURIComponent(mechanicId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as MechanicConfigResponse;
}

export async function materializeSharePackage(
  sessionId: string,
  request: SharePackageRequest,
): Promise<SharePackageResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/share-package`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as SharePackageResponse;
}

export async function generatePatch(
  sessionId: string,
  request: PatchGenerationRequest,
): Promise<PatchGenerationResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/patches`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as PatchGenerationResponse;
}

// ----------------------------------------------------------------------------
// Phase 4.1A - Named save-state library.
//
// Replaces the previous 3-fixed-slot mGBA save-state UI with an unlimited
// persistent library. Capture/restore bytes via mGBA's
// `forceAutoSaveState`/`getAutoSaveState` (capture) and
// `uploadAutoSaveState`/`loadAutoSaveState` (restore); this client
// shuttles the bytes through the backend's per-project store.

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Walk in chunks to avoid blowing the call-stack on the ~390 KB savestate.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    const end = Math.min(i + chunk, bytes.byteLength);
    binary += String.fromCharCode(...bytes.subarray(i, end));
  }
  return btoa(binary);
}

export async function listSaveStates(sessionId: string): Promise<SaveStateRecord[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/save-states`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SaveStateListResponse;
  return [...body.states];
}

export async function createSaveState(
  sessionId: string,
  args: { name: string; notes?: string | null; bytes: Uint8Array },
): Promise<SaveStateRecord> {
  const payload: SaveStateCreateRequest = {
    name: args.name,
    notes: args.notes ?? null,
    dataBase64: uint8ArrayToBase64(args.bytes),
  };
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/save-states`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SaveStateCreateResponse;
  return body.state;
}

export async function updateSaveState(
  sessionId: string,
  stateId: string,
  update: SaveStateUpdateRequest,
): Promise<SaveStateRecord> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/save-states/${encodeURIComponent(stateId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(update),
    },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SaveStateUpdateResponse;
  return body.state;
}

export async function deleteSaveState(sessionId: string, stateId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/save-states/${encodeURIComponent(stateId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 204) throw await readError(response);
}

export async function fetchSaveStateBytes(
  sessionId: string,
  stateId: string,
): Promise<Uint8Array> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/save-states/${encodeURIComponent(stateId)}/bytes`,
  );
  if (!response.ok) throw await readError(response);
  return new Uint8Array(await response.arrayBuffer());
}

// ----------------------------------------------------------------------------
// Phase 4.1B - Scene-boot recipes.
//
// Persistent records of "warp + seed flags + seed vars + (later) trigger
// script" combinations. The frontend lets the user compose recipes via
// SceneBootPicker; the orchestrator at lib/sceneBoot.ts applies them.

export async function listSceneBoots(sessionId: string): Promise<SceneBootRecipe[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/scene-boot-recipes`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SceneBootListResponse;
  return [...body.recipes];
}

export async function createSceneBoot(
  sessionId: string,
  request: SceneBootCreateRequest,
): Promise<SceneBootRecipe> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/scene-boot-recipes`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SceneBootCreateResponse;
  return body.recipe;
}

export async function updateSceneBoot(
  sessionId: string,
  recipeId: string,
  update: SceneBootUpdateRequest,
): Promise<SceneBootRecipe> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/scene-boot-recipes/${encodeURIComponent(recipeId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(update),
    },
  );
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as SceneBootUpdateResponse;
  return body.recipe;
}

export async function deleteSceneBoot(sessionId: string, recipeId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/scene-boot-recipes/${encodeURIComponent(recipeId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 204) throw await readError(response);
}

export async function fetchBuildArtifacts(
  sessionId: string,
): Promise<BuildArtifactsResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/build/artifacts`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as BuildArtifactsResponse;
}

/** Modernize-and-Ship slice 4 - one-click "Modernize" upgrade. POSTs
 *  to /api/projects/:id/modernize; the backend reads the bundled CFRU
 *  patch from disk and applies it to the project's ROM. No request
 *  body - everything needed lives in the bundle. Errors propagate as
 *  ProjectApiError with the backend's plain-English code (e.g.
 *  'rom_hash_mismatch', 'already_modernized', 'patch_artifact_missing'). */
export async function modernizeRom(sessionId: string): Promise<ModernizeResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/modernize`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ModernizeResponse;
}

/** Modernize-and-Ship slice 4 - fetch the bundled CFRU attribution
 *  (credits + license clause + version) for the AttributionPanel. */
export async function fetchModernizeAttribution(
  sessionId: string,
): Promise<ModernizeAttribution> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/modernize/attribution`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ModernizeAttribution;
}

export async function runBuild(
  sessionId: string,
  options?: BuildRunRequest,
): Promise<BuildRunResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/build`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(options ?? {}),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as BuildRunResponse;
}

export async function importAssetPng(
  sessionId: string,
  relativePath: string,
  pngBase64: string,
): Promise<{
  relativePath: string;
  width: number;
  height: number;
  bitDepth: number;
  bytesWritten: number;
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/assets`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ relativePath, pngBase64 }),
    },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function fetchScriptSource(
  sessionId: string,
  label: string,
): Promise<{
  label: string;
  sourcePath: string;
  lines: string[];
  text: string;
}> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/scripts/raw?label=${encodeURIComponent(label)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return await response.json();
}

export async function fetchLayout(
  sessionId: string,
  layoutName: string,
): Promise<LayoutData> {
  const qs = `?name=${encodeURIComponent(layoutName)}`;
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/layout${qs}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as LayoutData;
}

/** Composed metatile pixels for a layout: metatileId → 16×16 RGBA (256 px).
 *  Built from the decomp tilesets so the map panel renders real tiles. */
export async function fetchLayoutTiles(
  sessionId: string,
  layoutName: string,
): Promise<Map<number, Uint32Array>> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/layout-tiles?name=${encodeURIComponent(layoutName)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw await readError(response);
  }
  const json = (await response.json()) as { tiles: Record<string, string> };
  const out = new Map<number, Uint32Array>();
  for (const [id, b64] of Object.entries(json.tiles)) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.set(Number(id), new Uint32Array(bytes.buffer));
  }
  return out;
}

export async function searchProject(
  sessionId: string,
  query: string,
  limit?: number,
): Promise<SearchResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(sessionId)}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, ...(limit !== undefined ? { limit } : {}) }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as SearchResponse;
}

// Phase UX-C.3 - binary-ROM tile graphics + map cell byte routes.

export interface MetatileSpecRaw {
  readonly tileIndex: number;
  readonly hflip: boolean;
  readonly vflip: boolean;
  readonly paletteIndex: number;
}

export interface BinaryRomTilesetResponseLike {
  readonly tileCount: number;
  readonly palettes: ReadonlyArray<ReadonlyArray<number>>;
  /** Base64-encoded RAW palette-index tile sheet (1 byte per pixel,
   *  64 bytes per tile). Frontend applies per-metatile-tile spec's
   *  paletteIndex at composition time to render correct colors. */
  readonly tileSheetIndices: string;
  /** @deprecated Pre-baked palette-0 RGBA sheet. Kept briefly for
   *  migration; new code uses `tileSheetIndices` + per-metatile
   *  palette resolution. */
  readonly tileSheetRgba: string;
  readonly metatileSpecs: ReadonlyArray<{
    readonly layer0: ReadonlyArray<MetatileSpecRaw>;
    readonly layer1: ReadonlyArray<MetatileSpecRaw>;
  }>;
  readonly truncated: boolean;
}

export interface BinaryRomMapCellRaw {
  readonly metatileId: number;
  readonly collision: number;
  readonly elevation: number;
}

export interface BinaryRomMapDataResponseLike {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<BinaryRomMapCellRaw>;
}

export async function fetchBinaryRomTileset(
  sessionId: string,
  args: {
    /** File offset of the 24-byte Tileset struct; backend parses it
     *  internally to extract tiles/palettes/metatiles sub-offsets. */
    readonly tilesetStructOffset: number;
    readonly maxMetatiles?: number;
    readonly maxTiles?: number;
  },
): Promise<BinaryRomTilesetResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-tileset`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomTilesetResponseLike;
}

export async function fetchBinaryRomMapData(
  sessionId: string,
  args: {
    readonly layoutOffset: number;
    readonly width: number;
    readonly height: number;
  },
): Promise<BinaryRomMapDataResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-map-data`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomMapDataResponseLike;
}

export interface BinaryRomEditCellRequest {
  readonly x: number;
  readonly y: number;
  readonly metatileId?: number;
  readonly collision?: number;
  readonly elevation?: number;
}

export interface BinaryRomEditCellsResponseLike {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<BinaryRomMapCellRaw>;
  readonly backupCreated: boolean;
  readonly cellsChanged: number;
}

export interface BinaryRomOwSpriteResponseLike {
  readonly width: number;
  readonly height: number;
  /** Base64-encoded RGBA bytes (width × height × 4 bytes), row-major. */
  readonly rgbaBase64: string;
  /** @deprecated use paletteSource. Equals `paletteSource === 'neutral'`. */
  readonly grayscaleFallback: boolean;
  /** The Real Game Editor Push - 'detected' when the caller-supplied
   *  palette was honored (real in-game colors); 'neutral' when the
   *  backend fell back to its warm sepia ramp because no palette was
   *  resolved by the engine cross-ref. Frontend uses this to overlay a
   *  small "?" badge on the NPC marker so the user knows the colors
   *  are a fallback, not the actual sprite palette. */
  readonly paletteSource?: 'detected' | 'neutral';
}

/** Phase UX-E - fetch an overworld sprite's decoded RGBA image. When
 *  `palette` is omitted the backend returns a grayscale silhouette
 *  (palette-resolution substrate is a future iter). */
export async function fetchBinaryRomOwSprite(
  sessionId: string,
  args: {
    readonly structFileOffset: number;
    readonly frameIndex?: number;
    readonly palette?: ReadonlyArray<number>;
  },
): Promise<BinaryRomOwSpriteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-ow-sprite`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomOwSpriteResponseLike;
}

/** Phase G-RC5 - Patch ObjectEventTemplate struct fields in place
 *  on a binary ROM. Mirrors the decomp PATCH route's whitelist so the
 *  frontend can use one form for both project kinds. Backend creates
 *  `<rom>.bak` on first edit per project (idempotent). */
export interface BinaryRomObjectEventEditField {
  readonly structFileOffset: number;
  readonly fields: Readonly<Record<string, number | null | undefined>>;
}

export interface BinaryRomEditObjectEventFieldsResponseLike {
  readonly backupCreated: boolean;
  readonly bytesChanged: number;
  readonly results: ReadonlyArray<{
    readonly structFileOffset: number;
    readonly previous: Readonly<Record<string, number>>;
    readonly next: Readonly<Record<string, number>>;
  }>;
}

export async function editBinaryRomObjectEventFields(
  sessionId: string,
  edits: ReadonlyArray<BinaryRomObjectEventEditField>,
): Promise<BinaryRomEditObjectEventFieldsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/object-event-fields`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ edits }),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditObjectEventFieldsResponseLike;
}

/** Phase UX-D - write map cells back to the ROM. Backend creates
 *  `<rom>.bak` on first edit per project (idempotent). */
export async function editBinaryRomMapCells(
  sessionId: string,
  args: {
    readonly layoutOffset: number;
    readonly width: number;
    readonly height: number;
    readonly edits: ReadonlyArray<BinaryRomEditCellRequest>;
  },
): Promise<BinaryRomEditCellsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-cells`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditCellsResponseLike;
}

export interface BinaryRomEditDialogueStringResponseLike {
  readonly stringFileOffset: number;
  readonly bytesWritten: number;
  readonly originalSpanBytes: number;
  readonly backupCreated: boolean;
}

/** Phase I.3 - write a msgbox/sign string back to its ROM offset.
 *  Backend re-encodes via the Gen-3 codec, validates the new encoded
 *  length fits within the original terminator-bounded span, and
 *  writes in place + creates `<rom>.bak` on first edit. */
export async function editBinaryRomDialogueString(
  sessionId: string,
  args: { readonly stringFileOffset: number; readonly newText: string },
): Promise<BinaryRomEditDialogueStringResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/dialogue-string`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditDialogueStringResponseLike;
}

export interface BinaryRomEditScriptStepArgsResponseLike {
  readonly stepFileOffset: number;
  readonly opcodeByte: number;
  readonly bytesWritten: number;
  readonly backupCreated: boolean;
}

/** Phase I.4 - write the args of a single script step (set_flag,
 *  setvar, give_item, etc.) at its ROM offset. Backend validates the
 *  opcode at fileOffset matches the expected argBytes count. */
export async function editBinaryRomScriptStepArgs(
  sessionId: string,
  args: { readonly stepFileOffset: number; readonly argBytes: ReadonlyArray<number> },
): Promise<BinaryRomEditScriptStepArgsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/script-step-args`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditScriptStepArgsResponseLike;
}

export interface BinaryRomEditMapHeaderResponseLike {
  readonly mapHeaderOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** Phase I.4 - patch a map header's u8/u16 fields in place. */
export async function editBinaryRomMapHeader(
  sessionId: string,
  args: {
    readonly mapHeaderOffset: number;
    readonly fields: {
      readonly musicId?: number;
      readonly regionMapSectionId?: number;
      readonly weather?: number;
      readonly mapType?: number;
      readonly battleType?: number;
      readonly caveOrType?: number;
      readonly flags?: number;
    };
  },
): Promise<BinaryRomEditMapHeaderResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-header`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapHeaderResponseLike;
}

export interface BinaryRomEditTriggerFieldsResponseLike {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditHealLocationResponseLike {
  readonly sourceFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export interface BinaryRomGetMetatileAttrsResponseLike {
  readonly behavior: number;
  readonly terrainType: number;
  readonly encounterType: number;
  readonly layerType: number;
  readonly attrsOffset: number;
}

export interface BinaryRomEditMetatileAttrsResponseLike {
  readonly tilesetStructOffset: number;
  readonly metatileId: number;
  readonly attrsOffset: number;
  readonly bytesWritten: number;
  readonly backupCreated: boolean;
}

/** Phase J.4 - read a single metatile's attribute word. */
export async function fetchBinaryRomMetatileAttrs(
  sessionId: string,
  args: {
    readonly tilesetStructOffset: number;
    readonly metatileId: number;
    readonly family: 'frlg' | 'rse';
  },
): Promise<BinaryRomGetMetatileAttrsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-metatile-attrs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomGetMetatileAttrsResponseLike;
}

export interface BinaryRomEditMapDimensionsResponseLike {
  readonly layoutFileOffset: number;
  readonly newWidth: number;
  readonly newHeight: number;
  readonly backupCreated: boolean;
}

/** Phase J.3 - patch the MapLayout struct's width + height u32 fields.
 *  Shrink-only - refuses to grow past the original allocation. */
export async function editBinaryRomMapDimensions(
  sessionId: string,
  args: {
    readonly layoutFileOffset: number;
    readonly currentWidth: number;
    readonly currentHeight: number;
    readonly newWidth: number;
    readonly newHeight: number;
  },
): Promise<BinaryRomEditMapDimensionsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-dimensions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapDimensionsResponseLike;
}

export interface BinaryRomEditObjectEventTableResponseLike {
  readonly op: 'delete' | 'append';
  readonly newCount: number;
  readonly mutatedStructOffset: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditEncounterSlotResponseLike {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** WP-C1 - response from /binary-rom-edit/encounter-table. */
export interface BinaryRomEditEncounterTableResponseLike {
  readonly encounterTableId: string;
  readonly op: 'setRate' | 'reorder' | 'bulkReplaceSpecies';
  readonly editsApplied: number;
  readonly description: string;
}

export interface BinaryRomEditMapEventTableResponseLike {
  readonly op: 'delete' | 'append';
  readonly kind: 'warp' | 'coordEvent' | 'bgEvent';
  readonly newCount: number;
  readonly mutatedStructOffset: number;
  readonly backupCreated: boolean;
}

/** Phase K.2 - add or delete a warp / coord-event / bg-event slot in
 *  the parent MapEvents table. Mirrors the J.7/J.8 object-event-table
 *  route for the other three event kinds. */
export async function editBinaryRomMapEventTable(
  sessionId: string,
  args: {
    readonly mapEventsStructOffset: number;
    readonly subArrayOffset: number;
    readonly kind: 'warp' | 'coordEvent' | 'bgEvent';
    readonly op: 'delete' | 'append';
    readonly deleteStructFileOffset?: number;
    readonly newWarp?: {
      readonly x: number;
      readonly y: number;
      readonly elevation: number;
      readonly warpId: number;
      readonly destMapNum: number;
      readonly destMapGroup: number;
    };
    readonly newCoordEvent?: {
      readonly x: number;
      readonly y: number;
      readonly elevation: number;
      readonly trigger: number;
      readonly index: number;
      readonly scriptPointer: number;
    };
    readonly newBgEvent?: {
      readonly x: number;
      readonly y: number;
      readonly elevation: number;
      readonly kind: number;
      readonly data: number;
    };
  },
): Promise<BinaryRomEditMapEventTableResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-event-table`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapEventTableResponseLike;
}

export interface BinaryRomEditTrainerFieldsResponseLike {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** Phase L.3 - patch trainer struct fields (class, name, items, AI flags,
 *  encounter music, sprite). The name is Gen-3-encoded server-side. */
export async function editBinaryRomTrainerFields(
  sessionId: string,
  args: {
    readonly structFileOffset: number;
    readonly fields: {
      readonly trainerClass?: number;
      readonly encounterMusic?: number;
      readonly trainerPic?: number;
      readonly aiFlagsRaw?: number;
      readonly item0?: number;
      readonly item1?: number;
      readonly item2?: number;
      readonly item3?: number;
      readonly name?: string;
    };
  },
): Promise<BinaryRomEditTrainerFieldsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/trainer-fields`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTrainerFieldsResponseLike;
}

export interface BinaryRomEditTrainerPartyMemberResponseLike {
  readonly memberFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** Phase K.4 - patch a single trainer-party member struct. partyFlags
 *  selects the struct variant (Basic 8B / Moves 16B / Items 8B /
 *  MovesItems 16B). The route validates field/flag compatibility. */
export async function editBinaryRomTrainerPartyMember(
  sessionId: string,
  args: {
    readonly memberFileOffset: number;
    readonly partyFlags: number;
    readonly fields: {
      readonly speciesId?: number;
      readonly level?: number;
      readonly heldItemId?: number;
      readonly moveIds?: ReadonlyArray<number>;
    };
  },
): Promise<BinaryRomEditTrainerPartyMemberResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/trainer-party-member`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTrainerPartyMemberResponseLike;
}

export interface BinaryRomEditTrainerPartyAppendResponseLike {
  readonly newPartyPointer: number;
  readonly newPartyFileOffset: number;
  readonly newPartySize: number;
  readonly memberSize: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditTrainerPartyDeleteResponseLike {
  readonly newPartySize: number;
  readonly memberSize: number;
  readonly backupCreated: boolean;
}

/** Phase O.8 - delete a single trainer party member. Shifts subsequent
 *  members up by one slot (in-place compaction, no relocation needed),
 *  zero-fills the freed trailing slot, decrements Trainer.partySize.
 *  Gates on currentPartySize ≥ 2 (Gen-3 requires party size ≥ 1). */
export async function editBinaryRomTrainerPartyDelete(
  sessionId: string,
  args: {
    readonly trainerStructFileOffset: number;
    readonly currentPartyPointer: number;
    readonly currentPartySize: number;
    readonly memberIndex: number;
    readonly partyFlags: number;
  },
): Promise<BinaryRomEditTrainerPartyDeleteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/trainer-party-delete-member`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTrainerPartyDeleteResponseLike;
}

/** Phase O.6 - append a new party member to a trainer. Allocates free
 *  ROM space for (currentPartySize+1) members, copies existing members,
 *  writes the new one, and patches the Trainer struct's partySize +
 *  partyPointer fields. Maxes out at Gen-3 party size of 6. */
export async function editBinaryRomTrainerPartyAppend(
  sessionId: string,
  args: {
    readonly trainerStructFileOffset: number;
    readonly currentPartyPointer: number;
    readonly currentPartySize: number;
    readonly partyFlags: number;
    readonly newMember: {
      readonly speciesId: number;
      readonly level: number;
      readonly heldItemId?: number;
      readonly moveIds?: ReadonlyArray<number>;
    };
  },
): Promise<BinaryRomEditTrainerPartyAppendResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/trainer-party-append`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTrainerPartyAppendResponseLike;
}

export interface BinaryRomEditStructFieldsResponseLike {
  readonly sourceFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

async function postStructFields(
  sessionId: string,
  endpoint: string,
  args: { readonly sourceFileOffset: number; readonly fields: Readonly<Record<string, number>> },
): Promise<BinaryRomEditStructFieldsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/${endpoint}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditStructFieldsResponseLike;
}

/** Phase M.1 - patch a Pokémon species' 28-byte BaseStats struct fields. */
export async function editBinaryRomSpeciesFields(
  sessionId: string,
  args: { readonly sourceFileOffset: number; readonly fields: Readonly<Record<string, number>> },
): Promise<BinaryRomEditStructFieldsResponseLike> {
  return postStructFields(sessionId, 'species-fields', args);
}
/** Phase M.1 - patch a battle move's 12-byte struct fields. */
export async function editBinaryRomMoveFields(
  sessionId: string,
  args: { readonly sourceFileOffset: number; readonly fields: Readonly<Record<string, number>> },
): Promise<BinaryRomEditStructFieldsResponseLike> {
  return postStructFields(sessionId, 'move-fields', args);
}
/** Phase M.1 - patch an item's 44-byte struct (price/holdEffect/pocket/etc.). */
export async function editBinaryRomItemFields(
  sessionId: string,
  args: { readonly sourceFileOffset: number; readonly fields: Readonly<Record<string, number>> },
): Promise<BinaryRomEditStructFieldsResponseLike> {
  return postStructFields(sessionId, 'item-fields', args);
}

export interface BinaryRomEditEvolutionSlotResponseLike {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** Phase M.5 - patch a single evolution slot (6-byte struct). */
export async function editBinaryRomEvolutionSlot(
  sessionId: string,
  args: {
    readonly slotFileOffset: number;
    readonly fields: {
      readonly method?: number;
      readonly param?: number;
      readonly targetSpecies?: number;
    };
  },
): Promise<BinaryRomEditEvolutionSlotResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-evolution-slot`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditEvolutionSlotResponseLike;
}

export interface BinaryRomEditEvolutionDeleteResponseLike {
  readonly newPopulatedCount: number;
  readonly backupCreated: boolean;
}

/** Phase O.15 - delete one evolution slot from a species. Shifts
 *  subsequent slots left by 6 bytes within the fixed 5-slot
 *  EvolutionBlock window (30 bytes per species), zero-fills the slot
 *  that previously held the LAST populated entry (= new EVO_NONE
 *  terminator). No relocation, no count byte. */
export async function editBinaryRomEvolutionDelete(
  sessionId: string,
  args: {
    readonly blockFileOffset: number;
    readonly slotIndex: number;
    readonly currentPopulatedCount: number;
  },
): Promise<BinaryRomEditEvolutionDeleteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-evolution-delete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditEvolutionDeleteResponseLike;
}

export interface BinaryRomEditLearnsetMoveResponseLike {
  readonly entryFileOffset: number;
  readonly packedValue: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditTmhmResponseLike {
  readonly slotFileOffset: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditMapConnectionResponseLike {
  readonly slotFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditTypeMatchupResponseLike {
  readonly entryFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

/** Phase N.4 - patch a 3-byte type matchup entry. Effectiveness uses
 *  the standard ×10 encoding (0 = no effect, 5 = ½×, 10 = 1×, 20 = 2×). */
export async function editBinaryRomTypeMatchup(
  sessionId: string,
  args: {
    readonly entryFileOffset: number;
    readonly fields: {
      readonly attackerType?: number;
      readonly defenderType?: number;
      readonly effectiveness?: number;
    };
  },
): Promise<BinaryRomEditTypeMatchupResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/type-matchup`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTypeMatchupResponseLike;
}

/** Phase N.2 - patch a 12-byte MapConnection struct (direction / offset /
 *  destMapGroup / destMapNum). */
export async function editBinaryRomMapConnection(
  sessionId: string,
  args: {
    readonly slotFileOffset: number;
    readonly fields: {
      readonly direction?: number;
      readonly offset?: number;
      readonly destMapGroup?: number;
      readonly destMapNum?: number;
    };
  },
): Promise<BinaryRomEditMapConnectionResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-connection-slot`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapConnectionResponseLike;
}

export interface BinaryRomEditMapConnectionAppendResponseLike {
  readonly newConnectionsArrayPointer: number;
  readonly newConnectionsArrayFileOffset: number;
  readonly newCount: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditMapConnectionDeleteResponseLike {
  readonly newCount: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditWarpFieldsResponseLike {
  readonly structFileOffset: number;
  readonly fieldsWritten: ReadonlyArray<string>;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditStartBattleTrainerIdResponseLike {
  readonly stepFileOffset: number;
  readonly trainerId: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditMovementActionByteResponseLike {
  readonly movementDataOffset: number;
  readonly actionIndex: number;
  readonly newActionByte: number;
  readonly backupCreated: boolean;
}

/** Phase O.26 - patch a single movement action byte at
 *  `movementDataOffset + actionIndex`. Refuses to overwrite the
 *  END sentinel (0xFE) - growing/shrinking the sequence needs a
 *  separate relocation route. */
export async function editBinaryRomMovementActionByte(
  sessionId: string,
  args: {
    readonly movementDataOffset: number;
    readonly actionIndex: number;
    readonly newActionByte: number;
  },
): Promise<BinaryRomEditMovementActionByteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/movement-action-byte`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMovementActionByteResponseLike;
}

/** Phase O.23 - patch the trainerId field of a trainerbattle script
 *  step (u16 at stepFileOffset + 2). The opcode byte at stepFileOffset
 *  is verified to be 0x5C before writing. Other args (battleType +
 *  script pointers) are preserved untouched. */
export async function editBinaryRomStartBattleTrainerId(
  sessionId: string,
  args: { readonly stepFileOffset: number; readonly trainerId: number },
): Promise<BinaryRomEditStartBattleTrainerIdResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/start-battle-trainer-id`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditStartBattleTrainerIdResponseLike;
}

/** Phase O.22 - patch a Warp struct's destination fields in place.
 *  Touches elevation / warpId / destMapNum / destMapGroup; the x/y
 *  position lives in the same struct but goes through the existing
 *  coord-edit path. */
export async function editBinaryRomWarpFields(
  sessionId: string,
  args: {
    readonly structFileOffset: number;
    readonly fields: {
      readonly elevation?: number;
      readonly warpId?: number;
      readonly destMapNum?: number;
      readonly destMapGroup?: number;
    };
  },
): Promise<BinaryRomEditWarpFieldsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/warp-fields`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditWarpFieldsResponseLike;
}

/** Phase O.9 - delete one MapConnection. Shifts subsequent connections
 *  up by 12 bytes (in-place compaction, no relocation), zero-fills
 *  the freed trailing slot, decrements MapConnections.count. Allows
 *  count → 0 (no connections at all). */
export async function editBinaryRomMapConnectionDelete(
  sessionId: string,
  args: {
    readonly connectionsHeaderOffset: number;
    readonly currentCount: number;
    readonly currentConnectionsArrayPointer: number;
    readonly connectionIndex: number;
  },
): Promise<BinaryRomEditMapConnectionDeleteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-connection-delete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapConnectionDeleteResponseLike;
}

/** Phase O.7 - append a new MapConnection to a map's connections list.
 *  Allocates free ROM space for (currentCount+1) connections, copies
 *  existing, writes new at slot[currentCount], patches the parent
 *  MapConnections header's count + pointer. Only supports maps that
 *  already have a MapConnections struct (currentCount >= 0; adding
 *  the FIRST connection to a connection-less map needs a different
 *  flow that allocates the 8-byte header - deferred). */
export async function editBinaryRomMapConnectionAppend(
  sessionId: string,
  args: {
    readonly connectionsHeaderOffset: number;
    readonly currentCount: number;
    readonly currentConnectionsArrayPointer: number;
    readonly newConnection: {
      readonly direction: number;
      readonly offset: number;
      readonly destMapGroup: number;
      readonly destMapNum: number;
    };
  },
): Promise<BinaryRomEditMapConnectionAppendResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/map-connection-append`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMapConnectionAppendResponseLike;
}

/** Phase M.6 - patch a species' 8-byte TM/HM compat slot. */
export async function editBinaryRomTmhm(
  sessionId: string,
  args: { readonly slotFileOffset: number; readonly low: number; readonly high: number },
): Promise<BinaryRomEditTmhmResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-tmhm`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTmhmResponseLike;
}

/** Phase M.5 - patch a learnset move entry (2-byte packed level+move). */
export async function editBinaryRomLearnsetMove(
  sessionId: string,
  args: {
    readonly arrayFileOffset: number;
    readonly entryIndex: number;
    readonly level: number;
    readonly move: number;
  },
): Promise<BinaryRomEditLearnsetMoveResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-learnset-move`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditLearnsetMoveResponseLike;
}

export interface BinaryRomEditLearnsetAppendResponseLike {
  readonly newArrayFileOffset: number;
  readonly newArrayPointer: number;
  readonly newEntryCount: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditLearnsetDeleteResponseLike {
  readonly newEntryCount: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditMultichoiceAppendResponseLike {
  readonly newCount: number;
  readonly newListPointer: number;
  readonly newTextFileOffset: number;
  readonly newListFileOffset: number;
  readonly backupCreated: boolean;
}

export interface BinaryRomEditMultichoiceDeleteResponseLike {
  readonly newCount: number;
  readonly backupCreated: boolean;
}

/** Phase O.13 - delete one choice from a gMultichoiceLists entry.
 *  Shifts subsequent MenuActions left by 8 bytes (in-place compaction),
 *  zero-fills the freed trailing slot, decrements the count byte.
 *  No relocation, no text-bytes free (leaked, acceptable). Gates on
 *  count ≥ 2 (Gen-3 multichoice opcode degenerates below). */
export async function editBinaryRomMultichoiceDelete(
  sessionId: string,
  args: {
    readonly entryFileOffset: number;
    readonly choiceIndex: number;
  },
): Promise<BinaryRomEditMultichoiceDeleteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/multichoice-list-delete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMultichoiceDeleteResponseLike;
}

/** Phase O.12 - append a new choice to a gMultichoiceLists entry.
 *  Allocates free ROM space for the new choice text + new MenuAction
 *  array (count+1 entries), then patches the gMultichoiceLists entry's
 *  listPtr u32 + count u8. Old text + array are left in place. */
export async function editBinaryRomMultichoiceAppend(
  sessionId: string,
  args: {
    readonly entryFileOffset: number;
    readonly newChoiceText: string;
  },
): Promise<BinaryRomEditMultichoiceAppendResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/multichoice-list-append`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMultichoiceAppendResponseLike;
}

/** Phase O.11 - delete one learnset entry. Shifts subsequent entries
 *  left by one u16 slot, writes 0xFFFF at the new terminator slot,
 *  zero-fills the freed trailing u16. No relocation needed. */
export async function editBinaryRomLearnsetDelete(
  sessionId: string,
  args: { readonly arrayFileOffset: number; readonly entryIndex: number },
): Promise<BinaryRomEditLearnsetDeleteResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-learnset-delete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditLearnsetDeleteResponseLike;
}

/** Phase O.10 - append a new (level, move) entry to a species learnset.
 *  Allocates free ROM space for (currentCount + new + terminator)
 *  packed-u16 entries, copies existing, writes new entry + 0xFFFF
 *  terminator, rewrites the u32 pointer slot in gLevelUpLearnsets[].
 *  Old array is left in place. */
export async function editBinaryRomLearnsetAppend(
  sessionId: string,
  args: {
    readonly pointerFileOffset: number;
    readonly currentArrayFileOffset: number;
    readonly level: number;
    readonly move: number;
  },
): Promise<BinaryRomEditLearnsetAppendResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/species-learnset-append`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditLearnsetAppendResponseLike;
}

/** Phase K - patch a single WildPokemon slot (4 bytes). */
export async function editBinaryRomEncounterSlot(
  sessionId: string,
  args: {
    readonly slotFileOffset: number;
    readonly fields: {
      readonly speciesId?: number;
      readonly minLevel?: number;
      readonly maxLevel?: number;
    };
  },
): Promise<BinaryRomEditEncounterSlotResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/encounter-slot`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditEncounterSlotResponseLike;
}

/** WP-C1 - encounter table ops beyond per-slot:
 *    setRate - write u8 at WildPokemonInfo[0]
 *    reorder - write permuted slot array (slotOrder = [newIndex0 -> srcIndex, ...])
 *    bulkReplaceSpecies - overwrite every slot's species u16 with `speciesId` (levels preserved) */
export async function editBinaryRomEncounterTable(
  sessionId: string,
  args:
    | {
        readonly encounterTableId: string;
        readonly op: 'setRate';
        readonly encounterRate: number;
        readonly description?: string;
      }
    | {
        readonly encounterTableId: string;
        readonly op: 'reorder';
        readonly slotOrder: ReadonlyArray<number>;
        readonly description?: string;
      }
    | {
        readonly encounterTableId: string;
        readonly op: 'bulkReplaceSpecies';
        readonly speciesId: number;
        readonly description?: string;
      },
): Promise<BinaryRomEditEncounterTableResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/encounter-table`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditEncounterTableResponseLike;
}

/** Phase J.7 + J.8 - true delete or append on the map's ObjectEvent table.
 *  Delete shifts subsequent slots down by 24 bytes + zeros the last slot
 *  + decrements the count byte. Append increments the count + writes a
 *  fresh 24-byte slot at the new index. */
export async function editBinaryRomObjectEventTable(
  sessionId: string,
  args: {
    readonly mapEventsStructOffset: number;
    readonly objectEventsArrayOffset: number;
    readonly op: 'delete' | 'append';
    readonly deleteStructFileOffset?: number;
    readonly newObject?: {
      readonly localId: number;
      readonly graphicsId: number;
      readonly x: number;
      readonly y: number;
      readonly elevation: number;
      readonly movementType: number;
      readonly movementRangeXY: number;
      readonly trainerType: number;
      readonly trainerSightOrBerryTreeId: number;
      readonly scriptPointer: number;
      readonly flagId: number;
    };
  },
): Promise<BinaryRomEditObjectEventTableResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/object-event-table`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditObjectEventTableResponseLike;
}

/** Phase J.4 - write metatile attribute fields (behavior, terrain type,
 *  encounter type, layer type). Preserves padding bits. */
export async function editBinaryRomMetatileAttrs(
  sessionId: string,
  args: {
    readonly tilesetStructOffset: number;
    readonly metatileId: number;
    readonly family: 'frlg' | 'rse';
    readonly attrs: {
      readonly behavior?: number;
      readonly terrainType?: number;
      readonly encounterType?: number;
      readonly layerType?: number;
    };
  },
): Promise<BinaryRomEditMetatileAttrsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/metatile-attrs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditMetatileAttrsResponseLike;
}

/** Phase J.1 - edit binary-ROM trigger struct fields (bg-event kind,
 *  coord-trigger var/value, elevation). Phase O.33 - adds hidden-item
 *  field editing for bg kinds 5/7 (item id + flag offset + quantity). */
export async function editBinaryRomTriggerFields(
  sessionId: string,
  args: {
    readonly triggerKind: 'bg' | 'coord';
    readonly structFileOffset: number;
    readonly fields: {
      readonly bgEventKind?: number;
      readonly coordTriggerVar?: number;
      readonly coordTriggerIndex?: number;
      readonly elevation?: number;
      readonly hiddenItemId?: number;
      readonly hiddenItemFlagOffset?: number;
      readonly hiddenItemQuantity?: number;
    };
  },
): Promise<BinaryRomEditTriggerFieldsResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/trigger-fields`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditTriggerFieldsResponseLike;
}

/** Phase O.42 step 3/5 - edit a HealLocationEntry's 6-byte struct
 *  (group / mapNum / x / y). Mirrors the trigger-fields shape. */
export async function editBinaryRomHealLocation(
  sessionId: string,
  args: {
    readonly sourceFileOffset: number;
    readonly fields: {
      readonly group?: number;
      readonly mapNum?: number;
      readonly x?: number;
      readonly y?: number;
    };
  },
): Promise<BinaryRomEditHealLocationResponseLike> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/heal-location`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditHealLocationResponseLike;
}

// --- Agent patch lifecycle (AI-1.3) ---

export type AgentPatchActionErrorCode =
  | 'proposal_not_found'
  | 'proposal_not_pending'
  | 'project_not_open'
  | 'before_not_found'
  | 'before_ambiguous'
  | 'file_not_found'
  | 'unsafe_path'
  | 'unknown_edit_kind'
  | 'write_failed'
  | 'http_error';

export class AgentPatchActionError extends Error {
  constructor(
    public readonly code: AgentPatchActionErrorCode,
    message: string,
    public readonly editIndex?: number,
    public readonly filePath?: string,
  ) {
    super(message);
    this.name = 'AgentPatchActionError';
  }
}

async function readPatchError(response: Response): Promise<AgentPatchActionError> {
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
      editIndex?: number;
      filePath?: string;
    };
    if (body?.error) {
      return new AgentPatchActionError(
        body.error as AgentPatchActionErrorCode,
        body.message ?? body.error,
        body.editIndex,
        body.filePath,
      );
    }
  } catch {
    /* fallthrough */
  }
  return new AgentPatchActionError('http_error', `HTTP ${response.status} ${response.statusText}`);
}

export async function applyAgentPatch(proposalId: string): Promise<AgentPatchProposal> {
  const response = await fetch(
    `/api/agent/patches/${encodeURIComponent(proposalId)}/apply`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readPatchError(response);
  return (await response.json()) as AgentPatchProposal;
}

export async function rejectAgentPatch(proposalId: string): Promise<AgentPatchProposal> {
  const response = await fetch(
    `/api/agent/patches/${encodeURIComponent(proposalId)}/reject`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw await readPatchError(response);
  return (await response.json()) as AgentPatchProposal;
}

// ─── WP-A4: Visual scripter direct-apply API ───────────────────────────

/** Shape of one ScriptStep handed across the API to the script-edit
 *  endpoint. Same shape the encoder accepts; the backend decodes the
 *  full script, applies the user's op (insert / delete / edit), encodes
 *  back, and writes to ROM with the same atomic semantics every other
 *  binary-rom-edit route uses. */
export interface BinaryRomScriptStepLike {
  readonly kind:
    | 'dialogue'
    | 'set_flag'
    | 'clear_flag'
    | 'branch'
    | 'branch_on_var'
    | 'give_item'
    | 'start_battle'
    | 'play_sound'
    | 'move_npc'
    | 'fade_scene'
    | 'warp_player'
    | 'set_variable'
    | 'randomize_branch'
    | 'raw';
  readonly params: Readonly<Record<string, unknown>>;
}

export interface BinaryRomEditScriptStepResponse {
  readonly scriptOffset: number;
  readonly oldByteLength: number;
  readonly newByteLength: number;
  readonly wasRelocated: boolean;
  readonly pointerRewrites: number;
  readonly editsApplied: number;
  readonly description: string;
}

/** Direct-apply call for the visual scripter's Add/Edit/Delete step
 *  buttons. The user IS the reviewer when they click an inspector
 *  button, so this bypasses the agent-review proposal flow and writes
 *  immediately. Backed by /api/projects/:id/binary-rom-edit/script-step
 *  which wraps computeScriptEdit + applyEdits + op-log for undo. */
export async function editBinaryRomScriptStep(
  sessionId: string,
  args: {
    readonly scriptId: string;
    readonly op: 'insertStep' | 'deleteStep' | 'editStep';
    readonly stepIndex: number;
    readonly newStep?: BinaryRomScriptStepLike;
    readonly description?: string;
  },
): Promise<BinaryRomEditScriptStepResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(sessionId)}/binary-rom-edit/script-step`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw await readError(response);
  return (await response.json()) as BinaryRomEditScriptStepResponse;
}

/** Probe the backend for whether the `claude` CLI is reachable on the
 *  user's machine. The AgentPanel uses this to decide whether to show a
 *  "claude not installed" banner - otherwise the WS connects fine but
 *  every turn fails with the same "Could not locate the `claude` CLI"
 *  error, which is confusing because the connection pip says green. */
export async function fetchAgentHealth(): Promise<AgentHealthResponse> {
  const response = await fetch('/api/agent/health', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`/api/agent/health returned HTTP ${response.status}`);
  }
  return (await response.json()) as AgentHealthResponse;
}
