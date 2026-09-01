/* ============================================================================
   prep.js — données de la "Préparation tournée" : lettres/colis à distribuer
   pour la tournée du jour, et leur état de distribution. Totalement séparé de
   la base d'adresses (store.js) : ne modifie jamais les lignes permanentes,
   se réinitialise indépendamment, et reste isolé par id_tournee.
   ========================================================================== */
window.Prep = (function () {
  "use strict";

  var KEY = "atournee_prep_v1";
  // { [id_tournee]: { [addressId]: { lettres:n, colis:n, distribue:bool, distribueLe:iso } } }
  var state = {};

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      state = raw ? JSON.parse(raw) : {};
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
    return { lettres: (e && e.lettres) || 0, colis: (e && e.colis) || 0, distribue: !!(e && e.distribue) };
  }

  function setQty(idTournee, addrId, type, qty) {
    qty = Math.max(0, Math.round(Number(qty) || 0));
    var b = bucket(idTournee);
    var cur = b[addrId] || { lettres: 0, colis: 0, distribue: false };
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

  function setDelivered(idTournee, addrId, delivered) {
    var b = state[idTournee];
    if (!b || !b[addrId]) return;
    b[addrId].distribue = !!delivered;
    b[addrId].distribueLe = delivered ? new Date().toISOString() : "";
    persist();
  }

  function listEntries(idTournee) {
    var b = state[idTournee] || {};
    return Object.keys(b).map(function (id) {
      return {
        addressId: id,
        lettres: b[id].lettres || 0,
        colis: b[id].colis || 0,
        distribue: !!b[id].distribue
      };
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

  // Vision d'avancement : tournée totale / distribué / restant.
  function progress(idTournee) {
    var out = {
      lettresTotal: 0, colisTotal: 0,
      lettresDistribuees: 0, colisDistribuees: 0,
      lettresRestantes: 0, colisRestantes: 0,
      adressesTotal: 0, adressesDistribuees: 0, adressesRestantes: 0
    };
    listEntries(idTournee).forEach(function (e) {
      out.lettresTotal += e.lettres;
      out.colisTotal += e.colis;
      out.adressesTotal += 1;
      if (e.distribue) {
        out.lettresDistribuees += e.lettres;
        out.colisDistribuees += e.colis;
        out.adressesDistribuees += 1;
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
    load: load,
    getEntry: getEntry,
    setQty: setQty,
    adjust: adjust,
    remove: remove,
    setDelivered: setDelivered,
    listEntries: listEntries,
    totals: totals,
    progress: progress,
    resetTournee: resetTournee
  };
})();
