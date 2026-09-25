import { Workspace, cents, fmt, listRows, type CheckResult, type Finding } from '../workspace.js';

/** The wine shop Lookback on the site: 7 items, $1,230.00 (diomedes-site src/data/lookback.ts). */
export const WINE_LOOKBACK = {
  items: 7,
  totalCents: 123000,
  prefixes: ['short-', 'case-price-', 'credit-', 'club-'],
};

export function checkWine(ws: Workspace): CheckResult {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const posted = new Map<
    string,
    { case_price: number; break_cases: number | null; price_at_break: number | null }
  >();
  for (const file of [
    'distributors/fall-line-posted-prices-2026-06-to-09.csv',
    'distributors/tidewater-posted-prices-2026-06-to-09.csv',
  ])
    for (const r of ws.table(file))
      posted.set(r.sku, {
        case_price: cents(r.case_price),
        break_cases: r.break_cases ? Number(r.break_cases) : null,
        price_at_break: r.price_at_break ? cents(r.price_at_break) : null,
      });
  const catalog = new Map(ws.table('catalog/wines.csv').map((r) => [r.sku, r]));

  // Sales rows add up and use the shelf price.
  const sales = ws.table('sales/weekly-sales-2026-W30-to-W38.csv');
  for (const r of sales) {
    if (cents(r.revenue) !== Number(r.bottles) * cents(r.shelf_price))
      errors.push(`sales row ${r._row}: revenue is not bottles x shelf_price`);
    if (r.shelf_price !== catalog.get(r.sku)?.shelf_price)
      errors.push(`sales row ${r._row}: shelf price differs from the catalog`);
  }
  const w38 = new Map(
    sales.filter((r) => r.week === '2026-W38').map((r) => [r.sku, Number(r.bottles)]),
  );
  const weekend = new Map<string, number>();
  for (const r of ws.table('sales/weekend-2026-09-18-to-09-20.csv'))
    weekend.set(r.sku, (weekend.get(r.sku) ?? 0) + Number(r.bottles));
  for (const [sku, n] of weekend)
    if (n > (w38.get(sku) ?? 0)) errors.push(`weekend sales of ${sku} exceed all of W38`);

  // Invoices: each file matches the register; every line is extended correctly.
  const register = ws.table('invoices/register.csv');
  const lines = new Map<
    string,
    { inv: string; file: string; line: number; sku: string; cases: number; price: number }
  >();
  for (const inv of register) {
    const rows = ws.table(inv.file);
    const total = rows.reduce((c, r) => c + cents(r.extended), 0);
    if (total !== cents(inv.total))
      errors.push(`${inv.file}: lines sum to ${fmt(total)}, the register says ${inv.total}`);
    if (Number(inv.lines) !== rows.length)
      errors.push(`${inv.file}: ${rows.length} lines, the register says ${inv.lines}`);
    for (const r of rows) {
      const price = cents(r.case_price);
      if (cents(r.extended) !== Number(r.cases) * price)
        errors.push(`${inv.file} line ${r.line}: extended is not cases x case_price`);
      lines.set(`${inv.invoice}/${r.line}`, {
        inv: inv.invoice,
        file: inv.file,
        line: Number(r.line),
        sku: r.sku,
        cases: Number(r.cases),
        price,
      });
      // Finding: charged above the posted price, including a case break not applied.
      const p = posted.get(r.sku);
      if (!p) {
        errors.push(`${inv.file} line ${r.line}: ${r.sku} is not on a posted list`);
        continue;
      }
      const expected =
        p.break_cases !== null && Number(r.cases) >= p.break_cases
          ? p.price_at_break!
          : p.case_price;
      if (price > expected)
        findings.push({
          id: `case-price-${inv.invoice}-line-${r.line}`,
          file: inv.file,
          where: `line ${r.line}`,
          amount: fmt((price - expected) * Number(r.cases)),
          problem: `${r.description}, ${r.cases} cases at ${r.case_price}, posted ${fmt(expected)}`,
        });
      else if (price < expected)
        errors.push(`${inv.file} line ${r.line}: billed below the posted price`);
    }
  }

  // Finding: delivered short against the receiving log.
  const counted = new Set<string>();
  for (const r of ws.table('receiving/receiving-log-2026-06-23-to-09-17.csv')) {
    const key = `${r.invoice}/${r.line}`;
    const l = lines.get(key);
    if (!l || l.sku !== r.sku) {
      errors.push(`receiving row ${r._row}: no invoice line ${key} for ${r.sku}`);
      continue;
    }
    counted.add(key);
    const short = l.cases - Number(r.cases_counted);
    if (short > 0)
      findings.push({
        id: `short-${l.inv}-line-${l.line}`,
        file: l.file,
        where: `line ${l.line}`,
        amount: fmt(short * l.price),
        problem: `${l.cases} cases billed, ${r.cases_counted} counted in`,
      });
    if (short < 0) errors.push(`receiving row ${r._row}: more counted than billed`);
  }
  for (const key of lines.keys())
    if (!counted.has(key)) errors.push(`invoice line ${key} was never counted in`);

  // Statements: running balances add up and periods chain.
  const statements = ws.list('statements');
  const periods: { file: string; dist: string; from: string; to: string; refs: Set<string> }[] = [];
  for (const dist of ['fall-line', 'tidewater']) {
    let carried: number | null = null;
    for (const file of statements.filter((f) => f.includes(`/${dist}-`)).sort()) {
      const rows = ws.table(file);
      let balance = cents(rows[0].balance);
      if (carried !== null && balance !== carried)
        errors.push(
          `${file}: balance forward ${rows[0].balance} is not the previous closing balance`,
        );
      for (const r of rows.slice(1, -1)) {
        balance += cents(r.amount);
        if (balance !== cents(r.balance))
          errors.push(`${file} row ${r._row}: running balance does not add up`);
      }
      if (cents(rows.at(-1)!.balance) !== balance)
        errors.push(`${file}: closing balance does not add up`);
      carried = balance;
      periods.push({
        file,
        dist,
        from: rows[0].date,
        to: rows.at(-1)!.date,
        refs: new Set(rows.map((r) => r.reference)),
      });
      for (const inv of register.filter(
        (i) =>
          i.file.includes(`/${dist}-`) && i.date >= rows[0].date && i.date <= rows.at(-1)!.date,
      ))
        if (!rows.some((r) => r.reference === `Invoice ${inv.invoice}` && r.amount === inv.total))
          errors.push(`${file}: invoice ${inv.invoice} is missing or differs`);
    }
  }

  // Finding: a credit memo that no statement ever applied.
  for (const file of ws.list('credits')) {
    const text = ws.text(file);
    const memo = /\| Credit memo \| (\d+) \|/.exec(text)?.[1];
    const date = /\| Issued \| (\d{4}-\d\d-\d\d) \|/.exec(text)?.[1];
    const amount = /\| Credit amount \| \$([\d.,]+) \|/.exec(text)?.[1];
    if (!memo || !date || !amount) {
      errors.push(`${file}: memo number, date or amount unreadable`);
      continue;
    }
    const dist = file.includes('/fall-line-') ? 'fall-line' : 'tidewater';
    const period = periods.find((p) => p.dist === dist && date >= p.from && date <= p.to);
    if (!period) {
      errors.push(`${file}: no statement covers ${date}`);
      continue;
    }
    if (!period.refs.has(`Credit memo ${Number(memo)}`))
      findings.push({
        id: `credit-${dist}-${memo}`,
        file,
        where: `memo ${Number(memo)}, not on ${period.file}`,
        amount: fmt(cents(amount)),
        problem: 'Credit memo never applied',
      });
  }

  // Finding: club charges declined and never retried.
  const club = ws.table('club/september-run.csv');
  const declined = club.filter((r) => r.result === 'declined' && r.retry_result !== 'approved');
  for (const r of club)
    if (r.retry_result === 'approved' && r.result !== 'declined')
      errors.push(`club row ${r._row}: retried a charge that was not declined`);
  if (declined.length)
    findings.push({
      id: 'club-declined-2026-09-20',
      file: 'club/september-run.csv',
      where: listRows(declined.map((r) => r._row)),
      amount: fmt(declined.reduce((c, r) => c + cents(r.amount), 0)),
      problem: `${declined.length} club cards declined, no retry and no note`,
    });

  // Finding: the reorder. Under two weeks of stock at the W35 to W38 average.
  const recent = ['2026-W35', '2026-W36', '2026-W37', '2026-W38'];
  for (const r of ws.table('inventory/shelf-count-2026-09-20.csv')) {
    const sold = sales
      .filter((s) => s.sku === r.sku && recent.includes(s.week))
      .reduce((n, s) => n + Number(s.bottles), 0);
    const perWeek = sold / 4;
    const onHand = Number(r.on_hand_bottles);
    if (onHand < 2 * perWeek) {
      const size = Number(catalog.get(r.sku)!.case_size);
      const cases = Math.max(1, Math.ceil((4 * perWeek - onHand) / size));
      findings.push({
        id: `reorder-${r.sku.toLowerCase()}`,
        file: 'inventory/shelf-count-2026-09-20.csv',
        where: `row ${r._row}`,
        amount: `${cases} ${cases === 1 ? 'case' : 'cases'}`,
        problem: `${r.wine}: ${onHand} bottles, ${(onHand / perWeek).toFixed(1)} weeks at ${perWeek} a week`,
      });
    }
  }

  const lookback = findings.filter((f) => WINE_LOOKBACK.prefixes.some((p) => f.id.startsWith(p)));
  const total = lookback.reduce((c, f) => c + cents(f.amount), 0);
  if (lookback.length !== WINE_LOOKBACK.items || total !== WINE_LOOKBACK.totalCents)
    errors.push(
      `the site's wine Lookback is 7 items and $1,230.00; the files give ${lookback.length} items and $${fmt(total)}`,
    );
  return { findings, errors };
}
