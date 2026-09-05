# Bancs d'essai

Deux scripts Node sans dépendance : ils chargent `js/store.js` dans un faux
navigateur (`vm` + un `localStorage` en mémoire) et interrogent le module.

```bash
node tests/multi-tournees.js
node tests/non-regression.js
```

- **multi-tournees.js** — l'empilement de plusieurs fichiers de tournée :
  priorité de la pile à position de casier égale, étapes jamais fusionnées entre
  fichiers, réimport en place, persistance de l'ordre, pile reconstruite depuis
  un stockage antérieur à la fonctionnalité.
- **non-regression.js** — compare mot pour mot l'ordre, les cases, les colonnes
  de casier et l'export CSV entre le `store.js` d'avant l'empilement (témoin figé
  sur un commit) et le `store.js` courant, drapeau baissé. Rien ne doit bouger
  pour l'utilisateur qui ne charge qu'un fichier.
