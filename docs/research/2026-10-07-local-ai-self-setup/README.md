# Local AI self-setup, qualified profiles, and optional services

**Package:** NC-LOCAL-2026-10-07.1  
**Status:** researched proposal and implementation handoff; no application implementation, model qualification, training, release, or spending performed by this publication.

[Full research report in Drive](https://docs.google.com/document/d/1lhAeth1SYo99cE20qISkMfHggiYCKLMHG-bXMIrZEyM/edit) · [Implementation prompts](./IMPLEMENTATION_PROMPTS.md)

## Direction

Andrew requested simpler model setup, selection of the best available suitable model, and a clear commercial boundary: self-setup included with a paid subscription, with optional paid local installation, tuning, training, and hybrid services. Implement this as **the best qualified model for this computer and this work**, not the largest downloadable model or an unverified global winner.

The proposed included experience is disclosed hardware inspection, a maintained recommendation, supported download/configuration, bounded synthetic verification, lifecycle controls, safe update/rollback, and self-service troubleshooting. Preserve existing Free/manual local routes, third-party model rights and local data. Paid capability entitlement, inference payer, OS/installation permission, data destination, and remote/unattended authority remain separate. Preserve current Personal pay-as-you-go behavior. Managed inference remains the default unless a person deliberately chooses another supported policy.

This is a software-first offer. Customers must not need a services engagement merely to make the supported application work. Paid services remove effort, handle environment-specific complexity, and deliver verified workload improvements. Actual weight adaptation is an optional later service, not a prerequisite for good setup and not a synonym for configuration or teaching staff.

## Reconciled implementation evidence

The inspected app baseline is `bae249b60ffafa3934d775c6d59fbac80990a83e`. Core Pillars, Roadmap, and Project Memory retain version `2026-10-06.1`; older implementation checkpoints inside them are historical. Refresh source and active ownership before implementing.

[PR #225](https://github.com/andrewgodowsky-aoa/diomedes/pull/225) is merged: the general local route, explicit Start action, profile discovery and composition with managed workers already exist in source. Its reported checks are historical and do not independently establish installed-platform acceptance here. Do not restart that integration.

[`shared/local-model.ts`](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/shared/local-model.ts) consumes the installer-owned `nectovia-connection.json` and running server information. Preserve persisted `bonsai` and `bonsai:local` identifiers. They do not restrict which model can run. Existing loopback and Windows `.ps1` lifecycle checks must not be weakened to accommodate remote hosts or macOS. Those require a versioned, qualified adapter extension. Nectovia does not edit an external installer's descriptor merely because it discovered it.

The [Local Infrastructure ADR](https://github.com/andrewgodowsky-aoa/diomedes/blob/bae249b60ffafa3934d775c6d59fbac80990a83e/docs/product/2026-09-15-local-infrastructure.md) remains useful architecture; its early implementation inventory is superseded where PR #225 and current source differ. Reuse Core/Runtime/Trust, approved installation/Files effects, account admission, existing model matrix, Work/Board/Teams and artifact evidence. No parallel agent runtime, task queue, wallet, catalog authority or permission system.

Existing owners: DIO-154 Local Infrastructure; DIO-201 local interaction; DIO-122 persistent setup; DIO-145 model matrix; DIO-149 evaluation screening; DIO-213 own-model training; DIO-253 long-context local qualification. The missing slice is guided installation and qualified recommendation composed with those owners—not a new competing local-model roadmap.

## Customer journey

1. Ask about work and data policy: this computer, an approved private host, or managed AI. Local setup is optional. An unsuitable device must not make other eligible product routes unusable.
2. Disclose hardware inspection. Read OS/backend, CPU/GPU, free RAM/VRAM or unified memory, disk, and compatible existing runtimes. Preserve unknowns; do not double-count unified memory, pool GPUs naively, or upload a hardware fingerprint/user files for basic selection.
3. Show one recommended profile and at most two useful alternatives, such as reduced resource use or stronger reasoning. Show footprint, temporary disk needs, measured context band, task qualification and limitations. Put quantization, template and runtime details in Advanced.
4. Obtain approval for the exact download, licenses, destination and installation effects. Verify artifact integrity and source authenticity before execution. Resume interrupted downloads, expose Cancel, and preserve external installation ownership.
5. Run disclosed synthetic smoke checks: correct model/profile, a tool result, deterministic arithmetic, interruption/recovery and network policy. A successful health endpoint is not a quality certificate.
6. Show Local AI ready only with applicable runtime and qualification evidence. Label unqualified Advanced configurations honestly without unnecessarily withdrawing supported manual operation.
7. Persist setup progress and receipts. Reopening resumes; another device rechecks local hardware while retaining authorized organization preferences. An old cache does not revive revoked grants.

Local generation does not consume managed inference credits. Separately authorized cloud helpers or paid tools remain visible and attributable. Do not label the entire workflow free or private merely because the LLM runs locally.

## Qualified-profile selection

Use a workload envelope over existing structures: task class, tool/modality needs, occupied input band plus output reserve, latency/resource profile, source/data policy, offline requirements, permitted payer and evaluation reference. These are requirements, not permission grants.

Apply hard eligibility filters first: rights, runtime/backend/host compatibility, memory/context, tool behavior, current permissions, entitlement, payer and permitted destinations. Rank eligible qualified profiles by task success, recovery, latency and resource impact. Preserve explicit eligible pins. An invalid pin yields a reason, not a silent substitute.

Use objective verifiers, observed failure modes and explicit escalation policy—not the model's self-reported confidence. Arithmetic, filtering and database/report aggregation remain deterministic. Host-computed inventory and visualization data should be summarized for the model, not re-aggregated from hundreds of thousands of raw rows by a small model.

Keep candidate discovery separate from promotion. A qualification receipt identifies exact weights, tokenizer, template, quantization/KV settings, runtime/backend, hardware class, context occupancy, modalities, task-bank version, result denominators, limitations and rollback target. A changed template or quantization is a changed candidate. New catalog discovery never automatically installs, switches or qualifies a model.

Maintain a reviewed candidate/qualified channel in the existing registry architecture. Offer new qualified profiles with a reason and reversible migration. Establish an operating owner and review cadence, without inventing an unstaffed update SLA. Connected third-party engines continue their own capability discovery; do not add a vendor-version equality admission gate.

The initial screen should reuse current project candidates: Qwen3.5 4B/9B for lightweight classes; Qwen3.8-27B and Ornith-1.5-35B-A3B for the existing workstation comparison; additional DIO-213/DIO-253 comparators after source/runtime checks. No model winner is established here. An eventual Nectovia-trained model must compete under the same qualification rules.

## Research and acceptance program

Separate ordinary-device useful-work profiles from DIO-253's demanding workstation program. Preserve that program's targets: at least 100K occupied tokens, 128K preferred; at least 30 decoded tokens/second at that occupancy, 35 preferred; and its specified stable-prefix reuse target of at least 95% on turn two. These are existing goals, not results of this publication or universal consumer requirements.

Reuse DIO-149/DIO-213's frozen bank and deterministic verifiers. Screen a short subset, then repeatedly evaluate finalists against held-out work. Freeze scoring and configuration before comparing. Report paired task outcomes, failures, denominators and uncertainty. Do not turn a tiny score difference into a universal ranking.

Coverage: invoice/inventory reconciliation; cited knowledge; conflicting and absent records; customer commitments; scheduling/resource constraints; cross-location permissions; tool selection and repair; safe write proposals; report/artifact production; technical implementation. Hold-out layouts must differ from development/training examples. Business facts remain in retrieval/system state, not weights.

Measure cold/warm start, prefill, first useful output, decode at occupied context, end-to-end task completion, memory pressure, concurrency and failures separately. Record exact hardware/runtime/template/model/quant/effort. Maintain OS/application headroom and disclosed cancellation/resource limits. Do not overclock or perform heavy training on a customer workstation by default.

Reproduce DIO-251 and DIO-254–DIO-258's context clipping, timeout, read/progress and missing-final-answer failures as applicable to the current candidate. Recheck current issue state before calling a bug open or fixed. Prefix reuse requires server evidence and stable prompt construction, not just a faster second answer. Mandatory policy/correctness failures block promotion for the affected work class.

Real packaged Windows acceptance follows fixture/browser/source gates. Mac and paired-server acceptance are separate. No model downloads, inference evaluations, GPU runs or application tests occurred in this research pass.

## Reliability and hybrid operation

Model cards and installer instructions are untrusted inputs. Separate source authenticity, digest integrity, license rights and runtime compatibility. Test declared sizes, archive extraction bounds, path traversal, symlinks, redirects, wrong digest, altered descriptor, disk exhaustion, cancellation and partial downloads. Do not run arbitrary remote code automatically.

Bind lifecycle operations to owned process/service identities. Cover port collision, model mismatch, out-of-memory, process replacement, crash/restart, sleep/wake, drain and rollback. Never kill an unrelated process by name or replay an uncertain external write after switching models.

This computer, an approved private host and managed cloud are different destinations. Do not pass a LAN URL through loopback validation. Pairing, remote listeners/firewall changes and unattended execution use the existing authorization and revocation design. Preserve one Work/Board/artifact identity across execution locations.

A human-approved hybrid policy may permit specified task/data classes, destinations, payer and capped escalation. Each child rechecks current authority and funding. Local-only work stays local or pauses; local failure never silently uploads a private document. Privacy includes retrieval, embeddings, tools, web, synchronization, diagnostics and support access—not only generation.

Use content-free setup analytics where already authorized. Prompt/file/training content and diagnostic uploads keep separate consent, retention and redaction. Telemetry permission is not training permission.

## Commercial boundaries

- **Included paid guided setup:** supported discovery, recommendations, installation/configuration, bounded synthetic checks, lifecycle/update controls and self-service troubleshooting. Not hardware, unlimited human labor, custom integration, hosted compute or automatic model training.
- **Optional assisted local setup:** one scoped supported device/route/workflow and handover, remote or on-site. Quote through existing services pending exact offer approval. Do not silently rename or copy the price of Cloud AI Quick Start.
- **Hardware/model planning and Private AI deployment:** preserve existing offers and qualifying assessment-credit terms. The current site registry has `contact: true`; public copy is Contact for pricing. Numerical `from` fields are not public quotes. Hardware and approved external costs are separate.
- **Performance/workflow tuning:** prompts, context assembly, tools, retrieval, runtime settings, quantization, concurrency/cache and playbooks, with before/after evidence, reproducible configuration and rollback. No double billing for work already included in Managed.
- **Custom model adaptation:** conditional on a persistent trainable behavior gap after a good baseline, tools, retrieval and tuning. Scope rights-reviewed data, a capped experiment, held-out base comparison, deployed-quantized runtime validation, export/ownership terms, rollback and maintenance. Do not promise a quality gain or complete unlearning. Changing operational facts belong in retrieval.
- **Staff onboarding:** explicitly distinct from weight adaptation. Existing deployment training does not imply a newly trained model.

Subscription expiry does not delete downloaded weights, data or independent rights. Paid Agent/guided services obey actual entitlements and current Personal pay-as-you-go exceptions. Offline grace, device limits and exact assisted-setup packaging remain named decisions, not invented restrictions.

No rate card, automatic upsell, spending authorization or new training consent is approved by this package. Preserve DIO-213's teacher-source restrictions. AWS §50.5 and third-party terms require route-specific review; an open-weight label or API key does not establish training-data rights.

## Execution order

0. Reconcile source/ownership and define one Windows/llama.cpp synthetic vertical slice.
1. Add guided, resumable installation and owned lifecycle recovery using existing contracts.
2. Connect qualified recommendations, paid eligibility, persistent setup and current UI; preserve manual use.
3. Compose explicit hybrid/private-host support through existing owners and authorized routes.
4. Pilot assisted setup/workload tuning; conditional adaptation follows DIO-213 proof and target-runtime acceptance. Training never blocks initial setup.
5. Independently accept the packaged journey, assign maintenance ownership, and publish only supported claims through reviewed docs/site changes.

Start with Prompt 00 in IMPLEMENTATION_PROMPTS.md. It reconciles current source and then begins the first independent offline implementation slice. No merge, release, production mutation, live paid call or training run is authorized by the prompt package itself.

## Primary sources

Project: [Core Pillars](https://docs.google.com/document/d/1O0bWr5HEryEQmtOsUput0sgzLhk2c_Ze6MaXoMfKta4/edit), [Roadmap](https://docs.google.com/document/d/1bRhz3zQPXOYuVlt95U1EIkz7pcm1dtSsoBvkDrLR3zE/edit), [Project Memory](https://docs.google.com/document/d/13wYjK1BhEsGzc_yhpRtBz62pGmLxwdwq8pVqe1i4eKw/edit), [DIO-154](https://linear.app/diomedesdevs/issue/DIO-154), [DIO-213](https://linear.app/diomedesdevs/issue/DIO-213), [DIO-253](https://linear.app/diomedesdevs/issue/DIO-253), [site pricing](https://github.com/andrewgodowsky-aoa/diomedes-site/blob/main/src/data/pricing.ts) inspected blob `b5e6b0cd91240b3d5249b84ba0b0cdbd9d84821b`.

External official references inspected: [Loci](https://askloci.ai/), [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B), [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B), [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), [Ornith-1.5-35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B), [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server), [LM Studio load estimates](https://lmstudio.ai/docs/cli/local-models/load), [LM Studio terms](https://lmstudio.ai/app-terms), [Ollama FAQ](https://docs.ollama.com/faq), [MLX-LM](https://github.com/ml-explore/mlx-lm), [PEFT](https://huggingface.co/docs/peft/developer_guides/quantization), [AWS Service Terms](https://aws.amazon.com/service-terms/).

Loci supplies useful setup/pairing/network-disclosure patterns, not business-agent qualification evidence. LM Studio/Ollama are optional existing-installation integrations, not mandatory bundled dependencies. Application redistribution rights need review. MLX-LM is a separate Apple Silicon candidate. Vendor context and benchmark claims are not Nectovia measurements. The complete latest Waldman post was not independently established from primary retrieval; no new technical claim depends on its paraphrase.
