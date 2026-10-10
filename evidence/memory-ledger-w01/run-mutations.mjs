/** Deferred W01 mutation proof. This script has not been executed by its author. */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--candidate' || args[2] !== '--run') {
  console.error('Usage: node run-mutations.mjs --candidate <absolute-worktree> --run');
  process.exitCode = 2;
} else {
  run(path.resolve(args[1]));
}

function run(candidate) {
  const sources = [
    'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
    'shared', 'server/memory', 'tests/memory-ledger.test.ts',
    'tests/memory-store-recovery.test.ts', 'tests/fixtures/memory-ledger',
  ];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const bytes = new Map();
  const manifest = [];
  let size = 0;
  const collect = relative => {
    const absolute = path.join(candidate, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Source reparse/symlink refused: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) collect(`${relative}/${name}`);
    } else if (stat.isFile()) {
      if (stat.size > 8 * 1024 * 1024) throw new Error(`Source file too large: ${relative}`);
      const content = readFileSync(absolute);
      size += content.length;
      if (size > 32 * 1024 * 1024 || manifest.length >= 1000) throw new Error('Source copy bound exceeded.');
      bytes.set(relative, content);
      manifest.push({ path: relative, bytes: content.length, sha256: sha(content) });
    } else throw new Error(`Non-regular source refused: ${relative}`);
  };
  let root;
  const summary = { status: 'SETUP_INCOMPLETE', candidate, runs: [], mutationProofs: [] };
  try {
    if (!path.isAbsolute(args[1])) throw new Error('Candidate must be an absolute worktree path.');
    for (const source of sources) collect(source);
    const modules = realpathSync(path.join(candidate, 'node_modules'));
    const cli = path.join(modules, 'vitest', 'vitest.mjs');
    if (!existsSync(cli)) throw new Error('Installed Vitest is missing; installation is prohibited.');
    const dependencyFiles = ['vitest/package.json', 'tsx/package.json', 'zod/package.json'];
    const dependencies = dependencyFiles.map(relative => {
      const content = readFileSync(path.join(modules, relative));
      return { path: relative, sha256: sha(content), version: JSON.parse(content).version };
    });
    root = mkdtempSync(path.join(os.tmpdir(), 'nectovia-memory-w01-mutants-'));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith('nectovia-memory-w01-mutants-')) throw new Error('Invalid owned root.');
    console.log(`Preserved mutation evidence: ${root}`);
    json(path.join(root, 'OWNER.json'), {
      purpose: 'W01 disposable mutation copies; never delete through node_modules links',
      root, candidate, createdAt: new Date().toISOString(), pid: process.pid,
    });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (head.status !== 0 || head.error) throw new Error(`Cannot capture Git identity: ${head.stderr}`);
    json(path.join(root, 'source-manifest.json'), {
      head: head.stdout.trim(), files: manifest, sources, dependencies, dependencyDirectory: modules,
      runtime: { executable: process.execPath, versions: process.versions, platform: process.platform, arch: process.arch },
    });
    const createCopy = name => {
      const destination = path.join(root, name);
      mkdirSync(destination);
      for (const [relative, content] of bytes) {
        const file = path.join(destination, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      // The runner never removes copies or links. Shared dependencies are never copied/deleted.
      symlinkSync(modules, path.join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(path.join(destination, 'mutation.vitest.config.mjs'),
        `import base from './vitest.config.ts';\nexport default { ...base, cacheDir: ${JSON.stringify(path.join(destination, '.vite-local'))}, test: { ...base.test, cache: false } };\n`);
      return destination;
    };
    const targetNames = {
      scope: 'rejects a payload whose tenantId differs from the host scope without partial writes',
      cas: 'M28 refuses a stale expected revision instead of silently overwriting the winner',
      atomic: 'M30 injected after-entry failure exposes no partial revision, event or command receipt after reopen',
    };
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const execute = (name, directory, names) => {
      const outputFile = path.join(root, `${name}.vitest.json`);
      const command = [cli, 'run', '--config', 'mutation.vitest.config.mjs',
        'tests/memory-ledger.test.ts', 'tests/memory-store-recovery.test.ts',
        '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', '--no-cache',
        '--reporter=default', '--reporter=json', `--outputFile.json=${outputFile}`,
        '--testNamePattern', names.map(escape).join('|')];
      json(path.join(root, `${name}.invocation.json`), { executable: process.execPath, args: command, cwd: directory, timeoutMs: 60_000 });
      const result = spawnSync(process.execPath, command, {
        cwd: directory, windowsHide: true, timeout: 60_000, killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      writeFileSync(path.join(root, `${name}.stdout.log`), result.stdout ?? '');
      writeFileSync(path.join(root, `${name}.stderr.log`), result.stderr ?? '');
      const runResult = { name, status: result.status, signal: result.signal,
        error: result.error?.stack ?? null, report: outputFile };
      summary.runs.push(runResult);
      if (result.error || result.signal || !existsSync(outputFile)) throw new Error(`${name}: runtime/setup failure, not RED proof.`);
      const report = JSON.parse(readFileSync(outputFile, 'utf8'));
      const assertions = (report.testResults ?? []).flatMap(suite => suite.assertionResults ?? []);
      const selected = assertions.filter(assertion => names.some(title => assertion.title === title || assertion.fullName?.endsWith(title)));
      if (selected.length !== names.length || (report.numRuntimeErrorTestSuites ?? 0) !== 0)
        throw new Error(`${name}: missing/duplicate target or runtime-error suite, not RED proof.`);
      const unexpected = assertions.filter(assertion => assertion.status === 'failed' && !selected.includes(assertion));
      if (unexpected.length) throw new Error(`${name}: unrelated failures, not RED proof.`);
      return { runResult, report, selected };
    };
    const replace = (directory, relative, original, replacement) => {
      const file = path.join(directory, relative);
      const content = readFileSync(file, 'utf8');
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      const old = original.replaceAll('\n', eol);
      const next = replacement.replaceAll('\n', eol);
      if (content.split(old).length !== 2) throw new Error(`Mutation anchor drift: ${relative}`);
      writeFileSync(file, content.replace(old, next));
    };
    const baseline = createCopy('baseline');
    const control = execute('baseline', baseline, Object.values(targetNames));
    if (control.runResult.status !== 0 || control.report.numFailedTests !== 0 ||
        control.selected.some(assertion => assertion.status !== 'passed')) {
      throw new Error('Baseline was not GREEN for all three exact assertions; mutations are not evidence.');
    }
    const specs = [
      {
        name: 'cross-tenant-admission', target: targetNames.scope, files: ['server/memory/service.ts', 'server/memory/local-store.ts'],
        failure: /to throw an error/,
        apply(directory) {
          replace(directory, 'server/memory/service.ts',
            "        if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId ||\n          record.scopeRef !== scope.scopeRef) throw new MemoryLedgerError('memory_not_found_or_forbidden');",
            '        // MUTANT: payload identity is incorrectly trusted.');
          replace(directory, 'server/memory/local-store.ts',
            "            if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId || record.scopeRef !== scope.scopeRef)\n              fail('memory_not_found_or_forbidden');",
            '            // MUTANT: transaction insertion omits payload scope binding.');
          replace(directory, 'server/memory/local-store.ts',
            "      if (record.tenantId !== scope.tenantId || record.workspaceId !== scope.workspaceId || record.scopeRef !== scope.scopeRef)\n        fail('memory_not_found_or_forbidden');",
            '      // MUTANT: immutable insertion also omits payload scope binding.');
        },
      },
      {
        name: 'blind-stale-rebase', target: targetNames.cas, files: ['server/memory/service.ts'], failure: /to throw an error/,
        apply(directory) {
          replace(directory, 'server/memory/service.ts',
            '    const fingerprint = memoryCommandFingerprint(scope, command);',
            '    let fingerprint = memoryCommandFingerprint(scope, command);');
          replace(directory, 'server/memory/service.ts',
            "      if ((previous?.revision ?? 0) !== command.expectedRevision ||\n        subject.revision !== command.expectedRevision + 1) throw new MemoryLedgerError('revision_conflict');",
            '      // MUTANT: silently rebase a stale writer onto the latest revision.\n      command.expectedRevision = previous?.revision ?? 0;\n      subject.revision = command.expectedRevision + 1;\n      fingerprint = memoryCommandFingerprint(scope, command);');
        },
      },
      {
        name: 'commit-interrupted-entry', target: targetNames.atomic, files: ['server/memory/local-store.ts'], failure: /to deeply equal/,
        apply(directory) {
          replace(directory, 'server/memory/local-store.ts',
            "      try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }",
            "      try { if (this.db.isTransaction) this.db.exec('COMMIT'); } // MUTANT: preserve partial state on failure.");
        },
      },
    ];
    for (const spec of specs) {
      const directory = createCopy(spec.name);
      spec.apply(directory);
      const changes = [];
      let patch = '';
      for (const relative of spec.files) {
        const original = path.join(baseline, relative);
        const mutant = path.join(directory, relative);
        const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', original, mutant],
          { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
        if (diff.error || diff.status !== 1) throw new Error(`${spec.name}: could not preserve exact mutation diff.`);
        patch += diff.stdout;
        changes.push({ path: relative, before: sha(readFileSync(original)), after: sha(readFileSync(mutant)) });
      }
      writeFileSync(path.join(root, `${spec.name}.patch`), patch);
      json(path.join(root, `${spec.name}.changes.json`), changes);
      const result = execute(spec.name, directory, [spec.target]);
      const assertion = result.selected[0];
      const failure = (assertion.failureMessages ?? []).join('\n');
      const accepted = result.runResult.status === 1 && result.report.numFailedTests === 1 &&
        assertion.status === 'failed' && /AssertionError/.test(failure) && spec.failure.test(failure);
      summary.mutationProofs.push({ name: spec.name, target: spec.target, accepted, failureMessages: assertion.failureMessages });
      if (!accepted) throw new Error(`${spec.name}: failure was not the required behavior assertion; RED unproven.`);
    }
    for (const file of manifest) {
      if (sha(readFileSync(path.join(candidate, file.path))) !== file.sha256) throw new Error(`Candidate drift: ${file.path}`);
    }
    for (const dependency of dependencies) {
      if (sha(readFileSync(path.join(modules, dependency.path))) !== dependency.sha256) throw new Error(`Dependency drift: ${dependency.path}`);
    }
    summary.status = 'THREE_TARGETED_MUTANTS_KILLED';
    summary.limit = 'Bounded mutation sensitivity only; not full W01, typecheck, packaged runtime or release acceptance.';
  } catch (error) {
    summary.status = 'PROOF_INCOMPLETE';
    summary.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
    console.error(summary.error);
  } finally {
    if (root) {
      json(path.join(root, 'summary.json'), summary);
      // Keep the runner itself beside raw logs so the exact procedure remains reviewable.
      copyFileSync(new URL(import.meta.url), path.join(root, 'executed-runner.mjs'));
      console.log(`Result: ${summary.status}. No isolated copies or dependency links were removed.`);
    }
  }
}
