// Banc d'essai de la trace : une par fichier de tournée, chacune de sa couleur,
// et jamais de trait entre la dernière boîte d'un fichier et la première du
// suivant. parcours.js est chargé avec un faux Leaflet — on n'interroge que le
// modèle et la géométrie, pas le rendu.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

// Leaflet et MapView réduits à ce que parcours.js leur demande hors affichage.
function fauxLeaflet() {
  const groupe = () => ({ addTo: () => {}, clearLayers: () => {}, addLayer: () => {} });
  return { layerGroup: groupe, polyline: groupe, marker: groupe, divIcon: () => ({}) };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function chargerParcours() {
  const sandbox = {
    window: {}, localStorage: fauxLocalStorage(), console,
    L: fauxLeaflet(),
    fetch: () => Promise.reject(new Error("pas de réseau dans le banc d'essai")),
    setTimeout, clearTimeout, Promise,
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.MapView = { distanceMeters };
  sandbox.window.L = sandbox.L;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(RACINE, "js/parcours.js"), "utf8"), sandbox);
  return { S: sandbox.window.Store, P: sandbox.window.Parcours };
}

let echecs = 0;
function verifie(nom, obtenu, attendu) {
  const a = JSON.stringify(obtenu), b = JSON.stringify(attendu);
  if (a === b) console.log("  OK   " + nom);
  else { echecs++; console.log("  ECHEC " + nom + "\n         obtenu  " + a + "\n         attendu " + b); }
}

const HEAD = "id,id_tournee,nom_famille,numero,rue,code_postal,commune,lieu_dit,latitude,longitude,geocode_statut,casier_c,casier_l,ordre_zone,ordre_rue,position_manuelle,type_objet,notes,stoppub,date_maj";
function ligne(id, tour, rue, c, l, or_, lat, lon) {
  return [id, tour, "NOM", "1", rue, "16000", "VILLE", "", lat, lon, "verifie", c, l, 1, or_, "", "lettre", "", "false", "2026-09-05"].join(",");
}

// Deux fichiers, chacun quatre boîtes proches entre elles, mais les deux
// grappes séparées d'environ 1 km — sous le seuil de coupure, donc seule la
// frontière de fichier peut interrompre la trace.
function jeu(tour, base) {
  return [
    ligne(tour + "-1", tour, "RUE A", 1, 1, 1, (base).toFixed(5), "0.45000"),
    ligne(tour + "-2", tour, "RUE A", 1, 1, 2, (base + 0.002).toFixed(5), "0.45000"),
    ligne(tour + "-3", tour, "RUE B", 1, 2, 1, (base + 0.004).toFixed(5), "0.45000"),
    ligne(tour + "-4", tour, "RUE B", 1, 2, 2, (base + 0.006).toFixed(5), "0.45000"),
  ];
}
const CSV_A = [HEAD].concat(jeu("tm0", 45.80)).join("\n");
const CSV_B = [HEAD].concat(jeu("tm1", 45.81)).join("\n");

// --------------------------------------------------------------------------
console.log("\n=== 1. Un seul fichier : la trace est celle d'avant ===");
{
  const { S, P } = chargerParcours();
  S.load();
  S.importFromCSV(CSV_A);
  const m = P.construire();
  verifie("aucun point ne porte de fichier", m.etapes.map((e) => e.fichier), ["", ""]);
  const geo = P.geojson();
  verifie("une seule ligne continue", geo.features.length, 1);
  verifie("couleur laissée à la qualité", geo.features[0].properties.couleur, undefined);
  verifie("pas de liste de fichiers", geo.properties.fichiers, undefined);
  verifie("id_tournee du segment", geo.features[0].properties.id_tournee, "tm0");
}

// --------------------------------------------------------------------------
console.log("\n=== 2. Deux fichiers : une trace chacun, jamais reliées ===");
{
  const { S, P } = chargerParcours();
  S.load();
  S.importFromCSV(CSV_A, { mode: "remplacer" });
  S.importFromCSV(CSV_B, { mode: "ajouter" });
  verifie("empilement actif", S.multiActif(), true);

  const geo = P.geojson();
  verifie("deux traces", geo.features.length, 2);
  verifie("une par fichier", geo.features.map((f) => f.properties.id_tournee), ["tm0", "tm1"]);
  verifie("chacune sa couleur",
    geo.features.map((f) => f.properties.couleur),
    [S.getTourneeColor("tm0"), S.getTourneeColor("tm1")]);
  verifie("deux couleurs distinctes",
    S.getTourneeColor("tm0") !== S.getTourneeColor("tm1"), true);

  // Aucune coordonnée d'un fichier ne doit apparaître dans la trace de l'autre.
  const latsTm0 = geo.features[0].geometry.coordinates.map((c) => c[1]);
  const latsTm1 = geo.features[1].geometry.coordinates.map((c) => c[1]);
  verifie("trace tm0 sous 45.81", latsTm0.every((v) => v < 45.809), true);
  verifie("trace tm1 au-dessus de 45.81", latsTm1.every((v) => v >= 45.809), true);

  verifie("la collection liste les fichiers",
    geo.properties.fichiers.map((f) => f.id + ":" + f.adresses), ["tm0:4", "tm1:4"]);

  const r = P.resume(P.construire());
  verifie("le résumé compte les traces", r.fichiers.map((f) => f.id + ":" + f.etapes), ["tm0:2", "tm1:2"]);
}

// --------------------------------------------------------------------------
console.log("\n=== 3. L'ordre de la pile réordonne les traces ===");
{
  const { S, P } = chargerParcours();
  S.load();
  S.importFromCSV(CSV_A, { mode: "remplacer" });
  S.importFromCSV(CSV_B, { mode: "ajouter" });
  S.setOrdreFichiers(["tm1", "tm0"]);
  const geo = P.geojson();
  verifie("tm1 trace en premier", geo.features.map((f) => f.properties.id_tournee), ["tm1", "tm0"]);
  verifie("toujours deux traces séparées", geo.features.length, 2);
  const couleursPileInversee = [S.getTourneeColor("tm0"), S.getTourneeColor("tm1")];
  S.setOrdreFichiers(["tm0", "tm1"]);
  verifie("reordonner la pile ne change aucune couleur",
    [S.getTourneeColor("tm0"), S.getTourneeColor("tm1")], couleursPileInversee);
}

// --------------------------------------------------------------------------
console.log("\n=== 4. Couleur choisie : retenue et persistée ===");
{
  const sandbox = { window: {}, localStorage: fauxLocalStorage(), console, L: fauxLeaflet(),
    fetch: () => Promise.reject(new Error("hors ligne")), setTimeout, clearTimeout, Promise };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.MapView = { distanceMeters };
  sandbox.window.L = sandbox.L;
  vm.createContext(sandbox);
  const srcStore = fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8");
  const srcParcours = fs.readFileSync(path.join(RACINE, "js/parcours.js"), "utf8");
  vm.runInContext(srcStore, sandbox);
  vm.runInContext(srcParcours, sandbox);
  const S1 = sandbox.window.Store;
  S1.load();
  S1.importFromCSV(CSV_A, { mode: "remplacer" });
  S1.importFromCSV(CSV_B, { mode: "ajouter" });
  const autoTm0 = S1.getTourneeColor("tm0");
  S1.setTourneeColor("tm1", "#ff00aa");
  verifie("couleur retenue", S1.getTourneeColor("tm1"), "#ff00aa");
  verifie("l'autre n'a pas bougé", S1.getTourneeColor("tm0"), autoTm0);

  vm.runInContext(srcStore, sandbox);
  vm.runInContext(srcParcours, sandbox);
  const S2 = sandbox.window.Store;
  S2.load();
  verifie("couleur relue après rechargement", S2.getTourneeColor("tm1"), "#ff00aa");
  const geo = sandbox.window.Parcours.geojson();
  verifie("l'export dit la couleur choisie",
    geo.features.filter((f) => f.properties.id_tournee === "tm1")[0].properties.couleur, "#ff00aa");
}

// --------------------------------------------------------------------------
console.log("\n=== 5. La distance ne compte pas le saut entre deux tournées ===");
{
  const { S, P } = chargerParcours();
  S.load();
  S.importFromCSV(CSV_A, { mode: "remplacer" });
  S.importFromCSV(CSV_B, { mode: "ajouter" });

  // Chaque fichier tient deux étapes, ancrées sur la médiane de ses deux boîtes :
  // base+0,001 et base+0,005. Un seul saut par fichier, de 0,004 degré de
  // latitude. La somme attendue vaut donc exactement ces deux sauts-là, et rien
  // du kilomètre qui sépare les deux grappes.
  const unSaut = distanceMeters(45.801, 0.45, 45.805, 0.45);
  const attendu = 2 * unSaut;
  const obtenu = P.resume(P.construire()).distanceVolOiseau;

  verifie("somme = les deux chaînes, sans le saut entre elles",
    Math.round(obtenu), Math.round(attendu));

  // Le saut évité vaut environ un kilomètre : s'il entrait dans la somme, elle
  // le dirait tout de suite.
  const sautEvite = distanceMeters(45.805, 0.45, 45.811, 0.45);
  verifie("le saut évité est de l'ordre du kilomètre", sautEvite > 500, true);
  verifie("il n'est pas dans la somme", obtenu < attendu + sautEvite / 2, true);
}

console.log(echecs === 0 ? "\nTOUT PASSE" : "\n" + echecs + " ECHEC(S)");
process.exit(echecs === 0 ? 0 : 1);
