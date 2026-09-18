# Design Center — quick start

This is for the person sitting at the computer, not for a programmer. It takes about ten
minutes and you do not need to understand anything in it beforehand.

**What the Design Center is.** It is the one place inside Diomedes where you change how
Diomedes looks — its colours, its type, how round the corners are, how much things move, and
the pictures behind it. It runs on this computer. You do not need an AI, an account, an
internet connection, a model, a prompt or a budget to use it. Nothing you do in it is sent
anywhere, and nothing you do in it starts any work.

**One thing to know before you open it.** Today, saving and applying a design has to be turned
on when Diomedes is started. Skip to *"If the screen says a plan is required"* at the bottom
if that is what you see — you will still be able to look, but not to keep anything.

---

## 1. Open it

1. Open Diomedes.
2. Click **Settings** (top right of the window).
3. Click **Design Center** in the list down the left-hand side.
4. Click **Open Design Center**.

Settings closes and the Design Center fills the window. The app is still underneath it,
exactly as you left it; nothing restarted.

## 2. What you are looking at

There are four parts.

- **The left** is a list of the pieces you can look at — **Buttons**, **Navigation rail**,
  **Conversation**, and so on. Clicking one scrolls the middle to it. Underneath it, once you
  have saved any, is **Your themes**.
- **The middle** is the *preview*. It is not a picture of Diomedes — it is real Diomedes
  buttons, real messages, a real approval box, drawn with fixture examples. It shows you
  exactly what you will get.
- **The right side** is the *inspector*: every setting you can change, grouped under
  headings like **Your colours**, **Type**, **Surfaces and controls** and **Movement**.
- **The top** has the two things that decide what you are designing: **This app** or
  **Website**, and **Design** or **Interact**.

**Design and Interact.** In **Design** mode, clicking a button in the preview *selects* it so
you can change it. The button does not do anything — nothing runs, nothing is sent, no work
starts. In **Interact** mode the preview's buttons behave like buttons, so you can see what a
pressed one looks like. Neither mode touches your real projects.

## 3. Change something

Try this first, because it is the clearest:

1. In **Surfaces and controls**, drag **Control radius** to the left.
2. Watch the preview. The corners go square immediately.
3. Look at the rest of the window — the app around the Design Center has not changed at all.

That is the rule for everything here: **you are editing a design, not the app.** The app only
changes when you press **Apply**.

Other things worth trying:

- **Your colours** — the colours that are yours to pick.
- **Colours that mean something** — the colours Diomedes uses for *pay attention* and
  *something failed*. These stay readable whatever you choose; if you pick something the app
  cannot make readable, it will say so rather than let it through.
- **Type** — the lettering, and how big and how far apart it is.
- **Movement** — how much things slide and fade. If this computer is set to reduce motion,
  Diomedes obeys that setting no matter what you choose here.

**If you go too far:** **Undo** and **Redo** at the top step back and forward through your
changes. **Reset theme** puts everything back to how the design was when you opened it.

## 4. Put a picture in

1. Open the **Pictures** part of the inspector.
2. Choose a picture from this computer — a PNG, a JPEG or a WebP.
3. Pick where it goes, and move the sliders to place it.

Two things Diomedes does on purpose here, and will tell you about:

- A picture used as a **texture** behind text is turned down until the text over it is still
  properly readable. If you wanted it bolder, Diomedes says so and says why in plain words.
- A file Diomedes cannot read — the wrong kind of file, or a broken one — is refused with one
  sentence explaining it. Nothing crashes, and nothing half-imports.

## 5. Keep it

- **Apply** makes the design the one the app wears. The app changes colour where it stands.
  It does not restart, nothing you were writing is lost, and nothing you were reading scrolls
  away.
- **Save as new theme** keeps a copy under its own name so you can go back to it. The pictures
  come with it.
- **Versions** shows every version you have saved, and lets you go back to one.
- You do not have to remember to save while you work. A few seconds after you stop changing
  things, Diomedes quietly keeps a draft. A draft is never the applied design — a power cut
  while you are sliding a slider cannot leave the app wearing something half-finished.

## 6. Use it on the website too

The Design Center designs the app *and* the website; the switch at the top says which you are
looking at.

1. Click **Website** at the top.
2. Diomedes tells you whether this design can be used on the website, plainly, before you do
   anything.
3. Click **Export for website**. You get one file ending in `.diomedes-theme`, saved on this
   computer. It holds the design and its pictures, all in one file.

To use it, the website's own **Website Studio** has to be running on this computer. Diomedes
checks and tells you:

- If it says **Running**, click **Open Website Studio** and upload the file there.
- If it says **Not running**, open the folder where the website lives on this computer,
  double-click **Start Website Studio**, wait for the black window to say it is ready, and
  press **Check again**.

That check never leaves this computer.

## 7. Putting it all back

If you want Diomedes to look the way it did out of the box: **Settings → Appearance**, and
pick one of the built-in schemes. That always works — it needs no plan, no account and no
internet, and neither does changing the text size with `Ctrl +` and `Ctrl -`. Being able to
put your own app back the way it was is never something you have to pay for.

---

## If the screen says a plan is required

You will see a line saying customization requires an active plan, and **Apply**, **Import** and
**Save as new theme** will not be there.

That is honest, not broken. **Customization is not something you can buy yet** — there is no
signup, no checkout and no plan to be on. Until there is, saving and applying a design has to
be switched on when Diomedes starts, by starting it with `DIOMEDES_DESIGN_AUTHORING=1` set.
Ask Andrew to start it that way; it is one setting and it grants nothing except designing on
this computer — no account, no spending, and no authority for any agent.

Everything else on this page still works without it: you can open the Design Center, change
anything, watch the preview, and export a `.diomedes-theme` file. What you cannot do is make
it the design the app wears.

---

## The short version

| I want to… | Do this |
|---|---|
| See what a change looks like | Just make it. The preview updates; the app does not. |
| Undo | **Undo**, or **Reset theme** for all of it |
| Make the app look like this | **Apply** |
| Keep a copy | **Save as new theme** |
| Go back to an older one | **Versions** |
| Use it on the website | **Website** → **Export for website** |
| Put everything back | **Settings → Appearance**, pick a built-in scheme |
