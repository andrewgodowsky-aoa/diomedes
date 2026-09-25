import {
  TODAY,
  Workspace,
  cents,
  fmt,
  isoMonday2026,
  listRows,
  type CheckResult,
  type Finding,
} from '../workspace.js';

const SALES = 'sales/weekly-sales-2026-W30-to-W38.csv';
const CROISSANTS = ['Butter croissant', 'Almond croissant'];
const PUMPKIN = ['Pumpkin loaf slice', 'Pumpkin spice latte'];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
/** Whole dollars as the point of sale prints them: half a dollar rounds to the even dollar. */
const dollars = (c: number) => {
  const whole = Math.floor(c / 100);
  const rest = c - whole * 100;
  const d = rest > 50 || (rest === 50 && whole % 2 === 1) ? whole + 1 : whole;
  return `$${d.toLocaleString('en-US')}`;
};

export function checkBakery(ws: Workspace): CheckResult {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const sales = ws.table(SALES);

  // Every row adds up, and every week is the nine weeks W30 to W38 with the same eight items.
  const weeks = [...new Set(sales.map((r) => r.week))];
  if (weeks.join() !== [30, 31, 32, 33, 34, 35, 36, 37, 38].map((n) => `2026-W${n}`).join())
    errors.push(`${SALES}: expected weeks W30 to W38, found ${weeks.join(', ')}`);
  for (const r of sales) {
    const units = Number(r.units);
    if (cents(r.revenue) !== units * cents(r.unit_price))
      errors.push(`${SALES} row ${r._row}: revenue is not units x unit_price`);
    if (cents(r.gross_margin) !== units * (cents(r.unit_price) - cents(r.unit_cost)))
      errors.push(`${SALES} row ${r._row}: gross_margin is not units x (unit_price - unit_cost)`);
    if (r.week_starting !== isoMonday2026(Number(r.week.slice(6))))
      errors.push(`${SALES} row ${r._row}: week_starting is not that week's Monday`);
  }
  const byWeek = (week: string) => sales.filter((r) => r.week === week);
  const units = (week: string, items: string[]) =>
    byWeek(week)
      .filter((r) => items.includes(r.item))
      .reduce((n, r) => n + Number(r.units), 0);

  // The point-of-sale summary is the same nine weeks, summed from the item rows.
  const pos = ws
    .text('exports/pos-weekly-summary.txt')
    .split('\n')
    .filter((l) => l.startsWith('2026-W'));
  if (pos.length !== weeks.length)
    errors.push(
      `exports/pos-weekly-summary.txt: ${pos.length} weeks, the sales file has ${weeks.length}`,
    );
  for (const line of pos) {
    const m =
      /^(2026-W\d\d) \(week of (\w{3} \d\d)\): revenue \$([\d,]+), gross margin \$([\d,]+), croissants (\d+), pumpkin items (\d+)$/.exec(
        line,
      );
    if (!m) {
      errors.push(`exports/pos-weekly-summary.txt: unreadable line "${line}"`);
      continue;
    }
    const [, week, of, revenue, margin, croissants, pumpkin] = m;
    const rows = byWeek(week);
    const monday = new Date(`${rows[0]?.week_starting}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      timeZone: 'UTC',
    });
    if (of !== monday)
      errors.push(
        `exports/pos-weekly-summary.txt ${week}: week of ${of}, the sales file says ${monday}`,
      );
    const rev = rows.reduce((c, r) => c + cents(r.revenue), 0);
    const gm = rows.reduce((c, r) => c + cents(r.gross_margin), 0);
    if (`$${revenue}` !== dollars(rev))
      errors.push(
        `exports/pos-weekly-summary.txt ${week}: revenue $${revenue}, the item rows sum to ${dollars(rev)}`,
      );
    if (`$${margin}` !== dollars(gm))
      errors.push(
        `exports/pos-weekly-summary.txt ${week}: margin $${margin}, the item rows sum to ${dollars(gm)}`,
      );
    if (Number(croissants) !== units(week, CROISSANTS))
      errors.push(
        `exports/pos-weekly-summary.txt ${week}: croissants ${croissants}, the item rows say ${units(week, CROISSANTS)}`,
      );
    if (Number(pumpkin) !== units(week, PUMPKIN))
      errors.push(
        `exports/pos-weekly-summary.txt ${week}: pumpkin ${pumpkin}, the item rows say ${units(week, PUMPKIN)}`,
      );
  }

  // Last week's brief quotes W37 and W36 exactly.
  const brief = ws.text('briefs/weekly-operations-brief-2026-W37.md');
  for (const week of ['2026-W36', '2026-W37']) {
    const rows = byWeek(week);
    for (const figure of [
      dollars(rows.reduce((c, r) => c + cents(r.revenue), 0)),
      dollars(rows.reduce((c, r) => c + cents(r.gross_margin), 0)),
      String(units(week, CROISSANTS)),
      String(units(week, PUMPKIN)),
    ])
      if (!brief.includes(figure))
        errors.push(
          `briefs/weekly-operations-brief-2026-W37.md: does not quote ${week}'s ${figure}`,
        );
  }

  // Finding: the croissant price step. Exactly one week in which both prices move.
  const changes = new Map<string, { rows: number[]; rises: number[] }>();
  for (const item of CROISSANTS) {
    const rows = sales.filter((r) => r.item === item);
    rows.forEach((r, i) => {
      if (i && r.unit_price !== rows[i - 1].unit_price) {
        const c = changes.get(r.week) ?? { rows: [], rises: [] };
        c.rows.push(r._row);
        c.rises.push(cents(r.unit_price) - cents(rows[i - 1].unit_price));
        changes.set(r.week, c);
      }
    });
  }
  for (const [week, c] of changes)
    findings.push({
      id: `croissant-price-${week.slice(5).toLowerCase()}`,
      file: SALES,
      where: `${week}, ${listRows(c.rows)}`,
      amount: [...new Set(c.rises)].map(fmt).join(' / '),
      problem: 'Both croissant prices rise the same week',
    });

  // Finding: pumpkin items against croissants. Every week where the lead changes hands.
  let prev: number | null = null;
  for (const week of weeks) {
    const diff = units(week, PUMPKIN) - units(week, CROISSANTS);
    if (diff === 0)
      errors.push(
        `${SALES}: pumpkin and croissants tie in ${week}, so the crossing week is ambiguous`,
      );
    if (prev !== null && Math.sign(diff) !== Math.sign(prev)) {
      const rows = byWeek(week).map((r) => r._row);
      findings.push({
        id: `pumpkin-crosses-croissants-${week.slice(5).toLowerCase()}`,
        file: SALES,
        where: `${week}, rows ${rows[0]} to ${rows.at(-1)}`,
        amount: `pumpkin ${units(week, PUMPKIN)} vs croissants ${units(week, CROISSANTS)}`,
        problem:
          diff > 0
            ? 'Pumpkin items outsell croissants for the first time'
            : 'Croissants retake the lead',
      });
    }
    prev = diff;
  }

  // Finding: supplier prices that rose more than 5% from August to September.
  const aug = ws.table('suppliers/hollis-prices-2026-08.csv');
  for (const r of ws.table('suppliers/hollis-prices-2026-09.csv')) {
    const before = aug.find((a) => a.item === r.item);
    if (!before) continue;
    const rise = cents(r.price) - cents(before.price);
    if (rise * 20 > cents(before.price))
      findings.push({
        id: `hollis-${slug(r.item)}-rise`,
        file: 'suppliers/hollis-prices-2026-09.csv',
        where: `row ${r._row}`,
        amount: fmt(rise),
        problem: `${r.item} up ${((rise / cents(before.price)) * 100).toFixed(1)}% from August`,
      });
  }

  // Finding: anything at or below its reorder point on the Sunday count.
  for (const r of ws.table('inventory/count-2026-09-20.csv'))
    if (Number(r.on_hand) <= Number(r.reorder_at))
      findings.push({
        id: `reorder-${slug(r.item)}`,
        file: 'inventory/count-2026-09-20.csv',
        where: `row ${r._row}`,
        amount: `${r.on_hand} ${r.unit}, reorder at ${r.reorder_at}`,
        problem: `${r.item} at or below its reorder point`,
      });

  // Catering orders price out from the menu's tray prices.
  const menu = ws.text('menu/fall-2026-menu.md');
  const price = (re: RegExp) => cents(re.exec(menu)?.[1] ?? 'x');
  const tray = price(/pastry tray \(12\) \$(\d+)/);
  const quiche = price(/quiche \(whole, serves 8\) \$(\d+)/);
  const carafe = price(/coffee carafe \(12 cups\) \$(\d+)/);
  for (const r of ws.table('catering/orders-2026-W35-to-W39.csv')) {
    const total =
      Number(r.pastry_trays) * tray + Number(r.quiches) * quiche + Number(r.carafes) * carafe;
    if (total !== cents(r.total))
      errors.push(
        `catering/orders-2026-W35-to-W39.csv row ${r._row}: total ${r.total}, the menu prices it at ${fmt(total)}`,
      );
    if (r.status === 'picked up' && r.pickup_date > TODAY)
      errors.push(`catering/orders-2026-W35-to-W39.csv row ${r._row}: picked up in the future`);
    // Finding: an upcoming Saturday pickup inside the 9 to 11 rush with nobody to pack it.
    if (
      r.pickup_date >= TODAY &&
      r.pickup_day === 'Sat' &&
      r.pickup_time >= '09:00' &&
      r.pickup_time < '11:00' &&
      !r.packed_by
    )
      findings.push({
        id: `unpacked-${r.order.toLowerCase()}`,
        file: 'catering/orders-2026-W35-to-W39.csv',
        where: `row ${r._row}`,
        amount: fmt(cents(r.total)),
        problem: `Saturday ${r.pickup_date} ${r.pickup_time} pickup, nobody assigned to pack it`,
      });
  }
  return { findings, errors };
}
