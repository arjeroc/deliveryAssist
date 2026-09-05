/* ============================================================================
   prep.js — données de la "Préparation tournée" : lettres/colis à distribuer
   pour la tournée du jour, et leur état de distribution. Totalement séparé de
   la base d'adresses (store.js) : ne modifie jamais les lignes permanentes,
   se réinitialise indépendamment, et reste isolé par id_tournee.
   ========================================================================== */
window.Prep = (function () {
  "use strict";

  var KEY = "atournee_prep_v1";
  var ZONES_KEY = "atournee_prep_zones_v1";
  // { [id_tournee]: { [addressId]: { lettres:n, colis:n, presse:n, statut:s, motif:'', horodatage:iso } } }
  var state = {};
  // Zones de courrier standard retenues pour la tournée, désignées par leur
  // case de casier : { [id_tournee]: { "C2L3": true } }. Stockées à part des
  // quantités, pour qu'une clé de case ne puisse jamais être confondue avec un
  // identifiant d'adresse.
  var zones = {};

  // Catégories d'items à distribuer, source unique pour toute l'application :
  // ajouter une catégorie ici suffit à la faire apparaître partout.
  var TYPES = [
    { key: "lettres", icon: "✉️", label: "Lettres" },
    { key: "colis", icon: "📦", label: "Colis" },
    { key: "presse", icon: "📰", label: "Presse" }
  ];

  function typeKeys() { return TYPES.map(function (t) { return t.key; }); }

  function countItems(entry) {
    return typeKeys().reduce(function (n, k) { return n + (entry[k] || 0); }, 0);
  }

  // Trois états seulement : pas d'état "en cours" à déclarer à la main, il
  // coûterait un geste de plus sur le terrain sans rien apprendre — une zone
  // partiellement traitée se lit déjà dans sa progression.
  var STATUTS = { A_FAIRE: "a_faire", DISTRIBUE: "distribue", ABANDONNE: "abandonne" };

  // Motifs de non-distribution : liste courte, choisie en un seul appui.
  // Les quatre premiers subissent la non-distribution ; « Manque de temps » est
  // le seul qui l'assume comme une décision du livreur — la distinction compte
  // au moment de relire la tournée.
  var MOTIFS = [
    { key: "absent", label: "Absent", icon: "🚪" },
    { key: "boite", label: "Boîte pleine / inaccessible", icon: "📭" },
    { key: "introuvable", label: "Adresse introuvable", icon: "❓" },
    { key: "refus", label: "Refus client", icon: "🚫" },
    { key: "temps", label: "Manque de temps", icon: "⏱️" },
    { key: "autre", label: "Autre", icon: "⋯" }
  ];

  function motifLabel(key) {
    var m = MOTIFS.filter(function (x) { return x.key === key; })[0];
    return m ? m.label : "";
  }

  function nowISO() { return new Date().toISOString(); }

  // Les tournées enregistrées avant l'introduction des statuts ne connaissaient
  // qu'un booléen "distribue" : on le convertit au chargement, une seule fois.
  function migrateEntry(e) {
    if (e.statut) return e;
    e.statut = e.distribue ? STATUTS.DISTRIBUE : STATUTS.A_FAIRE;
    e.motif = "";
    e.horodatage = e.distribueLe || "";
    delete e.distribue;
    delete e.distribueLe;
    return e;
  }

  function loadZones() {
    try {
      var raw = localStorage.getItem(ZONES_KEY);
      zones = raw ? JSON.parse(raw) : {};
    } catch (e) { zones = {}; }
  }

  function persistZones() {
    try { localStorage.setItem(ZONES_KEY, JSON.stringify(zones)); } catch (e) { /* ignore */ }
  }

  function zonesBucket(idTournee) {
    if (!zones[idTournee]) zones[idTournee] = {};
    return zones[idTournee];
  }

  // Renvoie la table des cases retenues, telle quelle : l'appelant y lit
  // l'appartenance d'une case par sa clé, sans reparcourir la liste.
  function getZonesStandard(idTournee) {
    return zones[idTournee] || {};
  }

  function isZoneStandard(idTournee, cle) {
    return !!(zones[idTournee] && zones[idTournee][cle]);
  }

  function setZoneStandard(idTournee, cle, actif) {
    if (!cle) return;
    var b = zonesBucket(idTournee);
    if (actif) b[cle] = true;
    else delete b[cle];
    persistZones();
  }

  function toggleZoneStandard(idTournee, cle) {
    var actif = !isZoneStandard(idTournee, cle);
    setZoneStandard(idTournee, cle, actif);
    return actif;
  }

  function countZonesStandard(idTournee) {
    return Object.keys(getZonesStandard(idTournee)).length;
  }

  function load() {
    loadZones();
    try {
      var raw = localStorage.getItem(KEY);
      state = raw ? JSON.parse(raw) : {};
      var migrated = false;
      Object.keys(state).forEach(function (idT) {
        Object.keys(state[idT]).forEach(function (addrId) {
          if (!state[idT][addrId].statut) migrated = true;
          migrateEntry(state[idT][addrId]);
        });
      });
      if (migrated) persist();
    } catch (e) { state = {}; }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function bucket(idTournee) {
    if (!state[idTournee]) state[idTournee] = {};
    return state[idTournee];
  }

  function getEntry(idTournee, addrId) {
    var b = state[idTournee];
    var e = b && b[addrId];
    var out = {
      statut: (e && e.statut) || STATUTS.A_FAIRE,
      motif: (e && e.motif) || "",
      horodatage: (e && e.horodatage) || ""
    };
    // Les tournées enregistrées avant l'ajout d'une catégorie n'ont pas le
    // champ correspondant : il vaut zéro, aucune migration n'est nécessaire.
    typeKeys().forEach(function (k) { out[k] = (e && e[k]) || 0; });
    return out;
  }

  function blankEntry() {
    var e = { statut: STATUTS.A_FAIRE, motif: "", horodatage: "" };
    typeKeys().forEach(function (k) { e[k] = 0; });
    return e;
  }

  function setQty(idTournee, addrId, type, qty) {
    qty = Math.max(0, Math.round(Number(qty) || 0));
    var b = bucket(idTournee);
    var cur = b[addrId] || blankEntry();
    cur[type] = qty;
    if (countItems(cur) === 0) {
      delete b[addrId];
    } else {
      b[addrId] = cur;
    }
    persist();
    return getEntry(idTournee, addrId);
  }

  function adjust(idTournee, addrId, type, delta) {
    var cur = getEntry(idTournee, addrId);
    return setQty(idTournee, addrId, type, (cur[type] || 0) + delta);
  }

  function remove(idTournee, addrId) {
    var b = state[idTournee];
    if (b && b[addrId]) { delete b[addrId]; persist(); }
  }

  function setStatut(idTournee, addrId, statut, motif) {
    var b = state[idTournee];
    if (!b || !b[addrId]) return;
    b[addrId].statut = statut;
    b[addrId].motif = (statut === STATUTS.ABANDONNE) ? (motif || "") : "";
    b[addrId].horodatage = (statut === STATUTS.A_FAIRE) ? "" : nowISO();
    persist();
  }

  // Applique un statut à plusieurs adresses et renvoie l'état antérieur, pour
  // que l'appelant puisse proposer une annulation après coup.
  function setStatutMany(idTournee, addrIds, statut, motif) {
    var snapshot = addrIds.map(function (id) {
      var e = getEntry(idTournee, id);
      return { addressId: id, statut: e.statut, motif: e.motif, horodatage: e.horodatage };
    });
    addrIds.forEach(function (id) { setStatut(idTournee, id, statut, motif); });
    return snapshot;
  }

  function restore(idTournee, snapshot) {
    var b = state[idTournee];
    if (!b) return;
    snapshot.forEach(function (s) {
      if (!b[s.addressId]) return;
      b[s.addressId].statut = s.statut;
      b[s.addressId].motif = s.motif;
      b[s.addressId].horodatage = s.horodatage;
    });
    persist();
  }

  function listEntries(idTournee) {
    var b = state[idTournee] || {};
    return Object.keys(b).map(function (id) {
      var e = getEntry(idTournee, id);
      e.addressId = id;
      return e;
    });
  }

  function totals(idTournee) {
    return listEntries(idTournee).reduce(function (acc, e) {
      typeKeys().forEach(function (k) { acc[k] += e[k]; });
      acc.adresses += 1;
      return acc;
    }, (function () {
      var a = { adresses: 0 };
      typeKeys().forEach(function (k) { a[k] = 0; });
      return a;
    })());
  }

  // Vision d'avancement, par état : total / distribué / abandonné / restant.
  // Chaque état porte le compte de toutes les catégories d'items.
  function progress(idTournee) {
    function bag() {
      var b = {};
      typeKeys().forEach(function (k) { b[k] = 0; });
      return b;
    }
    var out = {
      total: bag(), distribues: bag(), abandonnes: bag(), restants: bag(),
      adresses: { total: 0, distribuees: 0, abandonnees: 0, restantes: 0 }
    };
    listEntries(idTournee).forEach(function (e) {
      var etat = e.statut === STATUTS.DISTRIBUE ? "distribues"
               : e.statut === STATUTS.ABANDONNE ? "abandonnes"
               : "restants";
      var compteur = e.statut === STATUTS.DISTRIBUE ? "distribuees"
                   : e.statut === STATUTS.ABANDONNE ? "abandonnees"
                   : "restantes";
      typeKeys().forEach(function (k) {
        out.total[k] += e[k];
        out[etat][k] += e[k];
      });
      out.adresses.total += 1;
      out.adresses[compteur] += 1;
    });
    return out;
  }

  function resetTournee(idTournee) {
    delete state[idTournee];
    persist();
    delete zones[idTournee];
    persistZones();
  }

  return {
    STATUTS: STATUTS,
    MOTIFS: MOTIFS,
    TYPES: TYPES,
    motifLabel: motifLabel,
    countItems: countItems,

    load: load,
    getEntry: getEntry,
    setQty: setQty,
    adjust: adjust,
    remove: remove,
    setStatut: setStatut,
    setStatutMany: setStatutMany,
    restore: restore,
    listEntries: listEntries,
    getZonesStandard: getZonesStandard,
    isZoneStandard: isZoneStandard,
    setZoneStandard: setZoneStandard,
    toggleZoneStandard: toggleZoneStandard,
    countZonesStandard: countZonesStandard,
    totals: totals,
    progress: progress,
    resetTournee: resetTournee
  };
})();
