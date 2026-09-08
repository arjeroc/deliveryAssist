// Banc d'essai du scan : on charge js/scan-core.js dans un faux navigateur —
// il n'en demande pas plus, puisqu'il ne connaît ni le DOM ni la caméra — et
// on éprouve la mécanique : cadence, états, gel des traitements, et surtout
// le fait que rien ne s'écrit dans la préparation avant le bouton vert.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RACINE = path.resolve(__dirname, "..");

function chargerCore() {
  const sandbox = { window: {}, console, Promise, Math, Date, Object, Number, Array, Infinity };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RACINE, "js/scan-core.js"), "utf8"), sandbox);
  return sandbox.window.ScanCore;
}

const C = chargerCore();
const E = C.ETATS;

let echecs = 0;
function verifie(nom, obtenu, attendu) {
  const a = JSON.stringify(obtenu), b = JSON.stringify(attendu);
  if (a === b) { console.log("  OK   " + nom); }
  else { echecs++; console.log("  ECHEC " + nom + "\n         obtenu  " + a + "\n         attendu " + b); }
}

// Une horloge que l'on avance à la main : sans elle, éprouver une cadence
// d'une seconde demanderait d'attendre une seconde.
function horlogeManuelle() {
  let t = 0;
  const h = () => t;
  h.avancer = (ms) => { t += ms; };
  return h;
}

// Une préparation en carton, qui note qui l'appelle et avec quoi.
function fausePrep() {
  const appels = [];
  return { appels, adjust: (idT, id, type, n) => appels.push([idT, id, type, n]) };
}

// Promesse dont on décide le dénouement : c'est ainsi qu'on tient une lecture
// « en vol » le temps de vérifier qu'aucune autre ne part.
function promesseTenue() {
  let resoudre;
  const p = new Promise((r) => { resoudre = r; });
  return { p, resoudre };
}

const attendre = () => new Promise((r) => setImmediate(r));

// --------------------------------------------------------------------------
console.log("\n=== 1. Machine à états : ce qui est permis, et rien d'autre ===");
{
  const m = C.creerMachine();
  verifie("départ au repos", m.etat(), E.IDLE);
  verifie("repos → démarrage caméra", m.aller(E.DEMARRAGE), true);
  verifie("démarrage → viseur", m.aller(E.VISEUR), true);
  verifie("viseur → attribution", m.aller(E.ATTRIBUTION), true);
  verifie("attribution → lecture refusée", m.aller(E.LECTURE), false);
  verifie("état inchangé après refus", m.etat(), E.ATTRIBUTION);
  verifie("attribution → démarrage caméra", m.aller(E.DEMARRAGE), true);
  verifie("démarrage → viseur → repos", m.aller(E.VISEUR) && m.aller(E.IDLE), true);

  const vus = [];
  const n = C.creerMachine((etat, avant) => vus.push(avant + ">" + etat));
  n.aller(E.DEMARRAGE); n.aller(E.DEMARRAGE); n.aller(E.VISEUR);
  verifie("un état identique ne se notifie pas", vus, ["idle>camera-starting", "camera-starting>scanning"]);

  // Tout état mène au repos : le ✕ doit fonctionner partout.
  Object.keys(C.TRANSITIONS).forEach((etat) => {
    if (etat === E.IDLE) return;
    if (C.TRANSITIONS[etat].indexOf(E.IDLE) < 0) {
      echecs++; console.log("  ECHEC " + etat + " ne sait pas revenir au repos");
    }
  });
  console.log("  OK   tout état sait revenir au repos");
}

// --------------------------------------------------------------------------
console.log("\n=== 2. Cadence : une lecture à la fois, et pas plus vite que prévu ===");
{
  const h = horlogeManuelle();
  const cad = C.creerCadence({ intervalle: 1000, horloge: h });
  const t1 = promesseTenue();
  let departs = 0;

  const p1 = cad.lancer(() => { departs++; return t1.p; });
  verifie("première lecture partie", !!p1, true);
  verifie("cadence occupée", cad.enVol(), true);
  const p2 = cad.lancer(() => { departs++; return Promise.resolve("x"); });
  verifie("aucune lecture en parallèle", p2, null);
  verifie("un seul départ", departs, 1);

  t1.resoudre("un");
  (async () => {
    verifie("résultat de la première rendu", await p1, "un");
    // Elle vient de finir : la suivante attend encore l'intervalle.
    verifie("cadence tenue juste après", cad.lancer(() => Promise.resolve("y")), null);
    h.avancer(999);
    verifie("cadence tenue à 999 ms", cad.lancer(() => Promise.resolve("y")), null);
    h.avancer(1);
    const p3 = cad.lancer(() => { departs++; return Promise.resolve("deux"); });
    verifie("lecture autorisée à 1000 ms", await p3, "deux");
    verifie("deux départs en tout", departs, 2);

    // --------------------------------------------------------------------
    console.log("\n=== 3. Cadence : un changement d'état périme la lecture en vol ===");
    const h2 = horlogeManuelle();
    const cad2 = C.creerCadence({ intervalle: 1000, horloge: h2 });
    const t2 = promesseTenue();
    const p4 = cad2.lancer(() => t2.p);
    cad2.annuler();                       // l'utilisateur a touché une carte
    t2.resoudre("trop tard");
    verifie("le résultat périmé ne remonte pas", await p4, null);
    verifie("la cadence repart libre", cad2.pret(), true);

    await suite();
  })().catch((e) => { echecs++; console.log("  ECHEC exception : " + e.message); fin(); });
}

// --------------------------------------------------------------------------
async function suite() {
  console.log("\n=== 4. Qualité d'image : ce qu'on dit à l'utilisateur ===");
  {
    const bon = { contraste: 40, nettete: 20, empreinte: new Array(16).fill(120) };
    const bouge = { contraste: 40, nettete: 20, empreinte: new Array(16).fill(200) };
    const flou = { contraste: 40, nettete: 1, empreinte: new Array(16).fill(120) };
    const sombre = { contraste: 4, nettete: 20, empreinte: new Array(16).fill(120) };
    verifie("image utilisable", C.qualiteFrame(bon, bon), { utilisable: true, indication: "" });
    verifie("cadre vide", C.qualiteFrame(null, null).indication, "Placez l'étiquette dans le cadre");
    verifie("main qui bouge", C.qualiteFrame(bouge, bon).indication, "Stabilisez l'étiquette");
    verifie("image floue", C.qualiteFrame(flou, flou).indication, "Rapprochez-vous de l'étiquette");
    verifie("image sombre", C.qualiteFrame(sombre, sombre).indication, "Cherchez un peu plus de lumière");

    // Une vignette 8×8 : moitié noire, moitié blanche. Contraste franc, une
    // seule transition verticale — donc peu de gradient horizontal.
    const l = 8, hh = 8, data = new Uint8ClampedArray(l * hh * 4);
    for (let y = 0; y < hh; y++) for (let x = 0; x < l; x++) {
      const v = y < 4 ? 0 : 255, i = (y * l + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    const st = C.statsZone(data, l, hh, 1);
    verifie("moyenne d'une image mi-noire mi-blanche", Math.round(st.moyenne), 128);
    verifie("contraste maximal", Math.round(st.contraste), 128);
    verifie("aucun gradient horizontal", st.nettete, 0);
    verifie("empreinte en quatre bandes", st.empreinte.slice(0, 4).concat(st.empreinte.slice(12)),
      [0, 0, 0, 0, 255, 255, 255, 255]);
    verifie("empreintes incomparables : écart maximal", C.ecartEmpreinte([1], null), 255);
  }

  console.log("\n=== 5. Cadrage et orientations ===");
  {
    const r = C.rectCapture(1000, 1000, { partLargeur: 0.8, partHauteur: 0.4, marge: 0 });
    verifie("cadre centré sans marge", r, { x: 100, y: 300, w: 800, h: 400 });
    const m = C.rectCapture(1000, 1000, { partLargeur: 0.8, partHauteur: 0.4, marge: 0.125 });
    verifie("la marge élargit le cadre", { w: m.w, h: m.h }, { w: 900, h: 450 });
    verifie("la marge reste centrée", { x: m.x, y: m.y }, { x: 50, y: 275 });
    const b = C.rectCapture(600, 400, { partLargeur: 1, partHauteur: 1, marge: 0.5 });
    verifie("jamais plus grand que l'image", b, { x: 0, y: 0, w: 600, h: 400 });

    // Le repli « pivot forcé » : buffer portrait, image redressée d'un quart
    // de tour pour l'œil. Le cadrage doit se raisonner dans le repère vu —
    // large veut dire large — puis revenir en coordonnées du buffer. Sans
    // cette traduction, « 90 % de large » désigne une bande verticale et le
    // cadre blanc cesse de montrer ce qui est lu : c'est la régression qui a
    // rendu le scan muet.
    {
      const opts = { partLargeur: 0.90, partHauteur: 0.70, marge: 0 };
      const droit = C.rectCaptureOriente(1000, 500, 0, opts);
      verifie("sans rotation, rien ne change",
        droit, C.rectCapture(1000, 500, opts));

      // Buffer 720×1280 (portrait), vu 1280×720 (paysage) : la découpe vue
      // fait 1152×504, donc 504 de large et 1152 de haut dans le buffer.
      const q = C.rectCaptureOriente(720, 1280, -90, opts);
      verifie("un quart de tour échange les axes",
        { w: q.w, h: q.h }, { w: 504, h: 1152 });
      verifie("et reste dans l'image",
        q.x >= 0 && q.y >= 0 && q.x + q.w <= 720 && q.y + q.h <= 1280, true);
      verifie("découpe centrée après traduction",
        { x: q.x, y: q.y }, { x: 108, y: 64 });

      // L'autre sens vise la même zone : seule l'orientation du contenu
      // change, jamais la région du capteur qui est lue.
      const inv = C.rectCaptureOriente(720, 1280, 90, opts);
      verifie("les deux sens lisent la même région", inv, q);
      verifie("270 vaut -90", C.rectCaptureOriente(720, 1280, 270, opts), q);
    }

    verifie("photo : les quatre angles", C.anglesAEssayer("photo"), [0, 90, 270, 180]);
    verifie("vidéo : l'orientation retenue seule", C.anglesAEssayer("video", 0, 0), [0]);
    verifie("vidéo : aucune rotation OCR coûteuse après un échec", C.anglesAEssayer("video", 0, 1), [0]);
    verifie("vidéo : le flux redressé reste lu à 0°", C.anglesAEssayer("video", 270, 3), [0]);
  }

  console.log("\n=== 6. Cartes : on ne remplace que sur du neuf, et du meilleur ===");
  {
    const c = (id, score) => ({ row: { id }, score, touches: 3 });
    verifie("rien à afficher : on garde", C.doitRemplacer([c("a", 5)], []), false);
    verifie("premier résultat : on affiche", C.doitRemplacer([], [c("a", 5)]), true);
    verifie("mêmes adresses : on ne redessine pas", C.doitRemplacer([c("a", 5)], [c("a", 9)]), false);
    verifie("meilleur résultat : on remplace", C.doitRemplacer([c("a", 5)], [c("b", 6)]), true);
    verifie("résultat plus faible : on garde", C.doitRemplacer([c("a", 5)], [c("b", 4)]), false);
    verifie("écart faible : aucun gagnant", C.ecartFaible([c("a", 10), c("b", 9.5)]), true);
    verifie("écart franc : un gagnant", C.ecartFaible([c("a", 10), c("b", 5)]), false);
    verifie("un seul candidat : un gagnant", C.ecartFaible([c("a", 10)]), false);
  }

  console.log("\n=== 7. Attribution : rien ne s'écrit sans le bouton vert ===");
  {
    const prep = fausePrep();
    const b = C.creerBrouillon(["lettres", "colis"]);
    b.ajuster("colis", 3);
    b.ajuster("colis", -1);
    b.ajuster("lettres", -5);
    verifie("quantité tenue en mémoire", b.valeurs(), { lettres: 0, colis: 2 });
    verifie("jamais négatif", b.get("lettres"), 0);
    verifie("catégorie inconnue ignorée", b.ajuster("presse", 4), 0);
    verifie("aucune écriture pendant la saisie", prep.appels.length, 0);
    verifie("écriture au moment voulu",
      C.appliquerAttribution(prep, "tm0", "a1", b.valeurs()), { colis: 2 });
    verifie("les zéros ne s'écrivent pas", prep.appels, [["tm0", "a1", "colis", 2]]);
    verifie("sans adresse, rien ne s'écrit", C.appliquerAttribution(prep, "tm0", null, { colis: 1 }), {});
    verifie("toujours un seul appel", prep.appels.length, 1);
  }

  console.log("\n=== 8. Erreurs caméra : un message par cause ===");
  {
    verifie("permission refusée",
      C.messageErreurCamera({ name: "NotAllowedError" }).indexOf("refusé") > 0, true);
    verifie("aucune caméra",
      C.messageErreurCamera({ name: "NotFoundError" }).indexOf("trouvée") > 0, true);
    verifie("caméra occupée",
      C.messageErreurCamera({ name: "NotReadableError" }).indexOf("autre application") > 0, true);
    verifie("résolution impossible",
      C.messageErreurCamera({ name: "OverconstrainedError" }).indexOf("l'image demandée") > 0, true);
    verifie("hors HTTPS", C.messageErreurCamera({ name: "non-securise" }).indexOf("HTTPS") > 0, true);
    verifie("cause inconnue nommée", C.messageErreurCamera({ name: "Zut" }).indexOf("(Zut)") > 0, true);
    verifie("pas de vidéo hors contexte sûr", C.videoDisponible({ mediaDevices: { getUserMedia: 1 } }, false), false);
    verifie("pas de vidéo sans getUserMedia", C.videoDisponible({ mediaDevices: {} }, true), false);
    verifie("vidéo disponible", C.videoDisponible({ mediaDevices: { getUserMedia: 1 } }, true), true);
  }

  await sessionTests();
  await insistanceTests();
  rapprochementTests();
  fin();
}

// --------------------------------------------------------------------------
// La session complète, avec caméra et OCR en carton.
// --------------------------------------------------------------------------
function creerBanc(opts) {
  opts = opts || {};
  const journal = [];
  const prep = fausePrep();
  const h = horlogeManuelle();
  const lectures = [];
  const motifs = [];
  let camerasOuvertes = 0, camerasFermees = 0;

  const session = C.creerSession({
    types: ["lettres", "colis", "presse"],
    prep,
    idTournee: () => "tm0",
    cadence: C.creerCadence({ intervalle: 1000, horloge: h }),
    demarrerCamera: () => {
      camerasOuvertes++;
      return opts.camera === "echec"
        ? Promise.reject({ name: "NotReadableError" })
        : Promise.resolve(true);
    },
    arreterCamera: (motif) => { camerasFermees++; motifs.push(motif); },
    reconnaitre: (angles) => {
      const t = promesseTenue();
      lectures.push({ angles, ...t });
      return t.p;
    },
    qualifier: (texte) => (texte
      ? [{ row: { id: texte }, score: texte.length, touches: 3 }]
      : []),
    onEtat: (etat) => journal.push(etat)
  });

  return { session, journal, prep, horloge: h, lectures, motifs,
    ouvertes: () => camerasOuvertes, fermees: () => camerasFermees };
}

const BONNE_IMAGE = { contraste: 40, nettete: 20, empreinte: new Array(16).fill(120) };

async function sessionTests() {
  console.log("\n=== 9. Session : viseur → lecture → attribution → viseur ===");
  {
    const b = creerBanc();
    await b.session.demarrer();
    b.session.evaluerFrame(BONNE_IMAGE);
    b.session.evaluerFrame(BONNE_IMAGE);
    verifie("mode photo : l'évaluation seule ne lance pas d'OCR", b.lectures.length, 0);
    b.session.tick(BONNE_IMAGE);
    verifie("mode photo : le déclencheur lance une seule lecture", b.lectures.length, 1);
    b.lectures[0].resoudre({ texte: "", angle: 0 });
    await attendre();
  }
  {
    const b = creerBanc();
    await b.session.demarrer();
    verifie("caméra ouverte une fois", b.ouvertes(), 1);
    verifie("chemin d'ouverture", b.journal, ["camera-starting", "scanning"]);

    b.session.tick(BONNE_IMAGE);                       // première image : cadrage
    verifie("aucune lecture sur une image seule", b.lectures.length, 0);
    b.session.tick(BONNE_IMAGE);                       // stable : la lecture part
    verifie("lecture lancée", b.lectures.length, 1);
    verifie("orientation principale seule", b.lectures[0].angles, [0]);
    verifie("état de lecture", b.session.etat(), "recognizing");

    b.session.tick(BONNE_IMAGE);                       // pendant la lecture
    verifie("aucune lecture parallèle", b.lectures.length, 1);

    b.lectures[0].resoudre({ texte: "MARTIN", angle: 0 });
    await attendre();
    verifie("retour au viseur", b.session.etat(), "scanning");
    verifie("cartes proposées", b.session.candidats().map((c) => c.row.id), ["MARTIN"]);
    verifie("aucune adresse choisie d'office", b.session.adresseId(), null);
    verifie("aucune écriture", b.prep.appels.length, 0);

    // Le doigt tranche.
    b.session.choisir("MARTIN");
    verifie("écran d'attribution", b.session.etat(), "assigning");
    verifie("caméra conservée pendant l'attribution", b.motifs.length, 0);
    verifie("candidats gelés", b.session.candidats().map((c) => c.row.id), ["MARTIN"]);
    b.horloge.avancer(5000);
    b.session.tick(BONNE_IMAGE);
    verifie("plus aucune lecture programmée", b.lectures.length, 1);

    b.session.ajusterQuantite("colis", 2);
    b.session.ajusterQuantite("presse", 1);
    verifie("quantités en attente", b.session.quantites(), { lettres: 0, colis: 2, presse: 1 });
    verifie("toujours rien d'écrit", b.prep.appels.length, 0);

    b.session.ajouterALaTournee();
    verifie("attribution enregistrée", b.prep.appels,
      [["tm0", "MARTIN", "colis", 2], ["tm0", "MARTIN", "presse", 1]]);
    await attendre();
    verifie("retour immédiat au viseur", b.session.etat(), "scanning");
    verifie("caméra redémarrée", b.ouvertes(), 2);
    verifie("quantités remises à zéro", b.session.quantites(), { lettres: 0, colis: 0, presse: 0 });
    verifie("cartes effacées pour l'étiquette suivante", b.session.candidats(), []);
    verifie("chemin complet", b.journal, [
      "camera-starting", "scanning", "recognizing", "scanning",
      "assigning", "camera-starting", "scanning"
    ]);
  }

  console.log("\n=== 10. « Changer d'adresse » n'enregistre rien ===");
  {
    const b = creerBanc();
    await b.session.demarrer();
    b.session.choisir("DUBOIS");
    b.session.ajusterQuantite("colis", 3);
    verifie("quantités saisies", b.session.quantites().colis, 3);
    b.session.changerAdresse();
    await attendre();
    verifie("rien d'enregistré", b.prep.appels, []);
    verifie("retour au viseur", b.session.etat(), "scanning");
    verifie("adresse relâchée", b.session.adresseId(), null);
    verifie("quantités oubliées", b.session.quantites(), { lettres: 0, colis: 0, presse: 0 });
    verifie("caméra reprise", b.ouvertes(), 2);
  }

  console.log("\n=== 11. Le ✕ ferme depuis n'importe quel état ===");
  {
    const b = creerBanc();
    await b.session.demarrer();
    b.session.tick(BONNE_IMAGE); b.session.tick(BONNE_IMAGE);
    verifie("une lecture est en vol", b.lectures.length, 1);
    b.session.choisir("PETIT");
    b.session.ajusterQuantite("colis", 4);
    b.session.fermer();
    verifie("état au repos", b.session.etat(), "idle");
    verifie("arrêt motivé par la fermeture", b.motifs[b.motifs.length - 1], "fermeture");
    verifie("adresse oubliée", b.session.adresseId(), null);
    verifie("quantités non validées perdues", b.session.quantites(), { lettres: 0, colis: 0, presse: 0 });
    verifie("aucune écriture", b.prep.appels, []);

    // La lecture partie avant la fermeture se dénoue dans le vide.
    b.lectures[0].resoudre({ texte: "PETIT", angle: 0 });
    await attendre();
    verifie("le résultat tardif ne réveille rien", b.session.etat(), "idle");
    verifie("aucune carte ressuscitée", b.session.candidats(), []);
  }

  console.log("\n=== 12. Repli photo et erreurs ===");
  {
    const b = creerBanc({ camera: "echec" });
    await b.session.demarrer();
    verifie("caméra en échec : état d'erreur", b.session.etat(), "error");
    verifie("arrêt motivé par l'erreur", b.motifs[b.motifs.length - 1], "erreur");
    verifie("le repli photo reste ouvert", b.session.modePhoto(), true);
    verifie("état photo", b.session.etat(), "fallback-photo");
    verifie("arrêt motivé par le repli", b.motifs[b.motifs.length - 1], "photo");

    b.session.poserCandidats([{ row: { id: "A" }, score: 9 }], "texte lu");
    verifie("le cliché pose ses cartes", b.session.candidats().map((c) => c.row.id), ["A"]);
    b.session.poserCandidats([], "rien");
    verifie("un nouveau cliché vide efface, lui", b.session.candidats(), []);

    b.session.poserCandidats([{ row: { id: "A" }, score: 9 }], "texte lu");
    verifie("choix possible depuis la photo", b.session.choisir("A"), true);
    verifie("attribution depuis la photo", b.session.etat(), "assigning");
    b.session.ajusterQuantite("lettres", 1);
    b.session.ajouterALaTournee();
    verifie("écriture depuis le repli", b.prep.appels, [["tm0", "A", "lettres", 1]]);
  }

  console.log("\n=== 13. Une lecture muette ne double pas le travail OCR vidéo ===");
  {
    const b = creerBanc();
    await b.session.demarrer();
    b.session.tick(BONNE_IMAGE); b.session.tick(BONNE_IMAGE);
    b.lectures[0].resoudre({ texte: "", angle: 0 });   // rien reconnu
    await attendre();
    b.horloge.avancer(1000);
    b.session.tick(BONNE_IMAGE);
    verifie("deuxième lecture toujours droite", b.lectures[1].angles, [0]);
    b.lectures[1].resoudre({ texte: "LEROY", angle: 0 });
    await attendre();
    b.horloge.avancer(1000);
    b.session.tick(BONNE_IMAGE);
    verifie("la lecture suivante reste droite", b.lectures[2].angles, [0]);
    verifie("cartes conservées pendant l'analyse suivante",
      b.session.candidats().map((c) => c.row.id), ["LEROY"]);
    b.lectures[2].resoudre({ texte: "", angle: 90 });
    await attendre();
    verifie("une lecture muette n'efface pas les cartes",
      b.session.candidats().map((c) => c.row.id), ["LEROY"]);
  }
}

// Une lecture complète : on avance l'horloge, on prend une image, on dénoue.
async function lire(b, texte, angle) {
  b.horloge.avancer(1500);
  b.session.tick(BONNE_IMAGE);
  const derniere = b.lectures[b.lectures.length - 1];
  derniere.resoudre({ texte: texte, angle: angle || 0 });
  await attendre();
}

async function insistanceTests() {
  console.log("\n=== 14. Une lecture qui insiste finit par passer devant ===");
  const b = creerBanc();
  await b.session.demarrer();
  b.session.tick(BONNE_IMAGE);            // image de calage

  await lire(b, "MARTINEZ");              // score 8
  verifie("première adresse proposée", b.session.candidats().map((c) => c.row.id), ["MARTINEZ"]);

  await lire(b, "PETIT");                 // score 5 : moins convaincant
  verifie("une lecture isolée ne renverse rien",
    b.session.candidats().map((c) => c.row.id), ["MARTINEZ"]);

  await lire(b, "PETIT");                 // la meme, deux fois de suite
  verifie("deux lectures concordantes l'emportent",
    b.session.candidats().map((c) => c.row.id), ["PETIT"]);

  await lire(b, "ROY");                   // score 3 : moins convaincant
  await lire(b, "GUY");                   // puis autre chose : personne n'insiste
  verifie("des lectures qui se contredisent ne changent rien",
    b.session.candidats().map((c) => c.row.id), ["PETIT"]);

  await lire(b, "");                      // lecture muette
  verifie("le silence non plus", b.session.candidats().map((c) => c.row.id), ["PETIT"]);

  b.session.choisir("PETIT");
  b.session.ajusterQuantite("colis", 1);
  b.session.ajouterALaTournee();
  await attendre();
  b.session.tick(BONNE_IMAGE);
  await lire(b, "DUBOIS");
  verifie("l'étiquette suivante s'affiche sans insister",
    b.session.candidats().map((c) => c.row.id), ["DUBOIS"]);
}

// --------------------------------------------------------------------------
// Le rapprochement lui-même, sur le vrai store.
// --------------------------------------------------------------------------
function chargerStore() {
  const memoire = new Map();
  const sandbox = {
    window: {}, console,
    localStorage: {
      getItem: (k) => (memoire.has(k) ? memoire.get(k) : null),
      setItem: (k, v) => memoire.set(k, String(v)),
      removeItem: (k) => memoire.delete(k),
      clear: () => memoire.clear(),
    },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RACINE, "js/store.js"), "utf8"), sandbox);
  return sandbox.window.Store;
}

function rapprochementTests() {
  console.log("\n=== 15. Un nom rare suffit ; un mot banal, non ===");
  const S = chargerStore();
  S.load();
  const head = "id,id_tournee,nom_famille,numero,rue,code_postal,commune,lieu_dit,latitude,longitude," +
    "geocode_statut,casier_c,casier_l,ordre_zone,ordre_rue,position_manuelle,type_objet,notes,stoppub,date_maj";
  const ligne = (id, nom, num, rue) => [id, "tm0", nom, num, rue, "16000", "ANGOULEME",
    "", "", "", "", "1", "1", "1", "1", "", "lettre", "", "false", "2026-09-05"].join(",");
  S.importFromCSV([head,
    ligne("a1", "MARTINEZ", "12", "RUE DES ROSIERS"),
    ligne("a2", "DUPONT", "5", "AVENUE DE LA GARE"),
    ligne("a3", "DUPONT", "7", "AVENUE DE LA GARE"),
    ligne("a4", "DUPONT", "9", "RUE DES ROSIERS"),
    ligne("a5", "ROY", "3", "PLACE DU MARCHE"),
    // Étiquettes terrain : une impression nette et une étiquette à fenêtre,
    // dont l'OCR peut confondre O/0, I/1, perdre un caractère ou hériter d'un
    // ancien encodage UTF-8 double.
    ligne("a6", "HILAIRE COURTOIS", "1", "ROUTE DE CHEZ FOUR"),
    ligne("a7", "FARGEOT HÃ©lÃ¨ne", "", "LIEU DIT LES PRADELIERES"),
  ].join("\n"));

  const ids = (texte) => S.matchTexteLibre(texte, 5).map((c) => c.row.id);

  verifie("adresse complète reconnue", ids("MARTINEZ\n12 RUE DES ROSIERS\n16000 ANGOULEME")[0], "a1");
  verifie("nom seul, porté par une seule adresse", ids("MARTINEZ"), ["a1"]);
  verifie("nom seul mal lu par l'OCR", ids("MARTLNEZ"), ["a1"]);
  verifie("nom seul dans le bruit d'une étiquette",
    ids("COLISSIMO 6A\nMME MARTINEZ\n8R0129384756"), ["a1"]);
  verifie("nom porté par trois adresses : rien n'est désigné", ids("DUPONT"), []);
  verifie("nom trop court pour se suffire", ids("ROY"), []);
  verifie("code postal seul : personne", ids("16000"), []);
  verifie("un type de voie seul : personne", ids("AVENUE"), []);
  verifie("le nom banal redevient utile avec un second mot",
    ids("DUPONT\n7 AVENUE DE LA GARE")[0], "a3");
  verifie("l'adresse sans nom fonctionne toujours",
    ids("12 RUE DES ROSIERS\n16000 ANGOULEME")[0], "a1");
  verifie("étiquette terrain nette : le bloc destinataire suffit",
    ids("M HILAIRE C0URT0IS\nCHEZ FRANCILLOU\n1 ROUTE DE CHEZ FOUR\n16260 CELLEFROUIN")[0], "a6");
  verifie("étiquette terrain à fenêtre : patronyme mal lu et lieu-dit",
    ids("MME FARGEDT HELENE\nLIEU DIT LES PRADEL1ERES\n16260 CELLEFROUIN")[0], "a7");
  verifie("nom et prénom malgré l'encodage historique du CSV",
    ids("FARGEOT HELENE")[0], "a7");
}

function fin() {
  console.log(echecs === 0 ? "\nTOUT PASSE" : "\n" + echecs + " ECHEC(S)");
  process.exit(echecs === 0 ? 0 : 1);
}
