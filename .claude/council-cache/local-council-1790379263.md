# Local council — pulling a flash dump from the dashboard

Local council: all four perspectives are Claude playing different roles, not different
vendors. Agreement is a shared prior to stress-test, not independent confirmation.

Roles: devil, simplicity, maintainability, dx. Question: which of A / B / C / A-prime for
triggering a ChipSat flash pull from the ground dashboard.

## Two premises in the question were wrong, and they were mine

- "Step 4 is only envelope parsing." No. flash_to_ground.py is time policy: date_records,
  kBootGapMs, dropping unanchored boots when others are anchored, basis=anchor/start/none
  feeding the time_source marker. Judgement code. B is bigger than I claimed, not smaller.
- "Two implementations of the 64-byte record format." There is one. parse_dump reads
  flash_dump's ASCII output ("record N boot B ms T" + 55 hex bytes); the Python never sees
  a 64-byte record. The real coupling is firmware print format to parser.

## The finding that outranks the question

Software/V2_6_X/tools/ is untracked in git (`?? Software/V2_6_X/tools/`). The logic that
cost five hardware-only bugs has no commits, no history, no tests in either repo, and one
`git clean -fdx` deletes it. Of 8 saved dump.txt captures, zero contain two "found " lines,
so last_dump's one branch has no recorded example. Duplicating (B) or depending on (A, A')
this code is a second-order worry next to the fact that it is unprotected.

## Where the roles landed

- simplicity: write zero Rust. flash_replay.py already finds the app via descent-ground.url,
  checks /api/health, starts it with --no-browser, serves the log and opens ?log=. The delta
  is who presses go. A button that works on one bench is UI debt.
- dx: a button is right, but a pull is a job, not a request. hub.onFlash is nulled on panel
  close (app.js:252), so closing the panel mid-operation loses all progress — tonight's "is
  it hung?" trap, still live. Needs GET-able state, a transcript on disk, and a sticky
  failure on the board row: if step 5 fails the board runs dump firmware and looks fine.
- maintainability: A-prime, but pin parse_dump / date_records / last_dump against the real
  captures first. The missing primitive is that the app cannot serve a log file at all — a
  read-only GET /api/log/<name> deletes the Python temp server, both CORS headers and the
  blocking loop, and fixes that the app cannot replay its own log.
- devil: A-prime's "then opens the log it writes" cannot work — open_in_ground ends in
  serve_forever and never exits; the only terminating mode opens nothing. Shelling out also
  hands a DTR-asserting port sweep to a program whose founding rule is not to do that, and
  makes each program able to launch the other. Prices a cheaper shape: the tool writes into
  the app's own directory, the app notices and offers it.

## Genuine tensions

- Is a button worth anything? simplicity and devil say the loop already exists and the delta
  is one keystroke. dx says the operator experience during a six-minute, five-failure-point
  operation is the whole point and a terminal gives him nothing to re-attach to.
- Standalone-ness: devil argues it is already gone for this feature, since steps 2 and 5 need
  the sibling toolchain under every option including B. The honest axis is which repo owns
  toolchain knowledge, and the answer stays "the flight one".

## What no role defended

Nobody defended C. Nobody defended A as stated. Three of four found holes in A-prime, one
of them fatal as described.

## Direction

1. Get tools/ into version control and pin the three pure functions against the 8 captures.
   Not the ground repo's to do — flag it.
2. Add read-only GET /api/log/<name> over the app's own directory. Smallest change, fixes a
   real gap (the app cannot replay its own log), deletes code in the sibling repo, and is a
   prerequisite for any button.
3. Notice a log dropped into the app's directory and offer it in the dashboard. Most of the
   button, no shell-out, no cycle, no execution surface.
4. Only then revisit a literal button, with job semantics, if still wanted.
