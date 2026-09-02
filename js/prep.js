/* ============================================================================
   prep.js — données de la "Préparation tournée" : lettres/colis à distribuer
   pour la tournée du jour, et leur état de distribution. Totalement séparé de
   la base d'adresses (store.js) : ne modifie jamais les lignes permanentes,
   se réinitialise indépendamment, et reste isolé par id_tournee.
   ========================================================================== */
window.Prep = (function () {
  "use strict";

  var KEY = "atournee_prep_v1";
  // { [id_tournee]: { [addressId]: { lettres:n, colis:n, statut:s, motif:'', horodatage:iso } } }
  var state = {};

  // Trois états seulement : pas d'état "en cours" à déclarer à la main, il
  // coûterait un geste de plus sur le terrain sans rien apprendre — une zone
  // partiellement traitée se lit déjà dans sa progression.
  var STATUTS = { A_FAIRE: "a_faire", DISTRIBUE: "distribue", ABANDONNE: "abandonne" };

  // Motifs de non-distribution : liste courte, choisie en un seul appui.
  var MOTIFS = [
    { key: "absent", label: "Absent", icon: "🚪" },
    { key: "boite", label: "Boîte pleine / inaccessible", icon: "📭" },
    { key: "introuvable", label: "Adresse introuvable", icon: "❓" },
    { key: "refus", label: "Refus / Stop Pub", icon: "🚫" },
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

  function load() {
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
    return {
      lettres: (e && e.lettres) || 0,
      colis: (e && e.colis) || 0,
      statut: (e && e.statut) || STATUTS.A_FAIRE,
      motif: (e && e.motif) || "",
      horodatage: (e && e.horodatage) || ""
    };
  }

  function setQty(idTournee, addrId, type, qty) {
    qty = Math.max(0, Math.round(Number(qty) || 0));
    var b = bucket(idTournee);
    var cur = b[addrId] || { lettres: 0, colis: 0, statut: STATUTS.A_FAIRE, motif: "", horodatage: "" };
    cur[type] = qty;
    if (cur.lettres === 0 && cur.colis === 0) {
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
      acc.lettres += e.lettres;
      acc.colis += e.colis;
      acc.adresses += 1;
      return acc;
    }, { lettres: 0, colis: 0, adresses: 0 });
  }

  // Vision d'avancement : tournée totale / distribué / abandonné / restant.
  function progress(idTournee) {
    var out = {
      lettresTotal: 0, colisTotal: 0,
      lettresDistribuees: 0, colisDistribuees: 0,
      lettresAbandonnees: 0, colisAbandonnees: 0,
      lettresRestantes: 0, colisRestantes: 0,
      adressesTotal: 0, adressesDistribuees: 0, adressesAbandonnees: 0, adressesRestantes: 0
    };
    listEntries(idTournee).forEach(function (e) {
      out.lettresTotal += e.lettres;
      out.colisTotal += e.colis;
      out.adressesTotal += 1;
      if (e.statut === STATUTS.DISTRIBUE) {
        out.lettresDistribuees += e.lettres;
        out.colisDistribuees += e.colis;
        out.adressesDistribuees += 1;
      } else if (e.statut === STATUTS.ABANDONNE) {
        out.lettresAbandonnees += e.lettres;
        out.colisAbandonnees += e.colis;
        out.adressesAbandonnees += 1;
      } else {
        out.lettresRestantes += e.lettres;
        out.colisRestantes += e.colis;
        out.adressesRestantes += 1;
      }
    });
    return out;
  }

  function resetTournee(idTournee) {
    delete state[idTournee];
    persist();
  }

  return {
    STATUTS: STATUTS,
    MOTIFS: MOTIFS,
    motifLabel: motifLabel,

    load: load,
    getEntry: getEntry,
    setQty: setQty,
    adjust: adjust,
    remove: remove,
    setStatut: setStatut,
    setStatutMany: setStatutMany,
    restore: restore,
    listEntries: listEntries,
    totals: totals,
    progress: progress,
    resetTournee: resetTournee
  };
})();
