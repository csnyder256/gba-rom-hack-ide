import { useCallback, useEffect, useState } from 'react';
import { WorkspaceShell } from './WorkspaceShell';
import { StatusBar } from './StatusBar';
import { HelpOverlay } from './HelpOverlay';
import { UndoRedoButtons } from './UndoRedoButtons';
import { useCommandPaletteStore } from './CommandPalette';
import { DesktopUpdates } from './DesktopUpdates';
import { ModernizeButton } from './ModernizeButton';
import type { BackendStatus } from '../api';
import { useUiPreferencesStore, useViewStore, type ViewKey } from '../state';
import { useAgentStore } from '../state/agent';
import { useEmulatorStore } from '../state/emulator';
import './EditorShell.css';

interface EditorShellProps {
  readonly backendStatus: BackendStatus;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function EditorShell({ backendStatus }: EditorShellProps) {
  const setView = useViewStore((s) => s.setView);
  const requestBuildPlay = useEmulatorStore((s) => s.requestBuildPlay);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const toggleShowInternalIds = useUiPreferencesStore((s) => s.toggleShowInternalIds);
  const openCommandPalette = useCommandPaletteStore((s) => s.setOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  const agentConnectionKind = useAgentStore((s) => s.connection.kind);
  const agentInFlight = useAgentStore((s) => s.inFlight);
  const agentPipState = agentInFlight ? 'busy' : agentConnectionKind;

  const onCloseHelp = useCallback(() => setHelpOpen(false), []);
  const onSelectHelpView = useCallback(
    (view: ViewKey) => {
      setView(view);
      setHelpOpen(false);
    },
    [setView],
  );

  // Global ? shortcut to open the help overlay (skipped when typing in inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '?' || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setHelpOpen((v) => !v);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Clicking the Agent titlebar button focuses the right-rail AgentPanel
  // input. The panel itself owns the Ctrl+Shift+A binding (set up inside
  // AgentPanel.tsx).
  const focusAgentInput = useCallback(() => {
    window.dispatchEvent(new CustomEvent('agent:focus-input'));
  }, []);

  return (
    <div className="editor-shell">
      <header className="editor-shell__titlebar">
        <span className="editor-shell__title">Pokémon GBA Decomp/Patch World Editor</span>
        <div className="editor-shell__titlebar-actions">
          <DesktopUpdates />
          <button
            type="button"
            className="editor-shell__open-rom-btn"
            onClick={() => setView('project')}
            title="Open a ROM or project"
            aria-label="Open a ROM or project"
            data-testid="editor-shell-open-rom-btn"
          >
            <span aria-hidden>📂</span>
            <span className="editor-shell__open-rom-label">Open ROM</span>
          </button>
          <button
            type="button"
            className="editor-shell__open-rom-btn"
            style={{ background: '#2e7d32', color: '#fff', borderColor: '#2e7d32' }}
            onClick={() => {
              setView('livePreview');
              requestBuildPlay();
            }}
            title="Compile your edits to a fresh ROM and play it in the browser"
            aria-label="Build and play"
            data-testid="editor-shell-build-play-btn"
          >
            <span aria-hidden>🔨</span>
            <span>Build &amp; Play</span>
          </button>
          <ModernizeButton />
          <button
            type="button"
            className="editor-shell__search-btn"
            onClick={() => openCommandPalette(true)}
            title="Search the workspace (Ctrl+K / ⌘+K)"
            aria-label="Search the workspace"
            data-testid="editor-shell-search-btn"
          >
            <span aria-hidden>🔍</span>
            <span className="editor-shell__search-label">Search</span>
            <span className="editor-shell__search-shortcut">
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </span>
          </button>
          <UndoRedoButtons />
          <button
            type="button"
            className="editor-shell__agent-btn"
            onClick={focusAgentInput}
            title="Jump to the AI agent input (Ctrl+Shift+A)"
            aria-label="Jump to agent"
            data-testid="editor-shell-agent-btn"
          >
            <span aria-hidden>💬</span>
            <span className="editor-shell__agent-label">Agent</span>
            <span
              className={`editor-shell__agent-pip editor-shell__agent-pip--${agentPipState}`}
              aria-hidden
              data-testid="editor-shell-agent-pip"
              data-state={agentPipState}
            />
            <span className="editor-shell__agent-shortcut">
              <kbd>Ctrl</kbd>
              <kbd>⇧</kbd>
              <kbd>A</kbd>
            </span>
          </button>
          <label
            className="editor-shell__internal-ids-toggle"
            title="When ON, every resolved name shows its internal id in parens (e.g. PIKACHU (species_25))"
            data-testid="editor-shell-internal-ids-toggle"
          >
            <input
              type="checkbox"
              checked={showInternalIds}
              onChange={toggleShowInternalIds}
              aria-label="Show internal ids"
            />
            <span>internal ids</span>
          </label>
          <button
            type="button"
            className="editor-shell__help-btn"
            onClick={() => setHelpOpen((v) => !v)}
            title="Explain this screen (?)"
            aria-label="Explain this screen"
            data-testid="editor-shell-help-btn"
          >
            ?
          </button>
        </div>
      </header>
      <div className="editor-shell__body">
        <WorkspaceShell />
      </div>
      <StatusBar backendStatus={backendStatus} />
      <HelpOverlay open={helpOpen} onClose={onCloseHelp} onSelectView={onSelectHelpView} />
    </div>
  );
}
