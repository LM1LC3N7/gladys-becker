# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Added

- Becker covers (shutter, venetian, screen, awning, sun sail, blinds, fold-out
  shutter) of a CentralControl CC31/CC41/CC51, on the local network: open,
  close, stop, and the position when the motor gives it back.
- Sun, wind, rain, twilight and temperature sensors, read only.
- A stop never blocked, kept in `/data` until a read shows it applied, sent
  again without end until the box answers (only an answered send counts as a
  try, 3 at most), and sent at start from `/data` before Gladys is reached.
- Badges saying where each command stands; "Test the connection" button.
- Documentation in English and French.

### Fixed

- A box that does not echo the JSON-RPC id (absent, null, 0) is accepted.
- Any answer of the box to a stop counts as a try (a refusal, an error page, a
  slow answer up to 3.3 s): no more endless bursts of stops.
- The read back of a stop waits for a pause the box asked, backs off, and ends
  when the box refuses that state.
- `/data` slower than 2 s at start is read again every 30 s; its stops are sent
  then, and nothing is written before it is read.
- 300 states a minute even with publications at the same time; a stop the box
  did not accept is acked as failed; a box that seems serial gets one command at
  a time; a close without a known type is refused; a new address of the box must
  be confirmed by "Test the connection"; all covers failing is not
  "connected"; a cover missing from one list is kept until the next.
- After a restart, the lists of the box are read at once (open and position no
  longer refused for up to an interval); "Test the connection" lists the covers.
- Close is never blocked: it goes after an address change or without a known
  type (direction of a shutter), refused only for an id the box lists as
  something else than a cover.
- One-at-a-time mode: commands leave until 3.8 s and are answered until 4.7 s,
  so a scene of five slow covers sets all five.
- An id echoed as a text equal to ours is accepted; an address change is seen
  even when /data is read late; a cover the box refuses to read (removed) does
  not make the box unreachable nor slow the other reads.

[Unreleased]: https://github.com/LM1LC3N7/gladys-becker/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-becker/releases/tag/v0.1.1
