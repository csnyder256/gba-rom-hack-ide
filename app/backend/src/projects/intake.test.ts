import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { crc32 } from 'node:zlib';
import { intakeFile, IntakeError } from './intake.js';

// For the rom case a file with the `.gba` extension and arbitrary bytes is
// enough: intake doesn't parse the header (the detector does). Archives are
// built by makeZip below, so the archive cases run on every platform.

/**
 * Minimal ZIP writer: stored (uncompressed) entries, UTF-8 names, no extra
 * fields. Enough for yauzl, and entry names are written verbatim, so a
 * hostile name like '../x' can be tested. (This replaced a PowerShell
 * Compress-Archive call whose startup alone took 4-6 s on Windows CI.)
 */
function makeZip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entryName, text] of Object.entries(entries)) {
    const name = Buffer.from(entryName, 'utf-8');
    const data = Buffer.from(text, 'utf-8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); // central directory header
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed to extract
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42); // where the local header starts
    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

describe('intakeFile', () => {
  let workspace: string;
  let managedRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'rom-editor-intake-'));
    managedRoot = path.join(workspace, 'managed');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('rejects a file that does not exist with file_not_found', async () => {
    try {
      await intakeFile(path.join(workspace, 'nope.gba'), { managedRootOverride: managedRoot });
      throw new Error('expected IntakeError');
    } catch (e) {
      expect(e).toBeInstanceOf(IntakeError);
      expect((e as IntakeError).code).toBe('file_not_found');
    }
  });

  it('rejects an unsupported file extension with unsupported_file_kind', async () => {
    const p = path.join(workspace, 'something.txt');
    writeFileSync(p, 'hello');
    try {
      await intakeFile(p, { managedRootOverride: managedRoot });
      throw new Error('expected IntakeError');
    } catch (e) {
      expect((e as IntakeError).code).toBe('unsupported_file_kind');
    }
  });

  it('intakes a .gba file: copies it + writes .editor/intake.json', async () => {
    const gba = path.join(workspace, 'FireRed.gba');
    writeFileSync(gba, Buffer.from('not-really-a-rom-but-thats-ok'));
    const r = await intakeFile(gba, { managedRootOverride: managedRoot });
    expect(r.intakeKind).toBe('rom');
    expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(r.managedProjectRoot).toBe(path.join(managedRoot, r.sha1));
    // The ROM was copied in.
    expect(existsSync(path.join(r.managedProjectRoot, 'FireRed.gba'))).toBe(true);
    // intake.json is shaped + valid.
    const meta = JSON.parse(
      readFileSync(path.join(r.managedProjectRoot, '.editor', 'intake.json'), 'utf-8'),
    );
    expect(meta.kind).toBe('rom');
    expect(meta.sha1).toBe(r.sha1);
    expect(meta.originalFileName).toBe('FireRed.gba');
    expect(meta.intakedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('re-intaking the same .gba lands in the same managed dir (SHA-1 stable)', async () => {
    const gba = path.join(workspace, 'FireRed.gba');
    writeFileSync(gba, Buffer.from('content-A'));
    const r1 = await intakeFile(gba, { managedRootOverride: managedRoot });
    const r2 = await intakeFile(gba, { managedRootOverride: managedRoot });
    expect(r1.sha1).toBe(r2.sha1);
    expect(r1.managedProjectRoot).toBe(r2.managedProjectRoot);
  });

  it('different .gba contents → different managed dirs', async () => {
    const a = path.join(workspace, 'a.gba');
    const b = path.join(workspace, 'b.gba');
    writeFileSync(a, Buffer.from('content-A'));
    writeFileSync(b, Buffer.from('content-B-different'));
    const r1 = await intakeFile(a, { managedRootOverride: managedRoot });
    const r2 = await intakeFile(b, { managedRootOverride: managedRoot });
    expect(r1.sha1).not.toBe(r2.sha1);
    expect(r1.managedProjectRoot).not.toBe(r2.managedProjectRoot);
  });

  it('intakes a .zip file: extracts entries + writes .editor/intake.json with count', async () => {
    const zip = path.join(workspace, 'project.zip');
    writeFileSync(zip, makeZip({ 'file-a.txt': 'AAA', 'sub/': '', 'sub/file-b.txt': 'BBB' }));

    const r = await intakeFile(zip, { managedRootOverride: managedRoot });
    expect(r.intakeKind).toBe('archive');
    expect(r.extractedEntryCount).toBe(3);
    expect(readFileSync(path.join(r.managedProjectRoot, 'file-a.txt'), 'utf-8')).toBe('AAA');
    expect(readFileSync(path.join(r.managedProjectRoot, 'sub', 'file-b.txt'), 'utf-8')).toBe('BBB');
    const meta = JSON.parse(
      readFileSync(path.join(r.managedProjectRoot, '.editor', 'intake.json'), 'utf-8'),
    );
    expect(meta.kind).toBe('archive');
    expect(meta.extractedEntryCount).toBe(r.extractedEntryCount);
  });

  it('refuses a .zip whose entry climbs out of the project, writing nothing outside it', async () => {
    const zip = path.join(workspace, 'evil.zip');
    writeFileSync(zip, makeZip({ 'ok.txt': 'fine', '../escaped.txt': 'pwned' }));

    await expect(intakeFile(zip, { managedRootOverride: managedRoot })).rejects.toBeInstanceOf(
      IntakeError,
    );
    expect(existsSync(path.join(managedRoot, 'escaped.txt'))).toBe(false);
    expect(existsSync(path.join(workspace, 'escaped.txt'))).toBe(false);
  });
});
