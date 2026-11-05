# Becker CentralControl

Pilotez vos volets roulants, brise-soleil orientables, screens, stores bannes et
voiles d'ombrage Becker (radio Centronic, CentronicPLUS et B-Tronic) par votre
**CentralControl CC31, CC41 ou CC51**, et lisez ses capteurs soleil, vent, pluie
et température, depuis Gladys. Tout reste sur votre réseau local : l'intégration
parle à l'API JSON-RPC de la box (`http://<box>/cgi-bin/cc51rpc.cgi`), jamais au
cloud Becker ni à son relais.

> Cette intégration n'a **jamais été testée avec une vraie box pour
> l'instant** : elle a été construite d'après l'intégration Home Assistant de
> Becker (becker_centralcontrol_has, MIT) et testée contre une box simulée. Non
> officiel, sans lien avec Becker-Antriebe GmbH.

## Configuration

1. Donnez à votre CentralControl une adresse fixe dans votre box internet
   (réservation DHCP).
2. Dans l'onglet Configuration de l'intégration, saisissez cette adresse (par
   exemple `192.168.1.70` ; ajoutez `:port` si la box répond sur un autre port
   que 80). Les noms en `.local` ne se résolvent pas dans le conteneur :
   utilisez l'adresse IP.
3. Changez si besoin l'intervalle de lecture (60 s par défaut, de 30 s à 1 h)
   et la langue des noms des fonctionnalités.
4. Enregistrez, puis **Tester la connexion** : elle liste les volets que la box
   annonce.
5. Ajoutez vos volets et capteurs depuis l'onglet **Découverte**.

## Ce que vous obtenez

- **Chaque volet** (volet roulant, brise-soleil, screen, store banne, voile
  d'ombrage, store, volet battant) devient un volet avec une fonctionnalité
  **Ouverture / fermeture** (ouvrir, fermer, arrêter). Quand le moteur renvoie
  sa position (B-Tronic, CentronicPLUS : « feedback » dans la box), une
  fonctionnalité **Position** (0 % fermé, 100 % ouvert) est lue à chaque
  intervalle et peut être réglée. Les moteurs Centronic ne renvoient aucun
  état : seulement les commandes, jamais de position.
- Un **store banne** est inversé, comme dans l'intégration de Becker :
  « fermer » le replie, et sa position est celle que donne la box.
- **Chaque capteur** (soleil, vent, pluie, crépuscule, température) devient un
  capteur en lecture seule. Soleil et crépuscule sont des niveaux de 0 à 15, le
  vent un niveau de 0 à 11 (l'échelle du capteur, pas des km/h), la pluie 0
  (sec) ou 1 (pluie), la température en °C. Une valeur hors de ces plages n'est
  pas publiée.
- Les portes, portes de garage, fenêtres de toit et oscillantes, lampes,
  prises, chauffages et scènes de la box ne sont pas proposés dans cette
  version.

## L'arrêt

L'**arrêt** n'est jamais bloqué : ni par une lecture en cours (il la coupe), ni
par une pause demandée par la box, ni par une autre commande en attente, ni par
la liste de la box pas encore lue, ni par une configuration illisible (il part
vers la dernière adresse connue), ni par un `/data` lent ou illisible. Il part
aussitôt ; pendant 3,3 s il est réécrit toutes les 250 ms jusqu'à ce que la box
réponde.

L'arrêt est gardé (en mémoire, et dans `/data` sans l'attendre) jusqu'à ce
qu'une lecture du volet, partie après la réponse de la box, montre qu'il ne
bouge plus :

- un arrêt auquel la box n'a pas répondu est renvoyé après 5 s, 10 s, 20 s,
  30 s, puis chaque minute et à chaque lecture réussie, **sans fin et sans
  limite d'âge** : seul un envoi qui a reçu une réponse compte comme essai (un
  délai dépassé, une coupure, un 429 ou un 5xx ne comptent pas) ;
- répondu mais le volet bouge encore dans le même sens : renvoyé, **3 essais
  répondus au plus**, puis « toujours en mouvement » sur le badge ;
- le volet bouge **dans l'autre sens** : un mouvement lancé ailleurs
  (application, télécommande) est laissé tranquille ;
- un moteur sans retour d'état, ou une box qui ne dit pas s'il bouge : un arrêt
  répondu suffit ;
- une **commande plus récente** de ce volet (ouvrir, fermer, position)
  acceptée par la box remplace l'arrêt ; une commande plus récente sans réponse
  ne le remplace pas (l'arrêt part) ;
- après un redémarrage, les arrêts gardés dans `/data` partent aussitôt, avant
  même de joindre Gladys.

Un arrêt ne part pas seulement tant qu'**aucune adresse de box n'est connue du
tout** (jamais configurée, rien dans `/data`) : il est gardé et part dès qu'une
adresse est enregistrée. Cliquer sur arrêt abandonne aussi les commandes de ce
volet pas encore parties : rien de ce qui a été cliqué avant un arrêt ne part
après lui.

## La fermeture

**Fermer** suit le même chemin (devant tout, coupe les lectures, ni retenue par
une pause ni par la liste pas encore lue, réécrite toutes les 250 ms pendant
3,3 s), mais elle n'est jamais renvoyée après un redémarrage. Elle n'est refusée
que si la box liste désormais ce volet avec **un autre type** (le sens pourrait
être inversé : un store banne se ferme vers le haut, un volet vers le bas).

## Ouvrir et position

Ils sont refusés, avec la raison sur le badge de l'appareil, quand : la
configuration n'est pas valide ; la box a demandé de ralentir (429, 5xx ; la
pause est gardée au redémarrage, de 1 min à 6 h) ; le volet n'a pas été listé
par la box depuis le démarrage (ou depuis qu'elle ne répondait plus) ; la box
liste cet identifiant avec un autre type ; le moteur ne donne pas de position
(position seulement) ; la valeur n'est pas un nombre entier de 0 à 100 ;
32 commandes attendent déjà ; la commande ne peut pas partir dans les 3,5 s ;
ou un arrêt ou une fermeture de ce volet est arrivé après elle.

Plusieurs volets bougent en même temps (une scène de cinq volets les règle tous
les cinq). Une commande n'est dite **appliquée** que si une lecture après elle
montre la position demandée (5 s et 20 s après) ; sinon le badge dit « acceptée,
en attente de relecture », « pas encore appliquée », « envoyée, sans
confirmation » (pas de réponse) ou « rien envoyé ».

## Lectures

Les positions et les capteurs sont lus à l'intervalle choisi, une requête à la
fois ; les listes de la box toutes les 10 minutes. Une lecture partie avant une
commande d'un volet ne s'applique jamais après elle, et les lectures
s'appliquent dans l'ordre de leur départ. Un volet ou la liste des capteurs en
échec n'arrête jamais les autres. Un redémarrage (même box) ne lit jamais plus tôt que
l'intervalle.

## Dépannage

- **« pas encore relu sur la box »** : la box n'a pas encore été listée dans
  cette session ; attendez la lecture suivante ou appuyez sur Tester la
  connexion.
- **« un autre type de volet »** : l'identifiant de cet appareil désigne
  maintenant un autre volet dans la box (reconfigurée). Supprimez l'appareil et
  ajoutez-le de nouveau depuis la Découverte.
- **« /data illisible »** : le fichier `/data/becker-state.json` ne peut pas
  être lu ; il est laissé tel quel et les arrêts ne sont pas gardés au
  redémarrage.
- Les journaux ne contiennent jamais une adresse saisie par erreur.
