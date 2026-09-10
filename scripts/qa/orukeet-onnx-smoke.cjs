// Fork-only CI qualification; run from the checked-out OpenWhispr repository.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const req = createRequire(path.join(process.cwd(), 'package.json'));
const { app } = req('electron');
assert(app, 'Run under Electron');
const options = {};
for (const name of ['audio', 'output', 'model']) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1) options[name] = process.argv[i + 1];
}
assert(options.audio && options.output);
const model = options.model || 'orukeet-v0.1.0-q8';
const expected = {
  'encoder.int8.onnx': 'd10711f1b8f3a516e2d7a93adb219caf8aba2b55295305db92f3e80e78c1499a',
  'decoder.int8.onnx': 'c185c2afb4c77c94bb1314807ecb3dc1623057a3dc540b83e10301af9bf4cfca',
  'joiner.int8.onnx': '1a7e90abf7172d926dd7e2edac2a5d5035c24dfb641a15e131d57b6a5f63cdd3',
  'tokens.txt': 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
};
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-sherpa-smoke-'));
app.setPath('userData', profile);
app.setPath('home', profile);
process.env.OPENWHISPR_CACHE_ROOT = path.join(profile, 'cache');
const Manager = req('./src/helpers/parakeet');
const info = req('./src/helpers/parakeetModelInfo');
const manager = new Manager();
const audio = fs.readFileSync(options.audio);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const result = {
  started_utc: new Date().toISOString(),
  scope: 'Real public model download, bundled sherpa-onnx binary and OpenWhispr ParakeetManager under Electron. Main-process lifecycle and inference; no microphone/UI simulation.',
  platform: process.platform,
  arch: process.arch,
  system_version: process.getSystemVersion?.(),
  cpu: os.cpus()[0].model,
  electron: process.versions.electron,
  node: process.versions.node,
  model,
  audio_sha256: sha(options.audio),
  checks: [],
  calls: [],
};
const check = (name) => { result.checks.push(name); console.log(name); };
async function transcribe(label) {
  const start = performance.now();
  const text = await manager.transcribeLocalParakeet(audio, { model });
  assert.equal(text.success, true);
  assert.match(text.text.toLowerCase(), /ask not what your country/);
  result.calls.push({ label, ms: performance.now() - start, text: text.text });
  return text.text;
}
(async () => {
  await app.whenReady();
  try {
    assert.equal(info.getModelRuntime(model), 'offline');
    check('registry selects existing offline runtime');
    const installed = await manager.downloadParakeetModel(model);
    assert.equal(installed.success, true);
    result.files = Object.fromEntries(info.getRequiredModelFiles(model).map(file => {
      const p = path.join(installed.path, file);
      return [file, { bytes: fs.statSync(p).size, sha256: sha(p) }];
    }));
    check('public archive downloads and extracts through production manager');
    for (const [file, hash] of Object.entries(expected)) assert.equal(result.files[file]?.sha256, hash, file);
    check('every installed graph and token file matches the release manifest');
    const t = performance.now();
    const loaded = await manager.startServer(model);
    assert.equal(loaded.success, true, loaded.reason);
    result.load_and_warm_ms = performance.now() - t;
    const child = manager.serverManager.wsServer.process;
    result.binary = manager.serverManager.getBinaryPath('offline');
    result.binary_sha256 = sha(result.binary);
    await transcribe('warmup');
    const repeated = [];
    for (let i = 0; i < 3; i++) repeated.push(await transcribe('repeat-' + i));
    assert.equal(new Set(repeated).size, 1);
    assert.equal(manager.serverManager.wsServer.process, child);
    check('repeat transcription reuses one process');
    const concurrent = await Promise.all([transcribe('concurrent-0'), transcribe('concurrent-1')]);
    assert.equal(concurrent[0], concurrent[1]);
    check('concurrent manager requests preserve transcript');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(manager.transcribeLocalParakeet(audio, { model, signal: abort.signal }), { name: 'AbortError' });
    check('already-cancelled request rejects');
    const cancelling = new AbortController();
    const active = manager.transcribeLocalParakeet(audio, { model, signal: cancelling.signal });
    setTimeout(() => cancelling.abort(), 20);
    await assert.rejects(active, { name: 'AbortError' });
    await transcribe('after-cancel');
    check('in-flight cancellation and next decode recover');
    await manager.stopServer();
    assert.equal(manager.serverManager.wsServer.process, null);
    await transcribe('after-restart');
    check('shutdown and restart recover');
    result.status = 'passed';
  } catch (e) { result.status = 'failed'; result.error = e.stack; }
  finally {
    await manager.stopServer();
    result.finished_utc = new Date().toISOString();
    fs.writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, output: options.output }));
    app.exit(result.status === 'passed' ? 0 : 1);
  }
})();
