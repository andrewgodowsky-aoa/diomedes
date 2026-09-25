import { TODAY, Workspace, cents, fmt, type CheckResult, type Finding } from '../workspace.js';

/** Monday of the week before TODAY: "this week" in the estimate follow-up is the last seven days. */
const WEEK_START = '2026-09-14';

export function checkAuto(ws: Workspace): CheckResult {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const ros = ws.table('exports/repair-orders.csv');
  const invoices = ws.table('exports/invoices.csv');
  const estimates = ws.table('exports/estimates.csv');
  const orders = ws.table('exports/parts-orders.csv');
  const received = ws.table('exports/parts-received.csv');
  const customers = new Map(ws.table('exports/customers.csv').map((c) => [c.customer_id, c]));

  for (const i of invoices) {
    if (cents(i.total) !== cents(i.labor) + cents(i.parts) + cents(i.tax))
      errors.push(`exports/invoices.csv row ${i._row}: total is not labor + parts + tax`);
    const ro = ros.find((r) => r.ro === i.ro);
    if (!ro || ro.invoice !== i.invoice)
      errors.push(`exports/invoices.csv row ${i._row}: RO ${i.ro} does not name ${i.invoice}`);
  }
  for (const r of ros) {
    if (!customers.has(r.customer_id))
      errors.push(`exports/repair-orders.csv row ${r._row}: unknown customer`);
    if (r.opened_on > TODAY || (r.closed_on && r.closed_on > TODAY))
      errors.push(`exports/repair-orders.csv row ${r._row}: dated after ${TODAY}`);
    if (!estimates.some((e) => e.ro === r.ro))
      errors.push(`exports/repair-orders.csv row ${r._row}: no estimate`);
  }
  const ids = orders.map((o) => o.part_order);
  if (new Set(ids).size !== ids.length)
    errors.push('exports/parts-orders.csv: a part order number is used twice');
  for (const x of received)
    if (!orders.some((o) => o.part_order === x.part_order && o.ro === x.ro))
      errors.push(`exports/parts-received.csv row ${x._row}: no matching part order`);

  // Findings: what each car marked Waiting on parts is really waiting on.
  const glass = ws.text('notes/glass.md').split('\n');
  for (const r of ros.filter((x) => x.status === 'Waiting on parts')) {
    const got = received.find((x) => x.ro === r.ro);
    const order = orders.find((o) => o.ro === r.ro);
    const sublet = glass.findIndex((l) => l.includes(`RO ${r.ro}`));
    if (got)
      findings.push({
        id: `stale-status-ro-${r.ro}`,
        file: 'exports/parts-received.csv',
        where: `row ${got._row}`,
        amount: `signed in ${got.received_on}`,
        problem: `RO ${r.ro} still reads Waiting on parts`,
      });
    else if (order)
      findings.push({
        id: `waiting-ro-${r.ro}`,
        file: 'exports/parts-orders.csv',
        where: `row ${order._row}`,
        amount:
          order.status === 'back-ordered'
            ? 'back-ordered, no date'
            : `ordered ${order.ordered_on}, due ${order.eta}`,
        problem: `${order.part}`,
      });
    else if (sublet >= 0)
      findings.push({
        id: `waiting-ro-${r.ro}`,
        file: 'notes/glass.md',
        where: `line ${sublet + 1}`,
        amount: 'sublet, not booked',
        problem: r.concern,
      });
    else errors.push(`RO ${r.ro} waits on parts with no part order or sublet note`);
  }

  // Finding: a part order past its due date and never received.
  for (const o of orders)
    if (
      o.status === 'ordered' &&
      o.eta &&
      o.eta < TODAY &&
      !received.some((x) => x.part_order === o.part_order)
    )
      findings.push({
        id: `not-received-${o.part_order.toLowerCase()}`,
        file: 'exports/parts-orders.csv',
        where: `row ${o._row}`,
        amount: `due ${o.eta}`,
        problem: `${o.part} for RO ${o.ro}`,
      });

  // Finding: a repair order closed with no invoice.
  for (const r of ros.filter((x) => x.status === 'Closed')) {
    if (invoices.some((i) => i.ro === r.ro)) continue;
    const est = estimates.find((e) => e.ro === r.ro);
    findings.push({
      id: `no-invoice-ro-${r.ro}`,
      file: 'exports/repair-orders.csv',
      where: `row ${r._row}`,
      amount: est ? fmt(cents(est.amount)) : '-',
      problem: `Closed ${r.closed_on}, no invoice`,
    });
  }

  // Finding: a finished car whose owner was never called.
  const calls = ws
    .list('notes')
    .filter((f) => f.startsWith('notes/calls-'))
    .map((f) => ws.text(f))
    .join('\n');
  for (const r of ros.filter((x) => x.status === 'Complete'))
    if (!calls.includes(`RO ${r.ro},`))
      findings.push({
        id: `not-told-ro-${r.ro}`,
        file: 'exports/repair-orders.csv',
        where: `row ${r._row}`,
        amount: `complete ${r.completed_at}`,
        problem: 'No pickup call logged',
      });

  // Findings: estimates out in the last week with no approval, and whether a text can reach them.
  for (const e of estimates) {
    if (e.approved_at || e.sent_at.slice(0, 10) < WEEK_START) continue;
    const ro = ros.find((r) => r.ro === e.ro);
    if (ro?.status !== 'Waiting on approval')
      errors.push(
        `exports/estimates.csv row ${e._row}: open estimate on an RO that is ${ro?.status}`,
      );
    const mobile = customers.get(e.customer_id)?.mobile;
    findings.push({
      id: `estimate-open-${e.estimate.toLowerCase()}`,
      file: 'exports/estimates.csv',
      where: `row ${e._row}`,
      amount: fmt(cents(e.amount)),
      problem: `Sent ${e.sent_at}${mobile ? '' : ', no mobile number on file'}`,
    });
    if (!mobile)
      findings.push({
        id: `no-mobile-${e.customer_id.toLowerCase()}`,
        file: 'exports/customers.csv',
        where: `row ${customers.get(e.customer_id)!._row}`,
        amount: '-',
        problem: `Estimate ${e.estimate} cannot be followed up by text`,
      });
  }
  for (const r of ros.filter((x) => x.status === 'Waiting on approval'))
    if (!estimates.some((e) => e.ro === r.ro && !e.approved_at))
      errors.push(`RO ${r.ro} waits on approval with no open estimate`);
  return { findings, errors };
}
