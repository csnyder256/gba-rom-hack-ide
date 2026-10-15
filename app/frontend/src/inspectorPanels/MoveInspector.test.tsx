import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MoveInspector } from './MoveInspector';
import { useUiPreferencesStore, type EntityRef } from '../state';
import type {
  BattleMoveEntry,
  ProjectManifest,
  SpeciesLearnsetEntry,
} from '@rom-editor/shared';

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-18T00:00:00Z',
    projectRoot: '/abs/test',
    identity: {
      kind: 'decomp',
      confidence: 1,
      displayName: 'test',
      baseGame: null,
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
    ...overrides,
  } as ProjectManifest;
}

const tackle: BattleMoveEntry = {
  id: 'MOVE_TACKLE',
  moveIndex: 33,
  effect: 0,
  power: 40,
  type: 0,
  accuracy: 100,
  pp: 35,
  secondaryEffectChance: 0,
  target: 0,
  priority: 0,
  flags: 0xf,
  split: 1,
  sourceTableOffset: 0x250000,
  name: 'TACKLE',
  typeName: 'Normal',
};

const thunder: BattleMoveEntry = {
  ...tackle,
  id: 'MOVE_THUNDER',
  moveIndex: 87,
  power: 110,
  type: 13,
  accuracy: 70,
  pp: 10,
  secondaryEffectChance: 30,
  split: 2,
  name: 'THUNDER',
  typeName: 'Electric',
};

const bulbasaurLearnset: SpeciesLearnsetEntry = {
  id: 'species_1',
  speciesIndex: 1,
  arrayFileOffset: 0,
  pointerRaw: 0,
  moves: [
    { level: 1, move: 33, moveName: 'TACKLE' },
    { level: 6, move: 22, moveName: 'VINE WHIP' },
  ],
};

const pikachuLearnset: SpeciesLearnsetEntry = {
  id: 'species_25',
  speciesIndex: 25,
  arrayFileOffset: 0,
  pointerRaw: 0,
  moves: [
    { level: 1, move: 33, moveName: 'TACKLE' },
    { level: 13, move: 87, moveName: 'THUNDER' },
  ],
};

describe('MoveInspector (Phase S.10)', () => {
  beforeEach(() => {
    useUiPreferencesStore.setState({ showInternalIds: false });
  });

  afterEach(() => cleanup());

  it('renders no-manifest state when project is not loaded', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(<MoveInspector selection={sel} manifest={null} sessionId={null} />);
    expect(screen.getByTestId('move-inspector')).toBeInTheDocument();
    expect(screen.getByText(/Open a project to inspect/i)).toBeInTheDocument();
  });

  it('renders unknown-move state when manifest has no battleMoves', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    const manifest = makeManifest({});
    render(<MoveInspector selection={sel} manifest={manifest} sessionId="s1" />);
    expect(screen.getByText(/no battle move with that id is present/i)).toBeInTheDocument();
  });

  it('renders move stats by direct id match', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    const manifest = makeManifest({ battleMoves: [tackle, thunder] });
    render(<MoveInspector selection={sel} manifest={manifest} sessionId="s1" />);
    expect(screen.getByText(/TACKLE/)).toBeInTheDocument();
    expect(screen.getByTestId('move-inspector-power').textContent).toBe('40');
    expect(screen.getByTestId('move-inspector-accuracy').textContent).toBe('100%');
    expect(screen.getByTestId('move-inspector-pp').textContent).toBe('35');
  });

  it('resolves a synthetic "move_<index>" id', () => {
    const sel: EntityRef = { kind: 'move', id: 'move_87' };
    const manifest = makeManifest({ battleMoves: [tackle, thunder] });
    render(<MoveInspector selection={sel} manifest={manifest} sessionId="s1" />);
    expect(screen.getByText(/THUNDER/)).toBeInTheDocument();
    expect(screen.getByTestId('move-inspector-power').textContent).toBe('110');
  });

  it('shows status move (power=0, accuracy=0) with em-dash labels', () => {
    const status: BattleMoveEntry = {
      ...tackle,
      id: 'MOVE_THUNDER_WAVE',
      moveIndex: 86,
      power: 0,
      accuracy: 0,
      split: 0,
      name: 'THUNDER WAVE',
    };
    const sel: EntityRef = { kind: 'move', id: 'MOVE_THUNDER_WAVE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [status] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('move-inspector-power').textContent).toMatch(/ - /);
    expect(screen.getByTestId('move-inspector-accuracy').textContent).toMatch(/never misses/);
  });

  it('surfaces secondary-effect chance only when > 0', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_THUNDER' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [thunder] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('move-inspector-secondary').textContent).toBe('30%');

    cleanup();
    const sel2: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel2}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    expect(screen.queryByTestId('move-inspector-secondary')).not.toBeInTheDocument();
  });

  it('lists species that learn the move with level', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({
          battleMoves: [tackle, thunder],
          speciesLearnsets: [bulbasaurLearnset, pikachuLearnset],
        })}
        sessionId="s1"
      />,
    );
    // Both Bulbasaur (lv1) and Pikachu (lv1) learn Tackle.
    expect(screen.getByTestId('move-inspector-learners')).toBeInTheDocument();
    // Two learner buttons present.
    const learners = screen.getAllByText(/Lv 1/);
    expect(learners.length).toBe(2);
  });

  it('shows the empty-learner state when no species learns the move', () => {
    const orphan: BattleMoveEntry = {
      ...tackle,
      id: 'MOVE_NIGHTMARE',
      moveIndex: 171,
      name: 'NIGHTMARE',
    };
    const sel: EntityRef = { kind: 'move', id: 'MOVE_NIGHTMARE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({
          battleMoves: [orphan],
          speciesLearnsets: [bulbasaurLearnset],
        })}
        sessionId="s1"
      />,
    );
    expect(
      screen.getByText(/No species learn this move via level-up/i),
    ).toBeInTheDocument();
  });

  it('developer-details disclosure shows move index + effect + table offset', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_THUNDER' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [thunder] })}
        sessionId="s1"
      />,
    );
    expect(screen.queryByTestId('move-inspector-advanced')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('move-inspector-advanced-toggle'));
    expect(screen.getByTestId('move-inspector-advanced')).toBeInTheDocument();
    expect(screen.getByTestId('move-inspector-advanced').textContent).toMatch(/#87/);
  });

  it('shows the derived Gen-3 damage class and offers no writable Category control', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    // Tackle is Normal-typed, so the Gen-3 class is Physical - derived from
    // the type, never read from the struct's 0x09 padding byte.
    expect(screen.getByText(/Physical/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('move-inspector-edit-btn'));
    expect(screen.queryByTestId('move-inspector-edit-split')).not.toBeInTheDocument();
  });

  it('renders an Edit stats button when sessionId is present', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    expect(screen.getByTestId('move-inspector-edit-btn')).toBeInTheDocument();
  });

  it('hides the Edit button when sessionId is null (read-only mode)', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId={null}
      />,
    );
    expect(screen.queryByTestId('move-inspector-edit-btn')).not.toBeInTheDocument();
  });

  it('clicking Edit stats reveals the edit form with current values', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('move-inspector-edit-btn'));
    const powerInput = screen.getByTestId(
      'move-inspector-edit-power',
    ) as HTMLInputElement;
    expect(powerInput.value).toBe('40');
    const accInput = screen.getByTestId(
      'move-inspector-edit-accuracy',
    ) as HTMLInputElement;
    expect(accInput.value).toBe('100');
    const ppInput = screen.getByTestId(
      'move-inspector-edit-pp',
    ) as HTMLInputElement;
    expect(ppInput.value).toBe('35');
  });

  it('Cancel restores the read view without changes', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('move-inspector-edit-btn'));
    expect(screen.getByTestId('move-inspector-edit-form')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('move-inspector-cancel-btn'));
    expect(screen.queryByTestId('move-inspector-edit-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('move-inspector-edit-btn')).toBeInTheDocument();
  });

  it('numeric inputs clamp to min/max range', () => {
    const sel: EntityRef = { kind: 'move', id: 'MOVE_TACKLE' };
    render(
      <MoveInspector
        selection={sel}
        manifest={makeManifest({ battleMoves: [tackle] })}
        sessionId="s1"
      />,
    );
    fireEvent.click(screen.getByTestId('move-inspector-edit-btn'));
    const powerInput = screen.getByTestId(
      'move-inspector-edit-power',
    ) as HTMLInputElement;
    fireEvent.change(powerInput, { target: { value: '999' } });
    expect(powerInput.value).toBe('255'); // clamped to max
    fireEvent.change(powerInput, { target: { value: '-50' } });
    expect(powerInput.value).toBe('0'); // clamped to min
  });
});
