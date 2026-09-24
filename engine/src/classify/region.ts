/**
 * Adaptive region classifier (Phase 3, P3-T1).
 *
 * For a byte range that NO earlier detector claimed, examine a sample of
 * the bytes and emit a typed `{probableClass, score, reason}` verdict.
 * This is the PD 8 ROM-wide accounting closer: paired with a finalizer
 * that walks unaccounted gaps, every byte in every ingested ROM ends up
 * with a class - either confidently classified or scored-unknown with a
 * best-guess probable class.
 *
 * No baked Pokémon offsets (PD 5). The classifier inspects only byte
 * statistics + structural shapes:
 *
 *   - zero_padding - bytes are >= 95% 0x00; classified at high confidence.
 *   - ff_padding - bytes are >= 95% 0xFF; the canonical GBA "blank cart"
 *                            fill byte; classified at high confidence.
 *   - graphics - distribution skewed toward palette-index bytes
 *                            (low entropy, mode in 0x00..0x0F or repeating
 *                            short cycles); scored at moderate confidence.
 *   - arm7_code - entropy in 3.0..5.0 bits/byte (ARM7 thumb/arm
 *                            instruction stream signature) AND > 30% of bytes
 *                            in the 0x00..0x4F opcode range; scored moderate.
 *   - pokemon_text - > 60% of bytes in the Gen-3 text-codec letter
 *                            ranges (0xBB..0xEE for ABC...) AND occasional
 *                            0xFF (string terminator).
 *   - high_entropy - entropy >= 7.0; scored as probable_compression
 *                            (covered by Phase 2 entropy detector when
 *                            window large enough; finalizer catches the
 *                            sub-window leftovers).
 *   - unknown - no profile fits; surfaced as scored-unknown
 *                            with `probableClass='unknown'` so PD 8 holds.
 *
 * The classifier is fast: a single linear pass building a 256-bin histogram
 * + a few aggregate counters. O(N) over the sampled region.
 *
 * Sampling: for very large gaps (multi-MB) we sample a window (default
 * 4 KiB) rather than scanning the full region. The sample's profile is
 * applied to the whole gap. This is honest - the region might have varied
 * content the sample missed, but PD 8 only requires accounting, not
 * forensic-grade per-byte classification. Phase 4+ can refine.
 */

import type { ProbableClass } from '../coverage/index.js';

export type RegionProbableClass =
  | 'zero_padding'
  | 'ff_padding'
  | 'graphics'
  | 'arm7_code'
  | 'pokemon_text'
  | 'high_entropy'
  | 'unknown';

export interface RegionProfile {
  /** Sample length actually examined (≤ region length). */
  readonly sampleLength: number;
  /** Shannon entropy in bits/byte (0..8). */
  readonly entropy: number;
  /** Fraction of bytes equal to 0x00 (0..1). */
  readonly zeroFraction: number;
  /** Fraction of bytes equal to 0xFF (0..1). */
  readonly ffFraction: number;
  /** Fraction of bytes in 0x00..0x4F (common ARM thumb opcode range). */
  readonly armOpcodeFraction: number;
  /** Fraction of bytes in 0xBB..0xEE (Pokémon Gen-3 text letter range). */
  readonly pokeTextLetterFraction: number;
  /** Fraction of bytes in 0x20..0x7E (printable ASCII). */
  readonly printableAsciiFraction: number;
  /** Top byte mode (most-common byte value). */
  readonly topByte: number;
  /** Count of `topByte`. */
  readonly topByteCount: number;
}

export interface RegionClassification {
  readonly probableClass: ProbableClass;
  /** Confidence in (0, 1]. Higher = more reliable verdict. */
  readonly score: number;
  /** Whether the verdict is strong enough for a `classified` coverage
   *  region vs. `unknown_scored`. */
  readonly classified: boolean;
  /** Human-readable reason citing the byte statistics. */
  readonly reason: string;
  readonly profile: RegionProfile;
}

export interface ClassifyRegionOptions {
  /** Bytes to sample from the start of the range. Default 4096. */
  readonly sampleLength?: number;
}

/** Default sample window. */
const DEFAULT_SAMPLE_LENGTH = 4096;

/** Threshold above which we promote `unknown_scored` → `classified`. */
const CLASSIFIED_THRESHOLD = 0.7;

/**
 * Classify a byte range. `start` and `length` describe the region in
 * the underlying ROM buffer; the function samples up to `sampleLength`
 * bytes from `start`.
 */
export function classifyRegion(
  bytes: Uint8Array,
  start: number,
  length: number,
  opts?: ClassifyRegionOptions,
): RegionClassification {
  if (!Number.isInteger(start) || start < 0 || start > bytes.length) {
    throw new Error(`classifyRegion: invalid start ${String(start)}`);
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`classifyRegion: invalid length ${String(length)}`);
  }
  const sampleLength = Math.min(length, opts?.sampleLength ?? DEFAULT_SAMPLE_LENGTH);
  const profile = profileBytes(bytes, start, sampleLength);
  return decide(profile);
}

/** Build a per-region statistical profile. */
export function profileBytes(bytes: Uint8Array, start: number, length: number): RegionProfile {
  const end = Math.min(bytes.length, start + length);
  const actual = end - start;
  if (actual <= 0) {
    return Object.freeze({
      sampleLength: 0,
      entropy: 0,
      zeroFraction: 0,
      ffFraction: 0,
      armOpcodeFraction: 0,
      pokeTextLetterFraction: 0,
      printableAsciiFraction: 0,
      topByte: 0,
      topByteCount: 0,
    });
  }
  const hist = new Uint32Array(256);
  for (let i = start; i < end; i++) {
    const b = bytes[i] ?? 0;
    hist[b] = (hist[b] ?? 0) + 1;
  }

  // Entropy.
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i] ?? 0;
    if (c === 0) continue;
    const p = c / actual;
    entropy -= p * Math.log2(p);
  }

  // Aggregate counters.
  let armOpcode = 0;
  for (let i = 0x00; i <= 0x4f; i++) armOpcode += hist[i] ?? 0;
  let pokeTextLetter = 0;
  for (let i = 0xbb; i <= 0xee; i++) pokeTextLetter += hist[i] ?? 0;
  let printable = 0;
  for (let i = 0x20; i <= 0x7e; i++) printable += hist[i] ?? 0;

  // Top byte.
  let topByte = 0;
  let topByteCount = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i] ?? 0;
    if (c > topByteCount) {
      topByteCount = c;
      topByte = i;
    }
  }

  return Object.freeze({
    sampleLength: actual,
    entropy: round3(entropy),
    zeroFraction: round3((hist[0] ?? 0) / actual),
    ffFraction: round3((hist[0xff] ?? 0) / actual),
    armOpcodeFraction: round3(armOpcode / actual),
    pokeTextLetterFraction: round3(pokeTextLetter / actual),
    printableAsciiFraction: round3(printable / actual),
    topByte,
    topByteCount,
  });
}

function decide(profile: RegionProfile): RegionClassification {
  // 1) Padding cases - extremely high confidence when overwhelming.
  if (profile.zeroFraction >= 0.95) {
    return verdict(
      'unknown_executable', // ROM padding is conventionally listed as
      0.95,                 // an unknown-executable-or-unused region;
      `≥95% bytes are 0x00 (zero-padding / unused ROM space; zeroFraction=${profile.zeroFraction.toFixed(3)})`,
      profile,
      'zero_padding',
    );
  }
  if (profile.ffFraction >= 0.95) {
    return verdict(
      'unknown_executable',
      0.95,
      `≥95% bytes are 0xFF (canonical blank-cart fill; ffFraction=${profile.ffFraction.toFixed(3)})`,
      profile,
      'ff_padding',
    );
  }

  // 2) Pokémon Gen-3 text codec - usually the highest-specificity signal.
  if (profile.pokeTextLetterFraction >= 0.6) {
    return verdict(
      'event_data',
      0.8,
      `≥60% bytes in Pokémon Gen-3 text-codec letter range 0xBB..0xEE (probable dialogue/script text; pokeTextLetterFraction=${profile.pokeTextLetterFraction.toFixed(3)})`,
      profile,
      'pokemon_text',
    );
  }

  // 3) High entropy → probable compression / encrypted / random.
  if (profile.entropy >= 7.0) {
    return verdict(
      'compression',
      0.6,
      `entropy ${profile.entropy.toFixed(2)} bits/byte ≥ 7.0 (probable compression or encrypted data - sub-window not caught by the Phase-2 entropy detector)`,
      profile,
      'high_entropy',
    );
  }

  // 4) ARM7 code-like profile: moderate entropy + opcode bias.
  if (profile.entropy >= 3.0 && profile.entropy < 6.5 && profile.armOpcodeFraction >= 0.3) {
    return verdict(
      'unknown_executable',
      0.6,
      `entropy ${profile.entropy.toFixed(2)} + ${(profile.armOpcodeFraction * 100).toFixed(1)}% bytes in 0x00..0x4F (consistent with ARM7 code stream)`,
      profile,
      'arm7_code',
    );
  }

  // 5) Graphics-like: low entropy with strong palette-index bias (mode
  // in 0x00..0x0F suggests 4bpp/8bpp tile data).
  if (profile.entropy <= 4.5 && profile.topByte <= 0x0f && profile.topByteCount / Math.max(1, profile.sampleLength) >= 0.2) {
    return verdict(
      'graphics',
      0.5,
      `low entropy (${profile.entropy.toFixed(2)}) + dominant byte 0x${profile.topByte.toString(16).padStart(2, '0')} suggests tile/palette-index data`,
      profile,
      'graphics',
    );
  }

  // 6) Fallback: unknown. Scored, never silently dropped (PD 8).
  return verdict(
    'unknown',
    0.3,
    `no profile matched (entropy=${profile.entropy.toFixed(2)}, zeroFrac=${profile.zeroFraction.toFixed(2)}, ffFrac=${profile.ffFraction.toFixed(2)}, armOp=${profile.armOpcodeFraction.toFixed(2)}, pokeText=${profile.pokeTextLetterFraction.toFixed(2)}, topByte=0x${profile.topByte.toString(16).padStart(2, '0')}@${profile.topByteCount}x)`,
    profile,
    'unknown',
  );
}

function verdict(
  probableClass: ProbableClass,
  score: number,
  reason: string,
  profile: RegionProfile,
  // Diagnostic shape label (not stored in CoverageRegion, but useful for
  // logging - could be plumbed into Detection.evidence later).
  _kind: RegionProbableClass,
): RegionClassification {
  return Object.freeze({
    probableClass,
    score,
    classified: score >= CLASSIFIED_THRESHOLD,
    reason,
    profile,
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
