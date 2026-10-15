import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomMoveFields, ProjectApiError } from '../api';
import type { BattleMoveEntry, ProjectManifest } from '@rom-editor/shared';
import './MoveInspector.css';

// Phase S.10 - MoveInspector. Surfaces every important attribute of a
// battle move (type, derived damage class, power, accuracy, PP, priority,
// secondary-effect chance, target, description) plus back-references
// (which species learn it and at what level). Each back-reference is
// click-through via useSelection so the operator can walk
// "move → species that learn it → that species' Pokémon inspector"
// without ever leaving the dock.
//
// The damage class is DERIVED, not stored: Gen-3 decides physical/special
// from the move's type (0 power = status), so the inspector shows it but
// never offers to write it back into the struct's padding byte.
//
// Selection id forms supported:
//   - synthetic: "move_45" (binary-ROM workspaces)
//   - decomp:    "MOVE_TACKLE" (pret-style)
//   - direct id: whatever BattleMoveEntry.id is in the manifest
//
// Works equally for vanilla FireRed (~354 moves) and CFRU-based hacks
// like Unbound (often 700+ moves due to expansion).

const SPLIT_LABEL: Record<number, { label: string; icon: string }> = {
  0: { label: 'Status', icon: '◇' },
  1: { label: 'Physical', icon: '⚔' },
  2: { label: 'Special', icon: '✦' },
};

const TARGET_LABEL: Record<number, string> = {
  0x00: 'Selected target',
  0x01: 'Random opponent',
  0x02: 'Both opponents',
  0x04: 'User',
  0x08: 'User + ally',
  0x10: 'All Pokémon',
  0x20: 'Opponent side (field)',
  0x40: 'User side (field)',
};

function findMove(
  manifest: ProjectManifest | null,
  selectionId: string,
): BattleMoveEntry | null {
  if (!manifest) return null;
  const moves = manifest.battleMoves ?? [];
  if (moves.length === 0) return null;
  const direct = moves.find((m) => m.id === selectionId);
  if (direct) return direct;
  const syntheticMatch = /^move_(\d+)$/.exec(selectionId);
  if (syntheticMatch) {
    const idx = Number.parseInt(syntheticMatch[1]!, 10);
    return moves.find((m) => m.moveIndex === idx) ?? null;
  }
  const decompMatch = /^MOVE_(.+)$/.exec(selectionId);
  if (decompMatch) {
    const tail = decompMatch[1]!.toLowerCase().replace(/_/g, '');
    return (
      moves.find(
        (m) =>
          (m.name ?? '').toLowerCase().replace(/[^a-z]/g, '') === tail,
      ) ?? null
    );
  }
  return null;
}

export function MoveInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftPower, setDraftPower] = useState(0);
  const [draftAccuracy, setDraftAccuracy] = useState(0);
  const [draftPp, setDraftPp] = useState(0);
  const [draftPriority, setDraftPriority] = useState(0);
  const [draftType, setDraftType] = useState(0);
  const [draftTarget, setDraftTarget] = useState(0);
  const [draftSecondary, setDraftSecondary] = useState(0);

  const move = useMemo(
    () => findMove(manifest, selection.id),
    [manifest, selection.id],
  );

  function beginEdit() {
    if (!move) return;
    setDraftPower(move.power);
    setDraftAccuracy(move.accuracy);
    setDraftPp(move.pp);
    setDraftPriority(move.priority);
    setDraftType(move.type);
    setDraftTarget(move.target);
    setDraftSecondary(move.secondaryEffectChance);
    setEditing(true);
  }

  async function commitEdit() {
    if (!move || !sessionId) return;
    setSaving(true);
    try {
      const fields: Record<string, number> = {};
      if (draftPower !== move.power) fields['power'] = draftPower;
      if (draftAccuracy !== move.accuracy) fields['accuracy'] = draftAccuracy;
      if (draftPp !== move.pp) fields['pp'] = draftPp;
      if (draftPriority !== move.priority) fields['priority'] = draftPriority;
      if (draftType !== move.type) fields['type'] = draftType;
      if (draftTarget !== move.target) fields['target'] = draftTarget;
      if (draftSecondary !== move.secondaryEffectChance)
        fields['secondaryEffectChance'] = draftSecondary;
      if (Object.keys(fields).length === 0) {
        setEditing(false);
        setSaving(false);
        return;
      }
      await editBinaryRomMoveFields(sessionId, {
        sourceFileOffset: move.sourceTableOffset,
        fields,
      });
      pushToast('success', `Saved ${Object.keys(fields).length} field(s)`);
      await scanCurrentProject();
      setEditing(false);
    } catch (err) {
      const msg =
        err instanceof ProjectApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      pushToast('error', `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  if (!manifest) {
    return (
      <div className="move-inspector move-inspector--empty" data-testid="move-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!move) {
    return (
      <div className="move-inspector move-inspector--empty" data-testid="move-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no battle move
          with that id is present in the scanned manifest. The moves_system
          detector either didn't run or this id falls outside the lifted range
          ({(manifest.battleMoves ?? []).length} moves indexed).
        </p>
      </div>
    );
  }

  const moveName =
    move.name && move.name.length > 0
      ? move.name
      : `Move #${move.moveIndex}`;
  const typeLabel = move.typeName ?? `Type ${move.type}`;
  const split = SPLIT_LABEL[move.split] ?? { label: `Split ${move.split}`, icon: '?' };
  const target = TARGET_LABEL[move.target] ?? `Target 0x${move.target.toString(16)}`;
  const powerLabel = move.power > 0 ? String(move.power) : ' - (status)';
  const accuracyLabel = move.accuracy > 0 ? `${move.accuracy}%` : ' - (never misses)';
  const priorityLabel =
    move.priority === 0
      ? '0 (normal)'
      : move.priority > 0
        ? `+${move.priority} (faster)`
        : `${move.priority} (slower)`;

  // Back-refs: species that learn this move + the level. Linear walk
  // over speciesLearnsets - fast enough for vanilla (411 species) and
  // for expansion-class hacks (~900 species).
  const learnSet = useMemo(() => {
    const out: Array<{
      speciesIndex: number;
      speciesId: string;
      level: number;
      moveName: string;
    }> = [];
    for (const ls of manifest.speciesLearnsets ?? []) {
      for (const m of ls.moves) {
        if (m.move === move.moveIndex) {
          out.push({
            speciesIndex: ls.speciesIndex,
            speciesId: ls.id,
            level: m.level,
            moveName: m.moveName ?? moveName,
          });
        }
      }
    }
    return out.sort((a, b) => a.level - b.level || a.speciesIndex - b.speciesIndex);
  }, [manifest.speciesLearnsets, move.moveIndex, moveName]);

  return (
    <div className="move-inspector" data-testid="move-inspector">
      <header className="move-inspector__header">
        <div className="move-inspector__name">{moveName}</div>
        <div className="move-inspector__sub">
          <span className="move-inspector__type-chip">{typeLabel}</span>
          <span
            className="move-inspector__split-chip"
            title="Gen-3 damage class - derived from the move's type, not stored in the ROM"
          >
            <span aria-hidden>{split.icon}</span> {split.label}
          </span>
        </div>
      </header>

      {!editing ? (
        <>
          <dl className="move-inspector__stats">
            <Stat label="Power" value={powerLabel} testid="move-inspector-power" />
            <Stat label="Accuracy" value={accuracyLabel} testid="move-inspector-accuracy" />
            <Stat label="PP" value={String(move.pp)} testid="move-inspector-pp" />
            <Stat
              label="Priority"
              value={priorityLabel}
              testid="move-inspector-priority"
            />
            <Stat label="Target" value={target} testid="move-inspector-target" />
            {move.secondaryEffectChance > 0 && (
              <Stat
                label="2nd effect chance"
                value={`${move.secondaryEffectChance}%`}
                testid="move-inspector-secondary"
              />
            )}
          </dl>
          {sessionId && (
            <button
              type="button"
              className="move-inspector__edit-btn"
              onClick={beginEdit}
              data-testid="move-inspector-edit-btn"
            >
              Edit stats…
            </button>
          )}
        </>
      ) : (
        <div className="move-inspector__edit-form" data-testid="move-inspector-edit-form">
          <NumField
            label="Power"
            value={draftPower}
            onChange={setDraftPower}
            min={0}
            max={255}
            testid="move-inspector-edit-power"
          />
          <NumField
            label="Accuracy"
            value={draftAccuracy}
            onChange={setDraftAccuracy}
            min={0}
            max={100}
            testid="move-inspector-edit-accuracy"
          />
          <NumField
            label="PP"
            value={draftPp}
            onChange={setDraftPp}
            min={1}
            max={64}
            testid="move-inspector-edit-pp"
          />
          <NumField
            label="Priority"
            value={draftPriority}
            onChange={setDraftPriority}
            min={-7}
            max={7}
            testid="move-inspector-edit-priority"
          />
          <NumField
            label="2nd %"
            value={draftSecondary}
            onChange={setDraftSecondary}
            min={0}
            max={100}
            testid="move-inspector-edit-secondary"
          />
          {(manifest.typeNames ?? []).length > 0 && (
            <label className="move-inspector__num-field">
              <span>Type</span>
              <select
                value={draftType}
                data-testid="move-inspector-edit-type"
                onChange={(e) =>
                  setDraftType(Number.parseInt(e.target.value, 10))
                }
              >
                {(manifest.typeNames ?? []).map((t) => (
                  <option key={t.typeIndex} value={t.typeIndex}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="move-inspector__num-field">
            <span>Target</span>
            <select
              value={draftTarget}
              data-testid="move-inspector-edit-target"
              onChange={(e) =>
                setDraftTarget(Number.parseInt(e.target.value, 10))
              }
            >
              <option value="0">Selected target</option>
              <option value="1">Random opponent</option>
              <option value="2">Both opponents</option>
              <option value="4">User</option>
              <option value="8">User + ally</option>
              <option value="16">All Pokémon</option>
              <option value="32">Opponent side</option>
              <option value="64">User side</option>
            </select>
          </label>
          <div className="move-inspector__edit-actions">
            <button
              type="button"
              className="move-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="move-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="move-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="move-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <section className="move-inspector__learners" data-testid="move-inspector-learners">
        <h3 className="move-inspector__learners-heading">
          Learned by{' '}
          <span className="move-inspector__learners-count">({learnSet.length})</span>
        </h3>
        {learnSet.length === 0 ? (
          <p className="move-inspector__learners-empty">
            No species learn this move via level-up. It may be TM/HM-only,
            tutor-only, or unused in this ROM.
          </p>
        ) : (
          <ul className="move-inspector__learners-list">
            {learnSet.slice(0, 30).map((ls, i) => (
              <li key={`${ls.speciesId}-${i}`}>
                <button
                  type="button"
                  className="move-inspector__learner-btn"
                  onClick={() => select({ kind: 'species', id: ls.speciesId })}
                >
                  <span className="move-inspector__learner-name">
                    {displayName(manifest, ls.speciesId, showInternalIds)}
                  </span>
                  <span className="move-inspector__learner-level">Lv {ls.level}</span>
                </button>
              </li>
            ))}
            {learnSet.length > 30 && (
              <li className="move-inspector__learners-more">
                + {learnSet.length - 30} more
              </li>
            )}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="move-inspector__advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        data-testid="move-inspector-advanced-toggle"
      >
        {advancedOpen ? 'Hide developer details' : 'Show developer details'}
      </button>
      {advancedOpen && (
        <dl
          className="move-inspector__advanced"
          data-testid="move-inspector-advanced"
        >
          <Stat label="Move index" value={`#${move.moveIndex}`} testid="" />
          <Stat label="Effect code" value={`0x${move.effect.toString(16)}`} testid="" />
          <Stat label="Flags" value={`0x${move.flags.toString(16)}`} testid="" />
          <Stat
            label="Table offset"
            value={`0x${move.sourceTableOffset.toString(16)}`}
            testid=""
          />
          <Stat label="Raw id" value={move.id} testid="" />
        </dl>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}) {
  return (
    <div className="move-inspector__row">
      <dt>{label}</dt>
      <dd {...(testid ? { 'data-testid': testid } : {})}>{value}</dd>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  testid,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  testid: string;
}) {
  return (
    <label className="move-inspector__num-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        data-testid={testid}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </label>
  );
}
