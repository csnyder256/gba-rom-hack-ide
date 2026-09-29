import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Modernization resolves assets beside the compiled module. Keep source and
// compiled runs equivalent, including the packaged desktop's offline runtime.
const source = new URL('../src/assets/', import.meta.url);
const target = new URL('../dist/assets/', import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log('Copied backend runtime assets to', fileURLToPath(target));
