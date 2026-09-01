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
      // Rayons de proximité (mètres) utilisés par la page Suivi tournée —
      // configurables plutôt que codés en dur.
      rayonImmediat: 100,
      rayonProche: 300,
      rayonEloigne: 1000
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

  function normalize(s) {
    return (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
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

  // --- recherche ----------------------------------------------------------------

  function search(query) {
    var q = normalize(query);
    if (!q) return state.rows.slice();
    return state.rows.filter(function (r) {
      var hay = normalize([r.nom_famille, r.rue, r.commune, r.lieu_dit, r.numero, r.code_postal].join(" "));
      return hay.indexOf(q) !== -1;
    });
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
    normalizeBool: normalizeBool,

    getCommuneColor: getCommuneColor,
    setCommuneColor: setCommuneColor,
    listCommunes: listCommunes,

    validateRows: validateRows,
    importFromCSV: importFromCSV,
    exportCSVText: exportCSVText,
    parseCSV: parseCSV,
    toCSV: toCSV,

    search: search,
    normalize: normalize,

    addRow: function (row) { state.rows.unshift(row); persist(); },
    updateRow: function (id, patch) {
      var row = state.rows.find(function (r) { return r.id === id; });
      if (row) { Object.assign(row, patch); row.date_maj = todayISO(); persist(); }
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
