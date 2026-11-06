/**
 * Local-file registry: the same interface as Arkiv, backed by one JSON file.
 * Keeps `pnpm demo`, the e2e suite and the viewer working offline when the
 * testnet is down during judging.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  matchesQuery,
  type PublishResult,
  type RegistryBackend,
  type RegistryQuery,
  type RegistryRecord,
  type ScanRecord,
} from './record.js';

export const DEFAULT_LOCAL_PATH = 'igris-registry.json';

interface LocalFile {
  version: 1;
  records: RegistryRecord[];
}

export class LocalRegistry implements RegistryBackend {
  readonly kind = 'local' as const;

  constructor(private path: string = DEFAULT_LOCAL_PATH) {}

  private load(): LocalFile {
    if (!existsSync(this.path)) return { version: 1, records: [] };
    return JSON.parse(readFileSync(this.path, 'utf8')) as LocalFile;
  }

  private save(file: LocalFile): void {
    writeFileSync(this.path, JSON.stringify(file, null, 2) + '\n');
  }

  async publish(record: ScanRecord): Promise<PublishResult> {
    const file = this.load();
    const id = `local-${record.hostname}-${record.scannedAt}-${file.records.length + 1}`;
    file.records.push({ ...record, id, scanner: 'local' });
    this.save(file);
    return { id, scanner: 'local' };
  }

  async query(q: RegistryQuery): Promise<RegistryRecord[]> {
    const all = this.load().records.filter((r) => matchesQuery(r, q));
    const sorted = all.sort((a, b) => b.scannedAt - a.scannedAt);
    return q.limit !== undefined ? sorted.slice(0, q.limit) : sorted;
  }

  async snapshot(): Promise<RegistryRecord[]> {
    return this.load().records;
  }
}
