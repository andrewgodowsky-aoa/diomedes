import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

// Independent of GitHub release metadata. Windows must validate the signature
// chain AND its verified publisher identity. Short-lived signing certificates
// rotate, so pin the reviewed organization identity rather than one certificate.
const publisher = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US';
const execute = promisify(execFile);
async function windowsSignature(file) {
  if (process.platform !== 'win32') throw new Error('Codex publisher verification requires Windows.');
  const literal = "'" + path.resolve(file).replace(/'/g, "''") + "'";
  const script = "$ErrorActionPreference='Stop'\n" +
    '$signature=Get-AuthenticodeSignature -LiteralPath ' + literal + '\n' +
    '@{status=[string]$signature.Status;subject=$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress';
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  // Do not inherit PowerShell 7 or user module search paths into Windows PowerShell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = path.join(powershell, 'Modules');
  try {
    const { stdout } = await execute(path.join(powershell, 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 16_384 });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch (cause) {
    throw new Error('Codex publisher signature could not be verified.', { cause });
  }
}

export async function verifyNativePublisher(file, readSignature = windowsSignature) {
  const signature = await readSignature(file);
  if (signature.status !== 'Valid' || signature.subject !== publisher)
    throw new Error('Codex publisher signature is not valid for the reviewed OpenAI identity: ' + path.basename(file));
}
