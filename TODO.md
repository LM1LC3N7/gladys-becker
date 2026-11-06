# TODO — Becker CentralControl

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-11-05): JSON-RPC of the CentralControl over
      HTTP (becker_centralcontrol_has v.0.0.7, MIT), covers and sensors in the
      Discovery, positions and sensors read at the interval, open / close /
      stop / position, stop never blocked and kept in `/data` until a read shows
      it applied, close on the same path, order rules (barrier, read sequence),
      pause on 429/5xx kept across restarts, badges, en/fr, docs, cover.
      Tested against a simulated box on 127.0.0.1 only.
- [x] **Review r1 fixes** (2026-11-05): id echo optional, any answer counts
      as a try, read back under pause, /data read again, the guards a mutant
      showed without a test (mutant list versioned in
      `scripts/mutants.list.mjs`, run by `scripts/mutants.mjs`).
- [x] **Review r2 fixes** (2026-11-06): lists read at start and by the Test
      button, close never blocked (refused only for a non-cover id), longer
      windows in one-at-a-time mode, text id echo, late /data address, removed
      cover. Suite run 20 times in a row under Node 22.
- [ ] **Milestone 2 — real box**: run against a real CC31/CC41/CC51 (see "To
      check"); turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: doors and windows (behind an option, never a
      switch), slats (venetian `step`), presets, lights and switches, scenes of
      the box, the reference's "invert position" option.
- [ ] **Milestone 4 — first release**: Docker image, Release workflow, topic,
      GHCR package public.

## To check on a real box

- The `result` of `group_send_command` (taken as accepted when it has no
  `error`) and the `error` codes of a refused command (wind or rain alarm).
- Whether `group_get_state` always gives `moving_up` / `moving_down` (without
  them a stop is not checked by a read: one answered stop is all there is).
- Whether the box echoes the JSON-RPC `id` (checked when echoed; absent, null
  or 0 accepted: one connection per request).
- Whether the box serves several requests at once (several covers of a scene
  are commanded in parallel, as Home Assistant does, up to 8; one command left
  without answer while others are in flight switches to one at a time).
- The ids of groups and remotes: same numbering space or not (kept apart here).
- Whether the API gives a serial number or a MAC of the box (none known: see
  "Identity" below).
- How the sun / twilight / wind levels map to physical units.

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) for the first milestone, as the lot asks; from now on the
  Release workflow bumps it.
- **SDK** `^0.16.0` (latest published, 2026-11-05).
- **Categories** `lighting` (covers, per the catalog table) and `environment`
  (weather sensors). No `keywords` / `countries` (they need Gladys 5.3.0).
- **Local only**: the reference sends the headers of the Becker relay
  (`Host`/`Origin: gw.b-tronic.net`) and an optional cookie even locally; they
  are not reproduced. No cloud.
- **Identity**: the API gives no serial number nor MAC of the box. External ids
  are `ext:becker:group:<id>` / `ext:becker:remote:<id>` (the item id of the
  box), frozen. Each device keeps the type it was created with
  (`BECKER_TYPE`); a list read showing another type at that id refuses every
  command but the stop, and the badge says so. Open and position need the
  cover to be listed in the current session.
- **Scope**: doors, door pulses, roof and tilt windows are left out (opening
  them is sensitive: a later milestone, behind an option, never a switch);
  dimmers, switches, heaters, thermostats and scenes too.
- **Protective commands**: stop and close. The stop is kept in `/data` (with
  the address it was clicked for) until a read started after its answer shows
  the cover still, and is never given up while unanswered; close is never
  replayed after a restart.
- **Direction of a contradicted stop**: taken from a read of less than 2 min
  before the click; a move the other way after the stop is a move started
  elsewhere and is left alone.
- **Parallel commands**: up to 8 covers at once (a scene), one command at a
  time per cover; the periodic reads one at a time; a stop or close cuts the
  periodic read in flight.
- **300 states a minute** at most, all devices together; a state left out is still changed at the next read.
- **Sensor values**: sun and twilight 0-15, wind 0-11, rain 0/1 (reference
  README), temperature -40..80 °C; anything else is not a measure. No unit for
  the levels (the core's units do not fit a level).
