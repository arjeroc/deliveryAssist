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
const ancienStore = execSync("git show " + AVANT_MULTI + ":js/store.js", { cwd: RACINE, encoding: "utf8" });
const ancienParcours = execSync("git show " + AVANT_MULTI + ":js/parcours.js", { cwd: RACINE, encoding: "utf8" });
const nouveauParcours = fs.readFileSync(path.join(RACINE, "js/parcours.js"), "utf8");
const nouveauStore = fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8");

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

const a = empreinte(charger(ancienStore));
const b = empreinte(charger(nouveauStore));

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

// --- la trace, elle aussi, doit sortir identique sur un fichier unique -------
function fauxLeaflet() {
  const groupe = () => ({ addTo: () => {}, clearLayers: () => {}, addLayer: () => {} });
  return { layerGroup: groupe, polyline: groupe, marker: groupe, divIcon: () => ({}) };
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function empreinteTrace(srcStore, srcParcours) {
  const sandbox = {
    window: {}, localStorage: fauxLocalStorage(), console, L: fauxLeaflet(),
    fetch: () => Promise.reject(new Error("hors ligne")), setTimeout, clearTimeout, Promise,
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.MapView = { distanceMeters };
  sandbox.window.L = sandbox.L;
  vm.createContext(sandbox);
  vm.runInContext(srcStore, sandbox);
  vm.runInContext(srcParcours, sandbox);
  const S = sandbox.window.Store, P = sandbox.window.Parcours;
  S.load();
  S.importFromCSV(CSV);
  const m = P.construire();
  const geo = P.geojson();
  return {
    etapes: m.etapes.map((e) => e.rang + "|" + e.rue + "|" + e.commune + "|" + e.niveau +
      "|" + (e.lat === null ? "-" : e.lat.toFixed(6)) + "|" + e.casiers.join("+")),
    segments: geo.features.map((f) => f.properties.etape_depart + "->" + f.properties.etape_arrivee +
      "|" + f.properties.distance_m + "|" + f.geometry.coordinates.length),
    distanceVolOiseau: Math.round(P.resume(m).distanceVolOiseau),
  };
}

const ta = empreinteTrace(ancienStore, ancienParcours);
const tb = empreinteTrace(nouveauStore, nouveauParcours);
["etapes", "segments", "distanceVolOiseau"].forEach((k) => {
  const ja = JSON.stringify(ta[k]), jb = JSON.stringify(tb[k]);
  if (ja === jb) {
    console.log("  OK    trace." + k + " identique (" +
      (Array.isArray(ta[k]) ? ta[k].length + " entrees" : ja) + ")");
  } else {
    echecs++;
    console.log("  ECHEC trace." + k + " differe");
    console.log("         ancien  " + ja);
    console.log("         nouveau " + jb);
  }
});

console.log(echecs === 0 ? "\nAUCUNE REGRESSION" : "\n" + echecs + " DIFFERENCE(S)");
process.exit(echecs === 0 ? 0 : 1);
