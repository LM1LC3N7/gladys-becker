// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, badges, feature names), in English
// and French. Never an address typed by the user.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Feature names, by key. */
const LABELS = {
  state: { en: 'Open / close', fr: 'Ouverture / fermeture' },
  position: { en: 'Position', fr: 'Position' },
  sun: { en: 'Sun (level 0-15)', fr: 'Soleil (niveau 0-15)' },
  wind: { en: 'Wind (level 0-11)', fr: 'Vent (niveau 0-11)' },
  dawn: { en: 'Twilight (level 0-15)', fr: 'Crépuscule (niveau 0-15)' },
  rain: { en: 'Rain', fr: 'Pluie' },
  temp: { en: 'Temperature', fr: 'Température' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** A duration: "45 s", "3 min", "2 h" (59.99 s is "1 min", never "60 s"). */
export function age(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  const min = Math.ceil(s / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

/** A { en, fr } pair cut to the SDK limit. */
export const trim = (pair, max = LIMITS.message) => ({
  en: pair.en.length > max ? `${pair.en.slice(0, max - 1)}…` : pair.en,
  fr: pair.fr.length > max ? `${pair.fr.slice(0, max - 1)}…` : pair.fr,
});

/** Why the box failed, in English and French (never an address). */
export function reasonOf(err) {
  switch (err?.kind) {
    case 'network':
      return err.sent
        ? { en: 'connection cut', fr: 'connexion coupée' }
        : { en: 'no connection', fr: 'pas de connexion' };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'aborted':
      return { en: 'cut by a stop or a close', fr: 'coupée par un arrêt ou une fermeture' };
    case 'size':
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case 'redirect':
      return { en: 'redirected answer', fr: 'réponse redirigée' };
    case 'rate':
      return { en: 'too many requests (429)', fr: 'trop de requêtes (429)' };
    case 'server':
      return {
        en: `error of the box (HTTP ${err.status})`,
        fr: `erreur de la box (HTTP ${err.status})`,
      };
    case 'http':
      return {
        en: `unexpected answer (HTTP ${err.status})`,
        fr: `réponse inattendue (HTTP ${err.status})`,
      };
    case 'format':
      return {
        en: 'not an answer of a CentralControl',
        fr: 'réponse qui n’est pas celle d’une CentralControl',
      };
    case 'rpc':
      return {
        en: `refused by the box${err.code !== undefined ? ` (code ${err.code})` : ''}`,
        fr: `refusée par la box${err.code !== undefined ? ` (code ${err.code})` : ''}`,
      };
    case 'notSent':
      return notSentReason(err.why);
    default:
      return { en: 'unexpected error', fr: 'erreur inattendue' };
  }
}

function notSentReason(why) {
  switch (why) {
    case 'late':
      return { en: 'could not leave in time', fr: 'n’a pas pu partir à temps' };
    case 'stopped':
      return { en: 'a stop came after it', fr: 'un arrêt est arrivé après elle' };
    case 'paused':
      return { en: 'requests paused', fr: 'requêtes en pause' };
    case 'config':
      return {
        en: 'no address of the box known yet',
        fr: 'aucune adresse de box connue pour l’instant',
      };
    case 'stopping':
      return { en: 'the integration stopped', fr: 'l’intégration s’est arrêtée' };
    default:
      return { en: 'not sent', fr: 'non envoyée' };
  }
}

const COMMANDS = {
  open: { en: 'Open', fr: 'Ouvrir' },
  close: { en: 'Close', fr: 'Fermer' },
  stop: { en: 'Stop', fr: 'Arrêt' },
  position: { en: 'Position', fr: 'Position' },
};

const commandText = (command, value) => {
  const c = COMMANDS[command] ?? COMMANDS.stop;
  return command === 'position'
    ? { en: `${c.en} ${value} %`, fr: `${c.fr} ${value} %` }
    : { en: c.en, fr: c.fr };
};

/** The texts of the integration. */
export const T = {
  connecting: { en: 'Connecting to the CentralControl…', fr: 'Connexion à la CentralControl…' },
  configMissing: {
    en: 'Enter the address of the CentralControl',
    fr: 'Saisissez l’adresse de la CentralControl',
  },
  configError(error, length) {
    switch (error) {
      case 'credentials':
        return {
          en: 'The address must not hold a user name nor a password',
          fr: 'L’adresse ne doit contenir ni utilisateur ni mot de passe',
        };
      case 'local':
        return {
          en: 'Names in .local do not resolve in the container: enter the IP address',
          fr: 'Les noms en .local ne se résolvent pas dans le conteneur : saisissez l’adresse IP',
        };
      case 'unusable':
        return {
          en: 'This address cannot be a box (0.0.0.0, broadcast or multicast)',
          fr: 'Cette adresse ne peut pas être une box (0.0.0.0, diffusion ou multicast)',
        };
      case 'missing':
        return T.configMissing;
      default:
        return {
          en: `Invalid address (${length ?? 0} characters): an IP address or a host name`,
          fr: `Adresse invalide (${length ?? 0} caractères) : une adresse IP ou un nom d’hôte`,
        };
    }
  },
  configUnread: (ms) => ({
    en: `Configuration not read from Gladys, next try in ${age(ms)}`,
    fr: `Configuration non lue depuis Gladys, nouvel essai dans ${age(ms)}`,
  }),
  connected: ({ covers, sensors }, interval) => ({
    en: `Connected: ${covers} covers, ${sensors} sensors, read every ${interval} s`,
    fr: `Connecté : ${covers} volets, ${sensors} capteurs, lus toutes les ${interval} s`,
  }),
  failure: (err, retryMs) => {
    const r = reasonOf(err);
    return {
      en: `CentralControl unreachable: ${r.en}; next try in ${age(retryMs)}`,
      fr: `CentralControl injoignable : ${r.fr} ; nouvel essai dans ${age(retryMs)}`,
    };
  },
  paused: (ms) => ({
    en: `The box asked to slow down: reads and commands paused for ${age(ms)} (stop and close still go)`,
    fr: `La box a demandé de ralentir : lectures et commandes en pause ${age(ms)} (arrêt et fermeture partent quand même)`,
  }),
  stopsPending: (n) => ({
    en: `${n} stop(s) waiting to be sent or confirmed`,
    fr: `${n} arrêt(s) en attente d’envoi ou de confirmation`,
  }),
  storeBroken: {
    en: '/data not read yet (read again every 30 s): stops are not kept across a restart meanwhile',
    fr: '/data pas encore lu (relu toutes les 30 s) : les arrêts ne sont pas gardés au redémarrage d’ici là',
  },
  confirmNeeded: {
    en: 'New address: press Test the connection to confirm the box (only stop and close go until then)',
    fr: 'Nouvelle adresse : appuyez sur Tester la connexion pour confirmer la box (seuls l’arrêt et la fermeture partent d’ici là)',
  },
  test: {
    ok: ({ covers, sensors }) => ({
      en: `CentralControl answered: ${covers} covers, ${sensors} sensors`,
      fr: `La CentralControl a répondu : ${covers} volets, ${sensors} capteurs`,
    }),
    failed: (err) => {
      const r = reasonOf(err);
      return { en: `No answer of the box: ${r.en}`, fr: `Pas de réponse de la box : ${r.fr}` };
    },
    tooSoon: (ms) => ({
      en: `Read ${age(ms)} ago; try again in a few seconds`,
      fr: `Lue il y a ${age(ms)} ; réessayez dans quelques secondes`,
    }),
  },
  badge: {
    // Commands.
    refused: (command, value, why) => {
      const c = commandText(command, value);
      return { en: `${c.en}: refused, ${why.en}`, fr: `${c.fr} : refusée, ${why.fr}` };
    },
    nothingSent: (command, value, err) => {
      const c = commandText(command, value);
      const r = reasonOf(err);
      return { en: `${c.en}: nothing sent (${r.en})`, fr: `${c.fr} : rien envoyé (${r.fr})` };
    },
    unconfirmed: (command, value, err) => {
      const c = commandText(command, value);
      const r = reasonOf(err);
      return {
        en: `${c.en}: sent, without confirmation (${r.en})`,
        fr: `${c.fr} : envoyée, sans confirmation (${r.fr})`,
      };
    },
    boxRefused: (command, value, err) => {
      const c = commandText(command, value);
      const r = reasonOf(err);
      return { en: `${c.en}: ${r.en}`, fr: `${c.fr} : ${r.fr}` };
    },
    sent: (command, value) => {
      const c = commandText(command, value);
      return {
        en: `${c.en}: accepted by the box, waiting for the read back`,
        fr: `${c.fr} : acceptée par la box, en attente de relecture`,
      };
    },
    sentNoFeedback: (command, value) => {
      const c = commandText(command, value);
      return {
        en: `${c.en}: accepted by the box (this motor gives no feedback)`,
        fr: `${c.fr} : acceptée par la box (ce moteur ne renvoie pas son état)`,
      };
    },
    applied: (command, value) => {
      const c = commandText(command, value);
      return { en: `${c.en}: applied (read back)`, fr: `${c.fr} : appliquée (relue)` };
    },
    moving: (command, value) => {
      const c = commandText(command, value);
      return { en: `${c.en}: moving (read back)`, fr: `${c.fr} : en mouvement (relu)` };
    },
    notYet: (command, value) => {
      const c = commandText(command, value);
      return { en: `${c.en}: not applied yet`, fr: `${c.fr} : pas encore appliquée` };
    },
    notApplied: (command, value) => {
      const c = commandText(command, value);
      return {
        en: `${c.en}: not applied (read back unchanged)`,
        fr: `${c.fr} : non appliquée (relecture inchangée)`,
      };
    },
    // Stops.
    stopSending: (tries) => ({
      en: `Stop: not answered yet, sent again until the box answers (${tries}/3 answered tries)`,
      fr: `Arrêt : pas encore de réponse, renvoyé jusqu’à ce que la box réponde (${tries}/3 essais répondus)`,
    }),
    stopChecking: (tries) => ({
      en: `Stop: accepted by the box, waiting for the read back (${tries}/3 answered tries)`,
      fr: `Arrêt : accepté par la box, en attente de relecture (${tries}/3 essais répondus)`,
    }),
    stopRefused: (tries, err) => {
      const r = reasonOf(err);
      return {
        en: `Stop: answered by the box but not accepted (${r.en}), read back in progress (${tries}/3 answered tries)`,
        fr: `Arrêt : la box a répondu sans l’accepter (${r.fr}), relecture en cours (${tries}/3 essais répondus)`,
      };
    },
    readFailed: (err) => {
      const r = reasonOf(err);
      return { en: `Not read: ${r.en}`, fr: `Non lu : ${r.fr}` };
    },
    stopApplied: {
      en: 'Stop: applied (read back, not moving)',
      fr: 'Arrêt : appliqué (relu, à l’arrêt)',
    },
    stopNoFeedback: {
      en: 'Stop: accepted by the box (no movement information to check it)',
      fr: 'Arrêt : accepté par la box (aucune information de mouvement pour le vérifier)',
    },
    stopGaveUp: {
      en: 'Stop: still moving after 3 answered tries, not sent again',
      fr: 'Arrêt : toujours en mouvement après 3 essais répondus, plus renvoyé',
    },
    stopOverridden: {
      en: 'Stop: replaced by a newer command accepted by the box',
      fr: 'Arrêt : remplacé par une commande plus récente acceptée par la box',
    },
    stopContradicted: {
      en: 'Stop: a move in the other direction started elsewhere, not sent again',
      fr: 'Arrêt : un mouvement dans l’autre sens a été lancé ailleurs, plus renvoyé',
    },
    identity: {
      en: 'This id is now another type of cover on the box: commands refused (stop excepted)',
      fr: 'Cet identifiant est maintenant un autre type de volet sur la box : commandes refusées (sauf l’arrêt)',
    },
    gone: {
      en: 'No longer listed by the box',
      fr: 'N’est plus listé par la box',
    },
  },
  why: {
    config: { en: 'no valid configuration', fr: 'pas de configuration valide' },
    identity: {
      en: 'cover not yet read back from the box in this session',
      fr: 'volet pas encore relu sur la box dans cette session',
    },
    otherType: {
      en: 'this id is now another type of cover on the box',
      fr: 'cet identifiant est maintenant un autre type de volet sur la box',
    },
    paused: (ms) => ({
      en: `the box asked to slow down, ${age(ms)} left`,
      fr: `la box a demandé de ralentir, encore ${age(ms)}`,
    }),
    value: { en: 'invalid value', fr: 'valeur invalide' },
    notCover: {
      en: 'the box lists this id as something else than a cover',
      fr: 'la box liste cet identifiant comme autre chose qu’un volet',
    },
    confirm: {
      en: 'new address of the box: press Test the connection to confirm it',
      fr: 'nouvelle adresse de box : appuyez sur Tester la connexion pour la confirmer',
    },
    noPosition: { en: 'this motor gives no position', fr: 'ce moteur ne donne pas de position' },
    queueFull: { en: 'too many commands waiting', fr: 'trop de commandes en attente' },
    unknownDevice: { en: 'unknown device', fr: 'appareil inconnu' },
    readOnly: { en: 'read-only feature', fr: 'fonctionnalité en lecture seule' },
  },
};
