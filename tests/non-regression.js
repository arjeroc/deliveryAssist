// Non-régression : l'ancien store.js (HEAD) et le nouveau doivent produire
// exactement le même ordre, les mêmes cases et les mêmes colonnes sur le même
// jeu de données, drapeau baissé.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

const RACINE = path.resolve(__dirname, "..");

function fauxLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

function charger(src) {
  const sandbox = { window: {}, localStorage: fauxLocalStorage(), console };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.Store;
}

// Le témoin est figé sur le dernier commit d'avant l'empilement des fichiers.
// Le comparer à HEAD ferait de ce test une tautologie dès le commit suivant.
const AVANT_MULTI = "fe4c916";
const ancien = execSync("git show " + AVANT_MULTI + ":js/store.js", { cwd: RACINE, encoding: "utf8" });
const nouveau = fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8");

// le jeu d'essai de l'application, extrait de ui.js
const uiSrc = fs.readFileSync(path.join(RACINE, "js/ui.js"), "utf8");
const debut = uiSrc.indexOf("var SAMPLE_CSV =");
const fin = uiSrc.indexOf(";", uiSrc.indexOf("2026-09-04\\n'", debut));
const expr = uiSrc.slice(debut + "var SAMPLE_CSV =".length, fin);
const SAMPLE = eval(expr);

// … plus quelques lignes tordues : casier partiel, zéros de tête, ordres vides
const EXTRA = [
  "x1,tm002,ZULU,1,RUE X,16260,AILLEURS,,,,,,,,,01,02,,,,lettre,,false,2026-09-04",
  "x2,tm002,YANKEE,2,RUE X,16260,AILLEURS,,,,,,,,,,,,,,lettre,,false,2026-09-04",
  "x3,tm002,XRAY,3,RUE X,16260,AILLEURS,,,,,,,,,3,,,,,lettre,,false,2026-09-04",
].join("\n") + "\n";

const CSV = SAMPLE + EXTRA;

function empreinte(S) {
  S.load();
  S.importFromCSV(CSV);
  return {
    ordre: S.rowsOrdreTournee().map((r) => r.id + "/" + r.nom_famille),
    cases: S.etapesCasier().map((e) => e.cle + ":" + e.label + ":" + e.rows.map((r) => r.id).join("+")),
    colonnes: S.casierColonnes().map((c) =>
      c.label + "{" + c.lignes.map((li) =>
        li.cle + "|" + li.premiereRue + "→" + li.derniereRue + "|" + li.nbAdresses + "|" + li.nbRues + "|" + li.commune
      ).join(";") + "}"),
    csvExport: S.exportCSVText(),
  };
}

const a = empreinte(charger(ancien));
const b = empreinte(charger(nouveau));

let echecs = 0;
["ordre", "cases", "colonnes", "csvExport"].forEach((k) => {
  const ja = JSON.stringify(a[k]), jb = JSON.stringify(b[k]);
  if (ja === jb) {
    console.log("  OK    " + k + " identique (" + (Array.isArray(a[k]) ? a[k].length + " entrées" : ja.length + " car.") + ")");
  } else {
    echecs++;
    console.log("  ECHEC " + k + " diffère");
    if (Array.isArray(a[k])) {
      a[k].forEach((v, i) => { if (v !== b[k][i]) console.log("         [" + i + "] ancien=" + v + "  nouveau=" + b[k][i]); });
      if (a[k].length !== b[k].length) console.log("         longueurs " + a[k].length + " vs " + b[k].length);
    }
  }
});

console.log(echecs === 0 ? "\nAUCUNE REGRESSION" : "\n" + echecs + " DIFFERENCE(S)");
process.exit(echecs === 0 ? 0 : 1);
