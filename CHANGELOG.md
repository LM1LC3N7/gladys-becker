# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
