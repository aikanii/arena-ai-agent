'use strict';

/**
 * Zero-dependency smoke tests: unit checks for the tricky bits plus a full
 * end-to-end run of `arena -p` against the bundled mock model.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

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

/**
 * Spawn a Node child that prints "PORT=<n>" once its server is listening.
 * Needed because spawnSync blocks this process's event loop, so servers used
 * by spawnSync'd CLIs must live in their own process.
 */
function startChildServer(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('child server did not report a port within 10s'));
    }, 10000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), child });
      }
    });
    child.stderr.on('data', (d) => process.stderr.write('[child-server] ' + d));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('child server exited early: ' + code));
    });
  });
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

  await test('anthropic conversion: system, tool_use blocks, merged tool_results', () => {
    const { toAnthropicMessages, toAnthropicTools } = require('../src/providers');
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'let me see', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'FILE' },
      { role: 'tool', tool_call_id: 't2', name: 'x', content: 'Y' },
      { role: 'assistant', content: 'done' },
    ]);
    assert.strictEqual(system, 'SYS');
    assert.deepStrictEqual(messages[0], { role: 'user', content: 'hi' });
    assert.strictEqual(messages[1].role, 'assistant');
    assert.deepStrictEqual(messages[1].content[1], { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } });
    // consecutive tool results merge into ONE user turn (Anthropic requirement)
    assert.strictEqual(messages[2].role, 'user');
    assert.strictEqual(messages[2].content.length, 2);
    assert.strictEqual(messages[2].content[0].tool_use_id, 't1');
    assert.strictEqual(messages[2].content[1].tool_use_id, 't2');
    const tools = toAnthropicTools([{ function: { name: 'read_file', description: 'd', parameters: { type: 'object' } } }]);
    assert.deepStrictEqual(tools[0], { name: 'read_file', description: 'd', input_schema: { type: 'object' } });
  });

  await test('anthropic e2e: agent loop over /v1/messages (mock gateway)', async () => {
    // Mock server runs as a CHILD process — spawnSync blocks this process's
    // event loop, so an in-process server could never answer.
    const script = `require(${JSON.stringify(path.join(ROOT, 'mock', 'server.js'))}).startMockServer(0).then(s => console.log('PORT=' + s.port));`;
    const srv = await startChildServer(script);
    const dir = tmpProject('anth');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'e2e-anth' }));
    const env = { ...process.env, FORCE_COLOR: '0', ARENA_BASE_URL: `http://127.0.0.1:${srv.port}`, ARENA_PROVIDER: 'anthropic', ARENA_API_KEY: 'mock-key' };
    try {
      const r = spawnSync(process.execPath, [BIN, '--full-auto', '-p', 'add authentication'], {
        cwd: dir, env, encoding: 'utf8', timeout: 90000,
      });
      assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.ok(fs.existsSync(path.join(dir, 'src', 'auth.js')), 'agent should create src/auth.js over the Anthropic protocol');
      assert.ok(/Done\./.test(r.stdout), 'final summary printed');
      assert.ok(r.stdout.includes('PASS'), 'verification output visible');
    } finally {
      srv.child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('login falls back to API-key paste when device flow is unavailable (405)', async () => {
    // Mini "gateway" (child process): rejects device flow, accepts message pings.
    const script = `
      const http = require('http');
      const srv = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/oauth/device/code') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/messages') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
      srv.listen(0, '127.0.0.1', () => console.log('PORT=' + srv.address().port));
    `;
    const srv = await startChildServer(script);
    try {
      const dir = tmpProject('tokenlogin');
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-home-tok-'));
      const env = { ...process.env, HOME: home, FORCE_COLOR: '0' };
      delete env.ARENA_API_KEY;

      const r = spawnSync(
        process.execPath,
        [BIN, 'login', '--base-url', `http://127.0.0.1:${srv.port}`, '--provider', 'anthropic', '--no-browser'],
        { cwd: dir, env, encoding: 'utf8', timeout: 60000, input: 'sk-arena-test-123\n' }
      );
      assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
      assert.ok(/falling back|api key sign-in/i.test(r.stdout), 'should announce the fallback');
      const creds = JSON.parse(fs.readFileSync(path.join(home, '.arena-agent', 'auth.json'), 'utf8'));
      assert.strictEqual(creds.accessToken, 'sk-arena-test-123');
      assert.strictEqual(creds.endpoint, `http://127.0.0.1:${srv.port}`);
      assert.ok(/signed in/i.test(r.stdout));

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    } finally {
      srv.child.kill();
    }
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
