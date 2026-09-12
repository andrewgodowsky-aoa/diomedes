# Code signing for Windows releases

Written 2026-09-12. Status: **nothing is signed yet.** Every published Diomedes build is
unsigned, the download page says so, and Windows SmartScreen and most antivirus heuristics
treat each new unsigned executable as unknown. This document says what signing buys, which
route is recommended, what Andrew has to do himself, and what the repository already
contains so that the first signed build is a configuration step rather than a project.

## Why this matters now

On 2026-09-12 Norton quarantined a Diomedes build on the development machine as
`IDP.Generic`. That detection is not a finding about the code. It is Norton's reputation
heuristic ("Identity Protection, generic") firing on an executable it has never seen, with
no publisher identity, that unpacks and launches other executables, which is exactly what an
unsigned Electron application inside an NSIS installer looks like. Every fresh build is a new
unknown file, so this will recur for users until two things change:

1. The binaries carry an Authenticode signature from a publicly trusted certificate, so the
   file has a publisher identity and reputation can accrue to that identity instead of to
   each new hash.
2. The specific files are submitted to the vendors as false positives (see the last section).

A SHA-256 on the download page proves integrity, not identity. It does nothing for
SmartScreen or antivirus.

## The three routes, as of September 2026

| Route | What it is | Cost | What Andrew must do | Reputation | Fit for Diomedes |
|---|---|---|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | Microsoft-run signing service. Keys live in Microsoft's HSM; certificates are short-lived and renewed automatically; signing is a `signtool` call with a dlib plug-in authenticated by an Azure identity. | Basic tier US$9.99 a month, up to 5,000 signatures. | Create an Azure subscription, an Artifact Signing account and a certificate profile; pass **identity validation** (individual developers in the US and Canada are eligible; organizations in the US, Canada, EU and UK). Validation takes days, not hours. | Certificate chains to Microsoft's public root. SmartScreen reputation builds with downloads the same way it does for OV/EV now (the instant-EV bypass ended in March 2024). | **Recommended.** Cheapest, no hardware token, no key on any machine, the repository's sign step already targets it. |
| **OV or EV certificate from a CA** (Sectigo, DigiCert, SSL.com, Certum) | A traditional code-signing certificate issued to a validated individual or organization. Since June 2023 the key must live on a hardware token or HSM; certificates issued after March 2026 are valid at most 460 days. | OV from about US$219 a year (Sectigo/Comodo); EV US$290 to US$685 a year. Token shipping extra unless a cloud HSM is used. | Buy, pass validation (OV: identity documents; EV: registered business), receive a USB token, install its driver, sign on that machine. | Same as above after the 2024 SmartScreen change; EV no longer skips the warning. EV is required only for kernel drivers. | Workable but more money and a physical token to protect. Choose it only if Azure identity validation is refused. |
| **SignPath Foundation** | Free signing for open-source projects; the certificate belongs to SignPath Foundation, so *they* are the publisher shown to users. | Free. | Apply; meet the terms: OSI licence for every component (Diomedes is Apache-2.0, which qualifies), binaries built from source "in a verifiable way" through their pipeline, each release manually approved, a code-signing policy published on the download page naming SignPath and the team roles, MFA on the repository and on SignPath. | Reputation accrues to SignPath Foundation's certificate. | Possible later. It makes the publisher line read "SignPath Foundation", it requires the build to move into their pipeline, and the bundled third-party engine binaries would need review against their no-proprietary-components rule. Not tonight's path. |

Sources checked 2026-09-12: Microsoft Learn (Artifact Signing quickstart, "Set up signing
integrations", "Code signing options for Windows app developers"), Azure pricing page for
Trusted Signing, signpath.org/terms.html, and 2026 CA price comparisons (sslinsights,
ssldragon, ssl.com). Prices change; recheck before paying.

## Recommendation

Use **Azure Artifact Signing**. Sign two files per release: `Diomedes.exe` inside the
packaged application before the installer is compiled, and the installer itself after. Keep
the product identity (`Diomedes.Experimental.8c27d61a-…`, marker
`.diomedes-experimental-20260909`) unchanged so a signed installer upgrades an unsigned
installation in place.

## What Andrew has to do (nothing here can be done by an agent)

1. **Azure subscription.** Sign in at portal.azure.com with the account that should own the
   signing identity. Pay-as-you-go is fine.
2. **Create an Artifact Signing account** (portal: "Artifact Signing" / "Trusted Signing
   accounts"). Choose a region near you (for example East US → endpoint
   `https://eus.codesigning.azure.net`). Note the account name and the endpoint; the
   certificate profile must be created in the same region or signing fails with 403.
3. **Identity validation.** Under the account, start an *individual* (or *organization*)
   identity validation. You will upload government identification and, for an organization,
   business registration. Expect a few business days. You are notified by email when it is
   `Completed`.
4. **Certificate profile.** Create a *Public Trust* certificate profile bound to that
   validated identity. Its name goes into `metadata.json`.
5. **Role assignment.** Give your own user the *Artifact Signing Certificate Profile Signer*
   role on the account (Access control → Add role assignment).
6. **On the build machine:**
   ```powershell
   winget install -e --id Microsoft.Azure.ArtifactSigningClientTools
   winget install -e --id Microsoft.AzureCLI
   az login
   ```
   The client-tools package installs `signtool.exe`, the .NET 8 runtime and
   `Azure.CodeSigning.Dlib.dll`. If you prefer NuGet: `Microsoft.Windows.SDK.BuildTools`
   (signtool 10.0.2261.755 or later; the 20348 SDK does not work with the dlib) and
   `Microsoft.ArtifactSigning.Client`.
7. **metadata.json**, kept outside the repository (for example
   `%USERPROFILE%\.diomedes-signing\metadata.json`):
   ```json
   {
     "Endpoint": "https://eus.codesigning.azure.net",
     "CodeSigningAccountName": "<your account name>",
     "CertificateProfileName": "<your profile name>",
     "CorrelationId": "diomedes-release"
   }
   ```
   It contains no secret. Authentication is your `az login` session
   (DefaultAzureCredential). Never put a client secret, PFX or password in this file; the
   sign script refuses a file that carries one.
8. **Environment for the build shell:**
   ```powershell
   $env:DIOMEDES_SIGN_METADATA = "$env:USERPROFILE\.diomedes-signing\metadata.json"
   $env:DIOMEDES_SIGNTOOL = "<path to>\signtool.exe"
   $env:DIOMEDES_SIGN_DLIB = "<path to>\x64\Azure.CodeSigning.Dlib.dll"
   pwsh scripts\sign-windows.ps1 -Path package.json -Check
   ```
   `-Check` prints `configured` and signs nothing. Exit 2 means a variable is missing.

## What the repository already contains

- `scripts/sign-windows.ps1`: signs the files it is given with
  `signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib … /dmdf …`,
  verifies each with `signtool verify /pa`, prints the signer and timestamp subjects, and
  exits non-zero on any failure. Exit 2 when the machine is not configured, exit 3 if the
  metadata file carries anything secret-shaped. It never accepts a key, password or
  thumbprint.
- `scripts/build-windows-installer.mjs --signed`: signs `Diomedes.exe` before the payload is
  hashed, compiles the installer, signs the installer, and then **requires** an Authenticode
  signature on the output. Without `--signed` the behaviour is unchanged: the build must be
  unsigned and the manifest records `authenticodeStatus: "NotSigned"`. The output name drops
  `-unsigned` (`Diomedes-Experimental-<version>-setup.exe`), the Programs entry drops
  "(Unsigned)", and the manifest records `signing: "azure-artifact-signing"`.
- The installer's own `getAuthenticodeStatus` reads the PE certificate table, so a "signed"
  claim in the manifest is checked against the bytes, not the flag.

The first signed release also needs, outside this repository: the site's release record
(`src/data/releases.ts`) switched to `signing: 'signed'` with the certificate subject as
`publisher`, and the release notes' "It is not signed" section replaced.

## Timestamping

Artifact Signing certificates live for about three days. The timestamp from
`http://timestamp.acs.microsoft.com` is what keeps the signature valid afterwards; the sign
script always passes it and fails if the timestamp cannot be obtained.

## Antivirus false positives (independent of signing)

For each published build, submit the exact files once they are public:

- **Norton / Symantec / Gen Digital:** submit.norton.com → "False positive" → upload the
  installer (or give the public URL) with its SHA-256 and the detection name `IDP.Generic`.
- **Microsoft Defender / SmartScreen:** microsoft.com/wdsi/filesubmission (developer) →
  upload the file; SmartScreen reputation is separate and only accrues with downloads.
- Keep a line in the release notes: the build is unsigned; verify the SHA-256; never disable
  protection to run it; restore from quarantine only when the hash matches the published one.

Only a person should upload files to a vendor portal. Record the submission id in
`docs/releases/RELEASE_HANDOFF.md` when it is done.
