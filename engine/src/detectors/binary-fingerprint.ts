/**
 * Phase-1 detector: binary fingerprinting.
 *
 * Per §15 Phase 1 acceptance: "every corpus ROM is fingerprinted and family/
 * engine-classified with confidence + evidence". This detector owns the
 * per-ROM identity payload - sha1 + byteLength + size class + parsed header
 * + the matched signature DB entries - that downstream Phase 1 detectors
 * (family classification, engine signature detection) consume.
 *
 * Two-path design (PD 5):
 *   - SIGNATURE-DRIVEN path: matches the ROM against the loaded SignatureDb
 *     and reports matched entries with reasons.
 *   - HEURISTIC path: even when ZERO signatures match, the detector still
 *     produces a meaningful Detection - sha1 + size class + header-based
 *     hints. An unknown-family ROM is never reported as "empty"; it's
 *     reported as `detected` with `signatureMatches: []` and heuristic-only
 *     evidence.
 *
 * The detector NEVER returns `not_detected` for inputs that have a valid
 * GBA header - every well-formed cart gets a fingerprint. `not_detected`
 * is reserved for the case where the loader produced bytes that don't
 * parse as a GBA header at all (Phase 0 caught that; this Phase 1 detector
 * defers to Phase 0's output when the header isn't parseable).
 */

import { makeDetected, makeEvidence, makeNotDetected, makePartial } from '../detection/index.js';
import type { Detection } from '../detection/index.js';
import type { CoverageMap } from '../coverage/index.js';
import { parseGbaHeader, type GbaHeader } from '../rom/header.js';
import type { RomImage } from '../rom/loader.js';
import type { RomDetector } from './types.js';
import { matchSignatures, type SignatureMatch } from '../signatures/matcher.js';
import type { SignatureDb } from '../signatures/loader.js';

export const BINARY_FINGERPRINT_DETECTOR_ID = 'binary_fingerprint';

/** Public GBA cart capacity tiers (powers of 2). Anything else is `odd`. */
export const KNOWN_SIZE_CLASSES = ['4MiB', '8MiB', '16MiB', '32MiB'] as const;
export type RomSizeClass = (typeof KNOWN_SIZE_CLASSES)[number] | 'odd' | 'sub-4MiB';

export interface RomFingerprint {
  readonly romSha1: string;
  readonly byteLength: number;
  readonly sizeClass: RomSizeClass;
  /** The parsed GBA header. Always present (we only run this detector
   *  when the header parsed). */
  readonly header: GbaHeader;
  /** Matched signature DB entries, ordered by descending confidence.
   *  Empty array is a meaningful, honest result: "this is a well-formed
   *  GBA cart but we have no signature for it." */
  readonly signatureMatches: ReadonlyArray<SignatureMatch>;
  /**
   * Heuristic hints derived from byte-level analysis (size, header bits,
   * entropy sample). Never copyrighted content - descriptive strings only.
   */
  readonly heuristicHints: ReadonlyArray<string>;
}

/** Build the binary-fingerprint detector bound to a specific signature DB. */
export function makeBinaryFingerprintDetector(args: {
  db: SignatureDb;
}): RomDetector<RomFingerprint> {
  return {
    id: BINARY_FINGERPRINT_DETECTOR_ID,
    name: 'Binary Fingerprint',
    phase: 1,
    detect(rom: RomImage, _coverage: CoverageMap): Detection<RomFingerprint> {
      const parsed = parseGbaHeader(rom.bytes);
      if (!parsed.ok) {
        // The Phase 0 header detector already surfaces a typed result for
        // these inputs; Phase 1 simply defers cleanly with a real reason.
        const failure = parsed.failure;
        return makeNotDetected({
          confidence: 0.95,
          evidence: [
            makeEvidence({
              kind: 'heuristic',
              summary: `Phase 0 header detector already reported header failure (${failure.kind})`,
              weight: 1.0,
              detail: { headerFailureKind: failure.kind },
            }),
          ],
          reason: `cannot fingerprint a ROM whose GBA cartridge header doesn't parse - header failure kind: ${failure.kind}`,
        });
      }

      const header = parsed.header;
      const sizeClass = classifyRomSize(rom.byteLength);
      const matches = matchSignatures({
        rom: { sha1: rom.sha1, byteLength: rom.byteLength, bytes: rom.bytes },
        gameCode: header.gameCode,
        db: args.db,
      });

      const heuristicHints = computeHeuristicHints({ rom, header, sizeClass });

      const fingerprint: RomFingerprint = Object.freeze({
        romSha1: rom.sha1,
        byteLength: rom.byteLength,
        sizeClass,
        header,
        signatureMatches: matches,
        heuristicHints,
      });

      const evidence = buildEvidence({ rom, header, sizeClass, matches, heuristicHints });
      const confidence = combinedConfidence(matches, heuristicHints.length);

      // When we have at least one strong signature match (confidence ≥ 0.7
      // post-scaling), report `detected`. Otherwise report `partial`: the
      // FINGERPRINT itself is fully detected - sha1, size, header are
      // concrete - but the IDENTITY (which game / family is this?) is
      // uncertain, so the operator should treat it as in-progress until
      // Phase 1's later tasks (engine-signature detection, family
      // classification) layer more evidence on top.
      if (matches.length > 0 && matches[0]!.confidence >= 0.5) {
        return makeDetected<RomFingerprint>({
          confidence,
          evidence,
          data: fingerprint,
        });
      }
      // No strong match - still a real, evidenced result.
      return makePartial<RomFingerprint>({
        confidence,
        evidence,
        data: fingerprint,
        partialReason:
          matches.length === 0
            ? 'ROM fingerprint extracted but no signature DB entry matched - family classification depends on later Phase 1 detectors (engine-signature heuristics, fork detection)'
            : `ROM fingerprint extracted but strongest signature match confidence ${matches[0]!.confidence.toFixed(2)} is below 0.5 detected threshold`,
      });
    },
  };
}

function classifyRomSize(byteLength: number): RomSizeClass {
  switch (byteLength) {
    case 4 * 1024 * 1024:
      return '4MiB';
    case 8 * 1024 * 1024:
      return '8MiB';
    case 16 * 1024 * 1024:
      return '16MiB';
    case 32 * 1024 * 1024:
      return '32MiB';
    default:
      return byteLength < 4 * 1024 * 1024 ? 'sub-4MiB' : 'odd';
  }
}

function computeHeuristicHints(args: {
  rom: RomImage;
  header: GbaHeader;
  sizeClass: RomSizeClass;
}): ReadonlyArray<string> {
  const hints: string[] = [];
  if (args.sizeClass !== 'odd' && args.sizeClass !== 'sub-4MiB') {
    hints.push(`ROM size is a standard GBA cart tier (${args.sizeClass})`);
  } else {
    hints.push(
      `ROM size ${String(args.rom.byteLength)} bytes does not match a standard GBA cart tier (4/8/16/32 MiB) - possible custom dump`,
    );
  }
  if (args.header.softwareVersion > 0) {
    hints.push(
      `cart reports software version ${String(args.header.softwareVersion)} - non-zero version often signals a revision or hack`,
    );
  }
  if (args.header.knownGame !== null) {
    hints.push(`header game code maps to known Nintendo cart family: ${args.header.knownGame}`);
  } else {
    hints.push(
      `header game code "${args.header.gameCode}" is not in the seed known-games table - could be a custom/fork cart or a less-common Nintendo cart`,
    );
  }
  // Cheap entropy sample of bytes [0x200, 0x400) - past the header but
  // before any common code region. Helps distinguish "real ROM bytes" from
  // "all-zeros stub": low entropy here = mostly zeros = likely synthetic.
  const entropy = sampleEntropy(args.rom.bytes, 0x200, 0x200);
  hints.push(`mid-region byte-entropy sample (8 bits): ${entropy.toFixed(2)} - ${entropy > 4.0 ? 'high (looks like real code/data)' : 'low (mostly zeros or repeating bytes - possible synthetic / stub)'}`);
  return Object.freeze(hints);
}

/**
 * Shannon entropy in bits over a window of `length` bytes starting at
 * `offset`. Pure helper, no allocation beyond a fixed-size 256-bin histogram.
 */
function sampleEntropy(bytes: Uint8Array, offset: number, length: number): number {
  const end = Math.min(bytes.length, offset + length);
  if (end <= offset) return 0;
  const histogram = new Uint32Array(256);
  for (let i = offset; i < end; i++) {
    const b = bytes[i] ?? 0;
    histogram[b] = (histogram[b] ?? 0) + 1;
  }
  const total = end - offset;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const count = histogram[i] ?? 0;
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function buildEvidence(args: {
  rom: RomImage;
  header: GbaHeader;
  sizeClass: RomSizeClass;
  matches: ReadonlyArray<SignatureMatch>;
  heuristicHints: ReadonlyArray<string>;
}) {
  const ev = [];
  ev.push(
    makeEvidence({
      kind: 'heuristic',
      summary: `ROM sha1 ${args.rom.sha1} (${String(args.rom.byteLength)} bytes, size class ${args.sizeClass})`,
      weight: 0.3,
      detail: { sha1: args.rom.sha1, byteLength: args.rom.byteLength, sizeClass: args.sizeClass },
    }),
  );
  ev.push(
    makeEvidence({
      kind: 'heuristic',
      summary: `cartridge header: game code ${args.header.gameCode}, title "${args.header.internalTitle}", version ${String(args.header.softwareVersion)}`,
      weight: 0.2,
      detail: {
        gameCode: args.header.gameCode,
        internalTitle: args.header.internalTitle,
        softwareVersion: args.header.softwareVersion,
        makerCode: args.header.makerCode,
      },
    }),
  );
  for (const m of args.matches) {
    ev.push(
      makeEvidence({
        kind: 'signature',
        summary: `signature match: ${m.entry.displayName} (family=${m.entry.family}, kind=${m.entry.kind}) at scaled-confidence ${m.confidence.toFixed(2)}`,
        weight: m.confidence,
        detail: {
          signatureId: m.entry.id,
          family: m.entry.family,
          kind: m.entry.kind,
          reasons: m.reasons.map((r) => ({ kind: r.kind, detail: r.detail })),
        },
      }),
    );
  }
  for (const h of args.heuristicHints) {
    ev.push(makeEvidence({ kind: 'heuristic', summary: h, weight: 0.1 }));
  }
  return ev;
}

function combinedConfidence(matches: ReadonlyArray<SignatureMatch>, hintCount: number): number {
  // Base confidence from "this is a well-formed GBA cart" alone: 0.4.
  // Each heuristic hint nudges by 0.02 (cap at +0.1).
  // Strongest signature match overrides everything if it's above 0.4.
  const base = Math.min(0.5, 0.4 + Math.min(hintCount, 5) * 0.02);
  if (matches.length === 0) return base;
  const top = matches[0]!.confidence;
  // Combine: max(base, top) but pull slightly toward base when top is low.
  if (top >= base) return top;
  return Math.round((base + (top - base) * 0.5) * 1000) / 1000;
}
