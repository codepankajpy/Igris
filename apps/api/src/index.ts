import express, { type Request, type Response } from 'express';
import cors from 'cors';
import type { Report } from '@igris/core';
import { scan } from '@igris/scanner';
import { recordFromReport, type RegistryRecord } from '@igris/registry';
import { fix } from '@igris/patcher';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory reports store + load initial seed snapshot if present
const memoryRecords: RegistryRecord[] = [];
const memoryFullReports = new Map<string, Report>();

function seedInitialRecords() {
  const possiblePaths = [
    join(process.cwd(), 'apps/web/public/snapshot.json'),
    join(process.cwd(), 'examples/snapshot.json'),
    join(process.cwd(), '../../examples/snapshot.json'),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(raw.records)) {
          memoryRecords.push(...raw.records);
          console.log(`[API] Seeded ${raw.records.length} records from ${p}`);
          break;
        }
      } catch (err) {
        console.warn(`[API] Could not parse seed snapshot at ${p}:`, err);
      }
    }
  }
}

seedInitialRecords();

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Igris Privacy Scanner API',
    version: '0.1.0',
    totalAudits: memoryRecords.length,
  });
});

app.get('/api/reports', (_req: Request, res: Response) => {
  res.json({
    version: 1,
    records: memoryRecords,
  });
});

app.get('/api/reports/:id', (req: Request, res: Response) => {
  const rec = memoryRecords.find((r) => r.id === req.params.id);
  const full = rec ? memoryFullReports.get(rec.id) : null;
  if (!rec) {
    return res.status(404).json({ error: 'Report not found' });
  }
  return res.json({ record: rec, report: full ?? null });
});

app.post('/api/scan', async (req: Request, res: Response) => {
  const { url, dwellMs, spoofMetaMask } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "url" in request body' });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL must use http:// or https://' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  console.log(`[API] Starting privacy scan for ${url} (dwell: ${dwellMs || 4000}ms) ...`);

  try {
    const report: Report = await scan({
      url: parsed.toString(),
      dwellMs: typeof dwellMs === 'number' ? Math.min(Math.max(dwellMs, 1000), 20000) : 4000,
      spoofMetaMask: spoofMetaMask !== false,
    });

    const reportJson = JSON.stringify(report);
    const rawScanRecord = recordFromReport(report, reportJson);

    const record: RegistryRecord = {
      ...rawScanRecord,
      id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      scanner: process.env.ARKIV_SCANNER_ADDRESS || '0xDbd0309b80f71E12d45Ac8321DBA637156a4198B',
    };

    // Save in memory
    memoryRecords.unshift(record);
    memoryFullReports.set(record.id, report);

    console.log(
      `[API] Scan finished for ${parsed.hostname} — Score: ${report.score}, Leaks: ${report.findings.length}, Anon-RPC: ${report.usesAnonRpc}`,
    );

    return res.json({
      success: true,
      record,
      report,
    });
  } catch (err: unknown) {
    console.error(`[API] Error scanning ${url}:`, err);
    return res.status(500).json({
      error: 'Failed to complete privacy scan',
      details: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/api/scan-repo', async (req: Request, res: Response) => {
  const { repoUrl } = req.body || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "repoUrl" in request body' });
  }

  if (!repoUrl.startsWith('https://github.com/') && !repoUrl.endsWith('.git')) {
    return res.status(400).json({ error: 'Please provide a valid GitHub repository URL' });
  }

  const tmp = mkdtempSync(join(tmpdir(), 'igris-repo-'));
  console.log(`[API] Cloning ${repoUrl} to ${tmp} ...`);

  try {
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, tmp], { timeout: 30000 });
    console.log(`[API] Running Anon-RPC AST patcher on repository ...`);
    const fixResult = fix({ targetDir: tmp });

    const recommendations = [];
    if (fixResult.changedFiles.length > 0) {
      recommendations.push(
        `Found ${fixResult.changedFiles.length} file(s) with unshielded RPC calls (viem/ethers/wagmi). Patching with the Ethereum Foundation Anon-RPC shim will eliminate RPC-level IP and wallet correlation.`,
      );
    } else {
      recommendations.push(
        'No direct unshielded viem/ethers/wagmi clients found, or the project is already using a privacy proxy.',
      );
    }

    return res.json({
      success: true,
      repoUrl,
      changedFiles: fixResult.changedFiles,
      diff: fixResult.diff,
      recommendations,
    });
  } catch (err: unknown) {
    console.error(`[API] Error processing repository ${repoUrl}:`, err);
    return res.status(500).json({
      error: 'Failed to inspect and patch repository',
      details: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Igris Scanner API running on http://localhost:${PORT}`);
});
