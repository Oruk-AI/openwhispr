// Fork-only qualification. Application/inference sources are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
assert.equal(process.platform, 'win32');
const repo = process.cwd();
const evidence = path.join(repo, 'windows-diagnostic');
fs.mkdirSync(evidence, { recursive: true });
const system32 = path.join(process.env.SystemRoot, 'System32');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const systemTar = path.join(system32, 'tar.exe');
const gitTar = path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'tar.exe');
const result = { started_utc: new Date().toISOString(), stages: [], status: 'running' };

function processTree(pid) {
  const command = `$all = @(Get-CimInstance Win32_Process); $ids = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${pid}); do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Depth 5 -Compress`;
  const scan = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  try { return JSON.parse(scan.stdout); } catch { return { error: String(scan.error || scan.stderr), status: scan.status }; }
}

async function bounded(label, executable, args, timeoutMs = 100000, cwd = repo, env = process.env) {
  const stdoutPath = path.join(evidence, label + '.stdout.txt');
  const stderrPath = path.join(evidence, label + '.stderr.txt');
  fs.writeFileSync(stdoutPath, ''); fs.writeFileSync(stderrPath, '');
  const stage = { label, executable, arguments: args, cwd, started_utc: new Date().toISOString(), timed_out: false };
  const start = Date.now();
  console.log('Starting', label, executable, JSON.stringify(args), 'limit', timeoutMs);
  await new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    stage.pid = child.pid;
    console.log('Diagnostic child PID', child.pid);
    let finished = false;
    let afterKill = null;
    const finish = (code, error) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(afterKill);
      stage.exit_code = code;
      if (error) stage.error = String(error);
      resolve();
    };
    child.stdout.on('data', data => fs.appendFileSync(stdoutPath, data));
    child.stderr.on('data', data => fs.appendFileSync(stderrPath, data));
    child.on('error', error => finish(null, error));
    child.on('close', code => finish(code));
    const timer = setTimeout(() => {
      stage.timed_out = true;
      console.log('Timeout reached for', label, 'PID', child.pid, '; recording only its descendants');
      stage.processes_on_timeout = processTree(child.pid);
      fs.writeFileSync(path.join(evidence, label + '.processes.json'), JSON.stringify(stage.processes_on_timeout, null, 2));
      console.log(JSON.stringify(stage.processes_on_timeout, null, 2));
      const killed = spawnSync(path.join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      stage.kill_output = killed.stdout + killed.stderr;
      console.log(stage.kill_output);
      afterKill = setTimeout(() => finish(null, 'Child close event did not arrive after bounded tree termination'), 5000);
    }, timeoutMs);
  });
  stage.elapsed_seconds = (Date.now() - start) / 1000;
  result.stages.push(stage);
  console.log(JSON.stringify(stage, null, 2));
  for (const log of [stdoutPath, stderrPath]) console.log(path.basename(log), fs.readFileSync(log, 'utf8').slice(-3000));
  return stage;
}

(async () => {
  try {
    const inventory = spawnSync(path.join(system32, 'where.exe'), ['tar'], { encoding: 'utf8', timeout: 10000 });
    console.log('where.exe tar:', inventory.stdout, inventory.stderr);
    result.tar_paths = inventory.stdout.trim().split(/\r?\n/);
    const candidates = [...new Set([...result.tar_paths, systemTar, gitTar])];
    for (let i = 0; i < candidates.length; i++) if (fs.existsSync(candidates[i])) await bounded('tar-version-' + i, candidates[i], ['--version'], 5000);
    // npm-cli runs the exact existing package script, avoiding an extra shell wrapper.
    const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    assert(fs.existsSync(npm), npm);
    const original = await bounded('original-npm-download', process.execPath, [npm, 'run', 'download:sherpa-onnx']);
    let installed = !original.timed_out && original.exit_code === 0;
    if (!installed) {
      const archive = 'sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2';
      const binDir = path.join(repo, 'resources', 'bin');
      const archivePath = path.join(binDir, archive);
      assert(fs.existsSync(archivePath), 'Original attempt left no archive');
      result.archive = { bytes: fs.statSync(archivePath).size, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex') };
      for (const [name, executable] of [['system32', systemTar], ['git', gitTar]]) {
        if (!fs.existsSync(executable)) continue;
        const dest = 'diagnostic-extract-' + name;
        fs.mkdirSync(path.join(binDir, dest), { recursive: true });
        const direct = await bounded('direct-' + name + '-extract', executable, ['-xjf', archive, '-C', dest], 60000, binDir);
        if (direct.timed_out || direct.exit_code !== 0) continue;
        const prefix = path.dirname(executable);
        const environment = { ...process.env };
        const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path');
        environment[pathKey] = prefix + ';' + environment[pathKey];
        const retry = await bounded('download-with-' + name, process.execPath, ['scripts/download-sherpa-onnx.js', '--current'], 120000, repo, environment);
        if (!retry.timed_out && retry.exit_code === 0) {
          installed = true;
          result.selected_path_prefix = prefix;
          fs.appendFileSync(process.env.GITHUB_PATH, prefix + '\n');
          break;
        }
      }
    }
    assert(installed, 'Stock runtime did not install within bounded attempts');
    result.install_marker = JSON.parse(fs.readFileSync(path.join(repo, 'resources', 'bin', '.sherpa-onnx-win32-x64.json'), 'utf8'));
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = error.stack; console.error(error);
  } finally {
    result.finished_utc = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  }
  process.exitCode = result.status === 'passed' ? 0 : 1;
})();
