# How Nectovia writes

This is the voice for every word a customer reads from this repository: app screens, buttons,
errors, empty states, pack skills, release notes and any document a business owner may open. It is
the product-side version of the website's voice guide, which lives in the private site repository
at `diomedes-site/docs/copy/VOICE.md`. The two agree; the site guide has more on marketing pages.

Andrew decides on voice. Claims, status and prices come from their sources (section 7), never from
this file.

---

## 1. Who is reading

A business owner who has used ChatGPT, at most. A steakhouse owner at 60. A remodeler who only
wants to know how to fix his inventory count. They are busy, they are not impressed by AI talk, and
they will stop reading the moment a sentence makes them work.

A technical reader (an owner's IT person) gets depth from the docs and the details a screen opens
on request. The Software Engineering pack adds the technical view. Depth never comes from wordier
copy on the main screen.

## 2. What we are saying

- **Nectovia is an engineer on the owner's staff.** It works out why something went wrong and
  fixes it, and it builds what is missing. Clerical help is fine, but it is not the lead example.
- **The owner gives it the problem.** They say what is wrong in their own words. They never write
  instructions, pick a model or learn a special way of asking.
- **Job first, feature last.** Start with something going wrong in a real business ("The Saturday
  schedule is a group text and a guess."). Then say what Nectovia does about it. Feature names
  belong in the docs and the roadmap, never in a heading or the first line.

## 3. Sentence rules

- Around 12 words on average. Hard ceiling 25. One idea per sentence.
- "You" for the owner, "we" for Diomedes Systems, "it" or "Nectovia" for the product.
- Contractions. Present tense. Active voice.
- Something concrete in every paragraph: a number, a day, a role, a file, an item.
- At most three items in a list inside a sentence, and at most three verbs in a chain.
- Assert. No "can help you", no "may be able to".
- One line per idea. Cut any sentence that restates a label or explains a control the owner can
  see.

## 4. App rules

These are Andrew's rules for the app's own copy, on top of section 3.

- **No italics.** Not in copy, not as an accent style.
- **No em dashes or en dashes used as punctuation,** and no " - " standing in for one. Use a
  period, a comma or a colon. A range like `Mon–Fri` or `9–5` is fine.
- **No reassurance tails.** Cut a closing sentence that only restates what the line before already
  implies. "Your business is out of credits, so this stopped here." is complete. Adding "Nothing
  more was charged." is the tail. Keep a closing line only when it tells the owner something they
  could not work out, such as "The provider may still have received it."
- **No over-explaining.** The simplest wording wins.
- **No model or vendor names typed into copy.** Names an owner picked or connected come from the
  app's catalog at run time. Nectovia's own choices are named as tiers. In the model picker and
  Settings > Providers, a person's own providers, connections and models appear by name from that
  catalog (Andrew, 2026-10-09).
- **Defined terms stay defined.** Agent, Mode, Team, Project, Files, Trust and the other terms in
  `docs/DIOMEDES_PROJECT_MEMORY.md` keep their meaning and spelling. Do not swap in synonyms.
- **The working words stay playful.** While a person waits, the line under the reply rotates
  sayings such as "Nectovia is rummaging through the archives…", and a running tool gets one in
  the same voice ("putting ink to the quill" while it writes) above its plain line
  (`client/console/working-words.ts`). Andrew keeps them and wants variety (2026-10-08). A voice
  pass leaves them as they are.

The app checks model output against the same habits: `shared/plain-writing-rules.json` holds the
filler openers, closing offers, contrast patterns, hedges and stock phrases it flags. Copy you write
by hand should pass that list too.

## 5. Cut on sight

| Pattern | Example | Do this |
|---|---|---|
| The verb chain | "It works out what's needed, makes the plan, does the work, checks it and reports back." | Pick the one verb that matters here. |
| The noun inventory | "Models, workers, tools, files, connections and automations." | Name one thing the owner recognizes. |
| Abstract stand-ins | "what needs your judgment", "the calls that matter" | Name it: the refund, the schedule, the vendor payment. |
| Mechanism before payoff | Explaining scopes and modes before the owner cares | Payoff first. Mechanism goes to the docs or the technical view. |
| Policy voice | "Access is separate, each with its own scope, time limit and log." | Say it the way you would across a counter. |
| "It" chains | Every sentence starts with "It" | Start with the owner, the moment or the thing. |
| Contrast framing | "It's not X. It's Y.", "rather than", "instead of" | Two positive sentences. |
| Tricolon closers | Three matched phrases to end a section | One specific next step. |
| Stock AI phrases | "handles the rest", "seamless", "robust", "delve", "day or night" | Say the specific version. |
| Filler and offers | "Great question", "Let me know if", "Hope this helps" | Cut. |
| Exclamation marks, hype, apology | "Amazing!", "It started as a hobby" | Say what it is now, plainly. |

## 6. Plain words

Some words mean nothing to an owner, or mean something else. On owner-facing text, use the right
column. The technical view and the docs may keep the left column where precision needs it, and the
defined terms in section 4 stay.

| Avoid | Say |
|---|---|
| export, exports | the report your software lets you download |
| run (as a noun) | job, each time it runs |
| run record | history, the log |
| scope | what it's allowed to touch |
| model, models | the AI |
| agents, workers | its helpers (and only when it matters) |
| API, interface | a way in that your software's maker publishes |
| deployment | setup |
| instruction files | your rules, written down |
| evidence, sources | the rows it used, where it got it |
| tokens, inference, route, adapter, command line | leave out |
| consequential, routine writes | anything that spends money or leaves the building |

## 7. Claims

- **Never say something works unless it is shipped and proven.** `README.md` defines "in source",
  "packaged" and "verified". Use those words exactly.
- **Invent nothing.** No customers, testimonials, counts, time saved or case studies. Sample
  businesses wear a Sample label.
- **Never type a price or a credit amount.** Read it from the source that owns it at the time you
  write.
- **Say "private by default".** Never promise zero data retention.

## 8. Pack skills

A pack skill's text is read by the owner and by whatever AI runs it. Write it for both.

- `name`: the plain name an owner would say. "Chase unpaid invoices", never "Receivables workflow".
- `value`: one line, what the owner gets.
- `starter`: the words the owner would type, in their voice.
- `inputs`: what to read, in the owner's words, and `howToProvide` saying exactly where to get it.
- `steps`: one instruction per step, written so any model follows them. Say what to do when a
  number is missing; never let it guess.
- `drafts`: anything that would reach a customer, vendor, employee or bank is a draft the owner
  sends. A skill never sends, posts or pays.
- `caution`: required on accounting, tax, legal and employment skills.

The existing skills in `shared/small-business-skills.ts` are the model to follow.

## 9. Two tests before it ships

1. **The counter test.** Would you say this sentence out loud to an owner across the counter at
   close? If you would have to put on a voice to say it, rewrite it.
2. **The bistro test.** Would a restaurant manager who has only used ChatGPT know what to do with
   this sentence, and why it matters to their week? If not, name the moment.
