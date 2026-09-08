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
  var STD_KEY = "atournee_prep_std_v1";
  var RAPPORTS_KEY = "atournee_rapports_v1";
  var CLOTURES_KEY = "atournee_clotures_v1";
  // { [id_tournee]: { [addressId]: { lettres:n, colis:n, presse:n, statut:s, motif:'', horodatage:iso } } }
  var state = {};
  // Zones de courrier standard retenues pour la tournée, désignées par leur
  // case de casier : { [id_tournee]: { "C2L3": true } }. Stockées à part des
  // quantités, pour qu'une clé de case ne puisse jamais être confondue avec un
  // identifiant d'adresse.
  var zones = {};
  // État de distribution du courrier standard, adresse par adresse :
  // { [id_tournee]: { [addressId]: { statut, motif, horodatage } } }.
  //
  // Un troisième registre, et non une entrée ordinaire : une adresse de zone
  // standard ne porte aucune quantité, or dans la table des objets suivis
  // l'absence de quantité vaut précisément « rien à distribuer ici » — une
  // entrée à zéro y serait effacée au premier enregistrement.
  var standard = {};

  // Archive des rapports de fin de tournée : [{ id, idTournee, dateFermeture,
  // debut, fin, html, resume }]. Le HTML y est conservé tel qu'il a été
  // généré à la clôture — cette liste ne relit jamais la tournée, elle garde
  // une photographie.
  var rapports = [];
  // Verrou de clôture, distinct de l'archive : { [id_tournee]: rapportId }.
  // Supprimer un vieux rapport dans l'archive ne doit jamais déverrouiller une
  // tournée en cours ; seule "Nouvelle tournée" (resetTournee) le fait, au
  // même titre qu'elle vide déjà zones et statuts.
  var clotures = {};

  // Catégories d'items à distribuer, source unique pour toute l'application :
  // ajouter une catégorie ici suffit à la faire apparaître partout.
  //
  // Deux noms pour la même chose : le court tient dans une carte de liste, le
  // long lève l'ambiguïté là où l'écran ne dit pas déjà qu'il s'agit d'objets
  // suivis — l'attribution après un scan, par exemple.
  var TYPES = [
    { key: "lettres", icon: "✉️", label: "Lettres", labelLong: "Lettres suivies" },
    { key: "colis", icon: "📦", label: "Colis", labelLong: "Colis" },
    { key: "presse", icon: "📰", label: "Presse", labelLong: "Presse" }
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

  function loadStandard() {
    try {
      var raw = localStorage.getItem(STD_KEY);
      standard = raw ? JSON.parse(raw) : {};
    } catch (e) { standard = {}; }
  }

  function persistStandard() {
    try { localStorage.setItem(STD_KEY, JSON.stringify(standard)); } catch (e) { /* ignore */ }
  }

  function standardBucket(idTournee) {
    if (!standard[idTournee]) standard[idTournee] = {};
    return standard[idTournee];
  }

  // Même forme de retour que getEntry, sans les quantités : le reste de
  // l'application manipule alors les deux natures d'adresse du même geste.
  function getStandardEntry(idTournee, addrId) {
    var b = standard[idTournee];
    var e = b && b[addrId];
    return {
      statut: (e && e.statut) || STATUTS.A_FAIRE,
      motif: (e && e.motif) || "",
      horodatage: (e && e.horodatage) || ""
    };
  }

  function setStandardStatut(idTournee, addrId, statut, motif) {
    var b = standardBucket(idTournee);
    if (statut === STATUTS.A_FAIRE) { delete b[addrId]; return; }
    b[addrId] = {
      statut: statut,
      motif: (statut === STATUTS.ABANDONNE) ? (motif || "") : "",
      horodatage: nowISO()
    };
  }

  function setStandardStatutMany(idTournee, addrIds, statut, motif) {
    var snapshot = addrIds.map(function (id) {
      var e = getStandardEntry(idTournee, id);
      return { addressId: id, statut: e.statut, motif: e.motif, horodatage: e.horodatage };
    });
    addrIds.forEach(function (id) { setStandardStatut(idTournee, id, statut, motif); });
    persistStandard();
    return snapshot;
  }

  function restoreStandard(idTournee, snapshot) {
    var b = standardBucket(idTournee);
    snapshot.forEach(function (s) {
      if (s.statut === STATUTS.A_FAIRE) { delete b[s.addressId]; return; }
      b[s.addressId] = { statut: s.statut, motif: s.motif, horodatage: s.horodatage };
    });
    persistStandard();
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

  // Une case se nomme par sa position tant qu'un seul fichier est chargé, et par
  // sa position et son fichier dès qu'ils sont plusieurs. Les zones déjà
  // retenues sont renommées avec elle : passer d'un fichier à deux — ou
  // l'inverse — ne doit pas effacer une préparation déjà faite.
  function remapZonesStandard(idTournee, transformer) {
    var b = zones[idTournee];
    if (!b) return;
    var out = {};
    Object.keys(b).forEach(function (cle) {
      var neuf = transformer(cle);
      if (neuf) out[neuf] = true;
    });
    zones[idTournee] = out;
    persistZones();
  }

  function loadRapports() {
    try {
      var raw = localStorage.getItem(RAPPORTS_KEY);
      rapports = raw ? JSON.parse(raw) : [];
    } catch (e) { rapports = []; }
  }

  function persistRapports() {
    try { localStorage.setItem(RAPPORTS_KEY, JSON.stringify(rapports)); } catch (e) { /* ignore */ }
  }

  function loadClotures() {
    try {
      var raw = localStorage.getItem(CLOTURES_KEY);
      clotures = raw ? JSON.parse(raw) : {};
    } catch (e) { clotures = {}; }
  }

  function persistClotures() {
    try { localStorage.setItem(CLOTURES_KEY, JSON.stringify(clotures)); } catch (e) { /* ignore */ }
  }

  function uidRapport() {
    return "rap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function estCloturee(idTournee) {
    return !!clotures[idTournee];
  }

  function getRapport(id) {
    return rapports.filter(function (r) { return r.id === id; })[0] || null;
  }

  function getRapportActif(idTournee) {
    return getRapport(clotures[idTournee]);
  }

  // Archive un rapport déjà généré (lecture seule sur les données métier, la
  // construction du HTML se fait ailleurs) et pose le verrou de clôture.
  function cloturer(idTournee, html, resume) {
    var rapport = {
      id: uidRapport(), idTournee: idTournee, dateFermeture: nowISO(),
      debut: (resume && resume.debut) || "", fin: nowISO(),
      html: html, resume: resume || {}
    };
    rapports.unshift(rapport);
    persistRapports();
    clotures[idTournee] = rapport.id;
    persistClotures();
    return rapport;
  }

  function listRapports() {
    return rapports.slice();
  }

  function supprimerRapport(id) {
    var avant = rapports.length;
    rapports = rapports.filter(function (r) { return r.id !== id; });
    persistRapports();
    return avant !== rapports.length;
  }

  function load() {
    loadZones();
    loadStandard();
    loadRapports();
    loadClotures();
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

  // Même forme que listEntries, sur le registre du courrier standard : le
  // rapport de fin de tournée a besoin des deux pour retrouver motifs et
  // horodatages, quelle que soit la nature de l'adresse.
  function listStandardEntries(idTournee) {
    var b = standard[idTournee] || {};
    return Object.keys(b).map(function (id) {
      var e = getStandardEntry(idTournee, id);
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
    delete standard[idTournee];
    persistStandard();
    // Repartir à zéro est le seul geste qui lève le verrou de clôture : les
    // rapports déjà archivés restent en place, ils ne décrivent pas la
    // tournée qui recommence.
    delete clotures[idTournee];
    persistClotures();
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
    listStandardEntries: listStandardEntries,
    getStandardEntry: getStandardEntry,
    setStandardStatutMany: setStandardStatutMany,
    restoreStandard: restoreStandard,
    getZonesStandard: getZonesStandard,
    remapZonesStandard: remapZonesStandard,
    isZoneStandard: isZoneStandard,
    setZoneStandard: setZoneStandard,
    toggleZoneStandard: toggleZoneStandard,
    countZonesStandard: countZonesStandard,
    totals: totals,
    progress: progress,
    resetTournee: resetTournee,

    estCloturee: estCloturee,
    cloturer: cloturer,
    listRapports: listRapports,
    getRapport: getRapport,
    getRapportActif: getRapportActif,
    supprimerRapport: supprimerRapport
  };
})();
