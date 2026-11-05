// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration), the vocabulary of the Becker CentralControl and the tuning of
// the integration.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Languages of the feature names (manifest `language` options). */
export const LANGUAGES = ['fr', 'en'];

/** Bounds of the read interval (seconds), mirrored by the manifest. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/**
 * The JSON-RPC API of the CentralControl CC31/CC41/CC51 (Becker's own Home
 * Assistant integration, becker_centralcontrol_has, MIT): a POST of a JSON-RPC
 * 2.0 object followed by a NUL byte to `http://<box>/cgi-bin/cc51rpc.cgi`, the
 * answer being JSON (a NUL byte may end it). Local only: the headers of the
 * Becker relay (`Host`/`Origin: gw.b-tronic.net`) the reference sends are
 * never sent here, nor any cookie.
 */
export const BOX = {
  port: 80,
  path: '/cgi-bin/cc51rpc.cgi',
};

export const METHODS = {
  LIST: 'deviced.deviced_get_item_list',
  COMMAND: 'deviced.group_send_command',
  GROUP_STATE: 'deviced.group_get_state',
  ITEM_STATE: 'deviced.item_get_state',
};

/**
 * The cover types handled (`device_type` of a group). Doors, door pulses,
 * roof and tilt windows, dimmers, switches, heaters and thermostats are left
 * out of this version (see TODO.md): opening a door or a window is a
 * sensitive command.
 */
export const COVER_TYPES = new Set([
  'shutter',
  'venetian',
  'screen',
  'awning',
  'sun-sail',
  'shutter-blinds',
  'shutter-foldout',
]);

/**
 * Types whose move direction is reversed (the reference reverses the awning
 * only): "close" an awning is retracting it, Becker's "up" (-1); its position
 * in Gladys is the value of the box, never 100 minus it.
 */
export const REVERSED_TYPES = new Set(['awning']);

/** The values each sensor type gives (reference `REMOTE_SUPPORTED_VALUES`). */
export const SENSOR_TYPES = {
  'sensor-sun': ['sun'],
  'sensor-wind': ['wind'],
  'sensor-rain': ['rain'],
  'sensor-dawn': ['dawn'],
  'sensor-temperature': ['temp'],
  'sensor-sun-wind': ['sun', 'wind'],
  'sensor-sun-rain': ['sun', 'rain'],
  'sensor-sun-wind-rain': ['sun', 'wind', 'rain'],
  'sensor-sun-wind-rain-temp': ['sun', 'wind', 'rain', 'temp', 'dawn'],
  'sensor-sun-wind-rain-dawn': ['sun', 'wind', 'rain', 'dawn'],
};

/**
 * The bounds of each sensor value (the reference README: sun 0-15, wind 0-11,
 * rain 0 or 1); a value out of them is not a measure and is never published.
 */
export const SENSOR_BOUNDS = {
  sun: { min: 0, max: 15, integer: true },
  wind: { min: 0, max: 11, integer: true },
  rain: { min: 0, max: 1, integer: true },
  dawn: { min: 0, max: 15, integer: true },
  temp: { min: -40, max: 80, integer: false },
};

/** The feature keys (frozen: the external ids end with them). */
export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
};

/** Gladys COVER_STATE values (shutter `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };

/** Becker `move` values. */
export const MOVE = { UP: -1, STOP: 0, DOWN: 1 };

export const LIMITS = {
  /** An answer to a list (the box lists every item it knows). */
  listBytes: 256 * 1024,
  /** Any other answer (a state, a command). */
  answerBytes: 16 * 1024,
  /** Items of one list taken into account. */
  items: 200,
  /** Characters of a name read from the box kept in Gladys. */
  name: 60,
  /** Characters of a badge or status message (SDK limit). */
  message: 200,
  /** Largest item id accepted (the box numbers its items from 1). */
  itemId: 2 ** 31 - 1,
  /** Commands of different covers in flight at once (a scene). */
  parallelCommands: 8,
  /** Commands waiting, all covers together (not counting stops and closes). */
  queue: 32,
  /** Size of the /data file read back. */
  stateBytes: 64 * 1024,
  /** Stops kept in /data. */
  pendingStops: 200,
  /** States published per minute, all devices together (Gladys rule). */
  statesPerMinute: 300,
};

export const TIMINGS = {
  /** One send of a stop or a close waits this long for its answer. */
  protectiveAttempt: 1200,
  /** A stop or close that got no answer is written again this often within its budget. */
  protectiveRetry: 250,
  /** Gladys acks a set_value within 5 s: a stop or close answers within this. */
  protectiveBudget: 3300,
  /**
   * A stop that got no answer within its budget is sent again after these
   * delays, then every minute, without end: only an answered send counts as a
   * try.
   */
  stopRetries: [5 * SECOND, 10 * SECOND, 20 * SECOND, 30 * SECOND, MINUTE],
  /** An answered stop is checked by a read started this long after its answer. */
  stopCheck: 2 * SECOND,
  /** A check that could not read is tried again after this. */
  stopCheckRetry: 5 * SECOND,
  /** Answered sends of a stop before it is given up when the reads still show a move. */
  stopTries: 3,
  /**
   * An ordinary command (open, position) not written within this of its
   * arrival is refused, never sent late; its answer is awaited until
   * `commandAnswerBy`.
   */
  commandSendBy: 3500,
  commandAnswerBy: 4300,
  /** An answered command is checked by reads at these delays after its answer. */
  commandChecks: [5 * SECOND, 20 * SECOND],
  /** One read request (a list or a state). */
  readTimeout: 5 * SECOND,
  /** A read cut by a stop or a close is started again this long after. */
  readResume: 2 * SECOND,
  /** The lists of the box are read again this often. */
  listEvery: 10 * MINUTE,
  /** A state older than this never decides the direction of a stop. */
  stateFresh: 2 * MINUTE,
  /** Reconnection delays after a failure (never sooner than the read interval). */
  retryMin: 30 * SECOND,
  retryMax: 10 * MINUTE,
  /** A 429 or a 5xx pauses the reads and the commands (never the stops and closes). */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** getConfig() failed: tried again this often, without end. */
  configRetry: 30 * SECOND,
  /** "Test the connection" reads at most this often. */
  testGap: 10 * SECOND,
  /** A read or write of /data never takes longer than this. */
  storeTimeout: 2 * SECOND,
};
