import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, sha256 } from 'viem';
import { abiPadded, buildCanaryForms } from './encodings.js';
import { findCanary, redactSnippet } from './detect.js';

// A fixed test canary (a throwaway vanity-free address).
const CANARY = '0x8ba1f109551bd432803012645ac136ddd64dba72';
const forms = buildCanaryForms(CANARY);
const CHECKSUMMED = getAddress(CANARY);
const CORE = CANARY.slice(2).toLowerCase();

// A different random address: nothing derived from it may ever match.
const OTHER = '0x52908400098527886e0f7030069857d2e4169ee7';

function expectSingleMatch(text: string, encoding: string, category = 'exact') {
  const matches = findCanary(text, forms);
  expect(matches, `expected exactly one match in: ${text.slice(0, 120)}`).toHaveLength(1);
  expect(matches[0]!.encoding).toBe(encoding);
  expect(matches[0]!.category).toBe(category);
}

describe('exact encodings — one test per form', () => {
  it('lowercase 0x', () => expectSingleMatch(`{"addr":"${CANARY}"}`, 'lowercase'));
  it('checksummed 0x', () => expectSingleMatch(`addr=${CHECKSUMMED}&x=1`, 'checksummed'));
  it('uppercase 0x', () =>
    expectSingleMatch(`0x${CORE.toUpperCase()} appears here`, 'uppercase'));
  it('no-0x lowercase', () => expectSingleMatch(`id:${CORE};`, 'no-0x-lowercase'));
  it('no-0x uppercase', () => expectSingleMatch(`${CORE.toUpperCase()}`, 'no-0x-uppercase'));
  it('mixed case other than checksum', () => {
    // Flip the case of one hex letter relative to the checksummed form.
    const cs = CHECKSUMMED.slice(2);
    const idx = cs.split('').findIndex((c) => /[a-f]/i.test(c));
    const mixed =
      cs.slice(0, idx) +
      (cs[idx] === cs[idx]!.toLowerCase() ? cs[idx]!.toUpperCase() : cs[idx]!.toLowerCase()) +
      cs.slice(idx + 1);
    expectSingleMatch(`0x${mixed}`, 'mixed-case');
  });
  it('ABI 32-byte padded with 0x (calldata)', () =>
    expectSingleMatch(`"params":[{"data":"0x70a08231000000000000000000000000${CORE}"}]`, 'abi-padded-32'));
  it('ABI 32-byte padded without 0x (event topic fragment)', () =>
    expectSingleMatch(`topic:${abiPadded(CORE)}`, 'abi-padded-32'));
  it('base64 of lowercase 0x form', () =>
    expectSingleMatch(
      `payload=${Buffer.from(CANARY, 'utf8').toString('base64')}`,
      'base64(lowercase)',
    ));
  it('base64 of checksummed form', () =>
    expectSingleMatch(Buffer.from(CHECKSUMMED, 'utf8').toString('base64'), 'base64(checksummed)'));
  it('base64 of no-0x form', () =>
    expectSingleMatch(Buffer.from(CORE, 'utf8').toString('base64'), 'base64(no-0x-lowercase)'));
  it('base64 of raw 20 bytes', () =>
    expectSingleMatch(Buffer.from(CORE, 'hex').toString('base64'), 'base64(raw-20-bytes)'));
  it('URL-encoded base64 (plus/slash/equals escaped)', () => {
    const b = Buffer.from(CORE, 'hex').toString('base64');
    const enc = encodeURIComponent(b);
    // Only meaningful when the base64 actually contains escapable chars.
    if (enc !== b) {
      const matches = findCanary(`?blob=${enc}`, forms);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.encoding).toMatch(/^url-encoded\(base64/);
    }
  });
  it('inside a JSON-RPC batch body', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [CANARY, 'latest'] },
      { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
    ]);
    expectSingleMatch(batch, 'lowercase');
  });
});

describe('hashed forms — flagged separately', () => {
  const lowerHash = keccak256(Buffer.from(CANARY, 'utf8'));
  const checksumHash = keccak256(Buffer.from(CHECKSUMMED, 'utf8'));
  const shaLower = sha256(Buffer.from(CANARY, 'utf8'));

  it('keccak256(lowercase) hex', () =>
    expectSingleMatch(`uid=${lowerHash}`, 'keccak256(lowercase)-hex', 'hashed'));
  it('keccak256(checksummed) hex without 0x', () =>
    expectSingleMatch(checksumHash.slice(2), 'keccak256(checksummed)-hex', 'hashed'));
  it('sha256(lowercase) hex uppercase', () =>
    expectSingleMatch(shaLower.slice(2).toUpperCase(), 'sha256(lowercase)-hex', 'hashed'));
  it('base64 of keccak digest bytes', () => {
    const b = Buffer.from(lowerHash.slice(2), 'hex').toString('base64');
    const matches = findCanary(`h=${b}`, forms);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.category).toBe('hashed');
  });
});

describe('partial display forms — low confidence', () => {
  it('matches 0x123456…abcd ellipsis form', () => {
    const display = `0x${CORE.slice(0, 6)}…${CORE.slice(-4)}`;
    expectSingleMatch(`<span>${display}</span>`, 'truncated-display', 'partial');
  });
  it('matches dot-dot-dot form without 0x', () => {
    const display = `${CORE.slice(0, 6)}...${CORE.slice(-4)}`;
    expectSingleMatch(display, 'truncated-display', 'partial');
  });
  it('does NOT double-report the full address as partial', () => {
    const matches = findCanary(CANARY, forms);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.category).toBe('exact');
  });
});

describe('false positives', () => {
  const otherForms = buildCanaryForms(OTHER);
  it('a different address never matches', () => {
    expect(findCanary(`${OTHER} ${getAddress(OTHER)} ${abiPadded(OTHER.slice(2))}`, forms)).toHaveLength(0);
  });
  it("the other address's own forms do match its own matcher (sanity)", () => {
    expect(findCanary(OTHER, otherForms)).toHaveLength(1);
  });
  it('near-miss: one hex char off', () => {
    const nearMiss = CORE.slice(0, -1) + (CORE.endsWith('0') ? '1' : '0');
    expect(findCanary(`0x${nearMiss}`, forms)).toHaveLength(0);
  });
  it('near-miss: truncated to 39 chars', () => {
    expect(findCanary(CORE.slice(0, 39), forms)).toHaveLength(0);
  });
  it('random hex of same length', () => {
    expect(findCanary('0x' + 'ab'.repeat(20), forms)).toHaveLength(0);
  });
  it('empty and unrelated text', () => {
    expect(findCanary('', forms)).toHaveLength(0);
    expect(findCanary('hello world 0x1234', forms)).toHaveLength(0);
  });
});

describe('overlap handling', () => {
  it('padded form wins over inner core', () => {
    const matches = findCanary(abiPadded(CORE), forms);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.encoding).toBe('abi-padded-32');
  });
  it('two separate occurrences are two matches', () => {
    const matches = findCanary(`${CANARY} and again ${CHECKSUMMED}`, forms);
    expect(matches).toHaveLength(2);
  });
});

describe('redaction', () => {
  it('replaces the canary and keeps context', () => {
    const text = `prefix-${'x'.repeat(50)}${CANARY}${'y'.repeat(50)}-suffix`;
    const m = findCanary(text, forms)[0]!;
    const snippet = redactSnippet(text, m, forms);
    expect(snippet).toContain('<CANARY>');
    expect(snippet).not.toContain(CORE);
    expect(snippet).toContain('x'.repeat(40));
    expect(snippet).toContain('y'.repeat(40));
  });
  it('redacts a second occurrence inside the context window', () => {
    const text = `${CANARY} ${CANARY}`;
    const m = findCanary(text, forms)[0]!;
    const snippet = redactSnippet(text, m, forms);
    expect(snippet).not.toContain(CORE);
    expect(snippet.match(/<CANARY>/g)!.length).toBe(2);
  });
});
