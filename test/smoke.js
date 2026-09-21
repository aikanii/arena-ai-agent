'use strict';

/**
 * Zero-dependency smoke tests: unit checks for the tricky bits plus a full
 * end-to-end run of `arena -p` against the bundled mock model.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'arena.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message.split('\n').join('\n    ')}`);
  }
}

function tmpProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arena-test-${name}-`));
  return dir;
}

async function main() {
  console.log('arena-agent smoke tests');

  await test('ignore matcher handles basenames, globs, anchored, negation', () => {
    const { Ignore } = require('../src/utils/ignore');
    const ig = new Ignore(['node_modules', '*.log', '/build', 'docs/', '!keep.log']);
    assert.strictEqual(ig.matches('node_modules', true), true);
    assert.strictEqual(ig.matches('src/node_modules', true), true);
    assert.strictEqual(ig.matches('debug.log', false), true);
    assert.strictEqual(ig.matches('keep.log', false), false);
    assert.strictEqual(ig.matches('build', true), true);
    assert.strictEqual(ig.matches('src/build', true), false); // anchored
    assert.strictEqual(ig.matches('docs', true), true);
    assert.strictEqual(ig.matches('docs/intro.md', false), true); // under ignored dir
    assert.strictEqual(ig.matches('src/app.js', false), false);
  });

  await test('diff finds the changed region', () => {
    const { diffLines, diffStats } = require('../src/utils/diff');
    const entries = diffLines(['a', 'b', 'c', 'd'], ['a', 'X', 'c', 'd']);
    const stats = diffStats(entries);
    assert.strictEqual(stats.added, 1);
    assert.strictEqual(stats.removed, 1);
    assert.ok(entries.some((e) => e.t === '+' && e.s === 'X'));
  });

  await test('workspace paths cannot escape the root', () => {
    const { resolveInRoot } = require('../src/utils/fsx');
    const root = '/tmp/proj';
    assert.strictEqual(resolveInRoot(root, 'src/a.js'), path.resolve(root, 'src/a.js'));
    assert.throws(() => resolveInRoot(root, '../evil.js'));
    assert.throws(() => resolveInRoot(root, '/etc/passwd'));
    assert.throws(() => resolveInRoot(root, 'src/../../evil.js'));
  });

  await test('write/edit/read/delete tools round-trip', async () => {
    const dir = tmpProject('fs');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
    const write = require('../src/tools/write');
    const edit = require('../src/tools/edit');
    const read = require('../src/tools/read');
    const del = require('../src/tools/delete');
    const ctx = { root: dir, session: {} };

    await write.execute({ path: 'new.txt', content: 'created\nby arena\n' }, ctx);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'created\nby arena\n');

    const r = await read.execute({ path: 'a.txt' }, ctx);
    assert.ok(r.result.includes('hello'));

    await edit.execute({ path: 'a.txt', old_string: 'world', new_string: 'arena' }, ctx);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello\narena\n');

    await assert.rejects(
      edit.execute({ path: 'a.txt', old_string: 'not-there', new_string: 'x' }, ctx),
      /not found/
    );

    await del.execute({ path: 'a.txt' }, ctx);
    assert.strictEqual(fs.existsSync(path.join(dir, 'a.txt')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('search_files finds matches with file:line output', async () => {
    const dir = tmpProject('search');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'one.js'), 'function login() {}\nfunction logout() {}\n');
    fs.writeFileSync(path.join(dir, 'two.md'), 'login docs\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), 'login\n');
    const search = require('../src/tools/search');
    const ctx = { root: dir, session: {} };
    const out = await search.execute({ pattern: 'login' }, ctx);
    assert.ok(out.result.includes('src/one.js:1'), out.result);
    assert.ok(out.result.includes('two.md:1'));
    assert.ok(!out.result.includes('node_modules'), 'must respect default ignores');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('run_command captures output and exit codes', async () => {
    const dir = tmpProject('bash');
    const bash = require('../src/tools/bash');
    const ctx = { root: dir, session: {} };
    const out = await bash.execute({ command: 'echo hi && exit 3' }, ctx);
    assert.ok(out.result.includes('hi'));
    assert.ok(out.result.includes('Exit code: 3'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('permissions: plan mode blocks writes, full-auto allows all', async () => {
    const { Permissions } = require('../src/permissions');
    const plan = new Permissions({ mode: 'plan', interactive: false });
    const p1 = await plan.authorize('write_file', { path: 'x', content: '' });
    assert.strictEqual(p1.ok, false);
    const p2 = await plan.authorize('read_file', { path: 'x' });
    assert.strictEqual(p2.ok, true);
    const full = new Permissions({ mode: 'fullAuto', interactive: false });
    const p3 = await full.authorize('run_command', { command: 'ls' });
    assert.strictEqual(p3.ok, true);
    const dflt = new Permissions({ mode: 'default', interactive: false });
    const p4 = await dflt.authorize('run_command', { command: 'ls' });
    assert.strictEqual(p4.ok, false, 'non-interactive default mode must deny commands');
    const p5 = await dflt.authorize('edit_file', { path: 'x', old_string: 'a', new_string: 'b' });
    assert.strictEqual(p5.ok, false);
    const ae = new Permissions({ mode: 'acceptEdits', interactive: false });
    assert.strictEqual((await ae.authorize('edit_file', { path: 'x', old_string: 'a', new_string: 'b' })).ok, true);
    assert.strictEqual((await ae.authorize('run_command', { command: 'ls' })).ok, false);
  });

  await test('mock server streams tool calls and final answer (e2e via CLI)', () => {
    const dir = tmpProject('e2e');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'e2e' }));
    const r = spawnSync(
      process.execPath,
      [BIN, '--mock', '--full-auto', '-p', 'add authentication to this application'],
      { cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env, FORCE_COLOR: '0' } }
    );
    assert.strictEqual(r.status, 0, `exit ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    const authPath = path.join(dir, 'src', 'auth.js');
    assert.ok(fs.existsSync(authPath), 'agent should create src/auth.js');
    const content = fs.readFileSync(authPath, 'utf8');
    assert.ok(content.includes('register') && content.includes('verify'));
    assert.ok(r.stdout.includes('PASS'), 'smoke test output should be visible');
    assert.ok(/Done\./.test(r.stdout), 'final summary should be printed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('login flow: device auth stores credentials; whoami/logout work', () => {
    const dir = tmpProject('login');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-home-'));
    const env = { ...process.env, HOME: home, FORCE_COLOR: '0' };
    delete env.ARENA_API_KEY;

    // 1. arena --mock login → device flow auto-approves, auth.json created
    const login = spawnSync(process.execPath, [BIN, '--mock', 'login'], {
      cwd: dir, env, encoding: 'utf8', timeout: 60000,
    });
    assert.strictEqual(login.status, 0, `login exit ${login.status}\n${login.stdout}\n${login.stderr}`);
    assert.ok(/sign in to arena ai/i.test(login.stdout), 'should show sign-in instructions');
    assert.ok(/ARENA-[A-Z0-9]+/.test(login.stdout), 'should show a user code');
    const authFile = path.join(home, '.arena-agent', 'auth.json');
    assert.ok(fs.existsSync(authFile), 'auth.json must be created');
    const creds = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.ok(creds.accessToken, 'access token stored');
    assert.ok(creds.endpoint, 'endpoint recorded');
    assert.ok(/signed in/i.test(login.stdout), 'should confirm sign-in');

    // 2. whoami shows the connected account
    const who = spawnSync(process.execPath, [BIN, '--mock', 'whoami'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(who.status, 0);
    assert.ok(who.stdout.includes('dev@arena.ai'), 'account email shown');

    // 3. the stored login token is enough to run the agent (no env key anywhere)
    const run = spawnSync(process.execPath, [BIN, '--mock', '--full-auto', '-p', 'add authentication'], {
      cwd: dir, env, encoding: 'utf8', timeout: 90000,
    });
    assert.strictEqual(run.status, 0, `run exit ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'auth.js')), 'agent ran using the login token');

    // 4. logout removes credentials; agent then shows sign-in guidance
    const out = spawnSync(process.execPath, [BIN, 'logout'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(out.status, 0);
    assert.ok(!fs.existsSync(authFile), 'auth.json removed');
    const after = spawnSync(process.execPath, [BIN, '-p', 'hi'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(after.status, 2);
    assert.ok(/arena login/.test(after.stdout), 'signed-out box points at arena login');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  await test('CLI help and version work', () => {
    const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.strictEqual(h.status, 0);
    assert.ok(h.stdout.includes('arena'));
    const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.strictEqual(v.status, 0);
    assert.ok(/arena v\d/.test(v.stdout));
  });

  await test('sessions persist and resume', () => {
    const dir = tmpProject('sess');
    const { SessionStore } = require('../src/session');
    const store = new SessionStore(dir);
    const s = store.newSession({ model: 'arena-agent', mode: 'default' });
    s.messages.push({ role: 'user', content: 'hello world' });
    store.save(s);
    const loaded = store.load(s.id);
    assert.ok(loaded && loaded.messages.length === 1);
    const latest = store.latest();
    assert.strictEqual(latest.id, s.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
