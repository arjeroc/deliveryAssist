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

  // --- géocodage en masse ----------------------------------------------------

  // Les deux services acceptent un CSV entier en une requête : géocoder 400
  // adresses coûte deux appels au lieu de 400. Le champ result_type renvoyé
  // indique la précision réellement obtenue — c'est lui qui permet de ne pas
  // faire passer un centre de commune pour une position d'adresse.
  var BULK_PRIMARY = "https://data.geopf.fr/geocodage/search/csv/";
  var BULK_FALLBACK = "https://api-adresse.data.gouv.fr/search/csv/";
  var LOT = 200;
  var TIMEOUT_LOT_MS = 60000;

  function csvEscape(v) {
    v = (v === undefined || v === null) ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function versCSV(items) {
    var lignes = ["numero,rue,code_postal,commune"];
    items.forEach(function (it) {
      lignes.push([it.numero, it.rue, it.code_postal, it.commune].map(csvEscape).join(","));
    });
    return lignes.join("\n");
  }

  function envoyerLot(url, items) {
    var form = new FormData();
    form.append("data", new Blob([versCSV(items)], { type: "text/csv" }), "adresses.csv");
    ["numero", "rue", "code_postal", "commune"].forEach(function (c) { form.append("columns", c); });

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_LOT_MS);
    return fetch(url, { method: "POST", body: form, signal: ctrl.signal })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      });
  }

  // Le CSV renvoyé conserve l'ordre des lignes envoyées : on peut donc
  // réassocier chaque résultat à son adresse par sa position.
  function lireReponse(texte, items) {
    var table = window.Store.parseCSV(texte);
    if (!table.length) return [];
    var entete = table[0];
    var iLon = entete.indexOf("longitude");
    var iLat = entete.indexOf("latitude");
    var iType = entete.indexOf("result_type");
    var iScore = entete.indexOf("result_score");
    var out = [];
    for (var i = 1; i < table.length && i - 1 < items.length; i++) {
      var rec = table[i];
      var lat = Number(rec[iLat]), lon = Number(rec[iLon]);
      if (!rec[iLat] || !rec[iLon] || isNaN(lat) || isNaN(lon)) continue;
      out.push({
        id: items[i - 1].id,
        latitude: lat,
        longitude: lon,
        type: iType >= 0 ? rec[iType] : "",
        score: iScore >= 0 ? Number(rec[iScore]) || 0 : 0
      });
    }
    return out;
  }

  // items : [{ id, numero, rue, code_postal, commune }]
  // onProgress(traites, total) est appelé après chaque lot.
  function geocodeBulk(items, onProgress) {
    var lots = [];
    for (var i = 0; i < items.length; i += LOT) lots.push(items.slice(i, i + LOT));

    var resultats = [];
    var traites = 0;
    return lots.reduce(function (chaine, lot) {
      return chaine.then(function () {
        return envoyerLot(BULK_PRIMARY, lot)
          .catch(function () { return envoyerLot(BULK_FALLBACK, lot); })
          .then(function (texte) {
            resultats = resultats.concat(lireReponse(texte, lot));
            traites += lot.length;
            if (onProgress) onProgress(traites, items.length);
          });
      });
    }, Promise.resolve()).then(function () { return resultats; });
  }

  function debounce(fn, delay) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, delay);
    };
  }

  return { search: search, geocodeBulk: geocodeBulk, debounce: debounce };
})();
