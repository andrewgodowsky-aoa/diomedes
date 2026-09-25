import {
  TODAY,
  Workspace,
  cents,
  fmt,
  listRows,
  type CheckResult,
  type Finding,
} from '../workspace.js';

/** The remodeler Lookback on the site: 9 items, $13,621.50 (diomedes-site src/data/lookback.ts). */
export const REMODEL_LOOKBACK = {
  items: 9,
  totalCents: 1362150,
  prefixes: ['unbilled-co-', 'short-', 'over-bid-', 'unbilled-draw-'],
};

export function checkRemodel(ws: Workspace): CheckResult {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const jobs = ws.table('jobs/jobs.csv');
  const active = jobs.filter((j) => j.status === 'active');
  if (active.length < 3)
    errors.push(`jobs/jobs.csv: ${active.length} active jobs, the suite promises at least three`);

  // Draw schedules add to 100% and to the contract.
  const draws = ws.table('billing/draw-schedule.csv');
  for (const j of jobs) {
    const mine = draws.filter((d) => d.job === j.job);
    if (mine.reduce((n, d) => n + Number(d.percent), 0) !== 100)
      errors.push(`billing/draw-schedule.csv: ${j.job} draws do not add to 100%`);
    if (mine.reduce((c, d) => c + cents(d.amount), 0) !== cents(j.contract_sum))
      errors.push(`billing/draw-schedule.csv: ${j.job} draws do not add to the contract`);
  }
  const drawById = new Map(draws.map((d) => [d.draw, d]));
  const cos = ws.table('change-orders/register.csv');
  const coById = new Map(cos.map((c) => [c.co, c]));

  // Client invoices: totals, and every line priced from its draw or change order.
  const invoices = ws.table('billing/invoices.csv');
  const billed = new Set<string>();
  for (const inv of invoices) {
    const rows = ws.table(inv.file);
    if (rows.reduce((c, r) => c + cents(r.amount), 0) !== cents(inv.total))
      errors.push(`${inv.file}: lines do not add to the register total`);
    for (const r of rows) {
      const source = r.kind === 'draw' ? drawById.get(r.ref) : coById.get(r.ref);
      if (!source || source.job !== inv.job)
        errors.push(`${inv.file} line ${r.line}: ${r.ref} is not a ${r.kind} of ${inv.job}`);
      else if (source.amount !== r.amount)
        errors.push(
          `${inv.file} line ${r.line}: ${r.ref} billed at ${r.amount}, not ${source.amount}`,
        );
      billed.add(r.ref);
    }
    if (inv.date > TODAY && !inv.status.startsWith('draft'))
      errors.push(`${inv.file}: dated after ${TODAY} but not a draft`);
  }

  // Finding: a signed change order that no invoice carries.
  for (const c of cos) {
    if (!ws.exists(c.file))
      errors.push(`change-orders/register.csv row ${c._row}: ${c.file} is missing`);
    if (c.status !== 'signed' || billed.has(c.co)) continue;
    const next = invoices
      .filter((i) => i.job === c.job && i.date >= c.signed_on)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    findings.push({
      id: `unbilled-co-${c.co.toLowerCase()}`,
      file: c.file,
      where: `signed ${c.signed_on}, not on invoice ${next?.invoice ?? '(none yet)'}`,
      amount: fmt(cents(c.amount)),
      problem: c.description,
    });
  }

  // Finding: supplier invoice lines billed above what the delivery ticket shows.
  for (const s of ws.table('invoices/register.csv')) {
    const lines = ws.table(s.file);
    const ticket = ws.table(s.ticket);
    if (lines.reduce((c, r) => c + cents(r.extended), 0) !== cents(s.total))
      errors.push(`${s.file}: lines do not add to the register total`);
    for (const l of lines) {
      if (cents(l.extended) !== Number(l.qty) * cents(l.unit_price))
        errors.push(`${s.file} line ${l.line}: extended is not qty x unit_price`);
      const t = ticket.find((x) => x.line === l.line && x.item === l.item);
      if (!t) {
        errors.push(`${s.ticket}: no line ${l.line} for ${l.item}`);
        continue;
      }
      const short = Number(l.qty) - Number(t.qty_delivered);
      if (short > 0)
        findings.push({
          id: `short-${s.file.slice(9, -4)}-line-${l.line}`,
          file: s.file,
          where: `line ${l.line}`,
          amount: fmt(short * cents(l.unit_price)),
          problem: `${l.item}: ${l.qty} billed, ${t.qty_delivered} on the ticket`,
        });
    }
  }

  // Finding: a sub billed above its bid for that job.
  const subInvoices = ws.table('subs/register.csv');
  for (const b of ws.table('subs/bids.csv')) {
    const mine = subInvoices
      .filter((s) => s.sub === b.sub && s.job === b.job)
      .sort((x, y) => x.date.localeCompare(y.date));
    for (const s of mine)
      if (ws.table(s.file).reduce((c, r) => c + cents(r.amount), 0) !== cents(s.total))
        errors.push(`${s.file}: lines do not add to the register total`);
    const total = mine.reduce((c, s) => c + cents(s.total), 0);
    if (total > cents(b.bid)) {
      const last = mine.at(-1)!;
      findings.push({
        id: `over-bid-${last.file.slice(5, -4)}`,
        file: last.file,
        where: `bid ${b.bid}, billed ${fmt(total)}`,
        amount: fmt(total - cents(b.bid)),
        problem: `${b.sub} at ${b.job}: ${b.scope}`,
      });
    }
  }
  for (const s of subInvoices)
    if (!ws.table('subs/bids.csv').some((b) => b.sub === s.sub && b.job === s.job))
      errors.push(`${s.file}: no bid on file`);

  // Finding: a job that passed its final inspection with a draw never billed.
  const cards = ws.list('permits').filter((f) => f.endsWith('.md'));
  for (const i of ws.table('permits/inspections.csv')) {
    if (i.result === 'pass' && i.date > TODAY)
      errors.push(`permits/inspections.csv row ${i._row}: passed in the future`);
    if (i.inspection !== 'Final' || i.result !== 'pass') continue;
    const card = cards.find((f) => ws.text(f).includes(i.permit));
    for (const d of draws.filter((x) => x.job === i.job && !billed.has(x.draw)))
      findings.push({
        id: `unbilled-draw-${d.draw.toLowerCase()}`,
        file: card ?? 'permits/inspections.csv',
        where: card ? `final passed ${i.date}, draw ${d.draw} not invoiced` : `row ${i._row}`,
        amount: fmt(cents(d.amount)),
        problem: `${d.milestone}, never invoiced`,
      });
  }

  // Finding: a purchase order over its allowance with no change order raised.
  const allowances = new Map(
    ws.table('contract/kessler-allowances.csv').map((a) => [a.category, cents(a.allowance)]),
  );
  for (const p of ws.table('purchase-orders/register.csv')) {
    const total = ws.table(p.file).reduce((c, r) => c + cents(r.extended), 0);
    if (total !== cents(p.total)) errors.push(`${p.file}: lines do not add to the register total`);
    const allowance = allowances.get(p.category);
    if (
      allowance !== undefined &&
      total > allowance &&
      !cos.some(
        (c) => c.job === p.job && c.status === 'signed' && c.amount === fmt(total - allowance),
      )
    )
      findings.push({
        id: `over-allowance-po-${p.po}`,
        file: p.file,
        where: `total ${fmt(total)}, ${p.category.toLowerCase()} allowance ${fmt(allowance)}`,
        amount: fmt(total - allowance),
        problem: 'Over the allowance, no change order raised',
      });
  }

  // Findings: what stands between Henderson and Friday's walkthrough.
  const henPunch = ws.table('jobs/henderson/punch-list.csv');
  const henOpen = henPunch.filter((r) => r.status !== 'closed');
  findings.push({
    id: 'henderson-punch-open',
    file: 'jobs/henderson/punch-list.csv',
    where: listRows(henOpen.map((r) => r._row)),
    amount: `${henOpen.length} of ${henPunch.length} open`,
    problem: 'Punch items still open',
  });
  for (const r of ws
    .table('jobs/henderson/schedule-2026-W39.csv')
    .filter((x) => x.confirmed !== 'yes'))
    findings.push({
      id: `henderson-unconfirmed-${r.trade.toLowerCase()}`,
      file: 'jobs/henderson/schedule-2026-W39.csv',
      where: `row ${r._row}`,
      amount: r.confirmed,
      problem: `${r.company} on ${r.date}`,
    });
  for (const r of ws.table('jobs/henderson/selections.csv').filter((x) => !x.choice))
    findings.push({
      id: `henderson-selection-${r.item.toLowerCase().replace(/\W+/g, '-')}`,
      file: 'jobs/henderson/selections.csv',
      where: `row ${r._row}`,
      amount: r.status,
      problem: 'Selection not made',
    });
  const msg = ws.text('messages/henderson.md').split('\n');
  if (!/Yes go ahead with the 24-inch porcelain/.test(msg[11] ?? ''))
    errors.push('messages/henderson.md: the tile approval is no longer on line 12');

  // Findings: the Marsh punch list, where an item closes only when someone signs it off.
  const mar = ws.table('jobs/marsh/punch.csv');
  const photos = new Set(ws.table('jobs/marsh/photos.csv').map((p) => p.item));
  const marOpen = mar.filter((r) => r.status !== 'done' || !r.signed_off_by);
  findings.push({
    id: 'marsh-punch-open',
    file: 'jobs/marsh/punch.csv',
    where: listRows(marOpen.map((r) => r._row)),
    amount: `${marOpen.length} of ${mar.length} open`,
    problem: 'Open, counting items marked done with no sign-off',
  });
  const unsigned = mar.filter((r) => r.status === 'done' && !r.signed_off_by);
  findings.push({
    id: 'marsh-punch-done-unsigned',
    file: 'jobs/marsh/punch.csv',
    where: listRows(unsigned.map((r) => r._row)),
    amount: `${unsigned.length}`,
    problem: 'Marked done, never signed off',
  });
  const noPhoto = marOpen.filter((r) => !photos.has(r.item));
  findings.push({
    id: 'marsh-punch-no-photo',
    file: 'jobs/marsh/punch.csv',
    where: listRows(noPhoto.map((r) => r._row)),
    amount: `${noPhoto.length}`,
    problem: 'Open items with no photo',
  });
  for (const r of marOpen.filter((x) => !x.owner))
    findings.push({
      id: `marsh-punch-unassigned-${r.item.toLowerCase()}`,
      file: 'jobs/marsh/punch.csv',
      where: `row ${r._row}`,
      amount: 'Unassigned',
      problem: r.description,
    });
  for (const p of photos)
    if (!mar.some((r) => r.item === p))
      errors.push(`jobs/marsh/photos.csv: ${p} is not a punch item`);

  const lookback = findings.filter((f) =>
    REMODEL_LOOKBACK.prefixes.some((p) => f.id.startsWith(p)),
  );
  const total = lookback.reduce((c, f) => c + cents(f.amount), 0);
  if (lookback.length !== REMODEL_LOOKBACK.items || total !== REMODEL_LOOKBACK.totalCents)
    errors.push(
      `the site's remodeler Lookback is 9 items and $13,621.50; the files give ${lookback.length} items and $${fmt(total)}`,
    );
  return { findings, errors };
}
