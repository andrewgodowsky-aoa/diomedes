import { Workspace, cents, fmt, listRows, type CheckResult, type Finding } from '../workspace.js';

const MONDAY = 'stock/sheet-goods-count-2026-09-14.csv';
const FRIDAY = 'stock/sheet-goods-count-2026-09-18.csv';
const SHEET_SQ_FT = 32;
const tenths = (s: string) => Math.round(Number(s) * 10);

export function checkWood(ws: Workspace): CheckResult {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const key = (r: Record<string, string>) => `${r.material} ${r.thickness}`;
  const monday = new Map(ws.table(MONDAY).map((r) => [key(r), r]));
  const friday = ws.table(FRIDAY);
  const delivery = ws.table('deliveries/3312.csv');
  const issues = ws.table('stock/issue-log.csv');

  // Finding: the Friday count against Monday's count plus the delivery less what was issued.
  for (const r of friday) {
    const m = monday.get(key(r));
    if (!m) {
      errors.push(`${FRIDAY} row ${r._row}: ${key(r)} is not on the Monday count`);
      continue;
    }
    const inbound = delivery
      .filter(
        (d) => key(d) === key(r) && d.received_on > '2026-09-14' && d.received_on <= '2026-09-18',
      )
      .reduce((n, d) => n + Number(d.qty_delivered), 0);
    const out = issues
      .filter((i) => key(i) === key(r) && i.date > '2026-09-14' && i.date <= '2026-09-18')
      .reduce((n, i) => n + Number(i.sheets), 0);
    const ledger = Number(m.sheets) + inbound - out;
    const gap = ledger - Number(r.sheets);
    if (gap !== 0)
      findings.push({
        id: `count-gap-${key(r)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}`,
        file: FRIDAY,
        where: `row ${r._row}`,
        amount: `${gap} sheets, ${fmt(gap * cents(r.unit_cost))}`,
        problem: `${key(r)}: ledger ${ledger}, counted ${r.sheets}`,
      });
    if (key(r) === 'Walnut ply 3/4')
      findings.push({
        id: 'walnut-ply-3-4-on-hand',
        file: FRIDAY,
        where: `row ${r._row}`,
        amount: `${r.sheets} sheets`,
        problem: `Monday ${m.sheets}, delivered ${inbound}, issued ${out}`,
      });
  }

  // Finding: the supplier invoice billing more than the delivery note shows.
  for (const l of ws.table('invoices/brookfield-3312.csv')) {
    if (cents(l.extended) !== Number(l.qty) * cents(l.unit_price))
      errors.push(`invoices/brookfield-3312.csv line ${l.line}: extended is not qty x unit_price`);
    const d = delivery.find((x) => x.line === l.line && key(x) === key(l));
    if (!d) errors.push(`invoices/brookfield-3312.csv line ${l.line}: not on the delivery note`);
    else if (Number(l.qty) > Number(d.qty_delivered))
      findings.push({
        id: `invoice-over-delivery-3312-line-${l.line}`,
        file: 'invoices/brookfield-3312.csv',
        where: `line ${l.line}`,
        amount: fmt((Number(l.qty) - Number(d.qty_delivered)) * cents(l.unit_price)),
        problem: `${key(l)}: ${l.qty} billed, ${d.qty_delivered} delivered`,
      });
  }

  // K-104: sheets cut against the estimate's allowance, and where the area went.
  const sheets = ws.table('jobs/K-104/sheets.csv');
  const cut = sheets.filter((s) => s.outcome === 'cut');
  const net = issues
    .filter((i) => i.job === 'K-104' && key(i) === 'MDF 1/4')
    .reduce((n, i) => n + Number(i.sheets), 0);
  if (net !== cut.length)
    errors.push(
      `stock/issue-log.csv: K-104 drew ${net} sheets net, jobs/K-104/sheets.csv cut ${cut.length}`,
    );
  const allowance = Number(
    /1\/4 MDF[^|]*\| (\d+) sheets/.exec(ws.text('jobs/K-104/estimate.md'))?.[1] ?? NaN,
  );
  const parts = ws.table('jobs/K-104/cutlist.csv');
  for (const p of parts)
    if (
      Math.round((Number(p.width_in) * Number(p.length_in) * Number(p.qty) * 10) / 144) !==
      tenths(p.sq_ft)
    )
      errors.push(`jobs/K-104/cutlist.csv row ${p._row}: sq_ft does not match its size`);
  const partArea = parts.reduce((n, p) => n + tenths(p.sq_ft), 0);
  const remnantArea = ws
    .table('stock/remnants.csv')
    .filter((r) => r.from_job === 'K-104')
    .reduce((n, r) => n + tenths(r.sq_ft), 0);
  const waste = cut.reduce((n, s) => n + tenths(s.waste_sq_ft), 0);
  if (partArea + remnantArea + waste !== cut.length * SHEET_SQ_FT * 10)
    errors.push(
      `K-104: parts ${partArea / 10} + remnants ${remnantArea / 10} + waste ${waste / 10} sq ft is not ${cut.length} sheets`,
    );
  if (cut.length > allowance) {
    const remakeSheets = [...new Set(parts.filter((p) => p.remake === 'yes').map((p) => p.sheet))];
    findings.push({
      id: 'k-104-over-allowance',
      file: 'jobs/K-104/sheets.csv',
      where: listRows(cut.filter((s) => remakeSheets.includes(s.sheet)).map((s) => s._row)),
      amount: `${cut.length - allowance} sheet${cut.length - allowance === 1 ? '' : 's'}`,
      problem: `${cut.length} cut against an allowance of ${allowance}; parts ${partArea / 10}, remnants ${remnantArea / 10}, waste ${waste / 10} sq ft`,
    });
  }
  const notes = ws.text('jobs/K-104/site-notes.md').split('\n');
  const remeasured = notes.findIndex((l) => l.includes('measured again'));
  if (remeasured >= 0)
    findings.push({
      id: 'k-104-remake-cause',
      file: 'jobs/K-104/site-notes.md',
      where: `line ${remeasured + 1}`,
      amount: '-',
      problem: 'Sink opening measured again; remake cut',
    });
  const approved = notes.some((l) => /change order/.test(l) && /Not approved/.test(l));
  if (approved)
    findings.push({
      id: 'k-104-change-order-unapproved',
      file: 'jobs/K-104/site-notes.md',
      where: `line ${notes.findIndex((l) => /Not approved/.test(l)) + 1}`,
      amount: '-',
      problem: 'Remake change order not approved, job cost provisional',
    });

  // MAR-11: an item closes only when someone checks it.
  const punch = ws.table('jobs/MAR-11/punch.csv');
  const photos = new Set(ws.table('jobs/MAR-11/photo-log.csv').map((p) => p.punch_item));
  const open = punch.filter((r) => r.status !== 'closed' || !r.checked_by);
  const by = (who: string) => open.filter((r) => r.owner === who).length;
  findings.push({
    id: 'mar-11-open',
    file: 'jobs/MAR-11/punch.csv',
    where: listRows(open.map((r) => r._row)),
    amount: `${open.length} open: ${by('installer')} installer, ${by('finisher')} finisher`,
    problem: 'Open punch items',
  });
  const unchecked = punch.filter((r) => r.status === 'closed' && !r.checked_by);
  findings.push({
    id: 'mar-11-closed-unchecked',
    file: 'jobs/MAR-11/punch.csv',
    where: listRows(unchecked.map((r) => r._row)),
    amount: `${unchecked.length}`,
    problem: 'Marked closed with no check recorded',
  });
  findings.push({
    id: 'mar-11-open-with-photo',
    file: 'jobs/MAR-11/photo-log.csv',
    where: `${photos.size} rows`,
    amount: `${open.filter((r) => photos.has(r.item)).length} of ${open.length}`,
    problem: 'Open items that carry a photo',
  });
  return { findings, errors };
}
