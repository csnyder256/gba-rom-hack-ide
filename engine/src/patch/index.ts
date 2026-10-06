export {
  IPS_FOOTER,
  IPS_HEADER,
  IPS_MAX_LITERAL_LENGTH,
  IPS_MAX_OFFSET,
  IPS_MAX_RLE_LENGTH,
  IPS_RESERVED_EOF_OFFSET,
  IPS_RLE_BREAK_EVEN_LENGTH,
  IpsFormatError,
  applyIps,
  decodeIps,
  encodeIps,
  type IpsRecord,
} from './ips.js';

export {
  produceIpsRecords,
  produceIpsRecordsWithReport,
  type IpsDiffReport,
  type ProduceIpsRecordsOptions,
} from './diff.js';

export {
  BPS_ACTION_SOURCE_COPY,
  BPS_ACTION_SOURCE_READ,
  BPS_ACTION_TARGET_COPY,
  BPS_ACTION_TARGET_READ,
  BPS_MAGIC,
  BPS_TRAILER_SIZE,
  BpsFormatError,
  applyBps,
  crc32,
  decodeBps,
  encodeBps,
  produceBpsActions,
  type BpsAction,
  type BpsDecodeResult,
} from './bps.js';

// Phase 3.7 - patch testing harness.
export {
  PatchTestError,
  testPatch,
  type PatchTestResult,
} from './test-harness.js';
