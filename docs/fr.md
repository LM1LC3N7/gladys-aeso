# Prix du pool de l’AESO pour Gladys Assistant

**Intégration non officielle, sans lien avec l’AESO (Alberta Electric System
Operator). Jamais testée avec une vraie clé de l’AESO ni un vrai contrat
d’énergie Gladys pour l’instant.**

Pour les foyers albertains au **tarif de détail variable** qui suit le prix
horaire du pool. L’intégration lit le prix du pool de chaque heure réglée,
alimente le calendrier d’énergie `spot-ca-ab` de Gladys et propose le modèle de
contrat **« Prix du pool de l’AESO (tarif variable) »**. Le prix de gros n’est ni
le tarif réglementé (RRO) ni un contrat à prix fixe : ce modèle sert à un tarif
qui suit le prix du pool.

## Obtenir une clé (gratuite)

1. Inscrivez-vous sur le portail développeurs de l’AESO,
   <https://developer-apim.aeso.ca/> (l’inscription vaut acceptation des
   conditions d’utilisation de l’AESO : usage personnel).
2. Abonnez-vous au produit **public** et copiez sa **clé primaire**.
3. Dans Gladys, collez-la dans le champ **Clé d’API de l’AESO** de
   l’intégration et enregistrez. Appuyez sur **Tester la clé** : elle lit une
   fois les heures réglées d’aujourd’hui et indique la dernière.

La clé est gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement
à l’AESO (`apimgw.aeso.ca`) dans l’en-tête `API-KEY`, jamais dans une URL, un
journal, le statut ni `/data`.

## Créer le contrat

Dans Gladys, **Suivi de l’énergie → Contrats → Nouveau contrat**, choisissez
**Prix du pool de l’AESO (tarif variable)** et renseignez :

| Saisie                      | Quoi saisir                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marge du fournisseur au kWh | La marge de votre fournisseur au tarif variable, CAD/kWh, hors TPS. 0 compte le prix du pool seul.                                                               |
| Prix provisoire au kWh      | **Obligatoire.** Votre prix habituel de l’énergie, marge comprise, hors TPS : compté pour une heure dont le prix du pool n’est pas encore publié, puis remplacé. |
| Frais de transport au kWh   | Vos frais variables de distribution et de transport et avenants, CAD/kWh, hors TPS. 0 les laisse de côté.                                                        |
| Frais fixes par mois        | Vos frais fixes d’administration et de transport d’un mois, hors TPS.                                                                                            |
| TPS                         | 5 % en Alberta.                                                                                                                                                  |

Au kWh : (prix du pool + marge) + transport, puis la TPS sur le tout, frais
fixes compris. Un prix du pool négatif (non permis par les règles du marché
actuelles) serait compté tel que publié.

## Comment le prix d’une heure arrive

Le prix du pool d’une heure est la moyenne de ses 60 prix marginaux du système
à la minute : il n’est connu qu’une fois l’heure finie. Donc :

- pendant une heure, et quelques minutes après, Gladys compte le **prix
  provisoire** du contrat (libellé « Provisional (hour not settled yet) ») ; le
  widget de prix et la condition de scène « prix actuel » montrent aussi ce prix
  provisoire ;
- 5 minutes après la fin de chaque heure, l’intégration demande à l’AESO les
  heures réglées du jour et écrit la nouvelle dans le calendrier ; Gladys
  recalcule alors les coûts depuis cette heure avec le vrai prix (au plus une
  fois toutes les 10 minutes par calendrier, côté cœur de Gladys) ;
- pendant un arrêt de l’intégration, le prix provisoire reste compté ; à son
  retour, elle lit les heures manquantes et Gladys les recalcule.

Une heure manquante n’est jamais devinée par l’intégration ni écrite à 0 : elle
reste inconnue dans le calendrier, et Gladys compte le prix provisoire que vous
avez choisi. Le prix du pool prévu par l’AESO n’est jamais utilisé.

## Source et requêtes

Le rapport Pool Price de l’API de l’AESO, version 1.1 :
`https://apimgw.aeso.ca/public/poolprice-api/v1.1/price/poolPrice?startDate=…&endDate=…`
(les jours de l’heure des Rocheuses, bornes comprises).

- Au premier démarrage : les 35 derniers jours, en deux requêtes (31 jours au
  plus par requête). Quand un contrat sur le modèle commence plus tôt, ses jours
  aussi (400 jours au plus), trois requêtes au plus d’affilée, puis une minute d’écart.
- Ensuite une requête par heure, 5 minutes après la fin de l’heure : le jour de
  cette heure. Si l’heure n’est pas encore réglée, de nouveau 10 minutes plus
  tard.
- Un jour passé répondu incomplet : redemandé une fois par jour.
- Un jour complet n’est jamais redemandé. Un redémarrage, une reconnexion, une
  nouvelle clé ou le bouton ne demandent jamais plus tôt qu’une minute après la
  dernière requête.
- Une requête à la fois, 20 secondes et 1 Mo au plus, un User-Agent propre à
  l’intégration (`gladys-aeso/<version>`), aucune redirection suivie.

Les réponses sont lues strictement : une heure n’est gardée que si ses débuts
UTC et heure des Rocheuses concordent, que l’heure est finie et que le prix est
un nombre simple entre −1 000 et 3 000 CAD/MWh (les règles du marché le bornent
aujourd’hui à 0 .. 999,99). Un prix vide (l’heure en cours et les suivantes, qui
n’ont qu’une prévision) est inconnu. Une réponse n’efface jamais un prix gardé ;
un prix corrigé le remplace.

## Erreurs et pauses

| Réponse                                                      | Ce que fait l’intégration                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401                                                          | La clé est refusée : plus aucune requête automatique, même après un redémarrage, tant que la clé n’est pas changée ou que le bouton **Tester la clé** ne réussit pas. Seuls 8 bits d’une empreinte salée de la clé refusée sont gardés dans `/data` (beaucoup de clés les partagent), jamais la clé. |
| 403 « quota »                                                | Une pause jusqu’au retour du quota (le délai donné par l’AESO, de 1 minute à 6 heures, 10 minutes sinon) ; pas une clé refusée.                                                                                                                                                                      |
| Autre 403                                                    | Pas une clé refusée : nouvel essai après 5, 15, 30, 60 minutes, puis toutes les 3 heures.                                                                                                                                                                                                            |
| 429                                                          | Une pause de la durée `Retry-After` (1 minute à 6 heures, 10 minutes sans en-tête), gardée dans `/data` après un redémarrage. Le bouton l’attend aussi.                                                                                                                                              |
| 5xx, délai dépassé, réseau, réponse illisible ou trop grande | Nouvel essai après 5, 15, 30, 60 minutes, puis toutes les 3 heures.                                                                                                                                                                                                                                  |
| 404 ou 410                                                   | La version 1.1 est peut-être retirée : redemandée toutes les 6 heures ; mettez l’intégration à jour.                                                                                                                                                                                                 |

Une clé changée pendant un arrêt de l’intégration partage ces 8 bits avec la
clé refusée une fois sur 256 : elle est alors tenue pour refusée aussi jusqu’à un
appui sur **Tester la clé** (une clé changée pendant qu’elle tourne est toujours
essayée).

Le calendrier détenu par une autre intégration (refusé par Gladys) : dit dans le
statut, les prix sont toujours lus.

## Fuseau horaire

L’Alberta garde UTC-6 toute l’année depuis le 1er novembre 2026. Les jours de
règlement suivent la base des fuseaux horaires du Node.js de l’intégration
(2026e ou plus récente connaît le changement) ; avec une plus ancienne, chaque
heure d’hiver serait décalée d’une heure par rapport aux heures des Rocheuses de
l’AESO : l’intégration ne demande alors rien et le dit. L’historique d’avant
novembre 2026 garde ses jours de 23 et 25 heures.

## Statut

Le statut de l’intégration montre la dernière heure réglée gardée, la dernière
vérification, la dernière erreur et la prochaine tentative, le calendrier non
alimenté, le nombre de contrats sur le modèle, un `/data` impossible à écrire.
`/data` illisible : relu toutes les 10 secondes, rien n’est demandé en
attendant. La configuration illisible dans Gladys : redemandée après
10 secondes, puis deux fois plus tard à chaque fois jusqu’à 5 minutes.

## Limites

- Jamais testée avec une vraie clé ni un vrai contrat.
- Les corrections de l’AESO sur un jour déjà complet ne sont pas relues.
- Aucun appareil, aucun déclencheur de scène : le prix sert à travers le
  contrat.
