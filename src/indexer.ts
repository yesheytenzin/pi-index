import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openDatabase } from './sqlite.ts';
type Database = ReturnType<typeof openDatabase>;
import { setTimeout as delay } from 'node:timers/promises';

export type SymbolResult = {
  name: string;
  path: string;
  line: number;
  kind: string;
  language?: string;
  scope?: string;
  signature?: string;
};
export type Coverage = {
  discovered: number;
  indexed: number;
  changed: number;
  unsupported: number;
  skipped: { path: string; reason: string }[];
  skipped_total: number;
  skipped_truncated: boolean;
  excluded: string[];
  limitations: string[];
};
type Snapshot = { symbols: SymbolResult[]; coverage: Coverage };
const MAX_FILE_BYTES = 1024 * 1024;
const BUSY_MS = 5000;
const CTAGS_OPTIONS = ['--options=NONE', '--output-format=json', '--fields=+nKlsS', '--sort=no', '-f', '-'];
const queues = new Map<string, Promise<void>>();
const emptyCoverage = (): Coverage => ({
  discovered: 0, indexed: 0, changed: 0, unsupported: 0, skipped: [], skipped_total: 0, skipped_truncated: false,
  excluded: ['Git-ignored untracked files are reported as skipped; ignored directories are summarized, not enumerated recursively.'],
  limitations: ['Git worktree files only; language support depends on Universal Ctags; files over 1 MiB and files containing NUL bytes are skipped.'],
});

function run(command: string, args: string[], cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<Buffer>((accept, reject) => {
    execFile(command, args, { cwd, signal, timeout: 30_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else accept(stdout);
    });
  });
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return previous;
  await new Promise<void>((accept, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    previous.then(() => { signal.removeEventListener('abort', abort); accept(); });
  });
}

function parseSymbols(text: string, path: string): SymbolResult[] {
  const symbols: SymbolResult[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('_type' in value)) throw new Error('Invalid Ctags JSON record');
    if (value._type === 'ptag') continue;
    if (value._type !== 'tag' || !('name' in value) || typeof value.name !== 'string' ||
        !('line' in value) || typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 1 ||
        !('kind' in value) || typeof value.kind !== 'string') throw new Error('Invalid Ctags symbol');
    const symbol: SymbolResult = { name: value.name, path, line: value.line, kind: value.kind };
    if ('language' in value) {
      if (typeof value.language !== 'string') throw new Error('Invalid Ctags language');
      symbol.language = value.language;
    }
    if ('scope' in value) {
      if (typeof value.scope !== 'string') throw new Error('Invalid Ctags scope');
      symbol.scope = value.scope;
    }
    if ('signature' in value) {
      if (typeof value.signature !== 'string') throw new Error('Invalid Ctags signature');
      symbol.signature = value.signature;
    }
    symbols.push(symbol);
  }
  return symbols;
}

function parseStoredSymbols(value: unknown, path: string): SymbolResult[] {
  if (typeof value !== 'string') throw new Error('Invalid symbol cache');
  const records: unknown = JSON.parse(value);
  if (!Array.isArray(records)) throw new Error('Invalid symbol cache');
  return parseSymbols(records.map(record => JSON.stringify({ ...record, _type: 'tag' })).join('\n'), path);
}

function limitValue(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be an integer from 1 to 10000');
  return limit;
}

function safeRelative(path: string, allowEmpty = false) {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..') || (!path && !allowEmpty)) {
    throw new Error('Expected a repository-relative path without traversal');
  }
  return path.replace(/^\.\//, '');
}

async function fileContents(root: string, path: string) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return { reason: 'outside-root' };
  let parent = root;
  for (const part of rel.split(sep)) {
    parent = join(parent, part);
    const stat = await lstat(parent).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (!stat) return { reason: 'missing' };
    if (stat.isSymbolicLink()) return { reason: 'symlink' };
    if (parent === absolute && !stat.isFile()) return { reason: 'not-regular-file' };
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return undefined;
    throw error;
  });
  if (!handle) return { reason: 'missing' };
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { reason: 'not-regular-file' };
    if (stat.size > MAX_FILE_BYTES) return { reason: 'oversize' };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) return { reason: 'oversize' };
    const content = buffer.subarray(0, size);
    if (content.includes(0)) return { reason: 'binary' };
    return { hash: createHash('sha256').update(content).digest('hex') };
  } finally { await handle.close(); }
}

export class SymbolIndex {
  private cwd: string;
  private cacheDir: string;
  private ctags: string;
  private closed = false;
  private location?: Promise<{ root: string; database: string }>;

  constructor(cwd: string, options: { cacheDir?: string; ctags?: string } = {}) {
    this.cwd = resolve(cwd);
    this.cacheDir = resolve(options.cacheDir ?? process.env.PI_INDEX_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pi-index'));
    this.ctags = options.ctags ?? process.env.PI_INDEX_CTAGS ?? 'ctags';
  }

  private async locate() {
    if (!this.location) {
      this.location = (async () => {
        const output = await run('git', ['rev-parse', '--show-toplevel'], this.cwd);
        // Git terminates the root with one LF; trim() would corrupt legal directory names.
        const root = await realpath(output.toString('utf8').replace(/\n$/, ''));
        const key = createHash('sha256').update(root).digest('hex');
        const directory = join(this.cacheDir, key);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await lstat(directory)).isSymbolicLink()) throw new Error('Cache directory cannot be a symlink');
        await chmod(directory, 0o700);
        return { root, database: join(directory, 'symbols.sqlite') };
      })();
    }
    return this.location;
  }

  private async operate<T>(signal: AbortSignal | undefined, operation: (db: Database, root: string) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('SymbolIndex is closed');
    signal?.throwIfAborted();
    const { root, database } = await this.locate();
    const previous = queues.get(database) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>(done => { release = done; });
    queues.set(database, next);
    try {
      await waitForTurn(previous, signal);
      signal?.throwIfAborted();
      if (this.closed) throw new Error('SymbolIndex is closed');
      const handle = await open(database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await handle.close();
      await chmod(database, 0o600);
      const db = openDatabase(database);
      try {
        db.exec('PRAGMA busy_timeout=0');
        const deadline = Date.now() + BUSY_MS;
        for (;;) {
          signal?.throwIfAborted();
          try { db.exec('BEGIN IMMEDIATE'); break; }
          catch (error) {
            if (!(error instanceof Error) || !/locked|busy/i.test(error.message)) throw error;
            if (Date.now() >= deadline) throw new Error('Symbol index busy after 5000ms', { cause: error });
            await delay(25, undefined, { signal });
          }
        }
        try {
          db.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, symbols TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
          const result = await operation(db, root);
          signal?.throwIfAborted();
          db.exec('COMMIT');
          return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } finally { db.close(); }
    } finally {
      // A cancelled waiter must not let later callers bypass the active transaction.
      void previous.then(release);
      void next.then(() => { if (queues.get(database) === next) queues.delete(database); });
    }
  }

  private async ctagsRun(args: string[], root: string, signal?: AbortSignal) {
    try { return await run(this.ctags, args, root, signal); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Universal Ctags executable ${JSON.stringify(this.ctags)} was not found. Install Universal Ctags with JSON support or set PI_INDEX_CTAGS/options.ctags.`, { cause: error });
      }
      throw error;
    }
  }

  private async refresh(db: Database, root: string, rebuild: boolean, signal?: AbortSignal): Promise<Snapshot> {
    const coverage = emptyCoverage();
    const skip = (path: string, reason: string) => {
      coverage.skipped_total++;
      if (coverage.skipped.length < 100) coverage.skipped.push({ path, reason });
      else coverage.skipped_truncated = true;
    };
    const version = (await this.ctagsRun(['--options=NONE', '--version'], root, signal)).toString('utf8');
    if (!version.startsWith('Universal Ctags')) throw new Error('Universal Ctags is required. Install Universal Ctags with JSON support and set PI_INDEX_CTAGS/options.ctags.');
    const features = (await this.ctagsRun(['--options=NONE', '--list-features'], root, signal)).toString('utf8');
    if (!/^json(?:\s|$)/m.test(features)) throw new Error('Universal Ctags lacks JSON support. Install a JSON-enabled build and set PI_INDEX_CTAGS/options.ctags.');
    const fingerprint = createHash('sha256').update(JSON.stringify([2, this.ctags, version, features, CTAGS_OPTIONS])).digest('hex');
    const force = rebuild || db.prepare('SELECT value FROM metadata WHERE key = ?').get('fingerprint')?.value !== fingerprint;
    const list = async (args: string[]) => {
      const buffer = await run('git', ['-c', 'core.quotepath=false', 'ls-files', '-z', ...args], root, signal);
      if (!buffer.equals(Buffer.from(buffer.toString('utf8')))) throw new Error('Non-UTF-8 filenames are not supported');
      return [...new Set(buffer.toString('utf8').split('\0').filter(Boolean))].sort();
    };
    const paths = await list(['--cached', '--others', '--exclude-standard']);
    // --directory collapses an ignored directory to one entry, so ignored content is summarized rather than enumerated recursively.
    const ignored = await list(['--others', '--ignored', '--exclude-standard', '--directory']);
    for (const path of ignored) skip(path, 'ignored');
    coverage.discovered = paths.length + ignored.length;
    const existing = new Map<string, { hash: string; symbols: SymbolResult[] | null }>();
    for (const row of db.prepare('SELECT path, hash, symbols FROM files').all()) {
      if (typeof row.path !== 'string' || typeof row.hash !== 'string') throw new Error('Invalid file cache');
      existing.set(row.path, { hash: row.hash, symbols: row.symbols === 'null' ? null : parseStoredSymbols(row.symbols, row.path) });
    }
    const candidates = new Map<string, string>();
    for (const path of paths) {
      signal?.throwIfAborted();
      safeRelative(path);
      const state = await fileContents(root, path);
      if ('reason' in state) skip(path, state.reason ?? 'unreadable');
      else candidates.set(path, state.hash);
    }
    const changed = [...candidates.keys()].filter(path => force || existing.get(path)?.hash !== candidates.get(path));
    const languages = new Map<string, string>();
    for (let offset = 0; offset < changed.length; offset += 64) {
      const batch = changed.slice(offset, offset + 64);
      let output = (await this.ctagsRun(['--options=NONE', '--print-language', ...batch.map(path => resolve(root, path))], root, signal)).toString('utf8');
      for (const path of batch) {
        const prefix = `${resolve(root, path)}: `;
        // Ctags omits a line entirely for some inputs (for example .gitignore); a missing line means no detected language.
        if (!output.startsWith(prefix)) { languages.set(path, 'NONE'); continue; }
        output = output.slice(prefix.length);
        const end = output.indexOf('\n');
        if (end < 0) throw new Error('Invalid Ctags language detection output');
        languages.set(path, output.slice(0, end));
        output = output.slice(end + 1);
      }
      if (output) throw new Error('Unexpected Ctags language detection output');
    }
    const symbols: SymbolResult[] = [];
    const insert = db.prepare('INSERT INTO files VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, symbols=excluded.symbols');
    for (const [path, hash] of candidates) {
      signal?.throwIfAborted();
      const cached = existing.get(path);
      let extracted: SymbolResult[] | null;
      if (!force && cached?.hash === hash) extracted = cached.symbols;
      else {
        if (languages.get(path) === 'NONE') extracted = null;
        else {
          const output = await this.ctagsRun([...CTAGS_OPTIONS, resolve(root, path)], root, signal);
          extracted = parseSymbols(output.toString('utf8'), path);
          coverage.changed++;
        }
        const after = await fileContents(root, path);
        if (!('hash' in after) || after.hash !== hash) throw new Error(`File changed during extraction: ${JSON.stringify(path)}`);
        insert.run(path, hash, JSON.stringify(extracted));
      }
      existing.delete(path);
      if (extracted === null) { coverage.unsupported++; skip(path, 'unsupported-language'); }
      else { coverage.indexed++; symbols.push(...extracted); }
    }
    const remove = db.prepare('DELETE FROM files WHERE path = ?');
    for (const path of existing.keys()) remove.run(path);
    const metadata = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
    metadata.run('coverage', JSON.stringify(coverage));
    metadata.run('fingerprint', fingerprint);
    return { symbols, coverage };
  }

  async find(query: { name: string; match?: 'exact' | 'prefix'; path_prefix?: string; limit?: number }, signal?: AbortSignal) {
    if (typeof query.name !== 'string' || !query.name || query.name.includes('\0')) throw new Error('name must be a nonempty string');
    if (query.match !== undefined && query.match !== 'exact' && query.match !== 'prefix') throw new Error('match must be exact or prefix');
    const prefix = safeRelative(query.path_prefix ?? '', true);
    const limit = limitValue(query.limit);
    return this.operate(signal, async (db, root) => {
      const { symbols, coverage } = await this.refresh(db, root, false, signal);
      const matches = symbols.filter(symbol => symbol.path.startsWith(prefix) && (query.match === 'prefix' ? symbol.name.startsWith(query.name) : symbol.name === query.name));
      matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
      return { root, results: matches.slice(0, limit), coverage, truncated: matches.length > limit };
    });
  }

  async outline(query: { path: string; limit?: number }, signal?: AbortSignal) {
    const path = safeRelative(query.path);
    const limit = limitValue(query.limit);
    return this.operate(signal, async (db, root) => {
      const { symbols, coverage } = await this.refresh(db, root, false, signal);
      const matches = symbols.filter(symbol => symbol.path === path).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
      return { root, results: matches.slice(0, limit), coverage, truncated: matches.length > limit };
    });
  }

  async rebuild(signal?: AbortSignal) {
    return this.operate(signal, async (db, root) => {
      const { coverage } = await this.refresh(db, root, true, signal);
      return { root, results: [], coverage, truncated: false };
    });
  }

  async status() {
    return this.operate(undefined, async (db, root) => {
      const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get('coverage');
      const coverage: Coverage = row && typeof row.value === 'string' ? JSON.parse(row.value) : emptyCoverage();
      return { root, results: [], coverage, truncated: false, initialized: Boolean(row) };
    });
  }

  close() { this.closed = true; }
}
