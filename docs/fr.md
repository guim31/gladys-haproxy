# HAProxy

[HAProxy](https://www.haproxy.org) est le répartiteur de charge et reverse
proxy placé devant de nombreux services : il répartit les requêtes entre
plusieurs serveurs, vérifie que chacun répond encore, et écarte un serveur qui
tombe. Cette intégration amène ses statistiques dans Gladys : un appareil
« HAProxy » avec les frontaux ouverts et les serveurs en service, et un
appareil par backend avec ses serveurs, ses sessions et sa part d'erreurs 5xx.
Les scènes peuvent réagir quand **n'importe quel** serveur tombe ou revient,
quand un backend n'a plus de serveur, ou quand HAProxy lui-même ne répond plus ;
un widget du tableau de bord liste d'abord les backends en panne. Lecture
seule : rien n'est jamais modifié dans HAProxy.

Testée avec un vrai HAProxy 3.2 (Docker, les trois sources ci-dessous, deux
backends derrière des health checks HTTP, serveurs arrêtés puis relancés
exprès, basic auth). HAProxy 2.x a les mêmes statistiques et devrait
fonctionner, sans avoir été testé : vos retours sont les bienvenus dans
[les issues](https://github.com/guim31/gladys-haproxy/issues).

## Ce qu'il vous faut

- Gladys Assistant 5.1.0 ou plus récent.
- HAProxy joignable depuis la machine de Gladys par **une** de ces sources :
  - **Page de statistiques (HTTP)**, la plus simple : un frontal avec la page
    de statistiques, éventuellement protégée par un utilisateur et un mot de
    passe :

    ```
    frontend stats
      bind :8404
      stats enable
      stats uri /stats
      stats auth gladys:un-long-mot-de-passe
    ```

  - **API Data Plane**, si elle tourne déjà à côté de HAProxy (port 5555 par
    défaut) : saisissez son utilisateur et son mot de passe ;
  - **API runtime en TCP** : un socket de statistiques exposé sur le réseau,
    `stats socket ipv4@0.0.0.0:9999 level user`. Il n'a pas de mot de passe :
    seulement sur un réseau de confiance.
- Pour savoir qu'un serveur est **tombé**, un health check sur lui (`check`
  sur la ligne `server`, `option httpchk` en HTTP). Sans lui, HAProxy affiche
  le serveur « no check » et l'intégration le compte en service.

## Premiers pas

### 1. Ouvrir les statistiques de HAProxy

Ajoutez la page de statistiques ci-dessus à `haproxy.cfg` (ou la ligne du
socket dans `global`), rechargez HAProxy, et ouvrez
`http://<machine HAProxy>:8404/stats` dans un navigateur : la page liste les
frontaux, les backends et les serveurs.

### 2. Configurer l'intégration

Dans Gladys, ouvrez **Intégrations → HAProxy → Configuration** :

- **Source** : Page de statistiques (HTTP), API Data Plane, ou API runtime en
  TCP (show stat).
- **Adresse** : l'URL de la page de statistiques comme dans le navigateur
  (`http://192.168.1.2:8404/stats`), l'URL de base de l'API Data Plane
  (`http://192.168.1.2:5555`), ou `hôte:port` du socket (`192.168.1.2:9999`).
- **Utilisateur** et **Mot de passe** : ceux de `stats auth`, ou de l'API Data
  Plane. Sinon, laissez vide.
- **Un appareil par serveur** : propose aussi chaque serveur dans l'onglet
  Découverte.
- **Intervalle de rafraîchissement** : de 15 secondes à 5 minutes, 30 secondes
  par défaut. Une requête légère à chaque fois.
- **Langue des noms** : la langue des noms des fonctionnalités et des
  résultats de scène.

Enregistrez, puis appuyez sur **Tester la connexion** : la réponse donne le
nombre de backends et de serveurs en service.

### 3. Ajouter les appareils

Ouvrez l'onglet **Découverte** et ajoutez l'appareil HAProxy et les backends à
suivre. Les déclencheurs de scène et le widget fonctionnent pour tous les
backends, ajoutés ou non.

## Les appareils

**HAProxy**

| Fonctionnalité      | Signification                                             |
| ------------------- | --------------------------------------------------------- |
| Joignable           | 1 quand les statistiques répondent, 0 après deux échecs   |
| Frontaux ouverts    | frontaux qui acceptent des connexions (non arrêtés)       |
| Backends en panne   | backends sans aucun serveur disponible                    |
| Serveurs en service | serveurs qui reçoivent du trafic, tous backends confondus |
| Serveurs au total   | serveurs déclarés, tous backends confondus                |
| Sessions en cours   | sessions ouvertes sur les frontaux                        |

**Un appareil par backend** (ayant au moins un serveur), nommé comme dans
HAProxy

| Fonctionnalité      | Signification                                                           |
| ------------------- | ----------------------------------------------------------------------- |
| Disponible          | 1 quand HAProxy a un serveur pour lui (secours compris)                 |
| Serveurs en service | serveurs qui reçoivent du trafic : UP, ou sans health check             |
| Serveurs au total   | serveurs déclarés, secours compris                                      |
| Sessions en cours   | sessions ouvertes sur le backend                                        |
| Erreurs 5xx         | part des 5xx parmi les réponses HTTP depuis la lecture précédente, en % |

**Un appareil par serveur** (option), nommé `backend/serveur` : **En ligne**,
1 quand le serveur est UP ou sans health check, 0 quand il est DOWN, en
maintenance (MAINT) ou en drain.

## Tableau de bord

Le widget **HAProxy** affiche trois tuiles (backends en panne, serveurs hors
service, backends OK), puis les backends — en panne d'abord, puis dégradés,
puis les autres — avec leurs serveurs en service, et les serveurs hors service
avec leur statut HAProxy et leur dernier health check (`DOWN · L4TOUT`). Le
bouton **Actualiser** relit HAProxy aussitôt. Ses réglages permettent de le
limiter à certains backends (appareils ajoutés à Gladys).

## Scènes

### Déclencheurs

- **Un serveur tombe** : un serveur ne reçoit plus de trafic (DOWN, MAINT,
  drain). Variables : nom du backend, nom du serveur, statut HAProxy, dernier
  health check.
- **Un serveur est rétabli** : avec la durée de la panne en minutes.
- **Un backend n'a plus de serveur** : HAProxy n'a plus de serveur pour lui,
  secours compris : ses clients reçoivent des erreurs 503.
- **HAProxy est injoignable** : deux lectures de suite sans réponse, avec la
  raison.

Les trois premiers peuvent être limités à certains backends (vide : tous). Rien
ne se déclenche à la première lecture : seuls les changements sont annoncés,
y compris ceux survenus pendant un redémarrage de Gladys ou de l'intégration.

### Actions

- **État d'un backend** : disponible ou non, état, serveurs en service et au
  total, sessions en cours, les serveurs hors service avec leur statut, et une
  phrase toute prête (« app : Dégradé, 1/2 serveur(s) en service (app2 :
  DOWN). »).
- **État de HAProxy** : joignable ou non, backends en panne avec leurs noms,
  serveurs en service, et une phrase. « HAProxy ne répond pas » est une
  réponse : la scène continue.

### Idées de scènes

- **Un serveur tombe** → envoyer un message Telegram « {{server}} de
  {{backend_name}} : {{status}} ({{check}}) ».
- **Un backend n'a plus de serveur** → une notification à tous les
  utilisateurs, et une lumière rouge dans le bureau.
- Chaque matin à 8 h → **État de HAProxy** → envoyer sa phrase.

## Dépannage

- **« pas de statistiques HAProxy à cette adresse »** : vérifiez la source et
  l'adresse. Pour la page de statistiques, ouvrez la même adresse suivie de
  `;csv` dans un navigateur : elle doit afficher des lignes commençant par
  `# pxname,svname`.
- **« utilisateur ou mot de passe refusé »** : l'utilisateur de `stats auth`,
  ou de l'API Data Plane.
- **« l'adresse redirige »** : la page est servie en HTTPS : saisissez
  l'adresse en `https://`.
- **Un serveur reste en service alors que son service est arrêté** : il n'a
  pas de health check (`check` sur la ligne `server`).
- **Les erreurs 5xx restent vides** : la part demande deux lectures, et un
  backend en mode TCP n'a pas de réponses HTTP (0 %).
- Journaux : **Intégrations → HAProxy → Logs** ; `LOG_LEVEL=debug` montre
  chaque lecture.

## Limites

- Lecture seule : aucun serveur n'est mis en maintenance ou en drain depuis
  Gladys.
- Un seul HAProxy par intégration. Avec plusieurs processus (`nbproc` des
  anciennes versions), le premier est lu.
- Les backends sans serveur (redirections, page de statistiques) ne sont pas
  proposés.
- Un certificat HTTPS auto-signé n'est pas accepté (utilisez `http://` sur le
  réseau local).
- L'API runtime en TCP n'a pas de mot de passe : gardez-la sur un réseau de
  confiance.
