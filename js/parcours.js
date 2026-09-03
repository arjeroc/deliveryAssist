/* ============================================================================
   parcours.js — reconstruction et tracé du parcours de tournée.

   Le principe est de ne jamais afficher un nuage d'adresses, mais une suite
   d'étapes : les adresses consécutives d'une même rue forment une étape, et
   c'est entre ces étapes que la trace est dessinée. Une tournée de 400 boîtes
   se lit alors en une trentaine de repères.

   Deux précautions guident tout le module :
   - une position estimée ne doit jamais se faire passer pour une position
     connue : chaque étape porte son niveau de fiabilité, et le tracé le montre ;
   - en zone rurale, beaucoup d'adresses ne se géocodent qu'au centre de la
     commune. Les étapes voisines retombant sur le même point sont donc
     fusionnées pour le tracé, faute de quoi la trace ferait des allers-retours
     absurdes sur le clocher du village.

   Module autonome : il dessine ses propres calques sur l'instance Leaflet
   existante et ne modifie aucun comportement de mapview.js.
   ========================================================================== */
window.Parcours = (function () {
  "use strict";

  var PREC_KEY = "atournee_geoprec_v1";  // précision du géocodage, par adresse
  var ROUTE_KEY = "atournee_route_v1";   // trace routière mise en cache

  // Seuils de zoom des trois niveaux de lecture.
  var ZOOM_NUMEROS = 12;
  var ZOOM_ADRESSES = 15;

  // Deux ancres plus proches que ça sont considérées comme un même lieu.
  var FUSION_M = 40;

  var COULEURS = {
    reel: "#2f6b4f",
    geocode: "#1e6fd9",
    approx: "#f4b400",
    estime: "#a0a49c"
  };

  var LIBELLES = {
    reel: "GPS relevé",
    geocode: "Géocodé",
    approx: "Approché (commune)",
    estime: "Position estimée"
  };

  var S = window.Store;

  // ---------------------------------------------------------------------
  // Précision du géocodage — stockée à côté de la base, sans toucher au CSV
  // ---------------------------------------------------------------------
  var precisions = {};

  function chargerPrecisions() {
    try { precisions = JSON.parse(localStorage.getItem(PREC_KEY)) || {}; }
    catch (e) { precisions = {}; }
  }

  function enregistrerPrecisions() {
    try { localStorage.setItem(PREC_KEY, JSON.stringify(precisions)); } catch (e) { /* ignore */ }
  }

  // Niveau de confiance d'une adresse, du plus sûr au plus flou.
  function niveauDe(row) {
    if (!S.hasGPS(row)) return null;
    if (row.geocode_statut !== "geocode") return "reel";
    var t = precisions[row.id];
    if (t === "housenumber" || t === "street") return "geocode";
    if (!t) return "geocode"; // géocodage antérieur, précision inconnue
    return "approx";          // locality, municipality, poi…
  }

  // ---------------------------------------------------------------------
  // Ordre de la tournée
  // ---------------------------------------------------------------------
  function num(v) {
    return (v === "" || v === undefined || v === null || isNaN(Number(v))) ? null : Number(v);
  }

  // L'ordre vient du casier (colonne puis ligne). ordre_zone et ordre_rue
  // départagent à l'intérieur d'un même casier, l'ordre du fichier en dernier
  // recours. Les adresses hors casier ferment la marche.
  function ordonner(rows) {
    return rows.map(function (r, i) {
      var c = num(r.casier_c), l = num(r.casier_l);
      return {
        row: r, i: i,
        c: c === null ? Infinity : c,
        l: l === null ? Infinity : l,
        z: num(r.ordre_zone) === null ? Infinity : num(r.ordre_zone),
        o: num(r.ordre_rue) === null ? Infinity : num(r.ordre_rue)
      };
    }).sort(function (a, b) {
      if (a.c !== b.c) return a.c - b.c;
      if (a.l !== b.l) return a.l - b.l;
      if (a.z !== b.z) return a.z - b.z;
      if (a.o !== b.o) return a.o - b.o;
      return a.i - b.i;
    }).map(function (x) { return x.row; });
  }

  // ---------------------------------------------------------------------
  // Découpage en étapes
  // ---------------------------------------------------------------------
  function cleRue(row) {
    return S.normalize(row.rue) + "|" + S.normalize(row.commune);
  }

  function mediane(valeurs) {
    var v = valeurs.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // L'ancre d'une étape est la médiane des positions de ses adresses les mieux
  // renseignées — la médiane plutôt que la moyenne pour qu'une coordonnée
  // aberrante ne déplace pas l'étape entière.
  function ancrerEtape(etape) {
    var niveaux = ["reel", "geocode", "approx"];
    for (var n = 0; n < niveaux.length; n++) {
      var membres = etape.adresses.filter(function (r) { return niveauDe(r) === niveaux[n]; });
      if (!membres.length) continue;
      etape.lat = mediane(membres.map(function (r) { return Number(r.latitude); }));
      etape.lon = mediane(membres.map(function (r) { return Number(r.longitude); }));
      etape.niveau = niveaux[n];
      return;
    }
    etape.lat = null;
    etape.lon = null;
    etape.niveau = null;
  }

  // Une étape sans aucune position est placée entre ses voisines connues.
  // C'est une commodité de lecture, marquée comme telle : jamais un point sûr.
  function interpoler(etapes) {
    etapes.forEach(function (e, i) {
      if (e.lat !== null) return;
      var avant = null, apres = null, k;
      for (k = i - 1; k >= 0; k--) if (etapes[k].lat !== null && etapes[k].niveau !== "estime") { avant = etapes[k]; break; }
      for (k = i + 1; k < etapes.length; k++) if (etapes[k].lat !== null && etapes[k].niveau !== "estime") { apres = etapes[k]; break; }
      var ref = avant && apres ? null : (avant || apres);
      if (ref) {
        e.lat = ref.lat; e.lon = ref.lon;
      } else if (avant && apres) {
        var t = (i - etapes.indexOf(avant)) / (etapes.indexOf(apres) - etapes.indexOf(avant));
        e.lat = avant.lat + (apres.lat - avant.lat) * t;
        e.lon = avant.lon + (apres.lon - avant.lon) * t;
      } else {
        return; // aucune position connue dans toute la tournée
      }
      e.niveau = "estime";
    });
  }

  function construire() {
    chargerPrecisions();
    var rows = ordonner(S.getRows());
    var etapes = [];
    var courante = null;

    rows.forEach(function (r) {
      var cle = cleRue(r);
      if (!courante || courante.cle !== cle) {
        // Rue différente : nouvelle étape. Une rue reparcourue plus loin dans
        // la tournée donne bien deux étapes distinctes, pas un retour en arrière.
        courante = {
          cle: cle,
          rue: r.rue || "(rue non renseignée)",
          commune: r.commune || "",
          lieuxDits: {},
          adresses: []
        };
        etapes.push(courante);
      }
      if (r.lieu_dit) courante.lieuxDits[r.lieu_dit.trim()] = true;
      courante.adresses.push(r);
    });

    etapes.forEach(function (e, i) {
      e.rang = i + 1;
      var lieux = Object.keys(e.lieuxDits);
      e.lieuDit = lieux.length === 1 ? lieux[0] : "";
      ancrerEtape(e);
    });
    interpoler(etapes);

    return { etapes: etapes, rows: rows };
  }

  // ---------------------------------------------------------------------
  // Statistiques
  // ---------------------------------------------------------------------
  function distanceVolOiseau(points) {
    var d = 0;
    for (var i = 1; i < points.length; i++) {
      d += window.MapView.distanceMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    return d;
  }

  function resume(modele) {
    var communes = {}, rues = {};
    var compte = { reel: 0, geocode: 0, approx: 0, sans: 0 };
    modele.rows.forEach(function (r) {
      if (r.commune) communes[S.normalize(r.commune)] = true;
      if (r.rue) rues[cleRue(r)] = true;
      var n = niveauDe(r);
      compte[n || "sans"] += 1;
    });
    var placees = modele.etapes.filter(function (e) { return e.lat !== null; });
    var estimees = placees.filter(function (e) { return e.niveau === "estime"; }).length;
    return {
      communes: Object.keys(communes).length,
      rues: Object.keys(rues).length,
      adresses: modele.rows.length,
      etapes: modele.etapes.length,
      positions: compte,
      etapesPlacees: placees.length,
      etapesEstimees: estimees,
      depart: modele.etapes[0] || null,
      arrivee: modele.etapes[modele.etapes.length - 1] || null,
      // La distance n'a de sens que si la trace repose majoritairement sur des
      // positions tenues : au-delà d'un tiers d'estimations, on ne l'affiche pas.
      distanceFiable: placees.length > 1 && estimees / placees.length <= 0.34,
      distanceVolOiseau: placees.length > 1 ? distanceVolOiseau(placees) : 0
    };
  }

  // ---------------------------------------------------------------------
  // Géocodage des adresses sans position
  // ---------------------------------------------------------------------
  function aGeocoder() {
    return S.getRows().filter(function (r) { return !S.hasGPS(r); });
  }

  function geocoderManquants(onProgress) {
    var cibles = aGeocoder();
    if (!cibles.length) return Promise.resolve({ demandes: 0, places: 0 });
    var items = cibles.map(function (r) {
      return { id: r.id, numero: r.numero, rue: r.rue, code_postal: r.code_postal, commune: r.commune };
    });
    chargerPrecisions();
    return window.Geocode.geocodeBulk(items, onProgress).then(function (res) {
      res.forEach(function (x) {
        S.updateRow(x.id, {
          latitude: String(x.latitude),
          longitude: String(x.longitude),
          geocode_statut: "geocode"
        });
        precisions[x.id] = x.type || "";
      });
      enregistrerPrecisions();
      viderCacheRoute();
      return { demandes: items.length, places: res.length };
    });
  }

  // ---------------------------------------------------------------------
  // Trace routière (calculée une fois, puis conservée localement)
  // ---------------------------------------------------------------------
  var OSRM = "https://router.project-osrm.org/route/v1/driving/";
  var MAX_POINTS_REQUETE = 25;

  function cleCache(points) {
    return points.map(function (p) { return p.lat.toFixed(5) + "," + p.lon.toFixed(5); }).join(";");
  }

  function lireCacheRoute(cle) {
    try {
      var c = JSON.parse(localStorage.getItem(ROUTE_KEY)) || {};
      return c.cle === cle ? c.trace : null;
    } catch (e) { return null; }
  }

  function ecrireCacheRoute(cle, trace) {
    try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ cle: cle, trace: trace })); } catch (e) { /* ignore */ }
  }

  function viderCacheRoute() {
    try { localStorage.removeItem(ROUTE_KEY); } catch (e) { /* ignore */ }
  }

  function indexLePlusProche(coords, lon, lat) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var d = Math.pow(coords[i][0] - lon, 2) + Math.pow(coords[i][1] - lat, 2);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Renvoie un tableau de tronçons : un par couple d'étapes consécutives, ce
  // qui permet ensuite de styler chaque tronçon selon la fiabilité de ses deux
  // extrémités.
  function routerLot(points) {
    var url = OSRM + points.map(function (p) { return p.lon + "," + p.lat; }).join(";") +
      "?overview=full&geometries=geojson";
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (json) {
      if (!json || json.code !== "Ok" || !json.routes || !json.routes.length) throw new Error("route absente");
      var coords = json.routes[0].geometry.coordinates;
      var etapesSnap = (json.waypoints || []).map(function (w) { return w.location; });
      var troncons = [];
      for (var i = 1; i < points.length; i++) {
        var a = etapesSnap[i - 1] ? indexLePlusProche(coords, etapesSnap[i - 1][0], etapesSnap[i - 1][1]) : 0;
        var b = etapesSnap[i] ? indexLePlusProche(coords, etapesSnap[i][0], etapesSnap[i][1]) : coords.length - 1;
        if (b < a) { var t = a; a = b; b = t; }
        troncons.push(coords.slice(a, b + 1).map(function (c) { return [c[1], c[0]]; }));
      }
      var legs = (json.routes[0].legs || []).map(function (l) { return l.distance || 0; });
      return { troncons: troncons, distances: legs };
    });
  }

  function router(points) {
    var cle = cleCache(points);
    var cache = lireCacheRoute(cle);
    if (cache) return Promise.resolve(cache);

    var lots = [];
    for (var i = 0; i < points.length - 1; i += MAX_POINTS_REQUETE - 1) {
      lots.push(points.slice(i, i + MAX_POINTS_REQUETE));
    }
    var troncons = [], distances = [];
    return lots.reduce(function (chaine, lot) {
      return chaine.then(function () {
        if (lot.length < 2) return;
        return routerLot(lot).then(function (r) {
          troncons = troncons.concat(r.troncons);
          distances = distances.concat(r.distances);
        });
      });
    }, Promise.resolve()).then(function () {
      var trace = { troncons: troncons, distances: distances };
      ecrireCacheRoute(cle, trace);
      return trace;
    });
  }

  // ---------------------------------------------------------------------
  // Dessin
  // ---------------------------------------------------------------------
  // Plusieurs cartes partagent le même modèle de parcours : celle de la Base de
  // données et celle de la Course. Chacune garde ses propres calques, sinon la
  // seconde effacerait les couches de la première.
  var vues = [];
  var modele = null;

  function vuePour(instance, options) {
    var carte = instance.getMap();
    if (!carte) return null;
    var v = vues.filter(function (x) { return x.map === carte; })[0];
    if (!v) {
      v = {
        map: carte,
        calques: {
          trace: L.layerGroup(), numeros: L.layerGroup(),
          communes: L.layerGroup(), adresses: L.layerGroup()
        }
      };
      carte.on("zoomend", function () { appliquerZoom(v); });
      vues.push(v);
    }
    v.leger = !!options.leger;
    v.onSelect = options.onSelect || null;
    return v;
  }

  function icone(html, classe, taille) {
    return L.divIcon({ className: "", html: '<div class="' + classe + '">' + html + '</div>',
      iconSize: [taille, taille], iconAnchor: [taille / 2, taille / 2] });
  }

  function esc(s) {
    return (s || "").toString().replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function popupEtape(e, total) {
    var noms = e.adresses.slice(0, 8).map(function (r) {
      return esc((r.numero ? r.numero + " — " : "") + (S.namesOf(r).join(" / ") || "(sans nom)"));
    });
    var reste = e.adresses.length - noms.length;
    return '<div class="pc-popup">' +
      '<strong>' + esc(e.rue) + '</strong><br>' +
      esc(S.communeLabel(e.commune, e.lieuDit)) + '<br>' +
      '<span class="pc-popup-meta">Étape ' + e.rang + " / " + total + " · " +
        e.adresses.length + ' adresse(s)</span><br>' +
      '<span class="pc-popup-prec">' + (LIBELLES[e.niveau] || "Sans position") + '</span>' +
      '<div class="pc-popup-liste">' + noms.join("<br>") +
        (reste > 0 ? "<br><em>+ " + reste + " autre(s)</em>" : "") + '</div>' +
    '</div>';
  }

  function placees() {
    return modele.etapes.filter(function (e) { return e.lat !== null; });
  }

  // Les étapes retombant au même endroit (centre de commune) sont fusionnées
  // pour le tracé : la trace suit le terrain, pas les répétitions de données.
  function pointsTrace() {
    var out = [];
    placees().forEach(function (e) {
      var dernier = out[out.length - 1];
      if (dernier && window.MapView.distanceMeters(dernier.lat, dernier.lon, e.lat, e.lon) < FUSION_M) {
        dernier.etapes.push(e);
        if (ordreNiveau(e.niveau) > ordreNiveau(dernier.niveau)) dernier.niveau = e.niveau;
        return;
      }
      out.push({ lat: e.lat, lon: e.lon, niveau: e.niveau, etapes: [e] });
    });
    return out;
  }

  var ORDRE_NIVEAU = { reel: 0, geocode: 1, approx: 2, estime: 3 };

  // Attention : « reel » vaut 0, donc pas de repli par « || » ici — il
  // transformerait le niveau le plus sûr en niveau le moins sûr.
  function ordreNiveau(n) {
    var v = ORDRE_NIVEAU[n];
    return v === undefined ? 3 : v;
  }

  function styleTroncon(a, b) {
    var pire = ordreNiveau(a.niveau) >= ordreNiveau(b.niveau) ? a.niveau : b.niveau;
    var sur = pire === "reel" || pire === "geocode";
    return {
      color: COULEURS[pire] || COULEURS.estime,
      weight: sur ? 5 : 4,
      opacity: sur ? 0.9 : 0.65,
      dashArray: sur ? null : "6,7"
    };
  }

  // Dans la Course, la trace n'est qu'un repère de fond : elle doit se lire
  // sans concurrencer les marqueurs de distribution.
  function allegerStyle(style) {
    return {
      color: style.color,
      weight: 3,
      opacity: 0.45,
      dashArray: style.dashArray
    };
  }

  function dessinerTrace(v, points, trace) {
    v.calques.trace.clearLayers();
    for (var i = 1; i < points.length; i++) {
      var geom = (trace && trace.troncons[i - 1] && trace.troncons[i - 1].length > 1)
        ? trace.troncons[i - 1]
        : [[points[i - 1].lat, points[i - 1].lon], [points[i].lat, points[i].lon]];
      var style = styleTroncon(points[i - 1], points[i]);
      L.polyline(geom, v.leger ? allegerStyle(style) : style).addTo(v.calques.trace);
    }
  }

  function dessinerReperes(v, points) {
    v.calques.numeros.clearLayers();
    v.calques.communes.clearLayers();
    var total = modele.etapes.length;

    points.forEach(function (p, i) {
      var e = p.etapes[0];
      var estDepart = i === 0, estArrivee = i === points.length - 1;
      var contenu = p.etapes.map(function (x) { return popupEtape(x, total); }).join("<hr>");

      if (estDepart || estArrivee) {
        L.marker([p.lat, p.lon], {
          icon: icone(estDepart ? "D" : "A", "pc-borne " + (estDepart ? "pc-depart" : "pc-arrivee"), 30),
          zIndexOffset: 1000
        }).bindPopup(estDepart ? "<strong>Départ</strong><br>" + contenu : "<strong>Arrivée</strong><br>" + contenu)
          .addTo(v.calques.communes);
        return;
      }

      // Changement de commune : repère visible dès la vue d'ensemble.
      var precedent = points[i - 1].etapes[0];
      if (S.normalize(precedent.commune) !== S.normalize(e.commune)) {
        L.marker([p.lat, p.lon], { icon: icone("", "pc-commune", 16) })
          .bindTooltip(e.commune, { permanent: false, direction: "top" })
          .bindPopup(contenu)
          .addTo(v.calques.communes);
      }

      L.marker([p.lat, p.lon], {
        icon: icone(String(e.rang), "pc-num pc-niv-" + (p.niveau || "estime"), 24)
      }).bindPopup(contenu).addTo(v.calques.numeros);
    });
  }

  function dessinerAdresses(v) {
    v.calques.adresses.clearLayers();
    modele.rows.forEach(function (r) {
      var niveau = niveauDe(r);
      if (!niveau) return;
      var m = L.circleMarker([Number(r.latitude), Number(r.longitude)], {
        radius: 4, weight: 1, color: "#fff", fillColor: COULEURS[niveau], fillOpacity: 1
      });
      var noms = S.namesOf(r).join(" / ") || "(sans nom)";
      m.bindPopup("<strong>" + esc(noms) + "</strong><br>" +
        esc([r.numero, r.rue].filter(Boolean).join(" ")) + "<br>" +
        esc(S.communeLabelOf(r)) + "<br><em>" + LIBELLES[niveau] + "</em>");
      if (v.onSelect) m.on("click", function () { v.onSelect(r.id); });
      m.addTo(v.calques.adresses);
    });
  }

  // Trois niveaux de lecture : la forme générale de loin, les numéros d'étape
  // en approchant, les adresses seulement au plus près — et seulement si
  // l'utilisateur les a demandées dans les réglages.
  function appliquerZoom(v) {
    if (!v || !v.map) return;
    var z = v.map.getZoom();
    basculer(v, v.calques.numeros, !v.leger && z >= ZOOM_NUMEROS);
    basculer(v, v.calques.adresses,
      !v.leger && S.getSettings().afficherAdressesCarte === true && z >= ZOOM_ADRESSES);
  }

  function basculer(v, calque, visible) {
    if (!v.map || !calque) return;
    if (visible && !v.map.hasLayer(calque)) v.map.addLayer(calque);
    if (!visible && v.map.hasLayer(calque)) v.map.removeLayer(calque);
  }

  // Réapplique les règles d'affichage sur toutes les cartes ouvertes, après un
  // changement de réglage.
  function rafraichirAffichage() {
    vues.forEach(appliquerZoom);
  }

  function recentrer(instance) {
    var carte = instance && instance.getMap();
    if (!carte || !modele) return;
    var pts = placees().map(function (e) { return [e.lat, e.lon]; });
    if (!pts.length) return;
    try { carte.fitBounds(pts, { padding: [30, 30] }); } catch (e) { /* ignore */ }
  }

  function effacer(instance) {
    var carte = instance && instance.getMap();
    vues.forEach(function (v) {
      if (carte && v.map !== carte) return;
      Object.keys(v.calques).forEach(function (k) {
        if (v.map.hasLayer(v.calques[k])) v.map.removeLayer(v.calques[k]);
        v.calques[k].clearLayers();
      });
    });
  }

  // Rendu complet. Renvoie une promesse résolue une fois le routage tenté,
  // pour que l'appelant puisse rafraîchir son résumé avec la distance réelle.
  function afficher(instance, options) {
    options = options || {};
    var v = vuePour(instance, options);
    if (!v) return Promise.resolve(null);

    modele = construire();
    var points = pointsTrace();

    effacer(instance);
    if (!points.length) return Promise.resolve({ modele: modele, trace: null });

    v.map.addLayer(v.calques.trace);
    dessinerTrace(v, points, null);
    if (!v.leger) {
      // En mode allégé, seule la trace est dessinée : les repères d'étape
      // masqueraient les marqueurs de distribution de la Course.
      v.map.addLayer(v.calques.communes);
      dessinerReperes(v, points);
      dessinerAdresses(v);
    }
    appliquerZoom(v);
    if (options.recentrer !== false) recentrer(instance);

    if (options.router === false || points.length < 2) {
      return Promise.resolve({ modele: modele, trace: null });
    }
    return router(points)
      .then(function (trace) {
        dessinerTrace(v, points, trace);
        return { modele: modele, trace: trace };
      })
      .catch(function () {
        // Routage indisponible : la trace reste en lignes directes, ce que le
        // résumé signale plutôt que de laisser croire à un tracé routier.
        return { modele: modele, trace: null };
      });
  }

  function distanceRoutee(trace) {
    if (!trace || !trace.distances || !trace.distances.length) return 0;
    return trace.distances.reduce(function (a, b) { return a + b; }, 0);
  }

  return {
    construire: construire,
    resume: resume,
    afficher: afficher,
    effacer: effacer,
    recentrer: recentrer,
    rafraichirAffichage: rafraichirAffichage,
    geocoderManquants: geocoderManquants,
    aGeocoder: aGeocoder,
    distanceRoutee: distanceRoutee,
    viderCacheRoute: viderCacheRoute,
    LIBELLES: LIBELLES,
    COULEURS: COULEURS
  };
})();
