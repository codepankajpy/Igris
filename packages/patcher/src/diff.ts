/**
 * Minimal dependency-free unified diff (line-based LCS with 3 lines of
 * context), verified against `git apply` in the test suite. Files the patcher
 * touches are small source modules, so the O(n·m) DP table is fine.
 */

function lcsTable(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }
  return t;
}

type Op = { kind: ' ' | '-' | '+'; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const t = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
      ops.push({ kind: '-', line: a[i]! });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: '-', line: a[i++]! });
  while (j < b.length) ops.push({ kind: '+', line: b[j++]! });
  return ops;
}

/**
 * Real lines of a file: a trailing newline terminates the last line instead
 * of opening a phantom empty one (the difference between String.split
 * semantics and what git counts).
 */
function splitLines(s: string): { lines: string[]; hasEol: boolean } {
  const hasEol = s.endsWith('\n');
  const lines = s.split('\n');
  if (hasEol) lines.pop();
  return { lines, hasEol };
}

const NO_EOL = '\\ No newline at end of file';

/** Unified diff of two file contents; empty string when identical. */
export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  if (before === after) return '';
  const { lines: a, hasEol: aEol } = splitLines(before);
  const { lines: b, hasEol: bEol } = splitLines(after);
  const ops = diffOps(a, b);

  interface Hunk {
    ops: Op[];
    aStart: number;
    bStart: number;
  }
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let aLine = 1; // 1-based line number of the NEXT a-line to process
  let bLine = 1;
  let trailing = 0;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.kind === ' ') {
      if (current) {
        current.ops.push(op);
        trailing++;
        if (trailing > context * 2) {
          current.ops.splice(current.ops.length - (trailing - context));
          hunks.push(current);
          current = null;
        }
      }
      aLine++;
      bLine++;
    } else {
      if (!current) {
        const lead: Op[] = [];
        for (let back = k - 1; back >= 0 && lead.length < context; back--) {
          if (ops[back]!.kind !== ' ') break;
          lead.unshift(ops[back]!);
        }
        current = { ops: [...lead], aStart: aLine - lead.length, bStart: bLine - lead.length };
      }
      trailing = 0;
      current.ops.push(op);
      if (op.kind === '-') aLine++;
      else bLine++;
    }
  }
  if (current) {
    if (trailing > context) current.ops.splice(current.ops.length - (trailing - context));
    hunks.push(current);
  }

  const lastHunk = hunks[hunks.length - 1]!;
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    const aCount = h.ops.filter((o) => o.kind !== '+').length;
    const bCount = h.ops.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${h.aStart},${aCount} +${h.bStart},${bCount} @@`);
    for (let k = 0; k < h.ops.length; k++) {
      const o = h.ops[k]!;
      out.push(o.kind + o.line);
      // "No newline at end of file" markers, when a hunk reaches the last line.
      const isLast = h === lastHunk && k === h.ops.length - 1;
      if (isLast) {
        if (o.kind !== '+' && !aEol && h.aStart + aCount - 1 === a.length) out.push(NO_EOL);
        else if (o.kind !== '-' && !bEol && h.bStart + bCount - 1 === b.length) out.push(NO_EOL);
      }
    }
  }
  return out.join('\n') + '\n';
}

/** Diff for a newly created file. */
export function newFileDiff(path: string, content: string): string {
  const { lines, hasEol } = splitLines(content);
  const body = lines.map((l) => '+' + l);
  if (!hasEol) body.push(NO_EOL);
  return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n') + '\n';
}
