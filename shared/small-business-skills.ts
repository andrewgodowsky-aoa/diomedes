/**
 * The Small Business pack's playbooks, as data.
 *
 * Written for Diomedes, for the owner of a restaurant, shop or service
 * business who wants the recurring back-office work done the way a good
 * operations manager would do it: from the numbers they actually have, with
 * gaps said out loud, and with anything that would reach a customer, a vendor,
 * an employee or a bank left as a draft for the owner.
 *
 * Every string here is original to Diomedes. The contract each entry has to
 * meet is `PackSkill` in `shared/capability-packs.ts`, and `validateManifest`
 * checks all of it at load: a read-and-draft Mode, declared needs, `acts:
 * false`, and a rendered playbook that fits its budget whole.
 *
 * Nothing here names a provider, a model or a tool. "What you were given"
 * means the documents supplied with the request and any connector data a route
 * hands over, so the same playbook reads correctly on every route.
 *
 * Type imports only: `capability-packs.ts` imports this file's value, so a
 * value import back would be a cycle.
 */
import type { PackSkill } from './capability-packs.js';

const UPLOAD = 'add it to this project in Files (Import)';

export const SMALL_BUSINESS_SKILLS: readonly PackSkill[] = [
  {
    id: 'business-pulse',
    name: 'Weekly business pulse',
    value: 'A one-screen read of how last week went and the three things worth acting on.',
    triggers: ['how did we do this week', 'weekly numbers', 'business health', 'week in review'],
    mode: 'ask',
    starter: 'Give me a pulse on last week: how we did, what changed, and what needs me.',
    inputs: [
      {
        label: 'Sales by day for last week, and the same week last year or last month if you have it',
        required: true,
        need: 'read-sales',
        howToProvide: `export a daily sales summary from your point-of-sale system as CSV or PDF and ${UPLOAD}.`,
      },
      {
        label: 'Labour hours or labour cost for the same week',
        required: false,
        need: 'read-payroll',
        howToProvide: `export the week's timesheet or labour report from your scheduling or payroll system and ${UPLOAD}.`,
      },
      {
        label: 'Bank balance at the start and end of the week',
        required: false,
        need: 'read-bank',
        howToProvide: `download the week's bank statement or transaction export and ${UPLOAD}.`,
      },
      {
        label: 'New reviews from the week',
        required: false,
        need: 'read-reviews',
        howToProvide: `export or copy the week's reviews into a document and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Say which of the data above you were given and the dates each one covers. If sales are missing, stop and ask for them.',
      'Total the week: sales, number of transactions or covers where shown, and average ticket (sales divided by transactions). Show your arithmetic in one line per figure.',
      'Compare with the comparison period only if it is in what you were given. Give the change as an amount and a percentage. If there is no comparison, say so rather than guessing a trend.',
      'Find the best and weakest day and name any day that is far outside the others. Offer a possible reason only when the data shows one, such as a closed day or a large single order.',
      'If labour is supplied, give labour as a share of sales for the week. Do not apply an industry benchmark unless the owner supplied one.',
      'If reviews are supplied, count them, give the average rating, and quote the one line that matters most.',
      'End with at most three actions for this week, each tied to a figure above.',
    ],
    output: {
      shape: 'brief',
      sections: [
        'Headline in one sentence',
        'Key figures',
        'What changed',
        'Worth your attention',
        'Three actions this week',
        'Data used and data missing',
      ],
    },
    visual: { kind: 'bar', about: 'sales by day for the week' },
    drafts: [],
    acts: false,
  },
  {
    id: 'cash-flow-snapshot',
    name: 'Cash flow snapshot',
    value: 'Cash today, what is due in and out over the next few weeks, and the first week money gets tight.',
    triggers: ['cash flow', 'can we make payroll', 'how much cash do we have', 'money coming in and out'],
    mode: 'ask',
    starter: 'Show me a cash flow snapshot for the next four weeks.',
    inputs: [
      {
        label: 'Current bank balance, with the date it was taken',
        required: true,
        need: 'read-bank',
        howToProvide: `download a recent bank statement or balance export and ${UPLOAD}, or type the balance and date into your message.`,
      },
      {
        label: 'Bills and other payments due in the next four weeks',
        required: true,
        need: 'read-accounting',
        howToProvide: `export unpaid bills (accounts payable aging) from your accounting software, or list rent, loans, payroll dates and supplier bills in a spreadsheet, and ${UPLOAD}.`,
      },
      {
        label: 'Money expected in: open customer invoices, or typical weekly sales',
        required: false,
        need: 'read-accounting',
        howToProvide: `export open invoices (accounts receivable aging) or a recent weekly sales summary and ${UPLOAD}.`,
      },
      {
        label: 'Payroll amounts and pay dates',
        required: false,
        need: 'read-payroll',
        howToProvide: `export the last payroll register from your payroll provider and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Say which inputs you have and their dates. Without a starting balance and the payments due, stop and ask for them.',
      'Build a week-by-week table for four weeks: starting cash, money in, money out, ending cash. Put each supplied item in the week it is due.',
      'For money in, use only open invoices with due dates or a weekly sales figure the owner supplied. If you use a past week as the estimate, label it an estimate and name the week it came from.',
      'Mark the first week where ending cash falls below zero or below any minimum the owner named.',
      'List the largest five payments by date and amount so the owner can see what drives the low point.',
      'Suggest options the owner could consider, such as asking a customer to pay an overdue invoice or asking a supplier for later terms. Present them as options, never as advice to borrow, invest or move money.',
    ],
    output: {
      shape: 'table',
      sections: ['Cash today', 'Four-week table', 'Tightest week', 'Largest payments', 'Options to consider', 'Assumptions and data missing'],
    },
    visual: { kind: 'line', about: 'ending cash for each of the four weeks' },
    drafts: [],
    caution: 'accounting',
    acts: false,
  },
  {
    id: 'month-end-prep',
    name: 'Month-end close checklist',
    value: 'A checklist for closing last month: what is reconciled, what is missing, and what to hand your bookkeeper.',
    triggers: ['close the month', 'month end', 'get ready for the bookkeeper', 'reconcile'],
    mode: 'plan',
    starter: 'Help me close last month and get everything ready for my bookkeeper.',
    inputs: [
      {
        label: 'Bank and card statements for the month',
        required: true,
        need: 'read-bank',
        howToProvide: `download each account's statement for the month as PDF or CSV and ${UPLOAD}.`,
      },
      {
        label: 'Transactions or a profit and loss report from your accounting software for the month',
        required: true,
        need: 'read-accounting',
        howToProvide: `export the month's transaction list or profit and loss report and ${UPLOAD}.`,
      },
      {
        label: 'Sales summary for the month',
        required: false,
        need: 'read-sales',
        howToProvide: `export the month's sales summary, including card and cash totals, from your point-of-sale system and ${UPLOAD}.`,
      },
      {
        label: 'Receipts or bills you still have on paper or in email',
        required: false,
        need: 'read-project-files',
        howToProvide: `scan or save them as PDFs or photos and ${UPLOAD}.`,
      },
    ],
    steps: [
      'List every account and period you were given, and every account the documents mention that has no statement.',
      'Where both a statement and the accounting export are supplied, compare their totals for the month and list any difference with its amount.',
      'Compare point-of-sale card and cash totals with bank deposits when both are supplied, and list days that do not match.',
      'List transactions with no category, no receipt noted, or a description too vague to categorise, with date and amount.',
      'Write a numbered checklist in order: reconcile each account, attach missing receipts, resolve each difference, then items to send to the bookkeeper.',
      'Finish with the questions only the owner or bookkeeper can answer.',
    ],
    output: {
      shape: 'checklist',
      sections: ['What was checked', 'Differences found', 'Items needing receipts or categories', 'Close checklist', 'Questions for your bookkeeper'],
    },
    visual: { kind: 'progress', about: 'accounts reconciled out of accounts found' },
    drafts: ['a short note to the bookkeeper listing what is attached and what is still open'],
    caution: 'accounting',
    acts: false,
  },
  {
    id: 'invoice-chase',
    name: 'Chase unpaid invoices',
    value: 'Who owes you, how late each invoice is, and a polite reminder drafted for each one.',
    triggers: ['who owes us', 'overdue invoices', 'chase payments', 'accounts receivable'],
    mode: 'ask',
    starter: 'Who owes us money? Draft reminders for anything overdue.',
    inputs: [
      {
        label: 'Open invoices with customer, amount, invoice date and due date',
        required: true,
        need: 'read-accounting',
        howToProvide: `export open invoices or an accounts receivable aging report from your accounting or invoicing software and ${UPLOAD}.`,
      },
      {
        label: 'Earlier reminders or customer replies',
        required: false,
        need: 'read-leads',
        howToProvide: `save the relevant email threads as PDF or text and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Use the date of the export, or ask for today\'s date if it is not shown, to work out how many days past due each invoice is.',
      'Group invoices: not yet due, 1 to 30 days late, 31 to 60, and over 60. Total each group.',
      'Order the overdue list by amount multiplied by days late, so the largest and oldest come first.',
      'For each overdue customer draft a reminder in a tone that fits how late it is: friendly under 30 days, firm but courteous at 31 to 60, and a direct request for a payment date over 60. Include invoice numbers, amounts and due dates exactly as supplied.',
      'Where an earlier reminder or reply is supplied, reflect it in the draft rather than repeating it.',
      'Flag any invoice that looks disputed or duplicated for the owner to decide before anything is sent.',
    ],
    output: {
      shape: 'draft',
      sections: ['Total owed and total overdue', 'Aging table', 'Who to contact first', 'Reminder drafts', 'Needs your decision'],
    },
    visual: { kind: 'bar', about: 'amount owed in each lateness group' },
    drafts: ['one payment reminder per overdue customer'],
    acts: false,
  },
  {
    id: 'pay-the-bills',
    name: 'Bills to pay',
    value: 'Every bill due soon, checked for duplicates and surprises, in the order to pay it.',
    triggers: ['what bills are due', 'pay the bills', 'accounts payable', 'vendor bills'],
    mode: 'ask',
    starter: 'What bills are due in the next two weeks, and in what order should I pay them?',
    inputs: [
      {
        label: 'Unpaid bills with vendor, amount, bill date and due date',
        required: true,
        need: 'read-accounting',
        howToProvide: `export unpaid bills or an accounts payable aging report from your accounting software, or save the bills themselves as PDFs, and ${UPLOAD}.`,
      },
      {
        label: 'Current bank balance',
        required: false,
        need: 'read-bank',
        howToProvide: `download a recent statement or balance export and ${UPLOAD}, or type the balance into your message.`,
      },
      {
        label: 'Recent paid bills from the same vendors',
        required: false,
        need: 'read-accounting',
        howToProvide: `export the last three months of paid bills and ${UPLOAD}.`,
      },
    ],
    steps: [
      'List each unpaid bill with vendor, number, amount and due date, and total them.',
      'Check for likely duplicates: same vendor and amount within a few days, or a repeated bill number. List each one for the owner to confirm.',
      'Where past bills are supplied, flag any bill more than a quarter above that vendor\'s usual amount, with both figures.',
      'Order the bills by due date, then by consequence of paying late: payroll taxes, rent and loans, utilities, then suppliers. Note any early-payment discount shown on a bill.',
      'If a bank balance is supplied, show what remains after each bill in order and mark the point where money would run short.',
      'Say plainly that the owner makes each payment in their own bank or accounting software. Do not initiate, schedule or promise any payment.',
    ],
    output: {
      shape: 'table',
      sections: ['Total due', 'Pay-in-this-order table', 'Possible duplicates', 'Unusual amounts', 'Cash left after paying'],
    },
    visual: { kind: 'bar', about: 'amount due by week' },
    drafts: ['a note to a vendor asking to extend a due date, only if the owner asks for one'],
    caution: 'accounting',
    acts: false,
  },
  {
    id: 'payroll-prep',
    name: 'Payroll prep check',
    value: 'Hours checked against the schedule before payroll runs: missed punches, overtime and tips flagged.',
    triggers: ['run payroll', 'check timesheets', 'overtime this week', 'tips payout'],
    mode: 'ask',
    starter: 'Check this pay period\'s hours before I run payroll.',
    inputs: [
      {
        label: 'Timesheets or clock-in records for the pay period',
        required: true,
        need: 'read-payroll',
        howToProvide: `export the pay period's time report from your time clock, point-of-sale or scheduling system and ${UPLOAD}.`,
      },
      {
        label: 'The posted schedule for the same period',
        required: false,
        need: 'read-payroll',
        howToProvide: `export or screenshot the schedule and ${UPLOAD}.`,
      },
      {
        label: 'Tips by shift or by employee',
        required: false,
        need: 'read-sales',
        howToProvide: `export the tips report from your point-of-sale system and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Total hours per employee for the period from the timesheets.',
      'List missing punches, shifts with no break where breaks are recorded, and shifts over twelve hours, each with name, date and times.',
      'Where a schedule is supplied, list shifts worked but not scheduled and scheduled but not worked, and differences over thirty minutes.',
      'Flag employees whose weekly hours go past the overtime threshold the owner states; if none is stated, flag anyone over forty in a week and say the threshold depends on local rules.',
      'If tips are supplied, total them per employee and check they add up to the tips report total.',
      'End with the corrections to make in the payroll system before submitting. You run nothing and submit nothing.',
    ],
    output: {
      shape: 'checklist',
      sections: ['Hours by employee', 'Punch and break issues', 'Schedule differences', 'Possible overtime', 'Tips check', 'Fix before you run payroll'],
    },
    visual: { kind: 'table', about: 'hours by employee against scheduled hours' },
    drafts: ['a short message asking an employee to confirm a missing punch'],
    caution: 'employment',
    acts: false,
  },
  {
    id: 'tax-season-organizer',
    name: 'Tax-season organizer',
    value: 'Everything your tax preparer will ask for, what you already have, and what is still missing.',
    triggers: ['tax season', 'get ready for taxes', 'what does my accountant need', 'year end'],
    mode: 'plan',
    starter: 'Help me get organised for tax season: what I have, what is missing, and what to send my preparer.',
    inputs: [
      {
        label: 'Year-end profit and loss and balance sheet, or a full-year transaction export',
        required: true,
        need: 'read-accounting',
        howToProvide: `export them for the tax year from your accounting software and ${UPLOAD}.`,
      },
      {
        label: 'Year-end payroll summaries and contractor payment totals',
        required: false,
        need: 'read-payroll',
        howToProvide: `download the annual payroll summary from your payroll provider and a list of contractor payments, and ${UPLOAD}.`,
      },
      {
        label: 'Loan, lease, equipment purchase and insurance documents from the year',
        required: false,
        need: 'read-project-files',
        howToProvide: `save each as a PDF and ${UPLOAD}.`,
      },
      {
        label: 'Last year\'s return or your preparer\'s document request list',
        required: false,
        need: 'read-project-files',
        howToProvide: `save it as a PDF and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Build the document list from the preparer\'s request list if supplied; otherwise from the categories of document a small business preparer typically asks for: income records, expense records, payroll, contractor payments, assets bought or sold, loans, vehicle use and home office if relevant.',
      'For each item, mark it Have (name the document), Partly, or Missing.',
      'From the supplied financials, list items a preparer will likely ask about: large one-off expenses, equipment purchases, owner draws, uncategorised transactions and year-over-year swings. Describe them; do not decide their tax treatment.',
      'Write the steps to finish, with the missing documents first.',
      'List the open questions for the preparer, worded so the owner can paste them into an email.',
    ],
    output: {
      shape: 'checklist',
      sections: ['Document checklist', 'Likely preparer questions', 'Steps to finish', 'Questions for your preparer'],
    },
    visual: { kind: 'progress', about: 'documents gathered out of documents needed' },
    drafts: ['a cover email to the tax preparer listing what is attached and what is to follow'],
    caution: 'tax',
    acts: false,
  },
  {
    id: 'restock-planner',
    name: 'Restock planner',
    value: 'What is running low, how much to order from whom, and what is sitting unsold.',
    triggers: ['what do I need to order', 'running low', 'restock', 'inventory', 'par levels'],
    mode: 'ask',
    starter: 'What do I need to reorder this week, and how much?',
    inputs: [
      {
        label: 'Current stock counts by item',
        required: true,
        need: 'read-inventory',
        howToProvide: `export a stock count from your inventory or point-of-sale system, or type your latest count into a spreadsheet, and ${UPLOAD}.`,
      },
      {
        label: 'Sales or usage by item over the last two to four weeks',
        required: true,
        need: 'read-sales',
        howToProvide: `export item-level sales for the period from your point-of-sale system and ${UPLOAD}.`,
      },
      {
        label: 'Par levels, supplier, pack size, price and lead time per item',
        required: false,
        need: 'read-inventory',
        howToProvide: `save your order guide or supplier price lists and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Match items across the stock count and the sales or usage data, and list any item that appears in one but not the other.',
      'Work out average daily use per item from the period supplied, and days of stock left at that rate.',
      'Where par levels are given, order enough to return to par. Where they are not, cover lead time plus seven days of use and say that is the assumption.',
      'Round each order up to the supplier\'s pack size when it is supplied, and group the order by supplier with cost where prices are given.',
      'List slow movers: items with stock for more than eight weeks at current use, with their value where cost is known.',
      'Present the order as a draft for the owner to place. Do not place or send any order.',
    ],
    output: {
      shape: 'table',
      sections: ['Running low', 'Suggested order by supplier', 'Slow movers', 'Items that did not match', 'Assumptions'],
    },
    visual: { kind: 'bar', about: 'days of stock left for the items closest to running out' },
    drafts: ['one purchase order per supplier, ready to review'],
    acts: false,
  },
  {
    id: 'review-replies',
    name: 'Review replies',
    value: 'What customers are saying, the patterns behind it, and a reply drafted for every review that needs one.',
    triggers: ['reply to reviews', 'bad review', 'what are customers saying', 'reputation'],
    mode: 'ask',
    starter: 'Go through our recent reviews and draft replies for the ones that need one.',
    inputs: [
      {
        label: 'Recent reviews with rating, date, text and where they were posted',
        required: true,
        need: 'read-reviews',
        howToProvide: `export or copy recent reviews from each review site into a document or spreadsheet and ${UPLOAD}.`,
      },
      {
        label: 'Your usual sign-off, tone and anything you never say in public',
        required: false,
        need: 'read-project-files',
        howToProvide: `write a few lines about how you like to reply and ${UPLOAD}, or say it in your message.`,
      },
    ],
    steps: [
      'Count the reviews by rating and site, and give the average rating for the period.',
      'Group what customers mention into themes such as food, wait, staff, price and cleanliness, with how many reviews mention each and whether mostly praise or complaint.',
      'Pick the reviews that need a reply: every rating of three or below, and any review with a question or a specific complaint.',
      'Draft each reply: thank them by first name only if they gave one, respond to the specific point, avoid arguing facts in public, offer a way to continue offline where it fits, and never offer refunds or compensation unless the owner said to.',
      'Flag any review that mentions a safety, health or legal matter for the owner to handle personally before replying.',
      'End with one or two operational changes the themes point to.',
    ],
    output: {
      shape: 'draft',
      sections: ['Ratings summary', 'Themes', 'Replies to post', 'Handle personally', 'What the reviews suggest changing'],
    },
    visual: { kind: 'pie', about: 'share of reviews by star rating' },
    drafts: ['one reply per review that needs one'],
    acts: false,
  },
  {
    id: 'lead-follow-up',
    name: 'Lead follow-up',
    value: 'New enquiries sorted by how likely and how valuable they are, with a call list and replies drafted.',
    triggers: ['new leads', 'enquiries', 'who should I call', 'follow up with customers', 'quote requests'],
    mode: 'ask',
    starter: 'Sort our recent enquiries and tell me who to call first. Draft the follow-ups.',
    inputs: [
      {
        label: 'Recent enquiries or leads with name, date, what they asked for and how they reached you',
        required: true,
        need: 'read-leads',
        howToProvide: `export leads from your website form, booking tool or CRM, or save the enquiry emails as PDF or text, and ${UPLOAD}.`,
      },
      {
        label: 'Your services, prices or typical job sizes',
        required: false,
        need: 'read-project-files',
        howToProvide: `add your price list or a short description of your services to this project.`,
      },
    ],
    steps: [
      'List each lead with how long ago they got in touch, what they want and whether anyone has replied yet, as far as the supplied data shows.',
      'Score each lead High, Medium or Low from what it says: a clear need, a date or budget, and a service you offer score higher. Give the reason in a few words.',
      'Put anyone who has waited more than one business day without a reply at the top, since speed matters most for a new enquiry.',
      'Write a call list in order with name, what they asked for and one opening line.',
      'Draft a short reply for each High and Medium lead that answers what they asked and proposes one next step. Quote prices only from what the owner supplied.',
      'List leads that look like spam or not a fit, so the owner can decide.',
    ],
    output: {
      shape: 'draft',
      sections: ['Leads waiting longest', 'Call list', 'Reply drafts', 'Low priority or not a fit'],
    },
    visual: { kind: 'stat', about: 'leads received, replied to, and still waiting' },
    drafts: ['one reply per High or Medium lead', 'a call script opening line per lead'],
    acts: false,
  },
  {
    id: 'marketing-week',
    name: 'Marketing week plan',
    value: 'A week of posts and one offer, grounded in what is actually happening at the business.',
    triggers: ['what should we post', 'marketing this week', 'social media ideas', 'promotion', 'newsletter'],
    mode: 'plan',
    starter: 'Plan this week\'s marketing: a few posts and one simple offer.',
    inputs: [
      {
        label: 'What is happening this week: specials, new items, events, slow days to fill',
        required: true,
        need: 'read-project-files',
        howToProvide: 'write a few lines in your message or add your events and specials to this project.',
      },
      {
        label: 'Sales by day or by item, to find slow days and best sellers',
        required: false,
        need: 'read-sales',
        howToProvide: `export recent sales by day and by item from your point-of-sale system and ${UPLOAD}.`,
      },
      {
        label: 'Recent reviews, for words customers already use',
        required: false,
        need: 'read-reviews',
        howToProvide: `export recent reviews and ${UPLOAD}.`,
      },
    ],
    steps: [
      'Name the week\'s one goal, such as filling a slow day or launching an item, from what the owner told you and any sales supplied.',
      'Propose one simple offer that serves the goal. Leave price and discount amounts as blanks for the owner unless they gave them.',
      'Draft three to five posts across the week, each with the day to post, the channel type, the text, and a plain description of the photo to take. Use real items and events only.',
      'Where reviews are supplied, reuse a customer\'s own words as a quote only with a note that the owner should ask permission first.',
      'Draft one short email or text for existing customers if the owner has a list.',
      'Give a way to tell whether it worked, using a figure the owner already has, such as sales on the target day.',
    ],
    output: {
      shape: 'checklist',
      sections: ['Goal this week', 'The offer', 'Post plan by day', 'Customer message', 'How we will know it worked'],
    },
    drafts: ['each post', 'the customer email or text'],
    acts: false,
  },
  {
    id: 'contract-review',
    name: 'Contract read-through',
    value: 'A plain-language summary of a lease, vendor or service agreement, with the clauses worth questioning.',
    triggers: ['review this contract', 'read this lease', 'vendor agreement', 'what am I signing'],
    mode: 'ask',
    starter: 'Read this agreement and tell me in plain words what I would be agreeing to and what to question.',
    inputs: [
      {
        label: 'The full agreement, including schedules and attachments',
        required: true,
        need: 'read-project-files',
        howToProvide: `save the agreement as a PDF or text document and ${UPLOAD}.`,
      },
      {
        label: 'What you want from the deal and any terms already discussed',
        required: false,
        need: 'read-project-files',
        howToProvide: 'say it in your message, or add the relevant emails to this project.',
      },
    ],
    steps: [
      'Say whether the document looks complete; list any schedule or attachment it refers to that you were not given.',
      'Summarise in plain words: who the parties are, what each must do, the term, total cost and payment timing, and how it ends.',
      'List the clauses a small business owner should look at closely, with section numbers and a quoted fragment: automatic renewal, price increases, personal guarantees, exclusivity, termination fees, liability and indemnity, insurance requirements and who pays for repairs.',
      'For each, say in one line why it matters and what question to ask. Do not say whether it is standard, fair, enforceable or legal.',
      'List dates and deadlines the owner would need to track, such as notice periods.',
      'End with the questions to take to the other party and those to take to a lawyer.',
    ],
    output: {
      shape: 'brief',
      sections: ['In plain words', 'Clauses to question', 'Dates to track', 'Questions for the other party', 'Questions for a lawyer', 'Missing pages or attachments'],
    },
    drafts: ['an email to the other party asking the listed questions'],
    caution: 'legal',
    acts: false,
  },
];

/**
 * Small-business work the pack does not carry yet, in the owner's words.
 * Listed so the next slice builds from the same inventory rather than
 * rediscovering it. Nothing here is offered in the app.
 */
export const SMALL_BUSINESS_SKILLS_LATER: readonly { readonly id: string; readonly name: string }[] = [
  { id: 'monday-brief', name: 'Monday brief: the week ahead and what needs you' },
  { id: 'proposal-builder', name: 'Proposal or quote builder' },
  { id: 'hiring', name: 'Job post and candidate screening' },
  { id: 'inbox-manager', name: 'Inbox sorting and reply drafts' },
  { id: 'social-content', name: 'Social content calendar beyond one week' },
  { id: 'seo-visibility', name: 'Search and AI-answer visibility check' },
  { id: 'report-builder', name: 'Custom report builder' },
  { id: 'ticket-deflector', name: 'Customer question answers and FAQ' },
];
