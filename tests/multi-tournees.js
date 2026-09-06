// Banc d'essai headless du tri multi-fichiers : on charge store.js dans un
// faux navigateur et on interroge l'ordre de la tournée.
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

function chargerStore() {
  const sandbox = { window: {}, localStorage: fauxLocalStorage(), console };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8"), sandbox);
  return sandbox.window.Store;
}

let echecs = 0;
function verifie(nom, obtenu, attendu) {
  const a = JSON.stringify(obtenu), b = JSON.stringify(attendu);
  if (a === b) { console.log("  OK   " + nom); }
  else { echecs++; console.log("  ECHEC " + nom + "\n         obtenu  " + a + "\n         attendu " + b); }
}

function csv(lignes) {
  const head = "id,id_tournee,nom_famille,numero,rue,code_postal,commune,lieu_dit,latitude,longitude,geocode_statut,casier_c,casier_l,ordre_zone,ordre_rue,position_manuelle,type_objet,notes,stoppub,date_maj";
  return [head].concat(lignes).join("\n");
}
// id,id_tournee,nom,num,rue,cp,commune,lieu_dit,lat,lon,statut,c,l,oz,or,pm,type,notes,stoppub,maj
function ligne(id, tour, nom, rue, c, l, oz, or_) {
  return [id, tour, nom, "1", rue, "16000", "VILLE", "", "", "", "", c, l, oz, or_, "", "lettre", "", "false", "2026-09-05"].join(",");
}

// --------------------------------------------------------------------------
console.log("\n=== 1. Un seul fichier : rien ne change, drapeau levé ou non ===");
{
  const S = chargerStore();
  S.load();
  S.importFromCSV(csv([
    ligne("a1", "tm0", "MARTIN", "RUE A", 1, 1, 1, 1),
    ligne("a2", "tm0", "DUBOIS", "RUE A", 1, 1, 1, 2),
    ligne("a3", "tm0", "PETIT", "RUE B", 1, 2, 2, 1),
    ligne("a4", "tm0", "HORS", "RUE C", "", "", 9, 1),
  ]));
  const ordre = () => S.rowsOrdreTournee().map((r) => r.id);
  verifie("ordre drapeau baissé", ordre(), ["a1", "a2", "a3", "a4"]);
  verifie("pas d'empilement", S.multiActif(), false);
  verifie("un fichier détecté", S.getFichiers().map((f) => f.id), ["tm0"]);
  verifie("clés de casier inchangées", S.etapesCasier().map((e) => e.cle), ["C1L1", "C1L2", "hors"]);
  verifie("suffixe vide", S.suffixeFichier({ id_tournee: "tm0" }), "");

  S.setSetting("multiTournees", true);
  verifie("drapeau levé, un seul fichier : toujours pas d'empilement", S.multiActif(), false);
  verifie("ordre identique", ordre(), ["a1", "a2", "a3", "a4"]);
  verifie("clés identiques", S.etapesCasier().map((e) => e.cle), ["C1L1", "C1L2", "hors"]);
}

// --------------------------------------------------------------------------
console.log("\n=== 2. Deux fichiers empilés : priorité de la pile sur C1L1 ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  S.importFromCSV(csv([
    ligne("a1", "tm0", "MARTIN", "RUE A", 1, 1, 1, 1),
    ligne("a2", "tm0", "DUBOIS", "RUE B", 1, 2, 2, 1),
    ligne("a3", "tm0", "HORS0", "RUE Z", "", "", 9, 1),
  ]), { mode: "remplacer", nomFichier: "tm0.csv" });
  S.importFromCSV(csv([
    ligne("b1", "tm1", "LEROY", "RUE C", 1, 1, 1, 1),
    ligne("b2", "tm1", "GARNIER", "RUE D", 1, 2, 2, 1),
    ligne("b3", "tm1", "HORS1", "RUE Y", "", "", 9, 1),
  ]), { mode: "ajouter", nomFichier: "tm1.csv" });

  verifie("pile = ordre d'arrivée", S.getFichiers().map((f) => f.id), ["tm0", "tm1"]);
  verifie("empilement actif", S.multiActif(), true);
  verifie("6 adresses", S.getRows().length, 6);

  const ordre = () => S.rowsOrdreTournee().map((r) => r.id);
  verifie("tm0 avant tm1", ordre(), ["a1", "b1", "a2", "b2", "a3", "b3"]);
  verifie("étapes distinctes", S.etapesCasier().map((e) => e.label),
    ["C1L1 · tm0", "C1L1 · tm1", "C1L2 · tm0", "C1L2 · tm1", "Hors casier · tm0", "Hors casier · tm1"]);

  S.setOrdreFichiers(["tm1", "tm0"]);
  verifie("pile inversée", S.getFichiers().map((f) => f.id), ["tm1", "tm0"]);
  verifie("tm1 avant tm0", ordre(), ["b1", "a1", "b2", "a2", "b3", "a3"]);
  verifie("étapes suivent la pile", S.etapesCasier().map((e) => e.label),
    ["C1L1 · tm1", "C1L1 · tm0", "C1L2 · tm1", "C1L2 · tm0", "Hors casier · tm1", "Hors casier · tm0"]);

  verifie("deplacerFichier ↓", (S.deplacerFichier("tm1", 1), S.getFichiers().map((f) => f.id)), ["tm0", "tm1"]);
  verifie("deplacerFichier bloqué en bout", S.deplacerFichier("tm1", 1), false);
}

// --------------------------------------------------------------------------
console.log("\n=== 3. Même adresse dans deux fichiers : jamais fusionnée ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  S.importFromCSV(csv([ligne("x1", "tm0", "MARTIN", "RUE A", 1, 1, 1, 1)]), { mode: "remplacer" });
  // même id de ligne ET même adresse, dans un autre fichier
  S.importFromCSV(csv([ligne("x1", "tm1", "MARTIN", "RUE A", 1, 1, 1, 1)]), { mode: "ajouter" });

  verifie("les deux lignes survivent", S.getRows().length, 2);
  const ids = S.getRows().map((r) => r.id);
  verifie("identifiants uniques", new Set(ids).size, 2);
  verifie("deux étapes de casier", S.etapesCasier().length, 2);
  // Les colonnes appartiennent à leur fichier : le C1 de tm0 et le C1 de tm1
  // sont deux colonnes de deux casiers, jamais une seule.
  const cols = S.casierColonnes();
  verifie("deux colonnes C1, une par fichier", cols.map((c) => c.cle), ["tm0@1", "tm1@1"]);
  verifie("chacune sa ligne", cols.map((c) => c.lignes.map((li) => li.cle).join("+")),
    ["C1L1@tm0", "C1L1@tm1"]);
  verifie("chaque ligne porte son fichier", cols.map((c) => c.lignes[0].fichier), ["tm0", "tm1"]);
  verifie("restreint à un fichier", S.casierColonnes("tm1").map((c) => c.cle), ["tm1@1"]);
}

// --------------------------------------------------------------------------
console.log("\n=== 3b. Une colonne n'en efface jamais une autre ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  // tm1 : C1 C2 C3   —   tm0 : C1 C2 C4
  S.importFromCSV(csv([
    ligne("m1", "tm1", "A", "RUE A", 1, 1, 1, 1),
    ligne("m2", "tm1", "B", "RUE B", 2, 1, 2, 1),
    ligne("m3", "tm1", "C", "RUE C", 3, 1, 3, 1),
  ]), { mode: "remplacer" });
  S.importFromCSV(csv([
    ligne("m4", "tm0", "D", "RUE D", 1, 1, 1, 1),
    ligne("m5", "tm0", "E", "RUE E", 2, 1, 2, 1),
    ligne("m6", "tm0", "F", "RUE F", 4, 1, 4, 1),
  ]), { mode: "ajouter" });
  S.setOrdreFichiers(["tm1", "tm0"]);

  verifie("six colonnes, aucune avalée",
    S.casierColonnes().map((c) => (c.fichier || "-") + "/C" + c.c),
    ["tm1/C1", "tm1/C2", "tm1/C3", "tm0/C1", "tm0/C2", "tm0/C4"]);
  verifie("le C1 de tm0 garde son adresse",
    S.casierColonnes("tm0").filter((c) => c.c === 1)[0].lignes[0].rows.map((r) => r.id), ["m4"]);
  verifie("le C1 de tm1 garde la sienne",
    S.casierColonnes("tm1").filter((c) => c.c === 1)[0].lignes[0].rows.map((r) => r.id), ["m1"]);
  verifie("chaque tournée navigue dans ses colonnes à elle",
    [S.casierColonnes("tm1").length, S.casierColonnes("tm0").length], [3, 3]);
}

// --------------------------------------------------------------------------
console.log("\n=== 3c. Zones écartées, renommage, export choisi ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  S.importFromCSV(csv([
    ligne("z1", "tm0", "A", "RUE A", 1, 1, 1, 1),
    ligne("z2", "tm0", "B", "RUE B", 1, 2, 2, 1),
  ]), { mode: "remplacer" });
  S.importFromCSV(csv([
    ligne("z3", "tm1", "C", "RUE C", 1, 1, 1, 1),
  ]), { mode: "ajouter" });

  verifie("toutes les cases entrent d'office",
    S.zonesDuFichier("tm0").map((z) => z.cle + ":" + z.integree), ["C1L1:true", "C1L2:true"]);

  S.setZoneIntegree("tm0", "C1L2", false);
  verifie("la case écartée sort de la tournée",
    S.rowsOrdreTournee().map((r) => r.id), ["z1", "z3"]);
  verifie("mais reste dans la base", S.getRows().length, 3);
  verifie("le sélecteur la montre décochée",
    S.zonesDuFichier("tm0").map((z) => z.cle + ":" + z.integree), ["C1L1:true", "C1L2:false"]);
  verifie("une case écartée n'est pas une colonne de la tournée",
    S.casierColonnes("tm0").map((c) => c.lignes.length), [1]);

  // Renommage : les adresses, la pile, la couleur et les zones suivent.
  const autoTm1 = S.getTourneeColor("tm1");
  S.setTourneeColor("tm0", "#123456");
  const res = S.renommerFichier("tm0", "tmX");
  verifie("renommage accepté", res.ok, true);
  verifie("les adresses portent le nouvel identifiant",
    S.getRows().filter((r) => r.id_tournee === "tmX").length, 2);
  verifie("la pile aussi", S.getFichiers().map((f) => f.id), ["tmX", "tm1"]);
  verifie("la couleur suit", S.getTourneeColor("tmX"), "#123456");
  verifie("celle du voisin ne bouge pas", S.getTourneeColor("tm1"), autoTm1);
  verifie("les zones écartées suivent",
    S.zonesDuFichier("tmX").map((z) => z.cle + ":" + z.integree), ["C1L1:true", "C1L2:false"]);
  verifie("un identifiant déjà pris est refusé", S.renommerFichier("tmX", "tm1").ok, false);


  // Export : strictement les tournées demandées.
  const toutes = S.exportCSVText().split("\n").filter(Boolean).length - 1;
  const uneSeule = S.exportCSVText(["tm1"]).split("\n").filter(Boolean).length - 1;
  verifie("tout sans sélection", toutes, 3);
  verifie("la sélection est respectée", uneSeule, 1);
  verifie("l'export garde les adresses écartées de la tournée",
    S.exportCSVText(["tmX"]).split("\n").filter(Boolean).length - 1, 2);
  // Une couleur seulement automatique appartient déjà au fichier aux yeux de
  // l'utilisateur : renommer ne doit pas la lui changer sous les yeux.
  const autoAvant = S.getTourneeColor("tm1");
  S.renommerFichier("tm1", "tmZ");
  verifie("une couleur d'office survit au renommage", S.getTourneeColor("tmZ"), autoAvant);
}

// --------------------------------------------------------------------------
console.log("\n=== 4. Retrait d'un fichier, retour au mono-fichier ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  S.importFromCSV(csv([ligne("a1", "tm0", "A", "RUE A", 1, 1, 1, 1)]), { mode: "remplacer" });
  S.importFromCSV(csv([ligne("b1", "tm1", "B", "RUE B", 1, 1, 1, 1)]), { mode: "ajouter" });
  verifie("clés suffixées à deux", S.etapesCasier().map((e) => e.cle), ["C1L1@tm0", "C1L1@tm1"]);
  const perdues = S.retirerFichier("tm1");
  verifie("1 adresse retirée", perdues, 1);
  verifie("pile réduite", S.getFichiers().map((f) => f.id), ["tm0"]);
  verifie("plus d'empilement", S.multiActif(), false);
  verifie("clés redevenues nues", S.etapesCasier().map((e) => e.cle), ["C1L1"]);
}

// --------------------------------------------------------------------------
console.log("\n=== 5. Réimport d'un fichier déjà empilé : mise à jour en place ===");
{
  const S = chargerStore();
  S.load();
  S.setSetting("multiTournees", true);
  S.importFromCSV(csv([ligne("a1", "tm0", "A", "RUE A", 1, 1, 1, 1)]), { mode: "remplacer" });
  S.importFromCSV(csv([ligne("b1", "tm1", "B", "RUE B", 1, 1, 1, 1)]), { mode: "ajouter" });
  S.setOrdreFichiers(["tm1", "tm0"]);
  S.importFromCSV(csv([
    ligne("a1", "tm0", "A", "RUE A", 1, 1, 1, 1),
    ligne("a2", "tm0", "A2", "RUE A", 1, 1, 1, 2),
  ]), { mode: "ajouter", nomFichier: "tm0-v2.csv" });
  verifie("pas de doublon de fichier", S.getFichiers().map((f) => f.id), ["tm1", "tm0"]);
  verifie("place dans la pile conservée", S.getFichiers()[0].id, "tm1");
  verifie("contenu remplacé, pas cumulé", S.getRows().filter((r) => r.id_tournee === "tm0").length, 2);
  verifie("total", S.getRows().length, 3);
}

// --------------------------------------------------------------------------
console.log("\n=== 6. Persistance de l'ordre à travers un rechargement ===");
{
  const sandbox = { window: {}, localStorage: fauxLocalStorage(), console };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8");
  vm.runInContext(src, sandbox);
  const S1 = sandbox.window.Store;
  S1.load();
  S1.setSetting("multiTournees", true);
  S1.importFromCSV(csv([ligne("a1", "tm0", "A", "RUE A", 1, 1, 1, 1)]), { mode: "remplacer" });
  S1.importFromCSV(csv([ligne("b1", "tm1", "B", "RUE B", 1, 1, 1, 1)]), { mode: "ajouter" });
  S1.setOrdreFichiers(["tm1", "tm0"]);

  // même localStorage, nouvelle instance du module : c'est un rechargement
  vm.runInContext(src, sandbox);
  const S2 = sandbox.window.Store;
  S2.load();
  verifie("ordre relu tel quel", S2.getFichiers().map((f) => f.id), ["tm1", "tm0"]);
  verifie("drapeau relu", S2.getSettings().multiTournees, true);
  verifie("ordre de tournée conservé", S2.rowsOrdreTournee().map((r) => r.id_tournee), ["tm1", "tm0"]);
}

// --------------------------------------------------------------------------
console.log("\n=== 7. Pile héritée d'un stockage sans pile ===");
{
  const sandbox = { window: {}, localStorage: fauxLocalStorage(), console };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8");
  // un stockage d'avant la fonctionnalité : des lignes, une méta sans fichiers
  sandbox.localStorage.setItem("atournee_data_v2", JSON.stringify([
    { id: "a1", id_tournee: "tm0", nom_famille: "A", rue: "RUE A", casier_c: "1", casier_l: "1" },
    { id: "b1", id_tournee: "tm1", nom_famille: "B", rue: "RUE B", casier_c: "1", casier_l: "1" },
  ]));
  sandbox.localStorage.setItem("atournee_meta_v2", JSON.stringify({ idTournee: "tm002" }));
  vm.runInContext(src, sandbox);
  const S = sandbox.window.Store;
  S.load();
  verifie("pile reconstruite depuis les données", S.getFichiers().map((f) => f.id), ["tm0", "tm1"]);
  verifie("comptes justes", S.getFichiers().map((f) => f.count), [1, 1]);
  verifie("drapeau baissé par défaut : pas d'empilement", S.multiActif(), false);
  verifie("comportement d'avant préservé", S.etapesCasier().map((e) => e.cle), ["C1L1"]);
}

console.log(echecs === 0 ? "\nTOUT PASSE" : "\n" + echecs + " ECHEC(S)");
process.exit(echecs === 0 ? 0 : 1);
