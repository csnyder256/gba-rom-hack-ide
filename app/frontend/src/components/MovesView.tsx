import { useMemo, useState, useEffect } from 'react';
import type { BattleMoveEntry, ProjectManifest } from '@rom-editor/shared';
import { editBinaryRomDialogueString, editBinaryRomMoveFields, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase M.2 - Battle moves workspace.
 *
 * Left rail: filterable move list. Right pane: editable struct fields
 * (power, accuracy, PP, type, effect, priority, target, secondary effect
 * chance, flags) plus a read-only Gen-3 damage class derived from the
 * move's type. Writes via the existing /binary-rom-edit/move-fields route.
 */

// Gen-3 has no stored damage-class byte: the physical/special split is a
// function of the move's TYPE (and 0 power = status). The manifest's
// `split` field carries the class the engine derives, so it is shown
// read-only here rather than written back to the struct's padding byte.
const SPLIT_LABEL: Readonly<Record<number, string>> = {
  0: 'Status (no damage)',
  1: 'Physical',
  2: 'Special',
};

const TARGET_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0x00, label: 'Selected target' },
  { value: 0x01, label: 'Random opponent' },
  { value: 0x02, label: 'Both opponents' },
  { value: 0x04, label: 'User' },
  { value: 0x08, label: 'User + ally' },
  { value: 0x10, label: 'All Pokémon' },
  { value: 0x20, label: 'Opponents side (field)' },
  { value: 0x40, label: 'User side (field)' },
];

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

interface MovesViewProps {
  readonly manifest: ProjectManifest;
}

export function MovesView({ manifest }: MovesViewProps): JSX.Element {
  const moves = manifest.battleMoves ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(moves.length > 0 ? 0 : null);
  const filtered = useMemo(() => {
    if (!filter.trim()) return moves;
    const q = filter.toLowerCase();
    return moves.filter(
      (m) =>
        (m.name ?? '').toLowerCase().includes(q) ||
        String(m.moveIndex).includes(q) ||
        (m.typeName ?? '').toLowerCase().includes(q),
    );
  }, [moves, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < moves.length
      ? moves[selectedIdx]!
      : null;

  if (moves.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No moves data</h2>
        <p>The moves_system detector didn't lift any battle moves. Open a Gen-3 ROM and scan.</p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by name / index / type…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="moves-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((m) => {
            const realIdx = moves.indexOf(m);
            // Phase O.72 - type + power in muted text after the
            // name so operators can scan attack moves at a glance.
            // Status moves (power=0) show " - " for power. Mirrors
            // the O.69/O.70/O.71 list-row polish pattern.
            const typeLabel = m.typeName ?? (m.type !== undefined ? `Type ${m.type}` : null);
            const powerLabel = m.power && m.power > 0 ? `${m.power} pwr` : ' - ';
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`moves-view-item-${m.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{m.moveIndex}</span>
                  <span className="species-view__item-name">
                    {m.name ?? `Move ${m.moveIndex}`}
                    {typeLabel && (
                      <span
                        className="species-view__item-meta"
                        data-testid={`moves-view-item-meta-${m.id}`}
                        style={{
                          marginLeft: 8,
                          color: 'var(--color-text-muted)',
                          fontSize: 11,
                        }}
                      >
                        · {typeLabel} · {powerLabel}
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
        {selected ? <MoveEditor move={selected} manifest={manifest} /> : <p>Pick a move to edit.</p>}
      </section>
    </div>
  );
}

function MoveNameEditor({
  move,
  manifest,
}: {
  move: BattleMoveEntry;
  manifest: ProjectManifest;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const nameEntry = useMemo(
    () =>
      (manifest.moveNames ?? []).find((n) => n.moveIndex === move.moveIndex) ?? null,
    [manifest.moveNames, move.moveIndex],
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
  // Move name slot is 13 bytes (12 chars + 0xFF terminator).
  const valid = name.length <= 12;
  async function save(): Promise<void> {
    if (!sessionId || !dirty || !valid) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: nameSlotOffset!,
        newText: name,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Move renamed to "${name}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Move rename failed - ${message}`);
    }
  }
  // Phase O.30 - Enter saves, Esc reverts move name.
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
          <span>Move name (≤12 chars)</span>
          <input
            type="text"
            maxLength={12}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="move-name-input"
          />
        </label>
      </div>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || !valid || !sessionId || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid="move-name-save"
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

function MoveEditor({
  move,
  manifest,
}: {
  move: BattleMoveEntry;
  manifest: ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const initial = {
    effect: move.effect,
    power: move.power,
    type: move.type,
    accuracy: move.accuracy,
    pp: move.pp,
    secondaryEffectChance: move.secondaryEffectChance,
    target: move.target,
    priority: move.priority,
    flags: move.flags,
  };
  const [values, setValues] = useState<Record<string, number>>({ ...initial });
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  // Reset when the selected move changes.
  useEffect(() => {
    setValues({ ...initial });
    setState({ kind: 'idle' });
    // Reset-on-selection: deps are intentionally just move.id, not the
    // derived `initial` object, which is rebuilt on every render.
  }, [move.id]);

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
      await editBinaryRomMoveFields(sessionId, {
        sourceFileOffset: move.sourceTableOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Move "${move.name}" saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Move save failed - ${message}`);
    }
  }

  function NumberField({
    name,
    field,
    min,
    max,
  }: {
    name: string;
    field: string;
    min: number;
    max: number;
  }): JSX.Element {
    return (
      <label className="species-field">
        <span>{name}</span>
        <input
          type="number"
          min={min}
          max={max}
          value={values[field] ?? 0}
          onChange={(e) =>
            setField(
              field,
              Math.max(min, Math.min(max, Number.parseInt(e.target.value, 10) || 0)),
            )
          }
        />
      </label>
    );
  }
  function EnumField({
    name,
    field,
    options,
  }: {
    name: string;
    field: string;
    options: ReadonlyArray<{ value: number; label: string }>;
  }): JSX.Element {
    return (
      <label className="species-field">
        <span>{name}</span>
        <select
          value={values[field] ?? 0}
          onChange={(e) => setField(field, Number.parseInt(e.target.value, 10))}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {!options.some((o) => o.value === values[field]) && (
            <option value={values[field]}>{`${values[field]} - Hack-specific`}</option>
          )}
        </select>
      </label>
    );
  }

  function ReadOnlyField({ name, value }: { name: string; value: string }): JSX.Element {
    return (
      <label className="species-field">
        <span>{name}</span>
        <input type="text" value={value} readOnly data-testid="moves-damage-class" />
      </label>
    );
  }

  // Phase O.30 - Enter saves, Esc reverts all move fields.
  const onKeyDownFields = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setValues({ ...initial });
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownFields}>
      <header>
        <h2>
          #{move.moveIndex} {move.name ?? `Move ${move.moveIndex}`}
        </h2>
        <p>
          {move.typeName ?? `Type ${move.type}`} move
        </p>
      </header>
      <MoveNameEditor move={move} manifest={manifest} />
      <fieldset>
        <legend>Damage</legend>
        <div className="species-field-grid">
          <NumberField name="Power" field="power" min={0} max={255} />
          <NumberField name="Accuracy" field="accuracy" min={0} max={255} />
          <NumberField name="PP" field="pp" min={0} max={255} />
          <ReadOnlyField
            name="Damage class"
            value={SPLIT_LABEL[move.split] ?? `Unknown (${move.split})`}
          />
          <EnumField name="Type" field="type" options={TYPE_OPTIONS_VANILLA} />
        </div>
      </fieldset>
      <fieldset>
        <legend>Behavior</legend>
        <div className="species-field-grid">
          <NumberField name="Effect id (u8)" field="effect" min={0} max={255} />
          <NumberField
            name="Secondary chance (%)"
            field="secondaryEffectChance"
            min={0}
            max={255}
          />
          <NumberField name="Priority (s8)" field="priority" min={-128} max={127} />
          <NumberField name="Flags (u8)" field="flags" min={0} max={255} />
          <EnumField name="Target" field="target" options={TARGET_OPTIONS} />
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="moves-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save move'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · move struct patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
    </div>
  );
}
