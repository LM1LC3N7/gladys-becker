# Becker CentralControl

Control your Becker roller shutters, venetian blinds, screens, awnings and sun
sails (Centronic, CentronicPLUS and B-Tronic radio) through your **CentralControl
CC31, CC41 or CC51**, and read its sun, wind, rain and temperature sensors, from
Gladys. Everything stays on your local network: the integration talks to the
JSON-RPC API of the box (`http://<box>/cgi-bin/cc51rpc.cgi`), never to the
Becker cloud nor its relay.

> This integration has **never been tested with a real box yet**: it was built
> from Becker's own Home Assistant integration (becker_centralcontrol_has, MIT)
> and tested against a simulated box. Unofficial, not affiliated with
> Becker-Antriebe GmbH.

## Configuration

1. Give your CentralControl a fixed address in your router (DHCP reservation).
2. In the integration's Configuration tab, enter that address (like
   `192.168.1.70`; add `:port` if the box answers on another port than 80).
   Names in `.local` do not resolve in the container: use the IP address.
3. Optionally change the read interval (60 s by default, 30 s to 1 h) and the
   language of the feature names.
4. Save, then **Test the connection**: it lists the covers the box answers with.
5. Add your covers and sensors from the **Discovery** tab.

## What you get

- **Each cover** (shutter, venetian, screen, awning, sun sail, blinds,
  fold-out shutter) becomes a shutter with an **Open / close** feature (open,
  close, stop). When the motor sends its position back (B-Tronic,
  CentronicPLUS: "feedback" in the box), a **Position** feature (0 % closed,
  100 % open) is read at every interval and can be set. Centronic motors give
  no state back: only the commands, never a position.
- An **awning** is reversed, as in Becker's integration: "close" retracts it,
  and its position is the one the box gives.
- **Each sensor** (sun, wind, rain, twilight, temperature) becomes a read-only
  sensor. Sun and twilight are levels 0 to 15, wind a level 0 to 11 (the
  sensor's own scale, not km/h), rain 0 (dry) or 1 (rain), temperature in °C.
  A value outside these ranges is not published.
- Doors, garage doors, roof and tilt windows, lights, switches, heating and
  scenes of the box are not offered in this version.

## The stop

The **stop** is never blocked: not by a read in progress (it cuts it), not by a
pause asked by the box, not by another command waiting, not by the list of the
box not yet read, not by a configuration that cannot be read (it goes to the
last address known), not by `/data` being slow or unreadable. It leaves at once;
within 3.3 s it is written again every 250 ms until the box answers.

The stop is kept (in memory, and in `/data` without waiting for it) until a read
of the cover, started after the box answered, shows it no longer moves:

- a stop the box has not answered is sent again after 5 s, 10 s, 20 s, 30 s,
  then every minute and at each successful read, **without end and without age
  limit**: only an answered send counts as a try (a timeout, a cut connection,
  a 429 or a 5xx does not);
- answered but the cover still moves the same way: sent again, **3 answered
  tries at most**, then shown "still moving" on the badge;
- the cover moves **the other way**: a move started elsewhere (app, remote) is
  left alone;
- a motor without feedback, or a box that does not say whether it moves: one
  answered stop is all there is;
- a **newer command** of that cover (open, close, position) accepted by the box
  replaces the stop; a newer command without answer does not (the stop goes);
- after a restart, the stops kept in `/data` leave at once, before Gladys is
  reached.

A stop is not sent only while **no address of the box is known at all** (never
configured, nothing in `/data`): it is kept and leaves as soon as an address is
saved. Clicking stop also drops the commands of that cover not yet sent: nothing
clicked before a stop leaves after it.

## The close

**Close** follows the same path (ahead of everything, cuts the reads, not held
by a pause nor by the list not yet read, written again every 250 ms within
3.3 s), but it is never sent again after a restart. It is refused only when the
box now lists that cover with **another type** (its direction could be the
other way: an awning closes up, a shutter down).

## Open and position

They are refused, with the reason on the device's badge, when: the
configuration is not valid; the box asked to slow down (429, 5xx; the pause is
kept across a restart, 1 min to 6 h); the cover has not been listed by the box
since the start (or since it stopped answering); the box lists that id with
another type; the motor gives no position (position only); the value is not a
whole number from 0 to 100; 32 commands already wait; the command cannot leave
within 3.5 s; or a stop or close of that cover came after it.

Several covers move at once (a scene of five covers sets all five). A command is
said **applied** only when a read after it shows the asked position (5 s and
20 s after); otherwise the badge says "accepted, waiting for the read back",
"not applied yet", "sent, without confirmation" (no answer) or "nothing sent".

## Reads

The positions and sensors are read at the interval you set, one request at a
time; the lists of the box every 10 minutes. A read that left before a command
of a cover is never applied after it, and reads apply in the order they left. A
cover or the sensor list that fails never stops the others. A restart (same box) never
reads sooner than the interval.

## Troubleshooting

- **"not yet read back from the box"**: the box was not listed yet in this
  session; wait for the next read or press Test the connection.
- **"another type of cover"**: the id of that device now holds another cover in
  the box (reconfigured). Delete the device and add it again from Discovery.
- **"/data unreadable"**: the file `/data/becker-state.json` cannot be read; it
  is left as it is and the stops are not kept across a restart.
- The logs never hold an address you typed by mistake.
