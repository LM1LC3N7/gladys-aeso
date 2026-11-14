// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (the connection status and the answer of the
// "Test the key" button). Every text is a { en, fr } object: Gladys picks the
// user's language. No text ever carries the key.
// -----------------------------------------------------------------------------

import { localText } from './time.js';

const reasons = {
  refused: {
    en: 'the AESO refused the key (401)',
    fr: 'l’AESO a refusé la clé (401)',
  },
  forbidden: {
    en: 'the AESO answered 403 (access not allowed for this key or this address)',
    fr: 'l’AESO a répondu 403 (accès non permis pour cette clé ou cette adresse)',
  },
  rate_limited: {
    en: 'the AESO asked to slow down (429 or quota used up)',
    fr: 'l’AESO demande de ralentir (429 ou quota épuisé)',
  },
  server: { en: 'the AESO API is unavailable (5xx)', fr: 'l’API de l’AESO est indisponible (5xx)' },
  retired: {
    en: 'the Pool Price API v1.1 is gone (404/410): the AESO may have retired it, update the integration',
    fr: 'l’API Pool Price v1.1 a disparu (404/410) : l’AESO l’a peut-être retirée, mettez l’intégration à jour',
  },
  http: { en: 'unexpected HTTP answer', fr: 'réponse HTTP inattendue' },
  network: { en: 'network error', fr: 'erreur réseau' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  invalid: {
    en: 'unreadable answer (hours whose times or prices do not read): the contracts count the provisional price meanwhile',
    fr: 'réponse illisible (heures dont l’horaire ou le prix ne se lit pas) : les contrats comptent le prix provisoire en attendant',
  },
};
export const reason = (code, lang) => (reasons[code] ?? reasons.invalid)[lang];
export const REASON_CODES = Object.keys(reasons);

const both = (fn) => ({ en: fn('en'), fr: fn('fr') });
const SOURCE = { en: 'Source: AESO.', fr: 'Source : AESO.' };

export const T = {
  starting: {
    en: 'Reading the saved AESO pool prices…',
    fr: 'Lecture des prix du pool de l’AESO gardés…',
  },
  storeUnreadable: {
    en: 'The saved data in /data cannot be read: read again every 10 seconds, nothing asked from the AESO meanwhile (check the volume of the integration).',
    fr: 'Les données gardées dans /data sont illisibles : relues toutes les 10 secondes, rien n’est demandé à l’AESO en attendant (vérifiez le volume de l’intégration).',
  },
  configUnreadable: (retryAt) =>
    both((lang) =>
      lang === 'en'
        ? `The configuration could not be read from Gladys: asked again about ${localText(retryAt)} (Mountain time).`
        : `La configuration n’a pas pu être lue dans Gladys : redemandée vers ${localText(retryAt)} (heure des Rocheuses).`,
    ),
  tzStale: {
    en: 'The time zone database of this image predates Alberta’s permanent UTC-6 (November 2026): every hour would be an hour off, so nothing is asked. Update the integration.',
    fr: 'La base des fuseaux horaires de cette image précède l’heure UTC-6 permanente de l’Alberta (novembre 2026) : chaque heure serait décalée d’une heure, donc rien n’est demandé. Mettez l’intégration à jour.',
  },
  missing: {
    en: 'Enter your AESO API key (free, from developer-apim.aeso.ca) in the configuration: nothing is asked without it.',
    fr: 'Saisissez votre clé d’API de l’AESO (gratuite, sur developer-apim.aeso.ca) dans la configuration : rien n’est demandé sans elle.',
  },
  malformed: {
    en: 'The API key does not look like an AESO key (8 to 128 printable characters, no space): nothing is sent.',
    fr: 'La clé d’API ne ressemble pas à une clé de l’AESO (8 à 128 caractères imprimables, sans espace) : rien n’est envoyé.',
  },
  refused: {
    en: 'The AESO refused this API key (401): nothing is asked any more until the key is changed or the "Test the key" button succeeds. Check the key of the "public" product on developer-apim.aeso.ca.',
    fr: 'L’AESO a refusé cette clé d’API (401) : plus rien n’est demandé tant que la clé n’est pas changée ou que le bouton « Tester la clé » ne réussit pas. Vérifiez la clé du produit « public » sur developer-apim.aeso.ca.',
  },

  /**
   * The status: the last settled hour held, the last check and its error,
   * the calendar not fed, the contracts, a /data that cannot be written.
   */
  status({
    through,
    checkedAt,
    error,
    retryAt,
    calendar,
    contracts,
    dataError,
    unreadable = 0,
    stale,
  }) {
    return both((lang) => {
      const en = lang === 'en';
      const parts = [];
      if (through) {
        parts.push(
          en
            ? `Pool prices known through the hour ending ${localText(through)} (Mountain time).`
            : `Prix du pool connus jusqu’à l’heure finissant à ${localText(through)} (heure des Rocheuses).`,
        );
      } else {
        parts.push(en ? 'No pool price held yet.' : 'Aucun prix du pool encore gardé.');
      }
      if (stale !== undefined) {
        parts.push(
          through === undefined
            ? en
              ? 'The AESO answers but publishes no settled pool price: the contracts count the provisional price.'
              : 'L’AESO répond mais ne publie aucun prix du pool réglé : les contrats comptent le prix provisoire.'
            : en
              ? `No new pool price published by the AESO for ${stale} hours (late, or its answer changed): the contracts count the provisional price meanwhile.`
              : `Aucun nouveau prix du pool publié par l’AESO depuis ${stale} heures (retard, ou réponse changée) : les contrats comptent le prix provisoire en attendant.`,
        );
      }
      if (checkedAt) {
        parts.push(
          en
            ? `Last check: ${localText(checkedAt)}.`
            : `Dernière vérification : ${localText(checkedAt)}.`,
        );
      }
      if (error) {
        const next = retryAt ? localText(retryAt) : undefined;
        parts.push(
          en
            ? `Last attempt failed: ${reason(error, lang)}${next ? `, next one about ${next}` : ''}.`
            : `Dernière tentative en échec : ${reason(error, lang)}${next ? `, prochaine vers ${next}` : ''}.`,
        );
      }
      if (unreadable > 0) {
        parts.push(
          en
            ? `${unreadable} settled hour(s) unreadable in the AESO answers: they keep the provisional price, asked again a day later.`
            : `${unreadable} heure(s) réglée(s) illisible(s) dans les réponses de l’AESO : elles gardent le prix provisoire, redemandées un jour plus tard.`,
        );
      }
      if (calendar === 'refused') {
        parts.push(
          en
            ? 'The spot-ca-ab calendar is fed by another integration (refused by Gladys).'
            : 'Le calendrier spot-ca-ab est alimenté par une autre intégration (refusé par Gladys).',
        );
      } else if (calendar) {
        parts.push(
          en
            ? 'The spot-ca-ab calendar could not be fed: tried again at the next check.'
            : 'Le calendrier spot-ca-ab n’a pas pu être alimenté : nouvel essai à la prochaine vérification.',
        );
      }
      if (contracts === 0) {
        parts.push(
          en
            ? 'No energy contract uses the "AESO pool price" template yet.'
            : 'Aucun contrat d’énergie n’utilise encore le modèle « Prix du pool de l’AESO ».',
        );
      } else if (contracts > 0) {
        parts.push(
          en
            ? `${contracts} energy contract(s) on the "AESO pool price" template.`
            : `${contracts} contrat(s) d’énergie sur le modèle « Prix du pool de l’AESO ».`,
        );
      }
      if (dataError) {
        parts.push(
          en
            ? '/data cannot be written: the prices stay in memory until the next restart.'
            : '/data ne peut pas être écrit : les prix restent en mémoire jusqu’au prochain redémarrage.',
        );
      }
      parts.push(SOURCE[lang]);
      return parts.join(' ').slice(0, 1000);
    });
  },

  // --- The "Test the key" button ---------------------------------------------------

  testStarting: {
    en: 'The integration is starting: try again in a few seconds.',
    fr: 'L’intégration démarre : réessayez dans quelques secondes.',
  },
  testBusy: {
    en: 'A read is in progress: try again in a minute.',
    fr: 'Une lecture est en cours : réessayez dans une minute.',
  },
  testTooSoon: (seconds) =>
    both((lang) =>
      lang === 'en'
        ? `The AESO was asked less than a minute ago: try again in ${seconds} s.`
        : `L’AESO a été interrogée il y a moins d’une minute : réessayez dans ${seconds} s.`,
    ),
  testPaused: (until) =>
    both((lang) =>
      lang === 'en'
        ? `The AESO asked to slow down: nothing is asked before ${localText(until)} (Mountain time).`
        : `L’AESO demande de ralentir : rien n’est demandé avant ${localText(until)} (heure des Rocheuses).`,
    ),
  testOk: ({ hours, last, price }) =>
    both((lang) => {
      const en = lang === 'en';
      if (!last) {
        return en
          ? 'Key accepted by the AESO. No settled hour in this answer yet.'
          : 'Clé acceptée par l’AESO. Aucune heure réglée dans cette réponse pour l’instant.';
      }
      return en
        ? `Key accepted by the AESO: ${hours} settled hour(s) read, the last one ending ${localText(last)} (Mountain time) at ${price} CAD/MWh.`
        : `Clé acceptée par l’AESO : ${hours} heure(s) réglée(s) lue(s), la dernière finissant à ${localText(last)} (heure des Rocheuses) à ${price} CAD/MWh.`;
    }),
  testFailed: (code) =>
    both((lang) =>
      lang === 'en'
        ? `Test failed: ${reason(code, lang)}.`
        : `Échec du test : ${reason(code, lang)}.`,
    ),
};
