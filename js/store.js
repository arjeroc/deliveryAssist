/* ============================================================================
   store.js — schéma des données, persistance locale, import/export CSV,
   validation et calcul de la position dans la tournée.
   Aucune donnée n'est jamais envoyée à un serveur depuis ce fichier.
   ========================================================================== */
window.Store = (function () {
  "use strict";

  var MULTI_SEP = "|";
  var DATA_KEY = "atournee_data_v2";
  var META_KEY = "atournee_meta_v2";
  var SETTINGS_KEY = "atournee_settings_v1";
  var OLD_DATA_KEY = "atournee_data_v1"; // v1 de l'outil, pour migration douce
  var OLD_META_KEY = "atournee_meta_v1";

  // Ordre des colonnes dans le CSV (import/export)
  var COLUMNS = [
    "id", "id_tournee", "nom_famille", "numero", "rue", "code_postal",
    "commune", "lieu_dit", "latitude", "longitude", "geocode_statut",
    "lat_relevee", "lon_relevee", "precision_m", "releve_le",
    "casier_c", "casier_l", "ordre_zone", "ordre_rue", "position_manuelle",
    "type_objet", "notes", "stoppub", "date_maj"
  ];

  // Colonnes apparues avec les relevés GPS de terrain. Un fichier plus ancien
  // reste un fichier valide : leur absence ne se signale pas à l'import, elle
  // se comble toute seule à la première tournée distribuée.
  var COLUMNS_OPTIONNELLES = ["lat_relevee", "lon_relevee", "precision_m", "releve_le"];

  var state = {
    rows: [],
    idTournee: "tm002",
    // Empilement des fichiers de tournée, dans l'ordre voulu par l'utilisateur :
    // [{ id, nom, count, importeLe }]. Un seul fichier la plupart du temps.
    fichiers: [],
    settings: {
      geocodageActif: true,
      communeColors: {},
      // Couleur de la trace de chaque fichier empilé, par identifiant de
      // fichier. Vide au départ : une couleur de la palette est attribuée
      // d'office, et n'est retenue ici que si l'utilisateur en choisit une.
      tourneeColors: {},
      // Scan d'étiquette : expérimental, désactivable si la lecture déçoit.
      scanActif: true,
      // Intervalle entre deux tentatives de lecture OCR en mode vidéo, en ms.
      // Réglable dans les réglages avancés : plus bas, la détection est plus
      // réactive ; la cadence (scan-core.js) empêche de toute façon deux
      // lectures de se chevaucher.
      scanIntervalleMs: 700,
      // Sens du pivot forcé quand le téléphone reste portrait (verrou de
      // rotation) : les deux sens ne se valent pas selon l'appareil et le
      // navigateur, d'où le réglage plutôt qu'un choix figé dans le code.
      scanPivotInverse: false,
      // Flèches de sens sur la trace : actives par défaut. C'est le seul
      // élément que la carte des Données pose par-dessus le trait, et il dit la
      // seule chose qu'un trait ne sait pas dire — dans quel sens on le suit.
      flechesSens: true
    }
  };

  // --- utilitaires ----------------------------------------------------------

  function uid() {
    return "row-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Quelques exports historiques ont été encodés deux fois en UTF-8 :
  // « HÃ©lÃ¨ne » arrive alors dans le navigateur à la place de « Hélène ».
  // On le répare uniquement quand la signature d'un tel accident est présente;
  // une donnée Unicode saine n'est donc jamais réinterprétée.
  function reparerEncodage(v) {
    var texte = (v === undefined || v === null) ? "" : String(v);
    if (!/[ÃÂ]/.test(texte)) return texte;
    try {
      var octets = new Uint8Array(texte.length);
      for (var i = 0; i < texte.length; i++) {
        if (texte.charCodeAt(i) > 255) return texte;
        octets[i] = texte.charCodeAt(i);
      }
      if (typeof TextDecoder !== "undefined") {
        return new TextDecoder("utf-8", { fatal: true }).decode(octets);
      }
      // Les navigateurs Android récents ont TextDecoder ; ce repli conserve
      // toutefois la correction dans les environnements de test plus anciens.
      var percent = "";
      for (var j = 0; j < octets.length; j++) {
        percent += "%" + octets[j].toString(16).padStart(2, "0");
      }
      return decodeURIComponent(percent);
    } catch (e) { return texte; }
  }

  // Normalisation de recherche : réparation éventuelle de l'encodage,
  // décomposition Unicode, suppression des diacritiques, majuscules, et toute
  // ponctuation ramenée à un espace.
  //   "Élodie Léa-Marie l'Abbé"  ->  "ELODIE LEA MARIE L ABBE"
  function normalize(s) {
    return reparerEncodage(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/Œ/g, "OE")
      .replace(/Æ/g, "AE")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  }

  // Le nom de rue est stocké en majuscules — accents conservés — pour éviter
  // que « Rue de la République » et « RUE DE LA RÉPUBLIQUE » coexistent dans la
  // base. La recherche, elle, retire les accents de son côté : elle n'est pas
  // affectée par ce choix d'écriture.
  function normaliseRue(v) {
    return (v === undefined || v === null ? "" : String(v)).trim().toUpperCase();
  }

  function blankRow() {
    return {
      id: uid(), id_tournee: state.idTournee, nom_famille: "", numero: "",
      rue: "", code_postal: "", commune: "", lieu_dit: "",
      latitude: "", longitude: "", geocode_statut: "",
      lat_relevee: "", lon_relevee: "", precision_m: "", releve_le: "",
      casier_c: "", casier_l: "", ordre_zone: "", ordre_rue: "",
      position_manuelle: "", type_objet: "", notes: "", stoppub: "false",
      date_maj: todayISO()
    };
  }

  // Normalise n'importe quelle valeur "booléenne" issue d'une saisie humaine
  // ou d'un import CSV externe (true/false, 1/0, oui/non, x, vrai/faux…)
  var TRUE_LIKE = ["true", "1", "oui", "yes", "x", "vrai", "on"];
  function normalizeBool(v) {
    if (v === true) return "true";
    if (v === false || v === undefined || v === null || v === "") return "false";
    return TRUE_LIKE.indexOf(String(v).trim().toLowerCase()) !== -1 ? "true" : "false";
  }
  function isStopPub(row) { return normalizeBool(row.stoppub) === "true"; }

  function namesOf(row) {
    return (row.nom_famille || "").split(MULTI_SEP).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function setNames(row, names) {
    row.nom_famille = names.map(function (s) { return s.trim(); }).filter(Boolean).join(MULTI_SEP);
  }

  function hasGPS(row) {
    return row.latitude !== "" && row.latitude !== undefined && row.latitude !== null &&
           row.longitude !== "" && row.longitude !== undefined && row.longitude !== null &&
           !isNaN(Number(row.latitude)) && !isNaN(Number(row.longitude));
  }

  // --- relevés GPS de terrain -----------------------------------------------
  //
  // L'API de géolocalisation ne rend pas un score de confiance mais un rayon
  // d'incertitude en mètres. On le convertit en score une fois pour toutes,
  // ici, pour que le reste de l'application — et l'utilisateur — n'aient qu'une
  // seule échelle à lire. Les deux bornes sont posées par l'usage :
  //   0,95 (≈ 35 m) : assez sûr pour devenir la position officielle de la boîte
  //   0,85 (≈ 105 m) : en dessous, le relevé n'apprend rien et n'est pas gardé
  var PRECISION_REF_M = 700;   // rayon auquel le score tombe à zéro
  var SCORE_MIN = 0.85;        // seuil de conservation
  var SCORE_SUR = 0.95;        // seuil de promotion en position vérifiée

  function scoreReleve(precisionM) {
    var p = Number(precisionM);
    if (isNaN(p) || p < 0) return 0;
    return Math.max(0, Math.min(1, 1 - p / PRECISION_REF_M));
  }

  function hasReleve(row) {
    return row.lat_relevee !== "" && row.lat_relevee !== undefined && row.lat_relevee !== null &&
           row.lon_relevee !== "" && row.lon_relevee !== undefined && row.lon_relevee !== null &&
           !isNaN(Number(row.lat_relevee)) && !isNaN(Number(row.lon_relevee));
  }

  function releveInfo(row) {
    if (!hasReleve(row)) return null;
    return {
      lat: Number(row.lat_relevee),
      lon: Number(row.lon_relevee),
      precision: row.precision_m === "" ? null : Number(row.precision_m),
      score: scoreReleve(row.precision_m),
      date: row.releve_le || ""
    };
  }

  // La finesse d'un géocodage — numéro de rue ou centre de commune — est relevée
  // par parcours.js auprès de l'API. Plutôt que d'aller la lire dans un stockage
  // qui ne lui appartient pas, ce module la lui demande. Tant que personne ne
  // répond, on suppose le géocodage précis : un relevé ne prend jamais la place
  // d'une donnée dont on ignore la qualité.
  var resolveurGeocodageApproche = null;

  function setResolveurGeocodageApproche(fn) { resolveurGeocodageApproche = fn; }

  function geocodageApproche(row) {
    if (row.geocode_statut !== "geocode") return false;
    return resolveurGeocodageApproche ? !!resolveurGeocodageApproche(row) : false;
  }

  // Position à employer pour la carte, la trace et l'itinéraire. Un relevé de
  // terrain non promu ne l'emporte que sur un géocodage approché : être passé
  // devant la boîte vaut mieux qu'un point posé sur le clocher du village, mais
  // pas mieux qu'un numéro de rue géocodé au mètre près.
  function positionUtile(row) {
    var releve = releveInfo(row);
    if (releve && geocodageApproche(row)) {
      return { lat: releve.lat, lon: releve.lon, source: "releve" };
    }
    if (hasGPS(row)) {
      return {
        lat: Number(row.latitude), lon: Number(row.longitude),
        source: row.geocode_statut === "geocode" ? "geocode" : "verifie"
      };
    }
    if (releve) return { lat: releve.lat, lon: releve.lon, source: "releve" };
    return null;
  }

  function hasPosition(row) { return positionUtile(row) !== null; }

  // Relevé capté automatiquement à la validation d'une livraison. Les règles
  // tiennent en quatre refus, tous silencieux : la validation d'une tournée ne
  // s'interrompt jamais pour un problème de GPS.
  function enregistrerReleveAuto(id, lat, lon, precisionM) {
    var row = findRow(id);
    if (!row) return { ok: false, raison: "introuvable" };
    // Un point déjà vérifié ne se corrige que depuis les Données, à la main.
    if (row.geocode_statut === "verifie") return { ok: false, raison: "verifie" };
    var score = scoreReleve(precisionM);
    if (score < SCORE_MIN) return { ok: false, raison: "imprecis", score: score };
    var ancien = releveInfo(row);
    if (ancien && ancien.score >= score) return { ok: false, raison: "moins_bon", score: score };

    var patch = {
      lat_relevee: lat.toFixed(6), lon_relevee: lon.toFixed(6),
      precision_m: String(Math.round(precisionM)), releve_le: new Date().toISOString()
    };
    var promu = score >= SCORE_SUR;
    if (promu) {
      patch.latitude = lat.toFixed(6);
      patch.longitude = lon.toFixed(6);
      patch.geocode_statut = "verifie";
    }
    updateRow(id, patch);
    return { ok: true, promu: promu, score: score };
  }

  // Relevé posé à la main depuis les Données : celui-là passe outre le statut
  // vérifié et les seuils — l'utilisateur a regardé où il se tenait.
  function enregistrerReleveManuel(id, lat, lon, precisionM) {
    var connue = !(precisionM === undefined || precisionM === null || isNaN(Number(precisionM)));
    var patch = {
      latitude: lat.toFixed(6), longitude: lon.toFixed(6), geocode_statut: "verifie",
      lat_relevee: lat.toFixed(6), lon_relevee: lon.toFixed(6),
      precision_m: connue ? String(Math.round(precisionM)) : "",
      releve_le: new Date().toISOString()
    };
    updateRow(id, patch);
    return patch;
  }

  function hasCasier(row) {
    return row.casier_c !== "" && row.casier_c !== undefined && row.casier_c !== null &&
           row.casier_l !== "" && row.casier_l !== undefined && row.casier_l !== null;
  }

  function casierLabel(row) {
    return hasCasier(row) ? ("C" + row.casier_c + "L" + row.casier_l) : "Hors casier";
  }

  // Clé normalisée d'une case de casier — "C2L3". Les zéros de tête et les
  // espaces d'un import ne doivent pas fabriquer deux cases pour une seule.
  function casierCle(row) {
    return hasCasier(row) ? ("C" + Number(row.casier_c) + "L" + Number(row.casier_l)) : "";
  }

  // --- fichiers de tournée empilés ------------------------------------------
  //
  // Une tournée peut se composer de plusieurs fichiers — tm0, tm1… — apportant
  // chacun sa propre grille de casier. Deux fichiers posant chacun une C1L1
  // décrivent deux cases réelles distinctes : elles ne se fondent jamais l'une
  // dans l'autre, même adresse pour adresse. Ce qui les départage est l'ordre
  // d'empilement choisi par l'utilisateur, et lui seul.
  //
  // Tant qu'un seul fichier est chargé — le cas courant — tout ce mécanisme
  // reste transparent : le rang de fichier est constant, le discriminant vide,
  // et l'ordre comme les clés de regroupement sont mot pour mot ceux d'avant.
  function multiActif() {
    return state.fichiers.length > 1;
  }

  function indexFichier(id) {
    for (var i = 0; i < state.fichiers.length; i++) {
      if (state.fichiers[i].id === id) return i;
    }
    return -1;
  }

  // Rang d'empilement : la place du fichier dans la pile. Un fichier inconnu
  // ferme la marche plutôt que de s'inviter en tête.
  function rangFichier(row) {
    if (!multiActif()) return 0;
    var i = indexFichier(row.id_tournee || "");
    return i === -1 ? state.fichiers.length : i;
  }

  // Discriminant à coller aux clés de regroupement. Vide hors empilement : les
  // clés existantes — et les préparations déjà enregistrées sous ces clés — ne
  // bougent pas d'un caractère.
  function cleFichier(row) {
    return multiActif() ? (row.id_tournee || "?") : "";
  }

  function suffixeFichier(row) {
    var f = cleFichier(row);
    return f ? "@" + f : "";
  }

  // Étiquette d'une case telle qu'elle se lit à l'écran : "C1L1" seule, ou
  // "C1L1 · tm1" quand plusieurs fichiers se disputent la position.
  function casierLabelEtape(row) {
    return casierLabel(row) + (cleFichier(row) ? " · " + cleFichier(row) : "");
  }

  // La liste des fichiers se relit toujours dans les données : une adresse
  // supprimée, un import qui remplace tout, et l'empilement doit suivre. Seul
  // l'ordre voulu par l'utilisateur ne se recalcule pas — il se conserve pour
  // les fichiers encore présents, les nouveaux venus s'ajoutant à la suite.
  function syncFichiers() {
    var comptes = {}, ordreVu = [];
    state.rows.forEach(function (r) {
      var id = r.id_tournee || "";
      if (comptes[id] === undefined) { comptes[id] = 0; ordreVu.push(id); }
      comptes[id] += 1;
    });
    var connus = {};
    state.fichiers.forEach(function (f) { connus[f.id] = true; });
    var suite = state.fichiers.filter(function (f) { return comptes[f.id] !== undefined; });
    ordreVu.forEach(function (id) {
      if (!connus[id]) suite.push({ id: id, nom: "", importeLe: new Date().toISOString() });
    });
    suite.forEach(function (f) { f.count = comptes[f.id] || 0; });
    state.fichiers = suite;

    // L'identifiant de la tournée courante est celui du premier fichier de la
    // pile. Il n'est jamais saisi : il vient de la colonne id_tournee du
    // fichier de données, et suit donc ce qui est chargé. Base vidée, on garde
    // le dernier connu plutôt que de faire clignoter l'en-tête sur un défaut.
    if (state.fichiers.length) state.idTournee = state.fichiers[0].id;
  }

  function getFichiers() {
    return state.fichiers.map(function (f) {
      var exclues = Object.keys(f.zonesExclues || {});
      return {
        id: f.id, nom: f.nom || "", count: f.count || 0, importeLe: f.importeLe || "",
        nbExclues: exclues.length
      };
    });
  }

  // Réordonne la pile. Les identifiants inconnus sont ignorés et ceux qui
  // manquent à l'appel restent à la fin : un ordre partiel ne fait pas
  // disparaître un fichier de la tournée.
  function setOrdreFichiers(ids) {
    var restants = state.fichiers.slice();
    var suite = [];
    (ids || []).forEach(function (id) {
      var i = -1;
      restants.forEach(function (f, k) { if (i === -1 && f.id === id) i = k; });
      if (i !== -1) suite.push(restants.splice(i, 1)[0]);
    });
    state.fichiers = suite.concat(restants);
    persist();
  }

  // Déplacement d'un cran, pour les pouces : le glisser-déposer sert la souris,
  // ces deux flèches servent tout le monde.
  function deplacerFichier(id, delta) {
    var i = indexFichier(id);
    if (i === -1) return false;
    var j = i + delta;
    if (j < 0 || j >= state.fichiers.length) return false;
    var f = state.fichiers.splice(i, 1)[0];
    state.fichiers.splice(j, 0, f);
    persist();
    return true;
  }

  // Retire un fichier de la tournée : ses adresses avec lui, sinon la pile
  // mentirait sur ce que la base contient encore.
  function retirerFichier(id) {
    var avant = state.rows.length;
    state.rows = state.rows.filter(function (r) { return (r.id_tournee || "") !== id; });
    persist();
    return avant - state.rows.length;
  }

  // --- zones de casier retenues, fichier par fichier -------------------------
  //
  // Un fichier apporte des cases dont toutes ne font pas forcément partie de la
  // tournée du jour. L'utilisateur en écarte depuis la carte du fichier, dans
  // les réglages. On enregistre les cases *écartées* et non les retenues : une
  // case qui apparaît à un réimport entre alors d'office dans la tournée, ce qui
  // est le comportement attendu — on n'a rien dit d'elle.
  //
  // Les adresses écartées restent dans la base : elles se cherchent, s'ouvrent
  // et se corrigent. Elles ne sont simplement pas de la tournée.
  function fichierEntree(id) {
    return state.fichiers.filter(function (f) { return f.id === id; })[0] || null;
  }

  function zonesExclues(id) {
    var f = fichierEntree(id);
    return (f && f.zonesExclues) || {};
  }

  function zoneIntegree(row) {
    if (!hasCasier(row)) return true;
    return !zonesExclues(row.id_tournee || "")[casierCle(row)];
  }

  function setZoneIntegree(id, cle, integree) {
    var f = fichierEntree(id);
    if (!f || !cle) return;
    if (!f.zonesExclues) f.zonesExclues = {};
    if (integree) delete f.zonesExclues[cle];
    else f.zonesExclues[cle] = true;
    persist();
  }

  // Les cases que le fichier contient, dans l'ordre de la grille, chacune avec
  // son compte d'adresses et son état. C'est ce que le sélecteur de la carte
  // affiche : on ne propose pas des cases que le fichier n'a pas.
  function zonesDuFichier(id) {
    var vues = {}, ordre = [];
    state.rows.forEach(function (r) {
      if ((r.id_tournee || "") !== id || !hasCasier(r)) return;
      var cle = casierCle(r);
      if (!vues[cle]) {
        vues[cle] = { cle: cle, c: Number(r.casier_c), l: Number(r.casier_l), nbAdresses: 0 };
        ordre.push(cle);
      }
      vues[cle].nbAdresses += 1;
    });
    var exclues = zonesExclues(id);
    return ordre
      .map(function (cle) {
        vues[cle].integree = !exclues[cle];
        return vues[cle];
      })
      .sort(function (a, b) { return a.c - b.c || a.l - b.l; });
  }

  // Colonnes du fichier, pour « tout retenir » / « tout relâcher » d'un bloc.
  function colonnesDuFichier(id) {
    var cols = {}, ordre = [];
    zonesDuFichier(id).forEach(function (z) {
      if (!cols[z.c]) { cols[z.c] = { c: z.c, label: "C" + z.c, zones: [] }; ordre.push(z.c); }
      cols[z.c].zones.push(z);
    });
    return ordre.sort(function (a, b) { return a - b; }).map(function (c) { return cols[c]; });
  }


  // "LIMOGES (Le Mas de…)" — le lieu-dit reste secondaire, entre parenthèses,
  // pour situer sans prendre le pas sur la commune.
  function communeLabel(commune, lieuDit) {
    commune = (commune || "").trim();
    lieuDit = (lieuDit || "").trim();
    if (!commune) return lieuDit;
    return lieuDit ? commune + " (" + lieuDit + ")" : commune;
  }

  function communeLabelOf(row) {
    return communeLabel(row.commune, row.lieu_dit);
  }

  // --- position dans la tournée (début / milieu / fin) -----------------------

  var VALID_POSITIONS = ["debut", "milieu", "fin"];
  var POSITION_LABELS = { debut: "Début de tournée", milieu: "Milieu de tournée", fin: "Fin de tournée" };

  function ordreZoneRange() {
    var vals = state.rows
      .map(function (r) { return r.ordre_zone; })
      .filter(function (v) { return v !== "" && v !== undefined && v !== null && !isNaN(Number(v)); })
      .map(Number);
    if (!vals.length) return null;
    return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }

  function computedPosition(row) {
    if (row.ordre_zone === "" || row.ordre_zone === undefined || row.ordre_zone === null || isNaN(Number(row.ordre_zone))) return null;
    var range = ordreZoneRange();
    if (!range || range.max === range.min) return "milieu";
    var span = range.max - range.min;
    var rel = (Number(row.ordre_zone) - range.min) / span;
    if (rel < 1 / 3) return "debut";
    if (rel > 2 / 3) return "fin";
    return "milieu";
  }

  // renvoie { value: 'debut'|'milieu'|'fin'|null, source: 'manuel'|'auto'|null }
  function positionInfo(row) {
    if (row.position_manuelle && VALID_POSITIONS.indexOf(row.position_manuelle) !== -1) {
      return { value: row.position_manuelle, source: "manuel" };
    }
    var auto = computedPosition(row);
    return { value: auto, source: auto ? "auto" : null };
  }

  // --- ordre de la tournée (source de vérité) --------------------------------

  // L'ordre de préparation est celui du casier, lu comme une grille :
  // C1L1 → C1L2 → … → C1L5 → C2L1 → … → C5L5. Quand plusieurs fichiers sont
  // empilés, leur ordre départage les positions qu'ils occupent tous les deux :
  // pile tm1 puis tm0, et toute C1L1 de tm1 passe avant toute C1L1 de tm0.
  // ordre_zone puis ordre_rue départagent ensuite à l'intérieur d'une même case,
  // et l'ordre du fichier tranche en dernier recours. Les adresses hors casier
  // ferment la marche.
  //
  // Cet ordre appartient aux données, pas à la carte : la cartographie s'y
  // conforme, elle ne le recalcule jamais. C'est ici, et nulle part ailleurs,
  // qu'il se définit.
  function ordreNum(v) {
    return (v === "" || v === undefined || v === null || isNaN(Number(v))) ? Infinity : Number(v);
  }

  function rangTournee(row) {
    return [ordreNum(row.casier_c), ordreNum(row.casier_l), rangFichier(row),
            ordreNum(row.ordre_zone), ordreNum(row.ordre_rue)];
  }

  function compareTournee(a, b) {
    var ra = rangTournee(a), rb = rangTournee(b);
    for (var i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return 0;
  }

  // Copie triée : la liste d'origine n'est jamais réordonnée sur place, sans
  // quoi un affichage pourrait modifier la base en la consultant.
  //
  // Les cases écartées depuis la carte du fichier sont retirées ici, en amont de
  // tout ce qui lit la tournée — casier, préparation, trace, course. Elles
  // restent dans state.rows, donc dans la recherche et les fiches : écartée de
  // la tournée du jour n'est pas supprimée.
  function rowsOrdreTournee(list) {
    return (list || state.rows)
      .filter(zoneIntegree)
      .map(function (r, i) { return { row: r, i: i }; })
      .sort(function (a, b) {
        var c = compareTournee(a.row, b.row);
        return c !== 0 ? c : a.i - b.i;
      })
      .map(function (x) { return x.row; });
  }

  // Découpage de la tournée en cases de casier, dans l'ordre de la grille.
  // Une case = un paquet préparé ensemble : c'est l'unité que le livreur
  // reconnaît en ouvrant son casier, donc l'unité de contrôle des données.
  //
  // Deux fichiers empilés sur la même position tiennent deux étapes : la case
  // du casier de tm1 et celle de tm0 sont deux paquets réels, préparés
  // séparément. Elles se suivent dans l'ordre de la pile, elles ne fusionnent
  // pas.
  function etapesCasier(list) {
    var ordonnees = rowsOrdreTournee(list);
    var out = [];
    ordonnees.forEach(function (r) {
      var base = hasCasier(r) ? casierCle(r) : "hors";
      var cle = base + suffixeFichier(r);
      var dernier = out[out.length - 1];
      if (!dernier || dernier.cle !== cle) {
        dernier = {
          cle: cle,
          label: (base === "hors" ? "Hors casier" : base) +
                 (cleFichier(r) ? " · " + cleFichier(r) : ""),
          fichier: cleFichier(r),
          c: base === "hors" ? null : Number(r.casier_c),
          l: base === "hors" ? null : Number(r.casier_l),
          rows: []
        };
        out.push(dernier);
      }
      dernier.rows.push(r);
    });
    return out;
  }

  // Le casier lu colonne par colonne : une colonne, ses lignes, et pour chaque
  // ligne la rue par laquelle elle commence et celle par laquelle elle finit.
  //
  // C'est la forme sous laquelle la Préparation désigne une zone de courrier
  // standard : le livreur reconnaît une ligne de casier à ses deux extrémités
  // bien plus vite qu'à l'énumération de tout ce qu'elle contient. Les adresses
  // hors casier n'y figurent pas — elles appartiennent à une autre tournée.
  //
  // Une case dont deux fichiers se disputent la position donne deux lignes,
  // portant chacune son fichier : le livreur a bien deux paquets devant lui, et
  // chacun se retient — ou se relâche — pour lui-même.
  //
  // La colonne aussi appartient à son fichier. Le C1 de tm1 et le C1 de tm0 sont
  // deux colonnes de deux casiers différents : les indexer sur le seul numéro
  // les fondait en une, et les lignes de l'un se retrouvaient rangées sous
  // l'autre. On les indexe donc sur le couple (fichier, numéro).
  //
  // fichierId restreint le résultat à un seul fichier — ce dont la Préparation a
  // besoin pour ne montrer que la tournée choisie. Sans argument, tous les
  // fichiers, dans l'ordre de la pile.
  function casierColonnes(fichierId) {
    var cases = {}, ordreCases = [];
    rowsOrdreTournee().forEach(function (r) {
      if (!hasCasier(r)) return;
      if (fichierId !== undefined && fichierId !== null && (r.id_tournee || "") !== fichierId) return;
      var cle = casierCle(r) + suffixeFichier(r);
      if (!cases[cle]) {
        cases[cle] = {
          cle: cle, c: Number(r.casier_c), l: Number(r.casier_l),
          fichier: cleFichier(r), rows: []
        };
        ordreCases.push(cle);
      }
      cases[cle].rows.push(r);
    });

    var colonnes = {}, ordreColonnes = [];
    ordreCases.forEach(function (cle) {
      var cel = cases[cle];
      // Suite des rues telles qu'elles se présentent dans la case : une rue qui
      // revient plus loin est bien une nouvelle borne, pas un doublon.
      var suite = [];
      cel.rows.forEach(function (r) {
        var nom = normaliseRue(r.rue) || "(rue non renseignée)";
        if (suite[suite.length - 1] !== nom) suite.push(nom);
      });
      cel.premiereRue = suite[0] || "";
      cel.derniereRue = suite[suite.length - 1] || "";
      cel.nbAdresses = cel.rows.length;
      cel.nbRues = suite.filter(function (v, i, t) { return t.indexOf(v) === i; }).length;
      cel.commune = (cel.rows[0].commune || "").trim();

      var cleCol = cel.fichier ? cel.fichier + "@" + cel.c : String(cel.c);
      if (!colonnes[cleCol]) {
        colonnes[cleCol] = {
          cle: cleCol, c: cel.c, fichier: cel.fichier,
          label: "C" + cel.c + (cel.fichier ? " · " + cel.fichier : ""),
          lignes: []
        };
        ordreColonnes.push(cleCol);
      }
      colonnes[cleCol].lignes.push(cel);
    });

    // Les colonnes d'un même fichier se suivent par numéro ; les fichiers se
    // suivent dans l'ordre de la pile, que ordreCases porte déjà.
    var rangFichierCol = {};
    state.fichiers.forEach(function (f, i) { rangFichierCol[f.id] = i; });
    return ordreColonnes
      .map(function (cle) { return colonnes[cle]; })
      .sort(function (a, b) {
        var fa = a.fichier ? (rangFichierCol[a.fichier] === undefined ? 1e9 : rangFichierCol[a.fichier]) : 0;
        var fb = b.fichier ? (rangFichierCol[b.fichier] === undefined ? 1e9 : rangFichierCol[b.fichier]) : 0;
        return fa - fb || a.c - b.c;
      })
      .map(function (col) {
        col.nbAdresses = col.lignes.reduce(function (n, li) { return n + li.nbAdresses; }, 0);
        return col;
      });
  }

  // --- validation -------------------------------------------------------------

  function validateRows(list) {
    var errors = [], warnings = [];
    var seenIds = {};
    list.forEach(function (r, idx) {
      var ref = "Ligne " + (idx + 2) + (r.nom_famille ? " (" + r.nom_famille + ")" : "");
      if (!r.id) r.id = uid();
      if (seenIds[r.id]) { errors.push(ref + " : id en double, un nouvel id a été généré."); r.id = uid(); }
      seenIds[r.id] = true;

      if (!r.nom_famille && !r.rue) errors.push(ref + " : ni nom ni rue renseignés.");
      if (!r.id_tournee) r.id_tournee = state.idTournee;

      ["casier_c"].forEach(function (f) {
        if (r[f] !== "" && r[f] !== undefined && r[f] !== null) {
          var n = Number(r[f]);
          if (!Number.isInteger(n) || n < 1 || n > 5) warnings.push(ref + " : casier_c=\"" + r[f] + "\" hors plage (1 à 5).");
        }
      });
      ["casier_l"].forEach(function (f) {
        if (r[f] !== "" && r[f] !== undefined && r[f] !== null) {
          var n = Number(r[f]);
          if (!Number.isInteger(n) || n < 1 || n > 4) warnings.push(ref + " : casier_l=\"" + r[f] + "\" hors plage (1 à 4).");
        }
      });
      if (hasCasier(r) === false && ((r.casier_c !== "" && r.casier_c != null) !== (r.casier_l !== "" && r.casier_l != null))) {
        warnings.push(ref + " : colonne et ligne du casier devraient être renseignées ensemble.");
      }
      if (r.latitude !== "" && r.latitude !== undefined) {
        var lat = Number(r.latitude);
        if (isNaN(lat) || lat < -90 || lat > 90) warnings.push(ref + " : latitude invalide.");
      }
      if (r.longitude !== "" && r.longitude !== undefined) {
        var lon = Number(r.longitude);
        if (isNaN(lon) || lon < -180 || lon > 180) warnings.push(ref + " : longitude invalide.");
      }
      [["lat_relevee", 90], ["lon_relevee", 180]].forEach(function (pair) {
        var v = r[pair[0]];
        if (v !== "" && v !== undefined && v !== null) {
          var n = Number(v);
          if (isNaN(n) || n < -pair[1] || n > pair[1]) warnings.push(ref + " : " + pair[0] + " invalide.");
        }
      });
      if (r.precision_m !== "" && r.precision_m !== undefined && r.precision_m !== null) {
        var prec = Number(r.precision_m);
        if (isNaN(prec) || prec < 0) warnings.push(ref + " : precision_m invalide.");
      }
      if (r.code_postal && !/^\d{5}$/.test(String(r.code_postal).trim())) {
        warnings.push(ref + " : code postal \"" + r.code_postal + "\" ne ressemble pas à un code à 5 chiffres.");
      }
      r.stoppub = normalizeBool(r.stoppub);
      r.rue = normaliseRue(r.rue);
    });
    return { errors: errors, warnings: warnings };
  }

  // --- CSV --------------------------------------------------------------------

  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    var rowsOut = [];
    var i = 0, field = "", record = [], inQuotes = false;
    var len = text.length;
    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      } else {
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ",") { record.push(field); field = ""; i++; continue; }
        if (c === "\r") { i++; continue; }
        if (c === "\n") { record.push(field); rowsOut.push(record); record = []; field = ""; i++; continue; }
        field += c; i++; continue;
      }
    }
    if (field.length > 0 || record.length > 0) { record.push(field); rowsOut.push(record); }
    rowsOut = rowsOut.filter(function (r) { return r.some(function (v) { return v !== ""; }); });
    return rowsOut;
  }

  function csvEscape(v) {
    v = (v === undefined || v === null) ? "" : String(v);
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function toCSV(list) {
    var lines = [COLUMNS.join(",")];
    list.forEach(function (r) {
      lines.push(COLUMNS.map(function (c) { return csvEscape(r[c]); }).join(","));
    });
    return lines.join("\n");
  }

  // Identifiant du fichier importé : celui que porte la colonne id_tournee, à
  // défaut le nom du fichier, à défaut la tournée courante. C'est cette
  // étiquette qui distinguera ensuite ses cases de celles des autres fichiers.
  function identifiantFichier(imported, nomFichier) {
    var vu = imported.map(function (r) { return (r.id_tournee || "").trim(); }).filter(Boolean)[0];
    if (vu) return vu;
    var stem = String(nomFichier || "").replace(/\.[^.]+$/, "").trim();
    return stem || state.idTournee;
  }

  // options : { mode: "remplacer" | "ajouter", nomFichier: "tm1.csv" }
  //
  // « remplacer » est le comportement historique et reste celui par défaut : le
  // fichier importé devient la base. « ajouter » empile un fichier de plus sur
  // ceux déjà chargés, sans toucher aux leurs.
  function importFromCSV(text, options) {
    options = options || {};
    var ajouter = options.mode === "ajouter";
    var table = parseCSV(text);
    if (table.length === 0) return { ok: false, message: "Fichier vide ou illisible." };
    var header = table[0].map(function (h) { return h.trim(); });
    var missingCols = COLUMNS.filter(function (c) {
      return header.indexOf(c) === -1 && COLUMNS_OPTIONNELLES.indexOf(c) === -1;
    });
    var extraCols = header.filter(function (h) { return COLUMNS.indexOf(h) === -1; });

    var imported = [];
    for (var i = 1; i < table.length; i++) {
      var rec = table[i];
      var obj = blankRow();
      header.forEach(function (colName, idx) {
        if (COLUMNS.indexOf(colName) !== -1) obj[colName] = (rec[idx] !== undefined ? rec[idx].trim() : "");
      });
      if (!obj.date_maj) obj.date_maj = todayISO();
      imported.push(obj);
    }

    var idFichier = identifiantFichier(imported, options.nomFichier);
    // Un fichier muet sur son id_tournee reçoit celui qu'on vient de lui
    // trouver : sans étiquette, ses cases se confondraient avec celles du
    // voisin de pile.
    imported.forEach(function (r) { if (!r.id_tournee) r.id_tournee = idFichier; });

    if (ajouter) {
      // Réimporter un fichier déjà empilé le met à jour : il reprend sa place
      // dans la pile plutôt que d'y figurer deux fois.
      state.rows = state.rows.filter(function (r) { return (r.id_tournee || "") !== idFichier; });
    }

    var result = validateRows(imported);

    if (ajouter) {
      // Les identifiants de ligne se croisent d'un fichier à l'autre : chacun a
      // été numéroté chez lui. Un doublon est réattribué ici, sans quoi une
      // adresse en masquerait une autre dans toute l'application.
      var pris = {};
      state.rows.forEach(function (r) { pris[r.id] = true; });
      var collisions = 0;
      imported.forEach(function (r) {
        if (pris[r.id]) { r.id = uid(); collisions += 1; }
        pris[r.id] = true;
      });
      if (collisions) {
        result.warnings.push(collisions + " identifiant(s) de ligne en conflit avec un autre fichier : renumérotés.");
      }
      state.rows = state.rows.concat(imported);
    } else {
      state.rows = imported;
      state.fichiers = [];
    }

    syncFichiers();
    var fiche = state.fichiers.filter(function (f) { return f.id === idFichier; })[0];
    if (fiche) {
      fiche.nom = options.nomFichier || fiche.nom || "";
      fiche.importeLe = new Date().toISOString();
    }
    persist();

    return {
      ok: true,
      count: imported.length,
      idFichier: idFichier,
      total: state.rows.length,
      missingCols: missingCols,
      extraCols: extraCols,
      errors: result.errors,
      warnings: result.warnings
    };
  }

  // ids : liste d'identifiants de fichiers à exporter. Sans argument — ou avec
  // la liste vide — tout sort, comme avant : l'export d'une tournée à fichier
  // unique n'a rien à choisir.
  function exportCSVText(ids) {
    validateRows(state.rows);
    persist();
    if (!ids || !ids.length) return toCSV(state.rows);
    var garde = {};
    ids.forEach(function (id) { garde[id] = true; });
    return toCSV(state.rows.filter(function (r) { return garde[r.id_tournee || ""]; }));
  }

  // --- persistance --------------------------------------------------------------

  function persist() {
    // Toute écriture invalide l'index : il sera reconstruit à la recherche suivante.
    invalidateIndex();
    // Toute écriture recale aussi la pile des fichiers : une adresse ajoutée ou
    // supprimée peut faire naître ou disparaître un fichier de la tournée, et
    // aucun appelant n'a à y penser.
    syncFichiers();
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state.rows));
      localStorage.setItem(META_KEY, JSON.stringify({
        idTournee: state.idTournee,
        fichiers: state.fichiers
      }));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) { /* stockage indisponible : on continue sans persister */ }
  }

  function migrateFromV1() {
    try {
      var raw = localStorage.getItem(OLD_DATA_KEY);
      if (!raw) return false;
      var oldRows = JSON.parse(raw) || [];
      if (!oldRows.length) return false;
      state.rows = oldRows.map(function (r) {
        var nr = blankRow();
        Object.keys(nr).forEach(function (k) {
          if (r[k] !== undefined) nr[k] = r[k];
        });
        nr.id = r.id || uid();
        return nr;
      });
      var oldMeta = localStorage.getItem(OLD_META_KEY);
      if (oldMeta) {
        var m = JSON.parse(oldMeta);
        if (m && m.idTournee) state.idTournee = m.idTournee;
      }
      persist();
      return true;
    } catch (e) { return false; }
  }

  function load() {
    try {
      var raw = localStorage.getItem(DATA_KEY);
      var meta = localStorage.getItem(META_KEY);
      var settings = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        state.rows = JSON.parse(raw) || [];
        if (meta) {
          var m = JSON.parse(meta);
          if (m && m.idTournee) state.idTournee = m.idTournee;
          // L'ordre d'empilement est un choix de l'utilisateur : il traverse le
          // rechargement comme le reste de la tournée.
          if (m && Array.isArray(m.fichiers)) state.fichiers = m.fichiers;
        }
      } else {
        migrateFromV1();
      }
      if (settings) {
        var s = JSON.parse(settings);
        // Seules les clés encore connues sont reprises : un réglage retiré de
        // l'application ne doit pas ressusciter depuis un stockage ancien.
        if (s && typeof s === "object") {
          Object.keys(state.settings).forEach(function (k) {
            if (s[k] !== undefined) state.settings[k] = s[k];
          });
        }
      }
    } catch (e) { state.rows = []; }
    // Un stockage antérieur à l'empilement ne porte aucune pile : elle se
    // reconstruit ici à partir des adresses déjà là.
    syncFichiers();
  }

  // --- couleurs par commune (configurables, avec une valeur par défaut stable) ---

  var AUTO_PALETTE = [
    "#e63946", // rouge
    "#f4b400", // jaune
    "#1e6fd9", // bleu
    "#2ecc71", // vert
    "#e67e22", // orange
    "#8e44ad", // violet
    "#16a2b8", // cyan
    "#d63384", // rose
    "#3f51b5", // indigo
    "#795548"  // brun
  ];

  function hashString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return Math.abs(h);
  }

  function autoColorForCommune(commune) {
    if (!commune) return "#9aa39a";
    return AUTO_PALETTE[hashString(commune.toUpperCase()) % AUTO_PALETTE.length];
  }

  // Palette des traces. Elle est distincte de celle des communes : sur la carte
  // des Données, la trace et les pastilles de commune ne se lisent pas au même
  // endroit, mais deux traces côte à côte doivent se distinguer d'un coup d'œil,
  // et se distinguer aussi des quatre couleurs de qualité de position.
  var PALETTE_TOURNEE = [
    "#c1121f", // rouge profond
    "#0a7d8c", // sarcelle
    "#7b2cbf", // violet
    "#bc6c25", // ocre
    "#1d3557", // bleu nuit
    "#4f772d", // olive
    "#d81b60", // magenta
    "#00695c"  // vert-bleu
  ];

  // Couleur d'office d'un fichier : tirée de son identifiant, puis décalée tant
  // qu'un autre fichier la porte déjà. Le départage se fait sur les
  // identifiants triés, jamais sur la pile : réordonner les fichiers ne doit pas
  // faire changer une trace de couleur sous les yeux de l'utilisateur.
  function autoColorForTournee(id) {
    var ids = state.fichiers.map(function (f) { return f.id; }).sort();
    var pris = {};
    for (var k = 0; k < ids.length; k++) {
      var base = hashString(ids[k]) % PALETTE_TOURNEE.length;
      var j = 0;
      while (j < PALETTE_TOURNEE.length && pris[(base + j) % PALETTE_TOURNEE.length]) j++;
      var choisi = (base + j) % PALETTE_TOURNEE.length;
      pris[choisi] = true;
      if (ids[k] === id) return PALETTE_TOURNEE[choisi];
    }
    return PALETTE_TOURNEE[hashString(String(id || "")) % PALETTE_TOURNEE.length];
  }

  function getTourneeColor(id) {
    if (!id) return PALETTE_TOURNEE[0];
    return state.settings.tourneeColors[id] || autoColorForTournee(id);
  }

  function setTourneeColor(id, hex) {
    if (!id) return;
    state.settings.tourneeColors[id] = hex;
    persist();
  }

  function getCommuneColor(commune) {
    if (!commune) return "#9aa39a";
    var key = commune.toUpperCase().trim();
    return state.settings.communeColors[key] || autoColorForCommune(key);
  }

  function setCommuneColor(commune, hex) {
    if (!commune) return;
    var key = commune.toUpperCase().trim();
    state.settings.communeColors[key] = hex;
    persist();
  }

  function listCommunes() {
    var set = {};
    state.rows.forEach(function (r) { if (r.commune) set[r.commune.toUpperCase().trim()] = true; });
    return Object.keys(set).sort();
  }

  // --- saisie assistée : réutiliser ce que la tournée contient déjà -----------

  // Rues déjà connues, restreintes à une commune quand elle est renseignée.
  function listRues(commune) {
    var cible = normalize(commune);
    var set = {};
    state.rows.forEach(function (r) {
      if (!r.rue) return;
      if (cible && normalize(r.commune) !== cible) return;
      set[r.rue.trim()] = true;
    });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, "fr"); });
  }

  // Adresses déjà enregistrées dans une rue, pour repérer d'un coup d'œil
  // qu'un numéro existe (et y rattacher un destinataire plutôt qu'un doublon).
  function listAdressesDeRue(rue, commune) {
    var cibleRue = normalize(rue), cibleCommune = normalize(commune);
    if (!cibleRue) return [];
    return state.rows
      .filter(function (r) {
        if (normalize(r.rue) !== cibleRue) return false;
        return !cibleCommune || normalize(r.commune) === cibleCommune;
      })
      .sort(function (a, b) {
        var na = parseInt(a.numero, 10), nb = parseInt(b.numero, 10);
        if (isNaN(na) && isNaN(nb)) return String(a.numero).localeCompare(String(b.numero), "fr");
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        if (na !== nb) return na - nb;
        return String(a.numero).localeCompare(String(b.numero), "fr");
      });
  }

  // Même numéro, même rue, même commune : c'est la même boîte aux lettres.
  function findDoublon(row) {
    if (!normalize(row.rue) || !normalize(row.numero)) return null;
    return state.rows.find(function (r) {
      return r.id !== row.id &&
             normalize(r.numero) === normalize(row.numero) &&
             normalize(r.rue) === normalize(row.rue) &&
             normalize(r.commune) === normalize(row.commune);
    }) || null;
  }

  // Filtre une liste de valeurs pour une liste déroulante : insensible à la
  // casse, aux accents et à la ponctuation, les débuts de mot d'abord.
  function filterValues(values, query, limit) {
    var tokens = normalize(query).split(" ").filter(Boolean);
    var scored = [];
    values.forEach(function (v) {
      var n = normalize(v);
      if (tokens.length && !tokens.every(function (t) { return n.indexOf(t) !== -1; })) return;
      var prefixe = tokens.length && n.indexOf(tokens[0]) === 0 ? 0 : 1;
      scored.push({ value: v, rang: prefixe });
    });
    scored.sort(function (a, b) {
      if (a.rang !== b.rang) return a.rang - b.rang;
      return a.value.localeCompare(b.value, "fr");
    });
    return scored.slice(0, limit || 8).map(function (x) { return x.value; });
  }

  // --- recherche ----------------------------------------------------------------

  // Mots vides des libellés de voie : ignorés car non discriminants. Ils sont
  // retirés de la requête comme des données, donc "12 RUE DE LA REPUBLIQUE",
  // "RUE REPUBLIQUE" et "REPUBLIQUE" désignent la même adresse.
  var STOPWORDS = {
    DE: 1, DU: 1, DES: 1, D: 1, LA: 1, LE: 1, LES: 1, L: 1, AU: 1, AUX: 1, ET: 1, EN: 1
  };

  // Abréviations de voie ramenées à une forme unique, dans les deux sens :
  // saisir "AV" trouve "AVENUE", et inversement.
  var TYPES_VOIE = {
    R: "RUE", RUE: "RUE",
    AV: "AVENUE", AVE: "AVENUE", AVENUE: "AVENUE",
    BD: "BOULEVARD", BLD: "BOULEVARD", BOULEVARD: "BOULEVARD",
    RTE: "ROUTE", ROUTE: "ROUTE",
    CH: "CHEMIN", CHE: "CHEMIN", CHEMIN: "CHEMIN",
    IMP: "IMPASSE", IMPASSE: "IMPASSE",
    PL: "PLACE", PLACE: "PLACE",
    ALL: "ALLEE", ALLEE: "ALLEE",
    SQ: "SQUARE", SQUARE: "SQUARE",
    ST: "SAINT", SAINT: "SAINT",
    STE: "SAINTE", SAINTE: "SAINTE",
    RES: "RESIDENCE", RESIDENCE: "RESIDENCE",
    LOT: "LOTISSEMENT", LOTISSEMENT: "LOTISSEMENT",
    HAM: "HAMEAU", HAMEAU: "HAMEAU",
    PAS: "PASSAGE", PASSAGE: "PASSAGE"
  };

  function tokenize(text) {
    var n = normalize(text);
    if (!n) return [];
    return n.split(" ").filter(Boolean).map(function (t) { return TYPES_VOIE[t] || t; });
  }

  // Retire les mots vides — sauf si la requête n'était composée que de ça,
  // auquel cas mieux vaut chercher littéralement que ne rien chercher.
  function contentTokens(tokens) {
    var kept = tokens.filter(function (t) { return !STOPWORDS[t]; });
    return kept.length ? kept : tokens;
  }

  function isNumeric(t) { return /^[0-9]+$/.test(t); }

  // Distance de Levenshtein bornée : dès que la distance minimale possible
  // dépasse "max", on abandonne — inutile de calculer la valeur exacte.
  function levenshtein(a, b, max) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      for (j = 0; j <= lb; j++) prev[j] = cur[j];
    }
    return prev[lb];
  }

  // Tolérance aux fautes de frappe proportionnelle à la longueur du mot :
  // sur un mot court, une lettre de différence change généralement de mot.
  function maxDistanceFor(token) {
    if (token.length >= 7) return 2;
    if (token.length >= 4) return 1;
    return 0;
  }

  // Qualité de correspondance d'un token de requête face à un token indexé.
  function tokenMatchScore(queryToken, indexedToken) {
    if (indexedToken === queryToken) return 1;
    if (indexedToken.indexOf(queryToken) === 0) return 0.85;   // saisie partielle
    // Les nombres ne tolèrent pas l'à-peu-près : le 12 n'est pas le 13.
    if (isNumeric(queryToken) || isNumeric(indexedToken)) return 0;
    var max = maxDistanceFor(queryToken);
    if (!max) return 0;
    return levenshtein(queryToken, indexedToken, max) <= max ? 0.6 : 0;
  }

  // --- index de recherche ---------------------------------------------------

  // Champs pondérés : un nom de destinataire est plus discriminant qu'une commune.
  var FIELD_WEIGHTS = { noms: 3, numero: 2.5, rue: 2, lieuDit: 1.4, commune: 1.2, codePostal: 1 };

  var searchIndex = null; // reconstruit paresseusement après toute modification
  // Combien d'adresses de la base portent chaque mot de nom. Un patronyme
  // unique dans la tournée est une signature ; « DUPONT » chez six foyers n'en
  // est pas une. Cette table sert au scan, quand une étiquette mal lue ne rend
  // qu'un seul mot exploitable.
  var freqNoms = {};

  function invalidateIndex() { searchIndex = null; }

  function buildIndex() {
    freqNoms = {};
    searchIndex = state.rows.map(function (r) {
      var noms = contentTokens(tokenize(namesOf(r).join(" ")));
      var vus = {};
      noms.forEach(function (t) {
        if (vus[t]) return;           // deux fois le même nom sur une adresse
        vus[t] = 1;                   // ne fait qu'une adresse
        freqNoms[t] = (freqNoms[t] || 0) + 1;
      });
      return {
        row: r,
        fields: {
          noms: noms,
          numero: tokenize(r.numero),
          rue: contentTokens(tokenize(r.rue)),
          lieuDit: contentTokens(tokenize(r.lieu_dit)),
          commune: contentTokens(tokenize(r.commune)),
          codePostal: tokenize(r.code_postal)
        }
      };
    });
    return searchIndex;
  }

  function getIndex() { return searchIndex || buildIndex(); }

  // Meilleur score obtenu par un token de requête sur l'ensemble des champs.
  function scoreTokenAgainstEntry(queryToken, entry) {
    var best = 0;
    Object.keys(entry.fields).forEach(function (field) {
      var weight = FIELD_WEIGHTS[field];
      entry.fields[field].forEach(function (indexedToken) {
        var s = tokenMatchScore(queryToken, indexedToken) * weight;
        if (s > best) best = s;
      });
    });
    return best;
  }

  // Tous les tokens de la requête doivent trouver preneur (ET logique) : c'est
  // ce qui garde la recherche tolérante sans la rendre bavarde.
  function searchScored(query) {
    var queryTokens = contentTokens(tokenize(query));
    if (!queryTokens.length) {
      return state.rows.map(function (r) { return { row: r, score: 0 }; });
    }
    var out = [];
    getIndex().forEach(function (entry) {
      var total = 0;
      for (var i = 0; i < queryTokens.length; i++) {
        var s = scoreTokenAgainstEntry(queryTokens[i], entry);
        if (!s) return; // un token sans correspondance élimine la ligne
        total += s;
      }
      out.push({ row: entry.row, score: total });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function search(query) {
    return searchScored(query).map(function (x) { return x.row; });
  }

  // --- rapprochement d'un texte scanné --------------------------------------

  // Bruit récurrent des étiquettes postales : civilités, mentions de service,
  // marquages d'expéditeur. Aucun n'aide à reconnaître une adresse.
  var BRUIT_SCAN = {
    M: 1, MR: 1, MME: 1, MLLE: 1, MONSIEUR: 1, MADAME: 1, MADEMOISELLE: 1,
    LIEU: 1, DIT: 1, CEDEX: 1, TSA: 1, BP: 1, CS: 1, SD: 1, EXP: 1, DEST: 1, POSTE: 1
  };

  // Confusions classiques d'un OCR sur du texte en capitales.
  var VERS_LETTRE = { "0": "O", "1": "I", "5": "S", "8": "B", "6": "G", "2": "Z" };
  var VERS_CHIFFRE = { O: "0", I: "1", L: "1", S: "5", B: "8", G: "6", Z: "2" };

  // Lève l'ambiguïté chiffre/lettre en tranchant selon la nature dominante du
  // mot : "C0URT0IS" devient COURTOIS, "1626O" redevient 16260. Sans cela, un
  // nom mal lu cesse de discriminer et l'adresse du voisin fait jeu égal.
  function deconfondre(token) {
    var lettres = (token.match(/[A-Z]/g) || []).length;
    var chiffres = (token.match(/[0-9]/g) || []).length;
    if (!lettres || !chiffres || lettres === chiffres) return token;
    var table = lettres > chiffres ? VERS_LETTRE : VERS_CHIFFRE;
    return token.split("").map(function (c) { return table[c] || c; }).join("");
  }

  // La déconfusion passe avant le filtrage : sinon "M0NTET" et "B0NNIEURE",
  // pris pour des références client, seraient jetés au lieu d'être réparés.
  function tokensUtilesScan(texte) {
    var vus = {};
    return contentTokens(tokenize(texte)).map(deconfondre).filter(function (t) {
      // Un chiffre isolé est gardé : en zone rurale, le « 1 » de
      // « 1 ROUTE DE CHEZ FOUR » distingue deux voisins.
      if (t.length < 2 && !/^[0-9]$/.test(t)) return false;
      if (BRUIT_SCAN[t]) return false;
      // Numéros de suivi et références client : trop longs pour être un numéro
      // de rue ou un code postal, ils ne feraient que brouiller le score.
      if (/^[0-9]+$/.test(t) && t.length > 5) return false;
      if (/[0-9]/.test(t) && /[A-Z]/.test(t) && t.length > 5) return false;
      if (vus[t]) return false;
      vus[t] = 1;
      return true;
    });
  }

  // Un nom propre rare vaut à lui seul une proposition. Une étiquette froissée,
  // pliée sur l'adresse, ou cadrée trop haut ne laisse parfois lire que le
  // patronyme : exiger deux mots communs revient alors à ne rien proposer du
  // tout, alors que le nom, lui, ne désigne qu'une adresse de la tournée.
  //
  // Trois garde-fous pour que cette porte ne s'ouvre pas trop grand : le mot
  // doit venir du champ des noms (le plus discriminant), être assez long pour
  // ne pas ressembler à tout, et n'être porté que par une ou deux adresses.
  var RARETE_NOM = 2;
  var LONGUEUR_NOM_SEUL = 4;

  function nomDiscriminant(tokens, entry) {
    var noms = entry.fields.noms;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].length < LONGUEUR_NOM_SEUL) continue;
      for (var j = 0; j < noms.length; j++) {
        if ((freqNoms[noms[j]] || 0) <= RARETE_NOM &&
            tokenMatchScore(tokens[i], noms[j]) > 0) return true;
      }
    }
    return false;
  }

  // Note un lot de mots face à une adresse : aucun mot n'est obligatoire,
  // chacun ajoute des points. L'inverse de search(), donc, car un texte scanné
  // contient du bruit et souvent une seconde adresse.
  function noterLot(tokens, entry) {
    var total = 0, touches = 0;
    tokens.forEach(function (t) {
      var s = scoreTokenAgainstEntry(t, entry);
      if (s > 0) { total += s; touches += 1; }
    });
    return { total: total, touches: touches };
  }

  // Toutes les tranches de 1 à 4 lignes consécutives : une adresse postale
  // tient sur des lignes voisines, jamais éparpillée dans l'image.
  function fenetresDeLignes(texte, maxLignes) {
    var lignes = texte.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var out = [];
    for (var i = 0; i < lignes.length; i++) {
      for (var n = 1; n <= maxLignes && i + n <= lignes.length; n++) {
        out.push(lignes.slice(i, i + n).join(" "));
      }
    }
    return out;
  }

  // Rapproche un texte scanné des adresses connues, en deux temps.
  //
  // 1. Rappel : sur l'ensemble du texte, quelles adresses ont des mots en commun ?
  // 2. Précision : parmi celles-là, on retient la meilleure fenêtre de lignes
  //    voisines. Sans cette seconde passe, sur une enveloppe à fenêtre le bloc
  //    de l'expéditeur et celui du destinataire se mélangent, et une rue
  //    d'expéditeur qui existe aussi dans la tournée peut l'emporter.
  function matchTexteLibre(texte, limit) {
    var tokensGlobaux = tokensUtilesScan(texte);
    if (!tokensGlobaux.length) return [];

    var presel = [];
    getIndex().forEach(function (entry) {
      var s = noterLot(tokensGlobaux, entry);
      // Un seul mot commun — le code postal, le plus souvent — ne désigne
      // personne. Sauf si ce mot est un nom propre rare : lui désigne.
      var nomSeul = (s.touches === 1) && nomDiscriminant(tokensGlobaux, entry);
      if (s.touches >= 2 || nomSeul) {
        presel.push({ entry: entry, brut: s.total, minTouches: nomSeul ? 1 : 2 });
      }
    });
    presel.sort(function (a, b) { return b.brut - a.brut; });
    presel = presel.slice(0, 30);

    var fenetres = fenetresDeLignes(texte, 4)
      .map(tokensUtilesScan)
      .filter(function (t) { return t.length; });

    var out = [];
    presel.forEach(function (p) {
      var meilleure = { total: 0, touches: 0 };
      fenetres.forEach(function (tokens) {
        var s = noterLot(tokens, p.entry);
        if (s.touches >= p.minTouches && s.total > meilleure.total) meilleure = s;
      });
      if (meilleure.touches >= p.minTouches) {
        out.push({ row: p.entry.row, score: meilleure.total, touches: meilleure.touches });
      }
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 5);
  }

  // --- écriture des lignes --------------------------------------------------

  function addRow(row) {
    row.rue = normaliseRue(row.rue);
    state.rows.unshift(row);
    persist();
  }

  function updateRow(id, patch) {
    var row = state.rows.find(function (r) { return r.id === id; });
    if (row) {
      Object.assign(row, patch);
      row.rue = normaliseRue(row.rue);
      row.date_maj = todayISO();
      persist();
    }
    return row;
  }

  function deleteRow(id) {
    state.rows = state.rows.filter(function (r) { return r.id !== id; });
    persist();
  }

  function findRow(id) {
    return state.rows.find(function (r) { return r.id === id; });
  }

  // --- API publique ---------------------------------------------------------------

  return {
    COLUMNS: COLUMNS,
    MULTI_SEP: MULTI_SEP,
    VALID_POSITIONS: VALID_POSITIONS,
    POSITION_LABELS: POSITION_LABELS,

    load: load,
    persist: persist,
    getRows: function () { return state.rows; },
    setRows: function (r) { state.rows = r; persist(); },
    getIdTournee: function () { return state.idTournee; },
    getSettings: function () { return state.settings; },
    setSetting: function (k, v) { state.settings[k] = v; persist(); },

    uid: uid,
    todayISO: todayISO,
    blankRow: blankRow,
    namesOf: namesOf,
    setNames: setNames,
    hasGPS: hasGPS,
    hasReleve: hasReleve,
    releveInfo: releveInfo,
    scoreReleve: scoreReleve,
    positionUtile: positionUtile,
    hasPosition: hasPosition,
    enregistrerReleveAuto: enregistrerReleveAuto,
    enregistrerReleveManuel: enregistrerReleveManuel,
    setResolveurGeocodageApproche: setResolveurGeocodageApproche,
    SCORE_MIN: SCORE_MIN,
    SCORE_SUR: SCORE_SUR,
    hasCasier: hasCasier,
    casierLabel: casierLabel,
    casierLabelEtape: casierLabelEtape,
    casierCle: casierCle,

    multiActif: multiActif,
    cleFichier: cleFichier,
    suffixeFichier: suffixeFichier,
    getFichiers: getFichiers,
    setOrdreFichiers: setOrdreFichiers,
    deplacerFichier: deplacerFichier,
    retirerFichier: retirerFichier,
    zoneIntegree: zoneIntegree,
    setZoneIntegree: setZoneIntegree,
    zonesDuFichier: zonesDuFichier,
    colonnesDuFichier: colonnesDuFichier,

    positionInfo: positionInfo,
    isStopPub: isStopPub,
    compareTournee: compareTournee,
    rowsOrdreTournee: rowsOrdreTournee,
    etapesCasier: etapesCasier,
    casierColonnes: casierColonnes,
    normalizeBool: normalizeBool,

    getCommuneColor: getCommuneColor,
    setCommuneColor: setCommuneColor,
    getTourneeColor: getTourneeColor,
    setTourneeColor: setTourneeColor,
    listCommunes: listCommunes,
    listRues: listRues,
    listAdressesDeRue: listAdressesDeRue,
    findDoublon: findDoublon,
    filterValues: filterValues,
    communeLabel: communeLabel,
    communeLabelOf: communeLabelOf,

    validateRows: validateRows,
    importFromCSV: importFromCSV,
    exportCSVText: exportCSVText,
    parseCSV: parseCSV,
    toCSV: toCSV,

    search: search,
    searchScored: searchScored,
    matchTexteLibre: matchTexteLibre,
    normalize: normalize,
    tokenize: tokenize,

    addRow: addRow,
    updateRow: updateRow,
    deleteRow: deleteRow,
    findRow: findRow
  };
})();
