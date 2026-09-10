// Fork-only qualification. No app source, dependencies, inference flags, or weights are modified.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { app } = require("electron");
const manifest = require("./orukeet-optimized-manifest.json");

assert(app, "Run with the app's Electron dependency");
const outputDir = path.resolve("qa-artifacts");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "comparison.json");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-optimized-qa-"));
app.setPath("userData", profile);
app.setPath("home", profile);
process.env.OPENWHISPR_CACHE_ROOT = path.join(profile, "cache");
const expectedArchIndex = process.argv.indexOf("--expected-arch");
const result = {
  status: "running",
  started_utc: new Date().toISOString(),
  source_commit: cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  arch: process.arch,
  system_version: process.getSystemVersion?.(),
  cpu: os.cpus()[0]?.model,
  logical_cpus: os.cpus().length,
  electron: process.versions.electron,
  node: process.versions.node,
  scope:
    "Anonymous public downloads and actual ParakeetManager under Electron with stock sherpa-onnx. Main-process lifecycle and inference, without microphone or UI simulation.",
  timing_method:
    "One resident model per block; three measured warm repeats after an excluded warmup; artifact order alternates by clip length; actual production thread selection is unchanged.",
  artifacts: {},
  spawns: [],
  timings: [],
  comparisons: [],
};
const save = () => fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
const hashBuffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
async function hashFile(filename) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

// Observe the actual launch arguments without changing any of them.
const originalSpawn = cp.spawn;
cp.spawn = function observedSpawn(binary, args, options) {
  const child = originalSpawn.call(this, binary, args, options);
  if (path.basename(binary).startsWith("sherpa-onnx-ws-")) {
    result.spawns.push({ binary: path.basename(binary), args, pid: child.pid });
    save();
  }
  return child;
};

const registry = require("../../src/models/modelRegistryData.json");
const optimizedId = "orukeet-v0.1.0-q8";
const baselineId = "orukeet-baseline-qa";
// The QA-only alias lets the unchanged downloader install both artifacts separately.
registry.parakeetModels[baselineId] = {
  ...registry.parakeetModels[optimizedId],
  downloadUrl: manifest.baseline.url,
  extractDir: manifest.baseline.extractDir,
  expectedSizeBytes: manifest.baseline.bytes,
};
const Manager = require("../../src/helpers/parakeet");
const info = require("../../src/helpers/parakeetModelInfo");
const manager = new Manager();
const ids = { baseline: baselineId, optimized: optimizedId };

function check(label, message) {
  result.artifacts[label].checks.push(message);
  console.log(`${label}: ${message}`);
  save();
}

function prefixWav(audio, seconds) {
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  let pcm;
  let format;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    assert(end <= audio.length, "Truncated WAV chunk");
    const name = audio.toString("ascii", offset, offset + 4);
    if (name === "fmt ") format = audio.subarray(offset + 8, end);
    if (name === "data") pcm = audio.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  assert(format && pcm, "WAV must contain format and samples");
  assert.equal(format.readUInt16LE(0), 1);
  assert.equal(format.readUInt16LE(2), 1);
  assert.equal(format.readUInt32LE(4), 16000);
  assert.equal(format.readUInt16LE(14), 16);
  const length = Math.min(pcm.length, Math.floor(seconds * 16000) * 2);
  const output = Buffer.alloc(44 + length);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + length, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  format.copy(output, 20, 0, 16);
  output.write("data", 36);
  output.writeUInt32LE(length, 40);
  pcm.copy(output, 44, 0, length);
  return { audio: output, seconds: length / 32000 };
}

async function transcribe(label, audio) {
  const start = performance.now();
  const response = await manager.transcribeLocalParakeet(audio, { model: ids[label] });
  const ms = performance.now() - start;
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.warning, undefined, JSON.stringify(response));
  return { ms, text: response.text };
}

async function stop() {
  await manager.stopServer();
  assert.equal(manager.serverManager.wsServer.process, null);
}

async function qualify(label, audio) {
  const release = manifest[label];
  const id = ids[label];
  const receipt = { model: id, release, checks: [], calls: [] };
  result.artifacts[label] = receipt;
  assert.equal(info.getModelRuntime(id), "offline");
  assert.equal(info.getSherpaModelType(id), "nemo_transducer");
  check(label, "registry selects the existing offline NeMo runtime");
  const extract = manager._extractModel;
  manager._extractModel = async function verifiedExtract(archivePath, modelName) {
    receipt.archive = {
      bytes: fs.statSync(archivePath).size,
      sha256: await hashFile(archivePath),
    };
    save();
    assert.equal(receipt.archive.bytes, release.bytes);
    assert.equal(receipt.archive.sha256, release.sha256);
    return extract.call(this, archivePath, modelName);
  };
  let installed;
  try {
    const start = performance.now();
    installed = await manager.downloadParakeetModel(id);
    receipt.download_extract_and_archive_verification_ms = performance.now() - start;
  } finally {
    manager._extractModel = extract;
  }
  assert.equal(installed.success, true);
  check(label, "anonymous archive download and production extraction succeed");
  const loaded = await manager.startServer(id);
  assert.equal(loaded.success, true, loaded.reason);
  receipt.files = {};
  for (const file of info.getRequiredModelFiles(id)) {
    const filename = path.join(installed.path, file);
    receipt.files[file] = { bytes: fs.statSync(filename).size, sha256: await hashFile(filename) };
    assert.equal(receipt.files[file].sha256, release.files[file], file);
  }
  check(label, "all graphs and tokens match the release manifest");
  const child = manager.serverManager.wsServer.process;
  const warmed = await transcribe(label, audio);
  assert.match(warmed.text.toLowerCase(), /ask not what your country/);
  const repeated = [];
  for (let index = 0; index < 3; index++) {
    const call = await transcribe(label, audio);
    repeated.push(call.text);
    receipt.calls.push({ kind: "repeat", ...call });
  }
  assert.equal(new Set(repeated).size, 1);
  assert.equal(manager.serverManager.wsServer.process, child);
  check(label, "repeated transcription reuses one process");
  const concurrent = await Promise.all([transcribe(label, audio), transcribe(label, audio)]);
  assert.equal(concurrent[0].text, repeated[0]);
  assert.equal(concurrent[1].text, repeated[0]);
  receipt.calls.push(...concurrent.map((call) => ({ kind: "concurrent", ...call })));
  check(label, "concurrent requests preserve the transcript");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    manager.transcribeLocalParakeet(audio, { model: id, signal: aborted.signal }),
    { name: "AbortError" }
  );
  check(label, "already-cancelled requests reject");
  const cancelling = new AbortController();
  const active = manager.transcribeLocalParakeet(audio, { model: id, signal: cancelling.signal });
  const timer = setTimeout(() => cancelling.abort(), 20);
  try {
    await assert.rejects(active, { name: "AbortError" });
  } finally {
    clearTimeout(timer);
  }
  const recovered = await transcribe(label, audio);
  assert.equal(recovered.text, repeated[0]);
  receipt.calls.push({ kind: "after-cancel", ...recovered });
  check(label, "in-flight cancellation and the next decode recover");
  await stop();
  const restarted = await transcribe(label, audio);
  assert.equal(restarted.text, repeated[0]);
  assert.notEqual(manager.serverManager.wsServer.process, child);
  receipt.calls.push({ kind: "after-restart", ...restarted });
  check(label, "shutdown and restart recover");
  await stop();
  assert.equal(receipt.checks.length, 8);
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function compare(audio) {
  const clips = [1.5, 3, 6, Infinity].map((seconds) => prefixWav(audio, seconds));
  for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
    const clip = clips[clipIndex];
    const order = clipIndex % 2 === 0 ? ["baseline", "optimized"] : ["optimized", "baseline"];
    const rows = {};
    for (const label of order) {
      const loaded = await manager.startServer(ids[label]);
      assert.equal(loaded.success, true, loaded.reason);
      await transcribe(label, clip.audio);
      const child = manager.serverManager.wsServer.process;
      const calls = [];
      for (let repeat = 0; repeat < 3; repeat++) calls.push(await transcribe(label, clip.audio));
      assert.equal(manager.serverManager.wsServer.process, child);
      assert.equal(new Set(calls.map((call) => call.text)).size, 1);
      rows[label] = { calls, median_ms: median(calls.map((call) => call.ms)) };
      result.timings.push({ label, seconds: clip.seconds, order, ...rows[label] });
      save();
      await stop();
    }
    assert.equal(rows.optimized.calls[0].text, rows.baseline.calls[0].text);
    result.comparisons.push({
      seconds: clip.seconds,
      input_sha256: hashBuffer(clip.audio),
      exact_transcript_match: true,
      text: rows.baseline.calls[0].text,
      baseline_median_ms: rows.baseline.median_ms,
      optimized_median_ms: rows.optimized.median_ms,
      speedup: rows.baseline.median_ms / rows.optimized.median_ms,
      latency_reduction_percent: (1 - rows.optimized.median_ms / rows.baseline.median_ms) * 100,
    });
    save();
  }
}

(async () => {
  await app.whenReady();
  const hardTimeout = setTimeout(
    () => {
      result.status = "failed";
      result.error = "Qualification exceeded the 25-minute execution budget";
      save();
      manager.stopServer().finally(() => app.exit(1));
      setTimeout(() => app.exit(1), 5000);
    },
    25 * 60 * 1000
  );
  try {
    assert(manifest.optimized, "Optimized release URL and hashes are not pinned yet");
    assert.equal(process.arch, process.argv[expectedArchIndex + 1]);
    for (const release of [manifest.baseline, manifest.optimized]) {
      assert.match(
        release.url,
        /^https:\/\/huggingface\.co\/oruk\/orukeet\/resolve\/[a-f0-9]{40}\//
      );
      assert.match(release.sha256, /^[a-f0-9]{64}$/);
      assert(Number.isSafeInteger(release.bytes) && release.bytes > 0);
    }
    assert.equal(registry.parakeetModels[optimizedId].downloadUrl, manifest.optimized.url);
    assert.equal(registry.parakeetModels[optimizedId].expectedSizeBytes, manifest.optimized.bytes);
    assert.equal(registry.parakeetModels[optimizedId].extractDir, manifest.optimized.extractDir);
    result.package_lock_sha256 = await hashFile("package-lock.json");
    const binary = manager.serverManager.getBinaryPath("offline");
    assert(binary, "Bundled stock sherpa binary is missing");
    result.binary = { filename: path.basename(binary), sha256: await hashFile(binary) };
    const response = await fetch(manifest.fixture.url);
    assert(response.ok, `Fixture download: ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    assert.equal(hashBuffer(audio), manifest.fixture.sha256);
    result.fixture = manifest.fixture;
    fs.writeFileSync(path.join(outputDir, "jfk.wav"), audio);
    for (const label of ["baseline", "optimized"]) await qualify(label, audio);
    await compare(audio);
    const threadCounts = result.spawns.map(({ args }) =>
      Number(args.find((arg) => arg.startsWith("--num-threads=")).split("=")[1])
    );
    assert.equal(new Set(threadCounts).size, 1);
    result.production_num_threads = threadCounts[0];
    assert.equal(threadCounts[0], Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75))));
    for (const { args } of result.spawns) {
      assert(args.includes("--model-type=nemo_transducer"));
      assert(!args.some((arg) => arg.startsWith("--provider=")));
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.stack;
    console.error(error);
  } finally {
    clearTimeout(hardTimeout);
    await stop().catch((error) => {
      result.status = "failed";
      result.shutdown_error = error.stack;
    });
    result.finished_utc = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: result.status, comparisons: result.comparisons }));
    app.exit(result.status === "passed" ? 0 : 1);
  }
})();
