/* ============================================================================
   geocode.js — recherche d'adresse via l'API de géocodage de la Géoplateforme
   (cartes.gouv.fr / IGN), avec repli sur l'ancienne Base Adresse Nationale si
   la première ne répond pas. Aucune donnée nominative n'est envoyée : seule
   l'adresse texte (numéro, rue, code postal, commune) est transmise.
   ========================================================================== */
window.Geocode = (function () {
  "use strict";

  var PRIMARY_URL = "https://data.geopf.fr/geocodage/search";
  var FALLBACK_URL = "https://api-adresse.data.gouv.fr/search/";
  var TIMEOUT_MS = 6000;

  function withTimeout(promise, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return { signal: ctrl.signal, run: promise(ctrl.signal).finally(function () { clearTimeout(timer); }) };
  }

  function fetchJSON(url, signal) {
    return fetch(url, { signal: signal, headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
  }

  function buildQuery(base, params) {
    var usp = new URLSearchParams(params);
    return base + "?" + usp.toString();
  }

  function featuresToResults(geojson) {
    if (!geojson || !Array.isArray(geojson.features)) return [];
    return geojson.features.map(function (f) {
      var p = f.properties || {};
      var coords = (f.geometry && f.geometry.coordinates) || [];
      return {
        label: p.label || "",
        numero: p.housenumber || "",
        rue: p.street || p.name || "",
        code_postal: p.postcode || "",
        commune: p.city || "",
        score: p.score || 0,
        longitude: coords[0],
        latitude: coords[1]
      };
    });
  }

  // adresse : { numero, rue, code_postal, commune }
  function search(adresse) {
    var q = [adresse.numero, adresse.rue, adresse.code_postal, adresse.commune].filter(Boolean).join(" ").trim();
    if (!q) return Promise.resolve([]);
    var params = { q: q, limit: 5 };
    if (adresse.code_postal) params.postcode = adresse.code_postal;

    var attempt = function (baseUrl, ctrlSignal) {
      return fetchJSON(buildQuery(baseUrl, params), ctrlSignal);
    };

    var ctrl1 = new AbortController();
    var t1 = setTimeout(function () { ctrl1.abort(); }, TIMEOUT_MS);

    return attempt(PRIMARY_URL, ctrl1.signal)
      .then(function (json) { clearTimeout(t1); return featuresToResults(json); })
      .catch(function () {
        clearTimeout(t1);
        var ctrl2 = new AbortController();
        var t2 = setTimeout(function () { ctrl2.abort(); }, TIMEOUT_MS);
        return attempt(FALLBACK_URL, ctrl2.signal)
          .then(function (json) { clearTimeout(t2); return featuresToResults(json); })
          .catch(function (err) { clearTimeout(t2); throw err; });
      });
  }

  function debounce(fn, delay) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  return { search: search, debounce: debounce };
})();
