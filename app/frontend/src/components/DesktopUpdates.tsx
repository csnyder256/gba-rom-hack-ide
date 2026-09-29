import { useEffect, useRef, useState } from 'react';
import './DesktopUpdates.css';
export interface DesktopUpdateStatus {
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  nextVersion?: string;
  percent?: number;
  message: string;
}
declare global {
  interface Window {
    GbaDesktop?: {
      status: () => Promise<DesktopUpdateStatus>;
      check: () => Promise<DesktopUpdateStatus>;
      download: () => Promise<DesktopUpdateStatus>;
      install: () => Promise<DesktopUpdateStatus>;
      onStatus: (fn: (status: DesktopUpdateStatus) => void) => () => void;
    };
  }
}
export function DesktopUpdates() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const desktop = window.GbaDesktop;
    if (!desktop) return;
    let active = true;
    void desktop.status().then(value => { if (active) setStatus(value); }).catch(() => undefined);
    const off = desktop.onStatus(value => { if (active) setStatus(value); });
    return () => { active = false; off(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  if (!status) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(status.phase);
  function run(action: 'check' | 'download' | 'install') {
    void window.GbaDesktop?.[action]().then(setStatus).catch(() => {
      setStatus({ ...status!, phase: 'error', message: 'The desktop update request failed. Nothing was installed.' });
    });
  }
  return <>
    <button ref={button} type="button" className="desktop-update-button" onClick={() => setOpen(true)} aria-label="Desktop updates">
      {status.phase === 'available' || status.phase === 'downloaded' ? 'Update available' : 'Updates'}
    </button>
    {open && <div className="desktop-update-backdrop"><section ref={panel} role="dialog" aria-modal="true" aria-labelledby="desktop-update-title" className="desktop-update-panel">
      <header><p>GBA ROM HACK IDE</p><button aria-label="Close updates" onClick={() => { setOpen(false); button.current?.focus(); }}>×</button></header>
      <h2 id="desktop-update-title">Keep your workspace current.</h2>
      <p className="desktop-update-version">Installed {status.currentVersion}{status.nextVersion ? ` → ${status.nextVersion}` : ''}</p>
      <p role="status">{status.message}</p>
      {status.phase === 'downloading' && <progress max={100} value={status.percent ?? 0} aria-label="Update download progress" />}
      <p className="desktop-update-note">Stable releases only. Save your work before restarting. Projects are stored outside the application and retained on upgrades.</p>
      <footer>
        <button disabled={busy || status.phase === 'disabled' || status.phase === 'downloaded'} onClick={() => run('check')}>Check for updates</button>
        {status.phase === 'available' && <button className="desktop-update-primary" onClick={() => run('download')}>Download update</button>}
        {status.phase === 'downloaded' && <button className="desktop-update-primary" onClick={() => run('install')}>Restart to install</button>}
      </footer>
    </section></div>}
  </>;
}
