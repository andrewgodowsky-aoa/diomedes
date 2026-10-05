import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

// Independent of GitHub release metadata. Windows must validate the signature
// chain AND its verified publisher identity. Short-lived signing certificates
// rotate, so pin the reviewed organization identity rather than one certificate.
const publisher = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US';
const execute = promisify(execFile);
const unavailable = 'Codex publisher signature could not be verified';
// One Windows PowerShell process reads every file of a set: each launch is a
// process an antivirus behaviour monitor may inspect, so a package's binaries
// share one. The answer is positional, one entry per requested file.
async function windowsSignatures(files) {
  if (process.platform !== 'win32') throw new Error('Codex publisher verification requires Windows.');
  const literals = files.map(file => "'" + path.resolve(file).replace(/'/g, "''") + "'");
  const script = "$ErrorActionPreference='Stop'\n" +
    '$signatures=@(foreach ($file in @(' + literals.join(',') + ')) {\n' +
    '$signature=Get-AuthenticodeSignature -LiteralPath $file\n' +
    '@{status=[string]$signature.Status;subject=$signature.SignerCertificate.Subject} })\n' +
    'ConvertTo-Json -InputObject $signatures -Compress';
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  // Do not inherit PowerShell 7 or user module search paths into Windows PowerShell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.join(powershell, 'Modules');
  let stdout;
  try {
    ({ stdout } = await execute(path.join(powershell, 'powershell.exe'),
      // Plain -Command text: Norton Behavior Shield flags -NonInteractive with
      // -EncodedCommand as IDP.HELU.PSE91 on every launch, and the same script as
      // -Command drew nothing (DIO-202, 2026-10-04 A/B). The script holds no
      // double quote, so the argument survives Windows command-line quoting.
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', script.replace(/\n/g, '; ')],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 16_384 }));
  } catch (cause) {
    // A stopped, blocked or timed-out check is not a verdict on the file. Say
    // which it was, so it is never mistaken for an invalid signature.
    const how = cause?.killed ? 'was stopped' + (cause.signal ? ' (' + cause.signal + ')' : '')
      : typeof cause?.code === 'number' ? 'exited with code ' + cause.code : 'could not run' + (cause?.code ? ' (' + cause.code + ')' : '');
    throw new Error(unavailable + ': Windows PowerShell ' + how + '.', { cause });
  }
  try {
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch (cause) {
    throw new Error(unavailable + ': Windows PowerShell returned no readable answer.', { cause });
  }
}

function requireReviewedPublisher(signature, file) {
  if (signature?.status !== 'Valid' || signature.subject !== publisher)
    throw new Error('Codex publisher signature is not valid for the reviewed OpenAI identity: ' + path.basename(file));
}

/** Verifies every file with one signature read; refuses unless each is Valid and from the reviewed publisher. */
export async function verifyNativePublishers(files, readSignatures = windowsSignatures) {
  if (files.length === 0) return;
  const signatures = await readSignatures(files);
  if (!Array.isArray(signatures) || signatures.length !== files.length)
    throw new Error(unavailable + ': expected ' + files.length + ' signature results.');
  files.forEach((file, index) => requireReviewedPublisher(signatures[index], file));
}

export async function verifyNativePublisher(file, readSignature = async one => (await windowsSignatures([one]))[0]) {
  requireReviewedPublisher(await readSignature(file), file);
}
