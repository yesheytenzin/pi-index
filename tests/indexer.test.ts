import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SymbolIndex } from '../src/indexer.ts';
import { openDatabase } from '../src/sqlite.ts';

const ctags = process.env.PI_INDEX_CTAGS ?? 'ctags';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-index-test-'));
  const root = join(directory, 'repo');
  const cacheDir = join(directory, 'cache');
  await mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  const indexes: SymbolIndex[] = [];
  t.after(async () => {
    indexes.forEach(index => index.close());
    await rm(directory, { recursive: true, force: true });
  });
  const index = (executable = ctags, cwd = root) => {
    const value = new SymbolIndex(cwd, { cacheDir, ctags: executable });
    indexes.push(value);
    return value;
  };
  const file = async (path: string, content: string | Buffer) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return { root, directory, cacheDir, index, file };
}

test('real Ctags find, prefix, outline, limits and persistent incremental hashes', async t => {
  const f = await fixture(t);
  await f.file('src/a.ts', 'export function alpha() {}\nexport function alphabet() {}\n');
  await f.file('other.ts', 'export function alpha() {}\n');
  const index = f.index();
  assert.equal((await index.status()).initialized, false);
  const first = await index.find({ name: 'alpha' });
  assert.equal(first.root, f.root);
  assert.deepEqual(first.results.map(symbol => symbol.path), ['other.ts', 'src/a.ts']);
  assert.equal(first.coverage.changed, 2);
  assert.equal(first.coverage.indexed, 2);
  assert.ok(first.results.every(symbol => symbol.line === 1 && symbol.kind.length));
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.equal((await index.find({ name: 'alpha', match: 'prefix', limit: 1 })).truncated, true);
  assert.deepEqual((await index.find({ name: 'alpha', path_prefix: 'src/' })).results.map(symbol => symbol.path), ['src/a.ts']);
  assert.deepEqual((await index.outline({ path: 'src/a.ts' })).results.map(symbol => [symbol.name, symbol.line]), [['alpha', 1], ['alphabet', 2]]);
  assert.equal((await f.index().find({ name: 'alpha' })).coverage.changed, 0);
  await f.file('src/a.ts', 'export function omega() {}\nexport function alphabet() {}\n');
  const updated = await index.find({ name: 'omega' });
  assert.equal(updated.coverage.changed, 1);
  assert.equal(updated.results.length, 1);
  await rm(join(f.root, 'other.ts'));
  assert.equal((await index.find({ name: 'alpha' })).results.length, 0);
  assert.equal((await index.rebuild()).coverage.changed, 1);
  assert.equal((await index.status()).initialized, true);
});

test('Git discovery covers untracked, tracked, ignored, binary, oversize and symlink files', async t => {
  const f = await fixture(t);
  await f.file('.gitignore', 'ignored.ts\n');
  await f.file('ignored.ts', 'function secret() {}');
  await f.file('tracked.ts', 'function tracked() {}');
  execFileSync('git', ['add', 'tracked.ts'], { cwd: f.root });
  await f.file('untracked.ts', 'function untracked() {}');
  await f.file('binary.ts', Buffer.from('function binary() {}\0'));
  await f.file('large.ts', 'x'.repeat(1024 * 1024 + 1));
  await writeFile(join(f.directory, 'external.ts'), 'function secret() {}');
  await symlink(join(f.directory, 'external.ts'), join(f.root, 'linked.ts'));
  const result = await f.index().find({ name: 'secret' });
  assert.equal(result.results.length, 0);
  const skipped = new Map(result.coverage.skipped.map(item => [item.path, item.reason]));
  assert.equal(skipped.get('ignored.ts'), 'ignored');
  assert.equal(skipped.get('binary.ts'), 'binary');
  assert.equal(skipped.get('large.ts'), 'oversize');
  assert.equal(skipped.get('linked.ts'), 'symlink');
  assert.equal((await f.index().find({ name: 'tracked' })).results.length, 1);
  assert.equal((await f.index().find({ name: 'untracked' })).results.length, 1);
});

test('argv handles whitespace, option-like and newline filenames without shell evaluation', async t => {
  const f = await fixture(t);
  const paths = ['-danger.ts', 'new\nline.ts', 'space name.ts', '$(touch GOTCHA).ts', 'quote"file.ts'];
  for (const path of paths) await f.file(path, 'function oddName() {}');
  const result = await f.index().find({ name: 'oddName' });
  assert.deepEqual(result.results.map(symbol => symbol.path).sort(), paths.sort());
  await assert.rejects(readFile(join(f.root, 'GOTCHA')));
});

test('project Ctags configuration is disabled', async t => {
  const f = await fixture(t);
  await f.file('.ctags.d/disable.ctags', '--languages=-TypeScript\n');
  await f.file('source.ts', 'function configured() {}');
  assert.equal((await f.index().find({ name: 'configured' })).results.length, 1);
});

test('bundled Zig parser indexes definitions Universal Ctags lacks', async t => {
  const f = await fixture(t);
  await f.file('src/app.zig', [
    'const std = @import("std");',
    'pub const Mode = enum { fast, slow };',
    'const Point = packed struct { x: i32 };',
    'pub fn start(mode: Mode) void {}',
    '    fn method() void {}',
    'test "it works" {}',
  ].join('\n') + '\n');
  const index = f.index();
  assert.deepEqual((await index.find({ name: 'start' })).results.map(s => [s.name, s.line, s.kind]), [['start', 4, 'function']]);
  assert.equal((await index.find({ name: 'Mode' })).results[0]?.kind, 'enum');
  assert.equal((await index.find({ name: 'Point' })).results[0]?.kind, 'struct');
  const outline = (await index.outline({ path: 'src/app.zig' })).results.map(s => s.name);
  assert.deepEqual(outline, ['std', 'Mode', 'Point', 'start', 'method', 'it works']);
});

test('canonical roots share a private cache, linked worktrees do not', async t => {
  const f = await fixture(t);
  await f.file('sub/source.ts', 'function shared() {}');
  const original = await f.index().find({ name: 'shared' });
  const alias = join(f.directory, 'alias');
  await symlink(f.root, alias);
  const same = await f.index(ctags, join(alias, 'sub')).find({ name: 'shared' });
  assert.equal(same.root, original.root);
  assert.equal(same.coverage.changed, 0);
  execFileSync('git', ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: f.root });
  const worktree = join(f.directory, 'worktree');
  execFileSync('git', ['worktree', 'add', '--detach', worktree], { cwd: f.root });
  await writeFile(join(worktree, 'different.ts'), 'function different() {}');
  const other = await f.index(ctags, worktree).find({ name: 'shared' });
  assert.equal(other.results.length, 0);
  assert.notEqual(other.root, original.root);
});

async function wrapper(directory: string, code: string) {
  const path = join(directory, `ctags-${Math.random()}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\n${code}\n`);
  await chmod(path, 0o700);
  return path;
}

test('failed extraction and invalid JSON roll back the entire previous snapshot', async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function before() {}');
  const baseline = await f.index().find({ name: 'before' });
  await f.file('a.ts', 'function after() {}');
  await f.file('b.ts', 'function additional() {}');
  for (const code of ['process.exit(2)', 'console.log("not json")', 'console.log(JSON.stringify({_type:"tag",name:"bad",line:"1",kind:"function"}))']) {
    const bad = f.index(await wrapper(f.directory, code));
    await assert.rejects(bad.rebuild());
    assert.deepEqual((await bad.status()).coverage, baseline.coverage);
    const database = join(f.cacheDir, createHash('sha256').update(f.root).digest('hex'), 'symbols.sqlite');
    const db = openDatabase(database);
    try {
      const rows = db.prepare('SELECT path, symbols FROM files').all();
      assert.equal(rows.length, 1);
      assert.match(String(rows[0]?.symbols), /before/);
      assert.doesNotMatch(String(rows[0]?.symbols), /after|additional/);
    } finally { db.close(); }
  }
  assert.equal((await f.index().find({ name: 'after' })).coverage.changed, 2);
});

test('abort kills extraction and rolls back, including an already-aborted request', async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function before() {}');
  const baseline = await f.index().find({ name: 'before' });
  await f.file('a.ts', 'function after() {}');
  const marker = join(f.directory, 'started');
  const executable = await wrapper(f.directory, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); setInterval(() => {}, 1000);`);
  const slow = f.index(executable);
  const controller = new AbortController();
  const request = slow.rebuild(controller.signal);
  const rejected = assert.rejects(request, error => error instanceof Error && error.name === 'AbortError');
  for (let i = 0; i < 200; i++) {
    if (await readFile(marker).then(() => true, () => false)) break;
    await delay(10);
  }
  assert.equal(await readFile(marker, 'utf8'), 'yes');
  controller.abort();
  await rejected;
  assert.deepEqual((await slow.status()).coverage, baseline.coverage);
  await assert.rejects(slow.rebuild(AbortSignal.abort()), error => error instanceof Error && error.name === 'AbortError');
});

test('same-process simultaneous requests serialize without blocking the event loop', async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function concurrent() {}');
  const indexes = [f.index(), f.index(), f.index()];
  const values = await Promise.all(indexes.map(index => index.find({ name: 'concurrent' })));
  assert.ok(values.every(value => value.results.length === 1));
  assert.deepEqual(values.map(value => value.coverage.changed).sort(), [0, 0, 1]);
});

test('external SQLite lock is acquired before scanning and retried asynchronously', async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function lockTest() {}');
  await f.index().rebuild();
  const database = join(f.cacheDir, createHash('sha256').update(f.root).digest('hex'), 'symbols.sqlite');
  const lock = openDatabase(database);
  lock.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const operation = f.index().rebuild(controller.signal);
  const rejected = assert.rejects(operation, error => error instanceof Error && error.name === 'AbortError');
  await delay(75);
  controller.abort();
  await rejected;
  lock.exec('ROLLBACK');
  lock.close();
  assert.equal((await f.index().find({ name: 'lockTest' })).results.length, 1);
});

test('separate Node processes refresh one cache safely', async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function processes() {}');
  const source = `import {SymbolIndex} from ${JSON.stringify(new URL('../src/indexer.ts', import.meta.url).href)};
    const index = new SymbolIndex(${JSON.stringify(f.root)}, {cacheDir:${JSON.stringify(f.cacheDir)},ctags:${JSON.stringify(ctags)}});
    console.log(JSON.stringify(await index.find({name:'processes'}))); index.close();`;
  const child = () => new Promise<string>((accept, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', source], { timeout: 15000 }, (error, stdout) => error ? reject(error) : accept(stdout));
  });
  const outputs = await Promise.all([child(), child(), child()]);
  const values = outputs.map(output => JSON.parse(output));
  assert.ok(values.every(value => value.results[0]?.name === 'processes'));
  assert.deepEqual(values.map(value => value.coverage.changed).sort(), [0, 0, 1]);
});

test('busy deadline expires before invoking Ctags', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.file('a.ts', 'function blocked() {}');
  await f.index().rebuild();
  const marker = join(f.directory, 'unexpected-scan');
  const executable = await wrapper(f.directory, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');`);
  const database = join(f.cacheDir, createHash('sha256').update(f.root).digest('hex'), 'symbols.sqlite');
  const lock = openDatabase(database);
  try {
    lock.exec('BEGIN IMMEDIATE');
    await assert.rejects(f.index(executable).rebuild(), /busy after 5000ms/);
    await assert.rejects(readFile(marker));
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});

test('queries validate paths and limits, close rejects work, non-Git roots fail clearly', async t => {
  const f = await fixture(t);
  const index = f.index();
  for (const path of ['../outside.ts', '/etc/passwd', 'foo/../../escape', 'nul\0.ts']) await assert.rejects(index.outline({ path }));
  await assert.rejects(index.find({ name: '' }));
  await assert.rejects(index.find({ name: 'x', limit: 0 }));
  await assert.rejects(index.find({ name: 'x', limit: 1.5 }));
  await assert.rejects(f.index(ctags, f.directory).status());
  index.close();
  await assert.rejects(index.status(), /closed/);
});
