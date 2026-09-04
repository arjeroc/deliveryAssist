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
    "casier_c", "casier_l", "ordre_zone", "ordre_rue", "position_manuelle",
    "type_objet", "notes", "stoppub", "date_maj"
  ];

  var state = {
    rows: [],
    idTournee: "tm002",
    settings: {
      geocodageActif: true,
      communeColors: {},
      // Rayons de proximité (mètres) utilisés par la page Course —
      // configurables plutôt que codés en dur.
      rayonImmediat: 100,
      rayonProche: 300,
      rayonEloigne: 1000,
      // 'distributions' : seules les zones ayant des items à distribuer.
      // 'complete'      : toute la tournée, zones de distribution standard incluses.
      modeSuivi: "distributions",
      // Scan d'étiquette : expérimental, désactivable si la lecture déçoit.
      scanActif: true,
      // Pastilles d'adresses sur la carte : masquées par défaut, la trace du
      // parcours se lisant beaucoup mieux sans elles.
      afficherAdressesCarte: false,
      // Repères d'étapes numérotés : ils portent la progression de la tournée,
      // mais peuvent être masqués pour ne garder que la trace.
      afficherEtapesCarte: true
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

  // Normalisation de recherche : décomposition Unicode, suppression des
  // diacritiques, majuscules, et toute ponctuation ramenée à un espace.
  //   "Élodie Léa-Marie l'Abbé"  ->  "ELODIE LEA MARIE L ABBE"
  function normalize(s) {
    return (s === undefined || s === null ? "" : String(s))
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

  function hasCasier(row) {
    return row.casier_c !== "" && row.casier_c !== undefined && row.casier_c !== null &&
           row.casier_l !== "" && row.casier_l !== undefined && row.casier_l !== null;
  }

  function casierLabel(row) {
    return hasCasier(row) ? ("C" + row.casier_c + "L" + row.casier_l) : "Hors casier";
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
  // C1L1 → C1L2 → … → C1L5 → C2L1 → … → C5L5. ordre_zone puis ordre_rue
  // départagent à l'intérieur d'une même case, et l'ordre du fichier tranche en
  // dernier recours. Les adresses hors casier ferment la marche.
  //
  // Cet ordre appartient aux données, pas à la carte : la cartographie s'y
  // conforme, elle ne le recalcule jamais. C'est ici, et nulle part ailleurs,
  // qu'il se définit.
  function ordreNum(v) {
    return (v === "" || v === undefined || v === null || isNaN(Number(v))) ? Infinity : Number(v);
  }

  function rangTournee(row) {
    return [ordreNum(row.casier_c), ordreNum(row.casier_l), ordreNum(row.ordre_zone), ordreNum(row.ordre_rue)];
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
  function rowsOrdreTournee(list) {
    return (list || state.rows)
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
  function etapesCasier(list) {
    var ordonnees = rowsOrdreTournee(list);
    var out = [];
    ordonnees.forEach(function (r) {
      var cle = hasCasier(r) ? ("C" + Number(r.casier_c) + "L" + Number(r.casier_l)) : "hors";
      var dernier = out[out.length - 1];
      if (!dernier || dernier.cle !== cle) {
        dernier = {
          cle: cle,
          label: cle === "hors" ? "Hors casier" : cle,
          c: cle === "hors" ? null : Number(r.casier_c),
          l: cle === "hors" ? null : Number(r.casier_l),
          rows: []
        };
        out.push(dernier);
      }
      dernier.rows.push(r);
    });
    return out;
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

  function importFromCSV(text) {
    var table = parseCSV(text);
    if (table.length === 0) return { ok: false, message: "Fichier vide ou illisible." };
    var header = table[0].map(function (h) { return h.trim(); });
    var missingCols = COLUMNS.filter(function (c) { return header.indexOf(c) === -1; });
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

    var result = validateRows(imported);
    state.rows = imported;
    persist();

    return {
      ok: true,
      count: imported.length,
      missingCols: missingCols,
      extraCols: extraCols,
      errors: result.errors,
      warnings: result.warnings
    };
  }

  function exportCSVText() {
    validateRows(state.rows);
    persist();
    return toCSV(state.rows);
  }

  // --- persistance --------------------------------------------------------------

  function persist() {
    // Toute écriture invalide l'index : il sera reconstruit à la recherche suivante.
    invalidateIndex();
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state.rows));
      localStorage.setItem(META_KEY, JSON.stringify({ idTournee: state.idTournee }));
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
        }
      } else {
        migrateFromV1();
      }
      if (settings) {
        var s = JSON.parse(settings);
        if (s && typeof s === "object") Object.assign(state.settings, s);
      }
    } catch (e) { state.rows = []; }
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

  function invalidateIndex() { searchIndex = null; }

  function buildIndex() {
    searchIndex = state.rows.map(function (r) {
      return {
        row: r,
        fields: {
          noms: contentTokens(tokenize(namesOf(r).join(" "))),
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
      // Un seul mot commun — le code postal, le plus souvent — ne désigne personne.
      if (s.touches >= 2) presel.push({ entry: entry, brut: s.total });
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
        if (s.touches >= 2 && s.total > meilleure.total) meilleure = s;
      });
      if (meilleure.touches >= 2) {
        out.push({ row: p.entry.row, score: meilleure.total, touches: meilleure.touches });
      }
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 5);
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
    setIdTournee: function (v) { state.idTournee = v || "tm002"; persist(); },
    getSettings: function () { return state.settings; },
    setSetting: function (k, v) { state.settings[k] = v; persist(); },

    uid: uid,
    todayISO: todayISO,
    blankRow: blankRow,
    namesOf: namesOf,
    setNames: setNames,
    hasGPS: hasGPS,
    hasCasier: hasCasier,
    casierLabel: casierLabel,
    positionInfo: positionInfo,
    isStopPub: isStopPub,
    compareTournee: compareTournee,
    rowsOrdreTournee: rowsOrdreTournee,
    etapesCasier: etapesCasier,
    normalizeBool: normalizeBool,

    getCommuneColor: getCommuneColor,
    setCommuneColor: setCommuneColor,
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

    addRow: function (row) {
      row.rue = normaliseRue(row.rue);
      state.rows.unshift(row);
      persist();
    },
    updateRow: function (id, patch) {
      var row = state.rows.find(function (r) { return r.id === id; });
      if (row) {
        Object.assign(row, patch);
        row.rue = normaliseRue(row.rue);
        row.date_maj = todayISO();
        persist();
      }
      return row;
    },
    deleteRow: function (id) {
      state.rows = state.rows.filter(function (r) { return r.id !== id; });
      persist();
    },
    findRow: function (id) {
      return state.rows.find(function (r) { return r.id === id; });
    }
  };
})();
