import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectManifest,
  SpeciesEntry,
  SpeciesLearnsetEntry,
} from '@rom-editor/shared';
import {
  editBinaryRomDialogueString,
  editBinaryRomEvolutionDelete,
  editBinaryRomEvolutionSlot,
  editBinaryRomLearnsetAppend,
  editBinaryRomLearnsetDelete,
  editBinaryRomLearnsetMove,
  editBinaryRomSpeciesFields,
  editBinaryRomTmhm,
  ProjectApiError,
} from '../api';
import { pushToast, useProjectStore, useUiPreferencesStore } from '../state';
import { displayName } from '../lib/displayName';
import { EntityPicker } from './EntityPicker';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase M.1 - Pokémon species workspace.
 *
 * Lists every detected species with editable base stats, types, catch
 * rate, held items, growth rate, egg group, abilities, friendship,
 * gender ratio, etc. Each row expands to a stat-block + editable
 * fields. Writes via /binary-rom-edit/species-fields.
 */

interface SpeciesViewProps {
  readonly manifest: ProjectManifest;
}

export function SpeciesView({ manifest }: SpeciesViewProps): JSX.Element {
  const species = manifest.species ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(species.length > 0 ? 0 : null);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const filtered = useMemo(() => {
    if (!filter.trim()) return species;
    const q = filter.toLowerCase();
    return species.filter(
      (s) =>
        (s.name ?? '').toLowerCase().includes(q) ||
        String(s.speciesIndex).includes(q) ||
        (s.id ?? '').toLowerCase().includes(q),
    );
  }, [species, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < species.length
      ? species[selectedIdx]!
      : null;

  if (species.length === 0) {
    return (
      <div className="species-view species-view--empty" data-testid="species-view-empty">
        <h2>No species data</h2>
        <p>
          The species_system detector didn't lift any species. Open a Gen-3 ROM
          / decomp project, scan, and they'll appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="species-view" data-testid="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by name or index…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="species-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((s) => {
            const realIdx = species.indexOf(s);
            // Phase O.73 - surface typing in the list row so the
            // operator can scan starters / dual-type Pokémon /
            // grass-type evolution lines without opening each
            // detail pane. Mirrors O.69/O.70/O.71/O.72.
            const typeMeta =
              s.type1Name && s.type2Name && s.type1Name !== s.type2Name
                ? `${s.type1Name} / ${s.type2Name}`
                : s.type1Name
                  ? s.type1Name
                  : null;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`species-view__item${
                    realIdx === selectedIdx ? ' species-view__item--selected' : ''
                  }`}
                  data-testid={`species-view-item-${s.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{s.speciesIndex}</span>
                  <span className="species-view__item-name">
                    {s.name ?? displayName(manifest, s.id, showInternalIds)}
                    {typeMeta && (
                      <span
                        className="species-view__item-meta"
                        data-testid={`species-view-item-types-${s.id}`}
                        style={{
                          marginLeft: 8,
                          color: 'var(--color-text-muted)',
                          fontSize: 11,
                        }}
                      >
                        · {typeMeta}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? (
          <SpeciesEditor species={selected} manifest={manifest} showInternalIds={showInternalIds} />
        ) : (
          <p>Pick a species to edit.</p>
        )}
      </section>
    </div>
  );
}

const TYPE_OPTIONS_VANILLA: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Fighting' },
  { value: 2, label: 'Flying' },
  { value: 3, label: 'Poison' },
  { value: 4, label: 'Ground' },
  { value: 5, label: 'Rock' },
  { value: 6, label: 'Bug' },
  { value: 7, label: 'Ghost' },
  { value: 8, label: 'Steel' },
  { value: 9, label: 'Mystery' },
  { value: 10, label: 'Fire' },
  { value: 11, label: 'Water' },
  { value: 12, label: 'Grass' },
  { value: 13, label: 'Electric' },
  { value: 14, label: 'Psychic' },
  { value: 15, label: 'Ice' },
  { value: 16, label: 'Dragon' },
  { value: 17, label: 'Dark' },
];

const GROWTH_RATE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Medium-fast' },
  { value: 1, label: 'Erratic' },
  { value: 2, label: 'Fluctuating' },
  { value: 3, label: 'Medium-slow' },
  { value: 4, label: 'Fast' },
  { value: 5, label: 'Slow' },
];

interface SpeciesEditorProps {
  readonly species: SpeciesEntry;
  readonly manifest: ProjectManifest;
  readonly showInternalIds: boolean;
}

function SpeciesEditor({ species, manifest, showInternalIds: _showInternalIds }: SpeciesEditorProps): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const initial = {
    baseHP: species.baseHP,
    baseAttack: species.baseAttack,
    baseDefense: species.baseDefense,
    baseSpeed: species.baseSpeed,
    baseSpAttack: species.baseSpAttack,
    baseSpDefense: species.baseSpDefense,
    type1: species.type1,
    type2: species.type2,
    catchRate: species.catchRate,
    expYield: species.expYield,
    item1: species.item1,
    item2: species.item2,
    genderRatio: species.genderRatio,
    eggCycles: species.eggCycles,
    friendship: species.friendship,
    growthRate: species.growthRate,
    eggGroup1: species.eggGroup1,
    eggGroup2: species.eggGroup2,
    ability1: species.ability1,
    ability2: species.ability2,
    safariZoneFleeRate: species.safariZoneFleeRate,
  };
  const [values, setValues] = useState<Record<string, number>>({ ...initial });
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  function setField(k: string, v: number): void {
    setValues((prev) => ({ ...prev, [k]: v }));
  }
  const dirty = Object.keys(initial).some(
    (k) => values[k] !== (initial as Record<string, number>)[k],
  );
  const canSave = dirty && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      const fields: Record<string, number> = {};
      for (const k of Object.keys(initial)) {
        if (values[k] !== (initial as Record<string, number>)[k]) fields[k] = values[k]!;
      }
      await editBinaryRomSpeciesFields(sessionId, {
        sourceFileOffset: species.sourceFileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Species "${species.name}" saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Species save failed - ${message}`);
    }
  }

  function NumberField({
    name,
    field,
    max,
  }: {
    name: string;
    field: string;
    max: number;
  }): JSX.Element {
    return (
      <label className="species-field">
        <span>{name}</span>
        <input
          type="number"
          min={0}
          max={max}
          value={values[field] ?? 0}
          onChange={(e) =>
            setField(
              field,
              Math.max(0, Math.min(max, Number.parseInt(e.target.value, 10) || 0)),
            )
          }
        />
      </label>
    );
  }
  function TypeField({ name, field }: { name: string; field: string }): JSX.Element {
    return (
      <label className="species-field">
        <span>{name}</span>
        <select
          value={values[field] ?? 0}
          onChange={(e) => setField(field, Number.parseInt(e.target.value, 10))}
        >
          {TYPE_OPTIONS_VANILLA.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!TYPE_OPTIONS_VANILLA.some((o) => o.value === values[field]) && (
            <option value={values[field]}>{`${values[field]} - Hack-specific`}</option>
          )}
        </select>
      </label>
    );
  }

  // Phase O.31 - Enter saves, Esc reverts all species fields.
  const onKeyDownFieldsEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setValues({ ...initial });
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownFieldsEdit}>
      <header>
        <h2>
          #{species.speciesIndex} {species.name ?? `Species ${species.speciesIndex}`}
        </h2>
        <p>
          {species.type1Name && species.type2Name && species.type1 !== species.type2
            ? `${species.type1Name} / ${species.type2Name} type`
            : species.type1Name
              ? `${species.type1Name} type`
              : 'Unknown type'}
        </p>
      </header>
      <SpeciesNameEditor species={species} manifest={manifest} />
      <fieldset>
        <legend>Base stats</legend>
        <div className="species-field-grid">
          <NumberField name="HP" field="baseHP" max={255} />
          <NumberField name="Attack" field="baseAttack" max={255} />
          <NumberField name="Defense" field="baseDefense" max={255} />
          <NumberField name="Sp. Atk" field="baseSpAttack" max={255} />
          <NumberField name="Sp. Def" field="baseSpDefense" max={255} />
          <NumberField name="Speed" field="baseSpeed" max={255} />
        </div>
      </fieldset>
      <fieldset>
        <legend>Type</legend>
        <div className="species-field-grid">
          <TypeField name="Type 1" field="type1" />
          <TypeField name="Type 2" field="type2" />
        </div>
      </fieldset>
      <fieldset>
        <legend>Catch / growth</legend>
        <div className="species-field-grid">
          <NumberField name="Catch rate" field="catchRate" max={255} />
          <NumberField name="EXP yield" field="expYield" max={255} />
          <NumberField name="Friendship" field="friendship" max={255} />
          <NumberField name="Egg cycles" field="eggCycles" max={255} />
          <NumberField name="Safari flee" field="safariZoneFleeRate" max={255} />
          <NumberField name="Gender ratio" field="genderRatio" max={255} />
          <label className="species-field">
            <span>Growth rate</span>
            <select
              value={values.growthRate ?? 0}
              onChange={(e) => setField('growthRate', Number.parseInt(e.target.value, 10))}
            >
              {GROWTH_RATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Abilities + items</legend>
        <div className="species-field-grid">
          <NumberField name="Ability 1" field="ability1" max={255} />
          <NumberField name="Ability 2" field="ability2" max={255} />
          <NumberField name="Held item 1 (u16)" field="item1" max={0xffff} />
          <NumberField name="Held item 2 (u16)" field="item2" max={0xffff} />
          <NumberField name="Egg group 1" field="eggGroup1" max={255} />
          <NumberField name="Egg group 2" field="eggGroup2" max={255} />
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="species-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save base stats'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · BaseStats patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
      {species.ability1Name && (
        <p style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          Resolved: Ability 1 = {species.ability1Name}
          {species.ability2Name && species.ability2 !== species.ability1
            ? ` · Ability 2 = ${species.ability2Name}`
            : ''}
        </p>
      )}
      <SpeciesEvolutionsEditor species={species} manifest={manifest} />
      <SpeciesLearnsetEditor species={species} manifest={manifest} />
      <SpeciesTmhmEditor species={species} manifest={manifest} />
    </div>
  );
}

function SpeciesTmhmEditor({
  species,
  manifest,
}: {
  species: SpeciesEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const tmhm = useMemo(
    () =>
      (manifest.speciesTMHM ?? []).find(
        (t) => t.speciesIndex === species.speciesIndex,
      ) ?? null,
    [manifest.speciesTMHM, species.speciesIndex],
  );
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [low, setLow] = useState(tmhm?.low ?? 0);
  const [high, setHigh] = useState(tmhm?.high ?? 0);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setLow(tmhm?.low ?? 0);
    setHigh(tmhm?.high ?? 0);
    setState({ kind: 'idle' });
  }, [tmhm?.sourceFileOffset, tmhm?.low, tmhm?.high]);
  if (!tmhm) return null;
  const dirty = low !== tmhm.low || high !== tmhm.high;
  function bitSet(idx: number): boolean {
    if (idx < 32) return ((low >>> idx) & 1) === 1;
    return ((high >>> (idx - 32)) & 1) === 1;
  }
  function toggle(idx: number): void {
    if (idx < 32) {
      const nextLow = (low ^ (1 << idx)) >>> 0;
      setLow(nextLow);
    } else {
      const nextHigh = (high ^ (1 << (idx - 32))) >>> 0;
      setHigh(nextHigh);
    }
  }
  async function save(): Promise<void> {
    if (!sessionId || !dirty || !tmhm) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomTmhm(sessionId, {
        slotFileOffset: tmhm.sourceFileOffset,
        low,
        high,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'TM/HM compatibility saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `TM/HM save failed - ${message}`);
    }
  }
  // Phase O.31 - Enter saves, Esc reverts TM/HM bits.
  const onKeyDownTmhmEdit = useEditFormKeyboard({
    canSave: dirty && sessionId !== null && state.kind !== 'saving',
    save,
    cancel: () => {
      setLow(tmhm.low);
      setHigh(tmhm.high);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });
  return (
    <fieldset onKeyDown={onKeyDownTmhmEdit}>
      <legend>TM / HM compatibility</legend>
      <p className="fields-editor__hint">
        Toggle each TM (1-50) or HM (1-8) the species can learn. Bit
        layout matches gTMHMLearnsets exactly: bits 0..49 = TM 1..50,
        bits 50..57 = HM 1..8.
      </p>
      <div className="tmhm-grid">
        {Array.from({ length: 50 }, (_, i) => i).map((i) => (
          <label key={`tm-${i}`} className="tmhm-cell">
            <input
              type="checkbox"
              checked={bitSet(i)}
              onChange={() => toggle(i)}
            />
            <span>TM{String(i + 1).padStart(2, '0')}</span>
          </label>
        ))}
        {Array.from({ length: 8 }, (_, i) => i + 50).map((i) => (
          <label key={`hm-${i}`} className="tmhm-cell tmhm-cell--hm">
            <input
              type="checkbox"
              checked={bitSet(i)}
              onChange={() => toggle(i)}
            />
            <span>HM{String(i - 49).padStart(2, '0')}</span>
          </label>
        ))}
      </div>
      <div className="species-editor__actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save TM/HM compat'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · 8-byte slot patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
    </fieldset>
  );
}

function SpeciesNameEditor({
  species,
  manifest,
}: {
  species: SpeciesEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const nameEntry = useMemo(
    () =>
      (manifest.speciesNames ?? []).find(
        (n) => n.speciesIndex === species.speciesIndex,
      ) ?? null,
    [manifest.speciesNames, species.speciesIndex],
  );
  const nameSlotOffset = nameEntry?.nameSlotOffset;
  const initialName = nameEntry?.name ?? '';
  const [name, setName] = useState(initialName);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setName(initialName);
    setState({ kind: 'idle' });
  }, [nameSlotOffset, initialName]);
  if (!nameEntry || nameSlotOffset === undefined) return null;
  const dirty = name !== initialName;
  // Species name slot is 11 bytes (10 chars + 0xFF terminator).
  const valid = name.length <= 10;
  async function save(): Promise<void> {
    if (!sessionId || !dirty || !valid) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: nameSlotOffset!,
        newText: name,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Species renamed to "${name}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Species rename failed - ${message}`);
    }
  }
  // Phase O.31 - Enter saves, Esc reverts species name.
  const onKeyDownNameEdit = useEditFormKeyboard({
    canSave: dirty && valid && sessionId !== null && state.kind !== 'saving',
    save,
    cancel: () => {
      setName(initialName);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });
  return (
    <fieldset onKeyDown={onKeyDownNameEdit}>
      <legend>Name</legend>
      <div className="species-field-grid">
        <label className="species-field">
          <span>Species name (≤10 chars)</span>
          <input
            type="text"
            maxLength={10}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="species-name-input"
          />
        </label>
      </div>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || !valid || !sessionId || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid="species-name-save"
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save name'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · name slot patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
    </fieldset>
  );
}

const EVOLUTION_METHOD_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - None' },
  { value: 1, label: '1 - Friendship (any time)' },
  { value: 2, label: '2 - Friendship (day)' },
  { value: 3, label: '3 - Friendship (night)' },
  { value: 4, label: '4 - Level' },
  { value: 5, label: '5 - Trade' },
  { value: 6, label: '6 - Trade with item' },
  { value: 7, label: '7 - Item (use stone)' },
  { value: 8, label: '8 - Level w/ atk>def' },
  { value: 9, label: '9 - Level w/ atk=def' },
  { value: 10, label: '10 - Level w/ atk<def' },
  { value: 11, label: '11 - Level w/ silcoon' },
  { value: 12, label: '12 - Level w/ cascoon' },
  { value: 13, label: '13 - Level w/ ninjask' },
  { value: 14, label: '14 - Level w/ shedinja' },
  { value: 15, label: '15 - Beauty (level + beauty)' },
];

function SpeciesEvolutionsEditor({
  species,
  manifest,
}: {
  species: SpeciesEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const evo = useMemo(
    () =>
      (manifest.speciesEvolutions ?? []).find(
        (e) => e.speciesIndex === species.speciesIndex,
      ) ?? null,
    [manifest.speciesEvolutions, species.speciesIndex],
  );
  if (!evo) return null;
  return (
    <fieldset>
      <legend>Evolutions ({evo.slots.length} / 5 slots)</legend>
      {evo.slots.map((slot, i) => (
        <EvolutionSlotRow
          key={slot.fileOffset}
          slot={slot}
          slotIndex={i}
          blockFileOffset={evo.sourceFileOffset}
          populatedCount={evo.slots.length}
          manifest={manifest}
        />
      ))}
      {/* Phase O.14 - fill the next empty slot in the fixed 5-slot
          window. Gen-3 EVOS_PER_MON=5 is a hard cap; populated slots
          are contiguous from index 0 so the next empty slot's file
          offset = sourceFileOffset + populatedCount * 6 (each slot is
          the 6-byte pret `struct Evolution`). */}
      <AddEvolutionButton entry={evo} manifest={manifest} />
    </fieldset>
  );
}

const EVOS_PER_MON = 5;
/** Bytes per evolution slot: `struct Evolution { u16 method; u16 param;
 *  u16 targetSpecies; }` - 6 bytes, no padding word (pret/pokefirered,
 *  pokeemerald, pokeruby). A per-species block is 5 × 6 = 30 bytes. */
const EVOLUTION_SLOT_SIZE = 6;

function AddEvolutionButton({
  entry,
  manifest,
}: {
  entry: {
    slots: ReadonlyArray<{ method: number; param: number; targetSpecies: number; fileOffset: number }>;
    sourceFileOffset: number;
  };
  manifest: ProjectManifest;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState(4); // EVO_LEVEL
  const [param, setParam] = useState(16);
  const [target, setTarget] = useState(2); // species 2 = Ivysaur (sane vanilla default)
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const populatedCount = entry.slots.length;
  const atMax = populatedCount >= EVOS_PER_MON;
  const nextSlotOffset = entry.sourceFileOffset + populatedCount * EVOLUTION_SLOT_SIZE;

  async function add(): Promise<void> {
    if (!sessionId || atMax) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomEvolutionSlot(sessionId, {
        slotFileOffset: nextSlotOffset,
        fields: { method, param, targetSpecies: target },
      });
      setState({ kind: 'idle' });
      pushToast(
        'success',
        `Evolution added - species now has ${String(populatedCount + 1)} evolution${populatedCount + 1 === 1 ? '' : 's'}`,
      );
      setOpen(false);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Add evolution failed - ${message}`);
    }
  }

  if (atMax) {
    return (
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '8px 0 0 0' }}>
        Species already at Gen-3 max (5 evolution slots).
      </p>
    );
  }
  if (!open) {
    return (
      <div className="species-editor__actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setOpen(true)}
          data-testid="evolution-add-open"
        >
          {`＋ Add evolution (${populatedCount}/${EVOS_PER_MON})`}
        </button>
      </div>
    );
  }
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        border: '1px solid var(--color-border)',
        borderRadius: 4,
      }}
      data-testid="evolution-add-form"
    >
      <h5 className="fields-editor__heading">New evolution</h5>
      <div className="species-field-grid">
        <label className="species-field">
          <span>Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(parseInt(e.target.value, 10))}
            data-testid="evolution-add-method"
          >
            {EVOLUTION_METHOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="species-field">
          <span>Parameter (level / item id / friendship)</span>
          <input
            type="number"
            min={0}
            max={0xffff}
            value={param}
            onChange={(e) =>
              setParam(Math.max(0, Math.min(0xffff, parseInt(e.target.value, 10) || 0)))
            }
            data-testid="evolution-add-param"
          />
        </label>
        <label className="species-field">
          <span>Target species</span>
          <EntityPicker
            kind="species"
            manifest={manifest}
            value={target}
            onChange={setTarget}
            minId={1}
            maxId={0xffff}
            testIdPrefix="evolution-add-target"
          />
        </label>
      </div>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.kind === 'saving'}
          onClick={() => void add()}
          data-testid="evolution-add-save"
        >
          {state.kind === 'saving' ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setOpen(false);
            setState({ kind: 'idle' });
          }}
        >
          Cancel
        </button>
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

function EvolutionSlotRow({
  slot,
  slotIndex,
  blockFileOffset,
  populatedCount,
  manifest,
}: {
  slot: { method: number; param: number; targetSpecies: number; fileOffset: number };
  slotIndex: number;
  blockFileOffset: number;
  populatedCount: number;
  manifest: ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [method, setMethod] = useState(slot.method);
  const [param, setParam] = useState(slot.param);
  const [target, setTarget] = useState(slot.targetSpecies);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setMethod(slot.method);
    setParam(slot.param);
    setTarget(slot.targetSpecies);
    setState({ kind: 'idle' });
  }, [slot.fileOffset, slot.method, slot.param, slot.targetSpecies]);

  const dirty =
    method !== slot.method || param !== slot.param || target !== slot.targetSpecies;
  async function save(): Promise<void> {
    if (!sessionId || !dirty) return;
    setState({ kind: 'saving' });
    try {
      const fields: { method?: number; param?: number; targetSpecies?: number } = {};
      if (method !== slot.method) fields.method = method;
      if (param !== slot.param) fields.param = param;
      if (target !== slot.targetSpecies) fields.targetSpecies = target;
      await editBinaryRomEvolutionSlot(sessionId, {
        slotFileOffset: slot.fileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Evolution slot saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Evolution save failed - ${message}`);
    }
  }

  // Phase O.31 - Enter saves, Esc reverts evolution slot.
  const onKeyDownEvoEdit = useEditFormKeyboard({
    canSave: dirty && sessionId !== null && state.kind !== 'saving',
    save,
    cancel: () => {
      setMethod(slot.method);
      setParam(slot.param);
      setTarget(slot.targetSpecies);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="species-field-grid"
      style={{ marginBottom: 8 }}
      onKeyDown={onKeyDownEvoEdit}
    >
      <label className="species-field">
        <span>Slot {slotIndex + 1} - Method</span>
        <select value={method} onChange={(e) => setMethod(Number.parseInt(e.target.value, 10))}>
          {EVOLUTION_METHOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!EVOLUTION_METHOD_OPTIONS.some((o) => o.value === method) && (
            <option value={method}>{`${method} - Hack-specific`}</option>
          )}
        </select>
      </label>
      <label className="species-field">
        <span>Param (level / item id / friendship)</span>
        <input
          type="number"
          min={0}
          max={0xffff}
          value={param}
          onChange={(e) =>
            setParam(Math.max(0, Math.min(0xffff, Number.parseInt(e.target.value, 10) || 0)))
          }
        />
      </label>
      <label className="species-field">
        <span>Target species</span>
        <EntityPicker
          kind="species"
          manifest={manifest}
          value={target}
          onChange={setTarget}
          minId={0}
          maxId={0xffff}
          testIdPrefix={`evolution-slot-${String(slotIndex)}-target`}
        />
      </label>
      <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || !sessionId || state.kind === 'saving'}
          onClick={() => void save()}
          style={{ height: 26, fontSize: 11, padding: '0 10px' }}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => {
            if (!sessionId) return;
            if (
              !window.confirm(
                `Delete evolution slot ${String(slotIndex + 1)}? Trailing slots shift up so the engine reads them correctly. The block will have ${String(populatedCount - 1)} evolution${populatedCount - 1 === 1 ? '' : 's'}.`,
              )
            ) {
              return;
            }
            setState({ kind: 'saving' });
            void (async () => {
              try {
                await editBinaryRomEvolutionDelete(sessionId, {
                  blockFileOffset,
                  slotIndex,
                  currentPopulatedCount: populatedCount,
                });
                pushToast('success', `Evolution slot ${String(slotIndex + 1)} deleted`);
                await scanCurrent();
              } catch (e) {
                const message =
                  e instanceof ProjectApiError
                    ? `${e.code}: ${e.message}`
                    : e instanceof Error
                      ? e.message
                      : String(e);
                setState({ kind: 'error', message });
                pushToast('error', `Evolution delete failed - ${message}`);
              }
            })();
          }}
          style={{
            height: 26,
            fontSize: 11,
            padding: '0 10px',
            color: 'var(--color-error, #e25555)',
          }}
          data-testid={`evolution-delete-${String(slotIndex)}`}
          title="Remove this evolution. Trailing slots shift up so the engine reads them correctly."
        >
          Delete
        </button>
        {state.kind === 'saved' && !dirty && <span className="species-editor__ok">Saved</span>}
        {state.kind === 'error' && <span className="species-editor__err">{state.message}</span>}
      </div>
    </div>
  );
}

function SpeciesLearnsetEditor({
  species,
  manifest,
}: {
  species: SpeciesEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const learnset = useMemo(
    () =>
      (manifest.speciesLearnsets ?? []).find(
        (l) => l.speciesIndex === species.speciesIndex,
      ) ?? null,
    [manifest.speciesLearnsets, species.speciesIndex],
  );
  if (!learnset || learnset.moves.length === 0) return null;
  return (
    <fieldset>
      <legend>Learnset ({learnset.moves.length} entries)</legend>
      <p className="fields-editor__hint">
        Edit existing entries in place. Add learnset move relocates the
        array (allocates a new larger one in free ROM space; old slot
        is left as-is - no compaction).
      </p>
      {learnset.moves.map((m, i) => (
        <LearnsetMoveRow
          key={i}
          arrayFileOffset={learnset.arrayFileOffset}
          entryIndex={i}
          level={m.level}
          move={m.move}
          moveName={m.moveName ?? null}
          manifest={manifest}
        />
      ))}
      {/* Phase O.10 - Add a new learnset move via free-space relocation. */}
      <AddLearnsetMoveButton learnset={learnset} manifest={manifest} />
    </fieldset>
  );
}

function AddLearnsetMoveButton({
  learnset,
  manifest,
}: {
  learnset: SpeciesLearnsetEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(5);
  const [move, setMove] = useState(1);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  if (
    learnset.pointerFileOffset === undefined ||
    learnset.pointerFileOffset < 0
  ) {
    // Older manifests without the per-entry pointer slot offset can't
    // be appended to. Silent fallback - operator can re-scan.
    return null;
  }

  async function add(): Promise<void> {
    if (!sessionId || learnset.pointerFileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      const r = await editBinaryRomLearnsetAppend(sessionId, {
        pointerFileOffset: learnset.pointerFileOffset,
        currentArrayFileOffset: learnset.arrayFileOffset,
        level,
        move,
      });
      setState({ kind: 'idle' });
      pushToast(
        'success',
        `Learnset grown to ${String(r.newEntryCount)} entries`,
      );
      setOpen(false);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Add learnset move failed - ${message}`);
    }
  }

  if (!open) {
    return (
      <div className="species-editor__actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setOpen(true)}
          data-testid="learnset-add-open"
        >
          {`＋ Add learnset move (${learnset.moves.length} current)`}
        </button>
      </div>
    );
  }
  return (
    <div
      className="fields-editor"
      style={{ marginTop: 8, padding: 8, border: '1px solid var(--color-border)' }}
      data-testid="learnset-add-form"
    >
      <h5 className="fields-editor__heading">New learnset entry</h5>
      <div className="species-field-grid">
        <label className="species-field">
          <span>Level (1-100)</span>
          <input
            type="number"
            min={1}
            max={100}
            value={level}
            onChange={(e) =>
              setLevel(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))
            }
            data-testid="learnset-add-level"
          />
        </label>
        <label className="species-field">
          <span>Move</span>
          <EntityPicker
            kind="move"
            manifest={manifest}
            value={move}
            onChange={setMove}
            minId={0}
            maxId={511}
            testIdPrefix="learnset-add-move"
          />
        </label>
      </div>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={state.kind === 'saving'}
          onClick={() => void add()}
          data-testid="learnset-add-save"
        >
          {state.kind === 'saving' ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setOpen(false);
            setState({ kind: 'idle' });
          }}
        >
          Cancel
        </button>
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

function LearnsetMoveRow({
  arrayFileOffset,
  entryIndex,
  level: initialLevel,
  move: initialMove,
  moveName,
  manifest,
}: {
  arrayFileOffset: number;
  entryIndex: number;
  level: number;
  move: number;
  moveName: string | null;
  manifest: ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [level, setLevel] = useState(initialLevel);
  const [move, setMove] = useState(initialMove);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setLevel(initialLevel);
    setMove(initialMove);
    setState({ kind: 'idle' });
  }, [arrayFileOffset, entryIndex, initialLevel, initialMove]);
  const dirty = level !== initialLevel || move !== initialMove;
  async function save(): Promise<void> {
    if (!sessionId || !dirty) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomLearnsetMove(sessionId, {
        arrayFileOffset,
        entryIndex,
        level,
        move,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Learnset move saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Learnset save failed - ${message}`);
    }
  }
  async function deleteEntry(): Promise<void> {
    if (!sessionId) return;
    if (
      !window.confirm(
        `Delete learnset entry #${String(entryIndex + 1)} (Lv ${String(initialLevel)} - ${moveName ?? `move ${String(initialMove)}`})? Subsequent entries shift up.`,
      )
    ) {
      return;
    }
    setState({ kind: 'saving' });
    try {
      const r = await editBinaryRomLearnsetDelete(sessionId, {
        arrayFileOffset,
        entryIndex,
      });
      pushToast(
        'success',
        `Learnset shrunk to ${String(r.newEntryCount)} entries`,
      );
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Learnset delete failed - ${message}`);
    }
  }
  // Phase O.31 - Enter saves, Esc reverts learnset row.
  const onKeyDownLearnsetEdit = useEditFormKeyboard({
    canSave: dirty && sessionId !== null && state.kind !== 'saving',
    save,
    cancel: () => {
      setLevel(initialLevel);
      setMove(initialMove);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });
  return (
    <div
      onKeyDown={onKeyDownLearnsetEdit}
      style={{
        display: 'grid',
        gridTemplateColumns: '60px 80px 1fr auto auto',
        gap: 6,
        alignItems: 'center',
        fontSize: 12,
        marginBottom: 2,
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', fontSize: 10 }}>
        <span style={{ color: 'var(--color-text-muted)' }}>Lv</span>
        <input
          type="number"
          min={1}
          max={100}
          value={level}
          onChange={(e) => setLevel(Math.max(1, Math.min(100, Number.parseInt(e.target.value, 10) || 1)))}
          style={{
            height: 22,
            padding: '0 4px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', fontSize: 10 }}>
        <span style={{ color: 'var(--color-text-muted)' }}>Move</span>
        <EntityPicker
          kind="move"
          manifest={manifest}
          value={move}
          onChange={setMove}
          minId={0}
          maxId={0x1ff}
          testIdPrefix={`learnset-move-${String(entryIndex)}`}
        />
      </label>
      <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
        {moveName ?? ''}
      </span>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!dirty || !sessionId || state.kind === 'saving'}
        onClick={() => void save()}
        style={{ height: 22, fontSize: 10, padding: '0 8px' }}
      >
        {state.kind === 'saving' ? '…' : 'Save'}
      </button>
      <button
        type="button"
        className="btn btn--secondary"
        disabled={!sessionId || state.kind === 'saving'}
        onClick={() => void deleteEntry()}
        style={{
          height: 22,
          fontSize: 10,
          padding: '0 8px',
          color: 'var(--color-error, #e25555)',
        }}
        data-testid={`learnset-delete-${String(entryIndex)}`}
        title="Remove this learnset entry. Subsequent entries shift up."
      >
        Delete
      </button>
    </div>
  );
}
