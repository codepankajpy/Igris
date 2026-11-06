/**
 * Gas estimate for one publish batch (arkiv/schema.md → "Batch size").
 *
 * One Arkiv transaction is capped at 2^24 gas (EIP-7825, the SDK's
 * MAX_TRANSACTION_GAS). The SDK estimates gas on the node before sending;
 * this module answers the question offline, before anything is sent:
 *
 * 1. **Calldata, exactly.** The batch is ABI-encoded exactly as the SDK
 *    encodes it (`execute((uint8,bytes)[])`, each create = `(uint128 salt,
 *    uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32
 *    name, uint8 typeId, bytes value)[] attributes)`; word types as 32-byte
 *    words, str/bytes raw), with the schema tag attribute, a worst-case
 *    (all-ones) salt and a realistic expiry block. Zero and non-zero bytes
 *    are counted.
 * 2. **Lower bound** (certain under any pricing): 21,000 + 4 per zero byte +
 *    16 per non-zero byte (EIP-2028). A batch above the cap by this bound
 *    alone can never land, so publish refuses it before signing.
 * 3. **Estimate**: 21,000 + max(EIP-2028 calldata + execution, EIP-7623
 *    floor = 10 per zero byte + 40 per non-zero byte). Execution is NOT
 *    known (the Arkiv engine's cost is undocumented and unmeasured, see
 *    arkiv/friction.md #12). It is ASSUMED by EVM analogy, per create:
 *    25,000 (≈ a new storage slot 22,100 + an event 375 + topics), per
 *    attribute 2,100 (≈ a cold storage access) and per byte of the encoded
 *    create 8 (≈ LOG data). Live publishes should log gasUsed to replace
 *    this assumption.
 */
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbi,
  parseAbiParameters,
  stringToBytes,
  toHex,
  type Hex,
} from 'viem';
import type { ExecuteBatchParameters } from '@arkiv-network/sdk';
import { SCHEMA_ATTRIBUTE } from '@arkiv-network/sdk/schema';

/** EIP-7825 per-transaction gas cap (the SDK's MAX_TRANSACTION_GAS). */
export const MAX_TRANSACTION_GAS = 2 ** 24;
const INTRINSIC = 21_000;
/** ASSUMED execution cost (unmeasured; see the module comment). */
export const ASSUMED_EXEC_PER_CREATE = 25_000;
export const ASSUMED_EXEC_PER_ATTRIBUTE = 2_100;
export const ASSUMED_EXEC_PER_BYTE = 8;

const EXECUTE_ABI = parseAbi([
  'function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)',
]);
const CREATE_PARAMS = parseAbiParameters(
  '(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)',
);
/** Operation tag of a create (its value does not change the size). */
const CREATE_OP = 0;
const WORST_SALT = 2n ** 128n - 1n;
/** A realistic expiry: block ≈ 10M + the maximum lifetime. */
const EXPIRES_AT = 10_000_000n + 7_884_000n;

export interface BatchGasEstimate {
  creates: number;
  attributes: number;
  calldataBytes: number;
  zeroBytes: number;
  nonZeroBytes: number;
  /** 21,000 + EIP-2028 calldata: no pricing can charge less. */
  lowerBound: number;
  /** 21,000 + EIP-7623 calldata floor. */
  calldataFloor: number;
  /** The ASSUMED execution cost (see the module comment). */
  assumedExecution: number;
  /** 21,000 + max(EIP-2028 calldata + assumed execution, EIP-7623 floor). */
  estimate: number;
}

type CreateInput = {
  schema: { name: unknown; columns: Record<string, { type: string; isIndexed?: boolean }> };
  values: Record<string, unknown>;
  flags?: { readonly?: boolean; permissionlessExtension?: boolean };
};

function valueBytes(type: string, raw: unknown): Hex {
  const v =
    typeof raw === 'object' && raw !== null && !(raw instanceof Uint8Array) && 'value' in raw
      ? (raw as { value: unknown }).value
      : raw;
  switch (type) {
    case 'str':
      return toHex(stringToBytes(String(v)));
    case 'bytes':
      return bytesToHex(v as Uint8Array);
    case 'bool':
      return pad(v ? '0x01' : '0x00', { size: 32 });
    case 'i32':
      return toHex(BigInt.asUintN(256, BigInt(v as number)), { size: 32 });
    default:
      return toHex(BigInt(v as number | bigint), { size: 32 });
  }
}

/** The `execute` calldata of a batch of creates, encoded as the SDK encodes it. */
export function batchCalldata(params: ExecuteBatchParameters): { data: Hex; attributes: number } {
  let attributes = 0;
  const ops = ((params.creates ?? []) as unknown as CreateInput[]).map((c) => {
    const attrs: Array<{ name: Hex; typeId: number; value: Hex }> = [
      {
        name: toHex(SCHEMA_ATTRIBUTE, { size: 32 }),
        typeId: 0x80,
        value: toHex(stringToBytes(String(c.schema.name))),
      },
    ];
    for (const [name, col] of Object.entries(c.schema.columns)) {
      const v = c.values[name];
      if (v === undefined) continue;
      attrs.push({
        name: toHex(name, { size: 32 }),
        typeId: col.isIndexed ? 0x81 : 0x01,
        value: valueBytes(col.type, v),
      });
    }
    attributes += attrs.length;
    return {
      operation: CREATE_OP,
      operationData: encodeAbiParameters(CREATE_PARAMS, [
        {
          salt: WORST_SALT,
          expiresAt: EXPIRES_AT,
          minLifetime: EXPIRES_AT,
          creationFlags: (c.flags?.readonly ? 1 : 0) | (c.flags?.permissionlessExtension ? 2 : 0),
          attributes: attrs,
        },
      ]),
    };
  });
  return {
    data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [ops] }),
    attributes,
  };
}

/** Estimate the gas of one batch (see the module comment for the method). */
export function estimateBatchGas(params: ExecuteBatchParameters): BatchGasEstimate {
  const { data, attributes } = batchCalldata(params);
  const bytes = Buffer.from(data.slice(2), 'hex');
  let zeroBytes = 0;
  for (const b of bytes) if (b === 0) zeroBytes++;
  const nonZeroBytes = bytes.length - zeroBytes;
  const creates = (params.creates ?? []).length;
  const standard = 4 * zeroBytes + 16 * nonZeroBytes;
  const floor = 10 * zeroBytes + 40 * nonZeroBytes;
  const execution =
    ASSUMED_EXEC_PER_CREATE * creates +
    ASSUMED_EXEC_PER_ATTRIBUTE * attributes +
    ASSUMED_EXEC_PER_BYTE * bytes.length;
  return {
    creates,
    attributes,
    calldataBytes: bytes.length,
    zeroBytes,
    nonZeroBytes,
    lowerBound: INTRINSIC + standard,
    calldataFloor: INTRINSIC + floor,
    assumedExecution: execution,
    estimate: INTRINSIC + Math.max(standard + execution, floor),
  };
}
