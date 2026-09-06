// Needs a running Diomedes service with Codex signed in. This spends ChatGPT usage.

const base = (process.env.DIOMEDES_API ?? 'http://127.0.0.1:47631/api').replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const subject = 'Draft the patio reopening note';

async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok)
    throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const integrations = await api('/integrations');
  const codex = integrations.integrations.find((integration) => integration.id === 'codex');
  if (!codex?.available) {
    console.error('FAIL: Codex integration is unavailable.');
    process.exit(1);
  }

  const project = await api('/projects/sample', 'POST', {});
  const { member } = await api(`/projects/${project.id}/team/members`, 'POST', {
    name: 'Lead',
    role: 'lead',
    engine: 'codex',
  });
  const state = () => api(`/projects/${project.id}/state`);
  await api(`/projects/${project.id}/ask`, 'POST', {
    mode: 'work',
    text: `Use the team tools: call team_members and team_task_list, then put one task on the board with team_task_create (subject "${subject}") assigned to yourself. Report what the tools returned. Do not change any file.`,
    route: 'codex',
    consent: true,
    threadId: member.threadId,
    attachedTo: { kind: 'project', ref: project.id },
  });

  let current;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleep(1000);
    current = await state();
    const session = current.sessions.at(-1);
    const openNeed = current.needs.find((need) => need.state === 'open');
    if (openNeed)
      await api(`/projects/${project.id}/needs/${openNeed.id}/resolve`, 'POST', {
        resolution: 'go-ahead',
        allowForTask: true,
      });
    if (session && ['done', 'failed', 'stopped'].includes(session.state)) break;
  }

  const session = current?.sessions.at(-1);
  const hasTask = current?.tasks.some((task) => task.name === subject) ?? false;
  const hasForbiddenLog =
    session?.log.some((entry) => {
      const sentence = entry.sentence.toLowerCase();
      // The disclosure line legitimately says native tools "remain disabled"; the failure
      // signatures are the host refusal and a tool the model could not reach.
      return sentence.includes('could not call') || sentence.includes('code-mode host is disabled');
    }) ?? false;
  if (session?.state === 'done' && hasTask && !hasForbiddenLog) {
    console.log('PASS: real Codex team session completed and created the patio reopening task.');
    return;
  }

  console.log(
    `FAIL: Codex team smoke did not complete successfully (session ${session?.state ?? 'missing'}, task ${hasTask ? 'found' : 'missing'}, log ${hasForbiddenLog ? 'blocked' : 'clear'}).`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${message.endsWith('.') ? message : `${message}.`}`);
  process.exitCode = 1;
});
