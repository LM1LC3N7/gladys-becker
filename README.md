# Becker CentralControl for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for Becker
roller shutters, venetian blinds, screens, awnings and sun sails (Centronic,
CentronicPLUS, B-Tronic) and the weather sensors, through the **CentralControl
CC31, CC41 or CC51**, on the local network (the JSON-RPC API of the box, no
cloud, no Becker relay).

> **Status: version 0.1.0, never been tested with a real box yet.** Built from
> Becker's own Home Assistant integration
> ([becker_centralcontrol_has](https://github.com/DominikStarke/becker_centralcontrol_has),
> MIT) and tested against a simulated box only. Unofficial, not affiliated with
> Becker-Antriebe GmbH.

- Covers: open, close, **stop (never blocked, kept until a read shows it
  applied)**, and the position when the motor gives it back.
- Sensors: sun, wind, rain, twilight, temperature, read only.
- Everything in the user guide: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run cover            # regenerates cover.png
```

The tests run against the SDK's fake Gladys, an in-memory CentralControl on a
virtual clock (`test/helpers/`), a real local HTTP server (`test/rpc.test.js`)
and the real clock sped up 20 times (`test/realclock.test.js`). They never
touch the network.

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the decisions and what comes next.

## License

Apache-2.0 ([LICENSE](LICENSE)); the notice of the ported protocol is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
