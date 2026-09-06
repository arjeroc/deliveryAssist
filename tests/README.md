# Bancs d'essai

Cinq scripts Node sans dépendance : ils chargent `js/store.js` — et pour la
trace `js/parcours.js`, avec un Leaflet en carton, pour le scan
`js/scan-core.js`, qui n'a besoin de rien — dans un faux navigateur
(`vm` + un `localStorage` en mémoire) et interrogent le modèle.

```bash
node tests/references.js && node tests/multi-tournees.js && node tests/traces-par-tournee.js && node tests/non-regression.js && node tests/scan.js
```

- **references.js** — toute fonction locale appelée est-elle définie dans son
  module ? La syntaxe ne dit rien d'un appel vers une fonction disparue ; ce
  garde-fou, lui, le dit. Écrit après avoir perdu deux fonctions dans un
  remplacement de bloc un peu large.
- **multi-tournees.js** — l'empilement de plusieurs fichiers : priorité de la
  pile à position de casier égale, colonnes et cases jamais fusionnées entre
  fichiers, zones écartées, renommage d'un identifiant de tournée, export
  sélectif, réimport en place, persistance, pile reconstruite depuis un stockage
  antérieur à la fonctionnalité.
- **traces-par-tournee.js** — une trace par fichier : jamais reliées entre elles,
  chacune de sa couleur, couleur choisie retenue et persistée, couleurs
  insensibles à l'ordre de la pile, et distance qui ne compte pas le saut d'une
  tournée à l'autre.
- **non-regression.js** — compare mot pour mot l'ordre, les cases, les colonnes
  de casier, l'export CSV, les étapes de la trace, ses segments et sa distance,
  entre le code d'avant l'empilement (témoin figé sur un commit) et le code
  courant, drapeau baissé. Rien ne doit bouger pour l'utilisateur qui ne charge
  qu'un fichier.
- **scan.js** — la mécanique du scan d'étiquette, prise hors du navigateur :
  transitions d'états permises et refusées, cadence d'OCR (jamais deux lectures
  en vol, jamais plus vite que l'intervalle, résultat périmé par un changement
  d'état), contrôle de netteté et de stabilité, marge de cadrage, économie des
  rotations, cartes qui ne clignotent pas — et surtout l'attribution : rien ne
  s'écrit dans la préparation avant « Ajouter à la tournée », « Changer
  d'adresse » n'écrit rien, et le ✕ n'oublie rien derrière lui.
