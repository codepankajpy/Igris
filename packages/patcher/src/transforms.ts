/**
 * The ts-morph codemod. Three patterns, matched by their IMPORT BINDINGS
 * (aliases included), never by bare identifier names:
 *
 *  1. viem/wagmi:  http(url[, opts])  where http ∈ {viem, @wagmi/core}
 *       → http(url, { ...opts, fetchFn: igrisAnonFetch })
 *  2. ethers:      new JsonRpcProvider(url, …) where JsonRpcProvider ∈ ethers
 *       → anonJsonRpcProvider(url, …)
 *  3. ethers:      BrowserProvider — left unchanged (reads already go through
 *       the user's wallet, the best case) with an informational note.
 *
 * Anything recognisably RPC-ish that can't be auto-patched becomes a manual
 * note (file, line, what to change) instead of a silent skip.
 */
import { Node, Project, SourceFile, SyntaxKind } from 'ts-morph';
import { relative, dirname, join } from 'node:path';
import { SHIM_BASENAME } from './shim.js';

export interface ManualNote {
  file: string;
  line: number;
  message: string;
}

export interface TransformResult {
  /** Files changed, by path. */
  changed: Set<string>;
  needsViem: boolean;
  needsEthers: boolean;
  notes: ManualNote[];
}

/** Local names under which `name` is imported from one of `modules`. */
function importedNames(sf: SourceFile, name: string, modules: string[]): Set<string> {
  const out = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    if (!modules.includes(mod)) continue;
    for (const named of imp.getNamedImports()) {
      if (named.getName() === name) out.add(named.getAliasNode()?.getText() ?? name);
    }
    const ns = imp.getNamespaceImport();
    if (ns) out.add(`${ns.getText()}.${name}`);
  }
  return out;
}

function calleeMatches(text: string, names: Set<string>): boolean {
  return names.has(text);
}

/** Ensure `import { named } from '<rel path to shim>'` exists in sf. */
function ensureShimImport(sf: SourceFile, shimDir: string, named: string): void {
  let rel = relative(dirname(sf.getFilePath()), join(shimDir, SHIM_BASENAME)).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  const existing = sf.getImportDeclarations().find((i) => i.getModuleSpecifierValue() === rel);
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === named)) {
      existing.addNamedImport(named);
    }
    return;
  }
  sf.addImportDeclaration({ moduleSpecifier: rel, namedImports: [named] });
}

export function transformProject(
  project: Project,
  rootDir: string,
  shimDir: string,
): TransformResult {
  const result: TransformResult = {
    changed: new Set<string>(),
    needsViem: false,
    needsEthers: false,
    notes: [],
  };

  for (const sf of project.getSourceFiles()) {
    const path = relative(rootDir, sf.getFilePath());
    if (path.includes('node_modules') || path.startsWith('..')) continue;
    if (sf.getBaseNameWithoutExtension() === SHIM_BASENAME) continue;
    let fileChanged = false;

    // --- pattern 1: viem/wagmi http(...) transports ---
    const httpNames = importedNames(sf, 'http', ['viem', '@wagmi/core', 'wagmi']);
    if (httpNames.size > 0) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!calleeMatches(call.getExpression().getText(), httpNames)) continue;
        const args = call.getArguments();
        if (args.some((a) => Node.isSpreadElement(a))) {
          result.notes.push({
            file: path,
            line: call.getStartLineNumber(),
            message:
              'http(...) is called with spread arguments; add `fetchFn: igrisAnonFetch` ' +
              'to its options object by hand.',
          });
          continue;
        }
        if (args.length >= 2) {
          const opts = args[1]!;
          if (!Node.isObjectLiteralExpression(opts)) {
            result.notes.push({
              file: path,
              line: call.getStartLineNumber(),
              message:
                'http(url, options) uses a non-literal options argument; add ' +
                '`fetchFn: igrisAnonFetch` to that options object by hand.',
            });
            continue;
          }
          if (opts.getProperty('fetchFn')) continue; // already patched — idempotent
          opts.addPropertyAssignment({ name: 'fetchFn', initializer: 'igrisAnonFetch' });
        } else {
          // http() or http(url)
          if (args.length === 0) call.addArgument('undefined');
          call.addArgument('{ fetchFn: igrisAnonFetch }');
        }
        ensureShimImport(sf, shimDir, 'igrisAnonFetch');
        result.needsViem = true;
        fileChanged = true;
      }
    }

    // --- pattern 2: ethers new JsonRpcProvider(...) ---
    const jrpNames = importedNames(sf, 'JsonRpcProvider', ['ethers', 'ethers/providers']);
    if (jrpNames.size > 0) {
      for (const neu of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (!calleeMatches(neu.getExpression().getText(), jrpNames)) continue;
        const args = neu.getArguments().map((a) => a.getText());
        if (args.length === 0 || !neu.getArguments()[0]) {
          result.notes.push({
            file: path,
            line: neu.getStartLineNumber(),
            message: 'new JsonRpcProvider() without a URL; wire it to anonJsonRpcProvider by hand.',
          });
          continue;
        }
        neu.replaceWithText(`anonJsonRpcProvider(${args.join(', ')})`);
        ensureShimImport(sf, shimDir, 'anonJsonRpcProvider');
        result.needsEthers = true;
        fileChanged = true;
      }
      // Remove now-unused JsonRpcProvider named imports (keeps builds clean).
      for (const imp of sf.getImportDeclarations()) {
        if (!['ethers', 'ethers/providers'].includes(imp.getModuleSpecifierValue())) continue;
        for (const named of imp.getNamedImports()) {
          if (named.getName() !== 'JsonRpcProvider') continue;
          const local = named.getAliasNode()?.getText() ?? named.getName();
          const stillUsed = sf
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .some(
              (id) =>
                id.getText() === local && id !== named.getNameNode() && id !== named.getAliasNode(),
            );
          if (!stillUsed) named.remove();
        }
        if (
          imp.getNamedImports().length === 0 &&
          !imp.getNamespaceImport() &&
          !imp.getDefaultImport()
        ) {
          imp.remove();
        }
      }
    }

    // --- pattern 3: BrowserProvider — informational only ---
    const bpNames = importedNames(sf, 'BrowserProvider', ['ethers']);
    if (bpNames.size > 0) {
      for (const neu of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (!calleeMatches(neu.getExpression().getText(), bpNames)) continue;
        result.notes.push({
          file: path,
          line: neu.getStartLineNumber(),
          message:
            'BrowserProvider routes reads through the user wallet already (best case); ' +
            'left unchanged. The wallet decides which RPC sees the address.',
        });
      }
    }

    if (fileChanged) result.changed.add(sf.getFilePath());
  }

  return result;
}
