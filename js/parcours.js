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

   La carte ne porte plus que la trace et, si le réglage le demande, ses
   flèches de sens. Aucun point, aucun repère, aucune pastille : un marqueur de
   plus sur une tournée de quatre cents boîtes, c'est quatre cents marqueurs, et
   la forme du parcours — la seule chose que cette carte donne à lire —
   disparaît dessous. Le détail d'une adresse se consulte dans les Données.

   Module autonome : il dessine ses propres calques sur l'instance Leaflet
   existante et ne modifie aucun comportement de mapview.js.
   ========================================================================== */
window.Parcours = (function () {
  "use strict";

  var PREC_KEY = "atournee_geoprec_v1";  // précision du géocodage, par adresse
  var ROUTE_KEY = "atournee_route_v1";   // trace routière mise en cache

  // En deçà de ce zoom, les flèches se chevauchent plus qu'elles n'informent.
  var ZOOM_FLECHES = 13;

  // Longueur minimale d'un tronçon pour mériter un chevron de sens. Sans ce
  // seuil, les cent cinquante tronçons d'une vraie tournée poseraient autant de
  // chevrons, et la trace disparaîtrait sous ses propres flèches.
  var FLECHE_MIN_M = 150;

  // Deux ancres plus proches que ça sont considérées comme un même lieu.
  var FUSION_M = 40;

  // Deux étapes consécutives séparées par plus d'une vingtaine de minutes de
  // route ne se suivent pas : c'est un trou dans la donnée, pas un trajet. La
  // trace s'y interrompt et reprend au point suivant, plutôt que de tirer un
  // trait à travers le département et de fausser toutes les distances.
  var COUPURE_MINUTES = 25;
  var VITESSE_MOYENNE_KMH = 50;

  function coupureMetres() {
    return VITESSE_MOYENNE_KMH * 1000 * (COUPURE_MINUTES / 60);
  }

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

  // Un géocodage est dit approché quand il ne descend pas au numéro ou à la
  // rue : il pose alors le point au centre de la commune. C'est le seul cas où
  // un relevé de terrain vaut mieux que lui — store.js le demande ici.
  function geocodageApproche(row) {
    var t = precisions[row.id];
    if (!t) return false;     // géocodage antérieur, précision inconnue : au bénéfice du doute
    return t !== "housenumber" && t !== "street";
  }

  // Niveau de confiance d'une adresse, du plus sûr au plus flou. Il porte sur
  // la position que la carte emploie vraiment, pas sur les seules colonnes
  // latitude/longitude : un relevé de terrain est une position tenue.
  function niveauDe(row) {
    var pos = S.positionUtile(row);
    if (!pos) return null;
    if (pos.source === "verifie" || pos.source === "releve") return "reel";
    return geocodageApproche(row) ? "approx" : "geocode";
  }

  // ---------------------------------------------------------------------
  // Ordre de la tournée
  // ---------------------------------------------------------------------
  // L'ordre appartient aux données : il est défini une seule fois, dans
  // store.js, à partir de la grille du casier. Le parcours le consomme tel
  // quel et ne se permet ni de le recalculer ni de le corriger — une carte qui
  // réordonne sa source finit par mentir sur la tournée.
  function ordonner(rows) {
    return S.rowsOrdreTournee(rows);
  }

  // ---------------------------------------------------------------------
  // Découpage en étapes
  // ---------------------------------------------------------------------
  // Le fichier d'origine entre dans la clé : deux fichiers empilés peuvent
  // décrire la même rue sur la même case sans être le même passage. Le
  // discriminant est vide hors empilement — la clé est alors celle d'avant.
  function cleRue(row) {
    return S.normalize(row.rue) + "|" + S.normalize(row.commune) + S.suffixeFichier(row);
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
      etape.lat = mediane(membres.map(function (r) { return S.positionUtile(r).lat; }));
      etape.lon = mediane(membres.map(function (r) { return S.positionUtile(r).lon; }));
      etape.niveau = niveaux[n];
      return;
    }
    etape.lat = null;
    etape.lon = null;
    etape.niveau = null;
  }

  // Une étape sans aucune position est placée entre ses voisines connues.
  // C'est une commodité de lecture, marquée comme telle : jamais un point sûr.
  // Le repère se cherche dans la même tournée : placer une étape de tm0 entre
  // deux étapes de tm1 la poserait sur un trajet qu'elle ne suit pas.
  function interpoler(etapes) {
    etapes.forEach(function (e, i) {
      if (e.lat !== null) return;
      var avant = null, apres = null, k;
      function utilisable(x) {
        return x.lat !== null && x.niveau !== "estime" && x.fichier === e.fichier;
      }
      for (k = i - 1; k >= 0; k--) if (utilisable(etapes[k])) { avant = etapes[k]; break; }
      for (k = i + 1; k < etapes.length; k++) if (utilisable(etapes[k])) { apres = etapes[k]; break; }
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

  function faireEtape(membres) {
    var premier = membres[0].row;
    var e = {
      cle: cleRue(premier),
      rue: premier.rue || "(rue non renseignée)",
      commune: premier.commune || "",
      lieuxDits: {},
      adresses: membres.map(function (m) { return m.row; }),
      // Place de l'étape : rang de sa première adresse. Les étapes étant
      // construites dans l'ordre de la tournée, ces rangs sont déjà croissants
      // — aucun tri ne vient donc redistribuer les étapes après coup.
      position: membres[0].i,
      fichier: S.cleFichier(premier),
      casiers: membres.map(function (m) { return S.casierLabelEtape(m.row); })
        .filter(function (v, k, t) { return t.indexOf(v) === k; })
    };
    e.adresses.forEach(function (r) { if (r.lieu_dit) e.lieuxDits[r.lieu_dit.trim()] = true; });
    return e;
  }

  // Découpage en étapes.
  //
  // Une étape est une suite d'adresses **voisines dans l'ordre de la tournée**
  // partageant la même rue. Jamais autre chose : regrouper une rue sur toute la
  // tournée — ce que faisait la version précédente — replaçait ses adresses au
  // rang de son premier passage, si bien qu'une rue parcourue en C1L4 puis en
  // C3L3 et C3L4 se lisait comme un seul arrêt en début de tournée. L'ordre du
  // casier s'en trouvait contredit par la carte.
  //
  // Seul recollage autorisé : deux passages de la même rue séparés par une ou
  // deux adresses (une boîte isolée intercalée). Le recollage reste local, donc
  // les étapes conservent l'ordre de la tournée.
  var ECART_RECOLLE = 2;

  function decouperEnEtapes(rows) {
    var etapes = [];
    rows.forEach(function (r, i) {
      var cle = cleRue(r);
      for (var j = etapes.length - 1; j >= 0; j--) {
        if (i - etapes[j].fin > ECART_RECOLLE + 1) break;
        if (etapes[j].cle === cle) {
          etapes[j].membres.push({ row: r, i: i });
          etapes[j].fin = i;
          return;
        }
      }
      etapes.push({ cle: cle, membres: [{ row: r, i: i }], debut: i, fin: i });
    });
    return etapes.map(function (e) { return faireEtape(e.membres); });
  }

  function construire() {
    chargerPrecisions();
    var rows = ordonner(S.getRows());
    var etapes = decouperEnEtapes(rows);

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
  // Le trajet entre la dernière boîte d'un fichier et la première du suivant
  // n'est pas parcouru : la trace ne le dessine pas, la distance ne le compte
  // pas non plus. Hors empilement, aucun point ne porte de fichier et la somme
  // est celle d'avant, terme pour terme.
  function memeFichier(a, b) {
    return a.fichier === b.fichier;
  }

  function distanceVolOiseau(points) {
    var d = 0, seuil = coupureMetres();
    for (var i = 1; i < points.length; i++) {
      if (!memeFichier(points[i - 1], points[i])) continue;
      var l = window.MapView.distanceMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      if (l <= seuil) d += l;
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
    // Nombre d'étapes par fichier, pour la légende des traces. Vide hors
    // empilement : il n'y a alors qu'une trace, et rien à départager.
    var parFichier = [];
    if (S.multiActif()) {
      var compteFichier = {};
      modele.etapes.forEach(function (e) {
        if (!e.fichier) return;
        compteFichier[e.fichier] = (compteFichier[e.fichier] || 0) + 1;
      });
      parFichier = S.getFichiers()
        .filter(function (f) { return compteFichier[f.id]; })
        .map(function (f) {
          return { id: f.id, etapes: compteFichier[f.id], couleur: S.getTourneeColor(f.id) };
        });
    }
    return {
      fichiers: parFichier,
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
      distanceVolOiseau: placees.length > 1
        ? distanceVolOiseau(etapesGroupeesParFichier(placees))
        : 0
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
        calques: { trace: L.layerGroup(), fleches: L.layerGroup() }
      };
      carte.on("zoomend", function () { appliquerZoom(v); });
      vues.push(v);
    }
    v.leger = !!options.leger;
    return v;
  }

  function placees() {
    return modele.etapes.filter(function (e) { return e.lat !== null; });
  }

  // L'ordre de passage entrelace les fichiers case par case — C1L1 de tm1, puis
  // C1L1 de tm0, puis C1L2 de tm1… C'est ce que le livreur suit, et c'est juste.
  //
  // Mais une trace qui suivrait cet entrelacement ne serait plus une trace :
  // elle sauterait d'une tournée à l'autre à chaque case, et se réduirait à une
  // poussière de tronçons. Le tracé regroupe donc les étapes par fichier, chacun
  // dans son propre ordre, et les lignes se superposent sur la carte — une par
  // tournée, de sa couleur. Le regroupement est stable : à l'intérieur d'un
  // fichier, les étapes restent dans l'ordre de son casier.
  //
  // Fichier unique : la partition rend la liste telle quelle.
  function etapesGroupeesParFichier(etapes) {
    if (!S.multiActif()) return etapes;
    var groupes = {}, ordre = [];
    etapes.forEach(function (e) {
      var f = e.fichier || "";
      if (!groupes[f]) { groupes[f] = []; ordre.push(f); }
      groupes[f].push(e);
    });
    // ordre suit la première apparition, donc la pile : les traces se succèdent
    // dans l'ordre d'empilement, comme tout le reste.
    return ordre.reduce(function (out, f) { return out.concat(groupes[f]); }, []);
  }

  // Les étapes retombant au même endroit (centre de commune) sont fusionnées
  // pour le tracé : la trace suit le terrain, pas les répétitions de données.
  //
  // La fusion s'arrête à la frontière du fichier : deux tournées qui passent au
  // même endroit y passent chacune pour son compte, et chacune doit garder son
  // point sur sa propre trace.
  function pointsTrace() {
    var out = [];
    etapesGroupeesParFichier(placees()).forEach(function (e) {
      var dernier = out[out.length - 1];
      if (dernier && dernier.fichier === e.fichier &&
          window.MapView.distanceMeters(dernier.lat, dernier.lon, e.lat, e.lon) < FUSION_M) {
        dernier.etapes.push(e);
        if (ordreNiveau(e.niveau) > ordreNiveau(dernier.niveau)) dernier.niveau = e.niveau;
        return;
      }
      out.push({ lat: e.lat, lon: e.lon, niveau: e.niveau, fichier: e.fichier, etapes: [e] });
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

  // Fichier unique : la couleur dit ce que vaut la position — c'est la seule
  // chose qu'une trace ait alors à distinguer. Plusieurs fichiers empilés : la
  // couleur dit de quelle tournée vient le trait, et la qualité continue de se
  // lire dans l'épaisseur, l'opacité et les pointillés, qui ne changent pas.
  // Une trace estimée reste pointillée, quelle que soit sa tournée.
  function couleurTroncon(point, pire) {
    if (point.fichier) return S.getTourneeColor(point.fichier);
    return COULEURS[pire] || COULEURS.estime;
  }

  function styleTroncon(a, b) {
    var pire = ordreNiveau(a.niveau) >= ordreNiveau(b.niveau) ? a.niveau : b.niveau;
    var sur = pire === "reel" || pire === "geocode";
    return {
      color: couleurTroncon(b, pire),
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

  // Géométrie d'un tronçon : le tracé routier s'il a été obtenu, la ligne
  // directe sinon.
  function geomTroncon(points, trace, i) {
    var t = trace && trace.troncons && trace.troncons[i - 1];
    if (t && t.length > 1) return t;
    return [[points[i - 1].lat, points[i - 1].lon], [points[i].lat, points[i].lon]];
  }

  function longueurTroncon(points, trace, i) {
    var d = trace && trace.distances && trace.distances[i - 1];
    if (typeof d === "number" && d > 0) return d;
    return window.MapView.distanceMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }

  // La trace n'est pas une ligne mais une suite de segments continus. Elle
  // s'interrompt sur trois motifs, et n'en comble aucun :
  //   - une étape dont la position n'est qu'estimée : il n'y a rien à relier ;
  //   - un saut plus long qu'un trajet plausible entre deux boîtes ;
  //   - un changement de fichier de tournée : chaque fichier tient sa propre
  //     trace, et relier la dernière boîte de l'un à la première de l'autre
  //     dessinerait un trajet que personne ne fait.
  // Renvoie les indices des points de chaque segment, les isolés écartés.
  function segmentsTrace(points, trace) {
    var segments = [], courant = null, seuil = coupureMetres();
    points.forEach(function (p, i) {
      if (p.niveau === "estime") { courant = null; return; }
      if (courant && longueurTroncon(points, trace, i) > seuil) courant = null;
      if (courant && points[i - 1].fichier !== p.fichier) courant = null;
      if (!courant) { courant = []; segments.push(courant); }
      courant.push(i);
    });
    return segments.filter(function (s) { return s.length > 1; });
  }

  // Cap entre deux points, en degrés depuis le nord.
  function cap(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var dLon = (lon2 - lon1) * rad;
    var y = Math.sin(dLon) * Math.cos(lat2 * rad);
    var x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
            Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }

  // Sens de parcours : un chevron au milieu du tronçon, orienté par le cap
  // local. L'orienter sur les deux extrémités le ferait pointer à travers
  // champs dès que la route tourne.
  function poserFleche(v, geom, couleur) {
    var m = Math.max(1, Math.floor(geom.length / 2));
    var a = geom[m - 1], b = geom[m];
    if (!a || !b) return;
    var angle = cap(a[0], a[1], b[0], b[1]);
    L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
      icon: L.divIcon({
        className: "",
        html: '<div class="pc-fleche" style="transform:rotate(' + angle.toFixed(0) +
              'deg);border-bottom-color:' + couleur + '"></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
      }),
      interactive: false,
      zIndexOffset: 400
    }).addTo(v.calques.fleches);
  }

  function dessinerTrace(v, points, trace) {
    v.calques.trace.clearLayers();
    v.calques.fleches.clearLayers();
    segmentsTrace(points, trace).forEach(function (segment) {
      for (var k = 1; k < segment.length; k++) {
        var i = segment[k];
        var geom = geomTroncon(points, trace, i);
        var style = styleTroncon(points[i - 1], points[i]);
        L.polyline(geom, v.leger ? allegerStyle(style) : style).addTo(v.calques.trace);
        if (!v.leger && longueurTroncon(points, trace, i) >= FLECHE_MIN_M) {
          poserFleche(v, geom, style.color);
        }
      }
    });
  }

  // Seul réglage d'affichage qui reste : le sens de parcours. Il se lit au
  // zoom de travail et se coupe depuis les réglages, pour qui préfère la trace
  // nue.
  function flechesDemandees() {
    return S.getSettings().flechesSens !== false;
  }

  function appliquerZoom(v) {
    if (!v || !v.map) return;
    var z = v.map.getZoom();
    basculer(v, v.calques.fleches, !v.leger && flechesDemandees() && z >= ZOOM_FLECHES);
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

  // Sans argument, efface toutes les cartes ouvertes ; avec une instance qui
  // n'a pas encore de carte, il n'y a rien à effacer — surtout pas les autres.
  function effacer(instance) {
    if (instance && !instance.getMap()) return;
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
    if (!points.length) return Promise.resolve({ modele: modele, trace: null, points: points });

    v.map.addLayer(v.calques.trace);
    dessinerTrace(v, points, null);
    appliquerZoom(v);
    if (options.recentrer !== false) recentrer(instance);

    if (options.router === false || points.length < 2) {
      return Promise.resolve({ modele: modele, trace: null, points: points });
    }
    return router(points)
      .then(function (trace) {
        dessinerTrace(v, points, trace);
        return { modele: modele, trace: trace, points: points };
      })
      .catch(function () {
        // Routage indisponible : la trace reste en lignes directes, ce que le
        // résumé signale plutôt que de laisser croire à un tracé routier.
        return { modele: modele, trace: null, points: points };
      });
  }

  // points est facultatif : sans lui, la somme est celle de tous les tronçons
  // sous le seuil, comme avant l'empilement.
  function distanceRoutee(trace, points) {
    if (!trace || !trace.distances || !trace.distances.length) return 0;
    var seuil = coupureMetres();
    return trace.distances.reduce(function (a, b, k) {
      if (b > seuil) return a;
      // distances[k] relie points[k] à points[k + 1].
      if (points && points[k] && points[k + 1] && !memeFichier(points[k], points[k + 1])) return a;
      return a + b;
    }, 0);
  }

  // Construction de la trace hors de tout affichage : appelée au chargement
  // des données et avant un export. Le routage se met en cache sous une clé
  // qui porte l'empreinte des coordonnées ; tant qu'aucune position ne bouge,
  // les appels suivants ne coûtent rien et aucun jour ne refait le calcul.
  function preparer() {
    modele = construire();
    var points = pointsTrace();
    if (points.length < 2) return Promise.resolve(null);
    return router(points).catch(function () { return null; });
  }

  // ---------------------------------------------------------------------
  // Export GeoJSON
  // ---------------------------------------------------------------------
  function pousserCoord(coords, lat, lon) {
    var lonR = Number(lon.toFixed(6)), latR = Number(lat.toFixed(6));
    var dernier = coords[coords.length - 1];
    if (dernier && dernier[0] === lonR && dernier[1] === latR) return;
    coords.push([lonR, latR]);
  }

  // Une LineString par segment continu. Les interruptions ne sont pas comblées :
  // elles se lisent dans le fichier exactement comme sur la carte, et aucune
  // coordonnée inventée n'y entre — une étape seulement estimée en est exclue.
  // Dernier GeoJSON produit. La trace dessinée par Leaflet et ce fichier
  // sortent du même modèle et du même cache de routage : les régénérer
  // ensemble, c'est garantir que l'export dit exactement ce que la carte montre.
  var dernierGeoJSON = null;

  function geojson() {
    // Toujours reconstruit : un export décrit les données du moment, pas le
    // dernier affichage — sans quoi un import suivi d'un export livrerait la
    // tournée précédente. Seul le tracé routier est repris du cache, dont la
    // clé porte l'empreinte des coordonnées et se périme donc d'elle-même.
    modele = construire();
    var points = pointsTrace();
    var trace = lireCacheRoute(cleCache(points));

    var features = segmentsTrace(points, trace).map(function (segment, n) {
      var coords = [], longueur = 0;
      for (var k = 1; k < segment.length; k++) {
        var i = segment[k];
        geomTroncon(points, trace, i).forEach(function (c) { pousserCoord(coords, c[0], c[1]); });
        longueur += longueurTroncon(points, trace, i);
      }
      var depart = points[segment[0]].etapes[0];
      var arrivee = points[segment[segment.length - 1]].etapes[0];
      var premiere = points[segment[0]].etapes[0];
      var fichier = points[segment[0]].fichier;
      var idT = (premiere.adresses[0] && premiere.adresses[0].id_tournee) || S.getIdTournee();
      return {
        type: "Feature",
        properties: {
          segment: n + 1,
          // Un segment appartient à un seul fichier, par construction : la trace
          // se coupe au changement. L'export le dit, et donne la couleur sous
          // laquelle la carte l'a dessiné — les deux doivent se lire pareil.
          id_tournee: idT,
          couleur: fichier ? S.getTourneeColor(fichier) : undefined,
          etapes: segment.length,
          etape_depart: depart.rang,
          etape_arrivee: arrivee.rang,
          depart: S.communeLabel(depart.commune, depart.lieuDit) + " — " + depart.rue,
          arrivee: S.communeLabel(arrivee.commune, arrivee.lieuDit) + " — " + arrivee.rue,
          distance_m: Math.round(longueur),
          routee: !!(trace && trace.troncons && trace.troncons.length)
        },
        geometry: { type: "LineString", coordinates: coords }
      };
    });

    dernierGeoJSON = {
      type: "FeatureCollection",
      properties: {
        id_tournee: S.getIdTournee(),
        genere_le: new Date().toISOString(),
        // Les fichiers empilés et leur couleur, dans l'ordre de passage. Absent
        // hors empilement : il n'y a alors qu'une tournée, déjà nommée au-dessus.
        fichiers: S.multiActif()
          ? S.getFichiers().map(function (f) {
              return { id: f.id, adresses: f.count, couleur: S.getTourneeColor(f.id) };
            })
          : undefined,
        adresses: modele.rows.length,
        etapes: modele.etapes.length,
        segments: features.length,
        coupure_minutes: COUPURE_MINUTES,
        vitesse_moyenne_kmh: VITESSE_MOYENNE_KMH
      },
      features: features
    };
    return dernierGeoJSON;
  }

  // ---------------------------------------------------------------------
  // Construction complète, à la demande
  // ---------------------------------------------------------------------
  // Le geste déclenché depuis les réglages, dans l'ordre où il faut le faire :
  // donner une position aux adresses qui n'en ont pas, oublier la trace mise
  // en cache, la recalculer sur les positions du moment, puis régénérer le
  // GeoJSON. Chaque étape annonce où elle en est : un géocodage de quatre
  // cents adresses ne se fait pas en une seconde, et un écran muet pendant ce
  // temps-là passe pour une panne.
  function construireTrace(onProgress) {
    function etape(texte) { if (onProgress) onProgress(texte); }
    var bilan = { demandes: aGeocoder().length, geocodees: 0, geocodageEchoue: false,
                  routee: false, segments: 0, etapes: 0 };
    var chaine = Promise.resolve();

    if (bilan.demandes) {
      etape("Géocodage de " + bilan.demandes + " adresse(s)…");
      chaine = geocoderManquants(function (traites, total) {
        etape("Géocodage… " + traites + " / " + total);
      }).then(function (r) {
        bilan.geocodees = r.places;
      }).catch(function () {
        // Sans réseau, le géocodage échoue : la trace se refait quand même,
        // sur les positions déjà connues.
        bilan.geocodageEchoue = true;
      });
    }

    return chaine.then(function () {
      etape("Calcul de la trace…");
      viderCacheRoute();
      return preparer();
    }).then(function (trace) {
      bilan.routee = !!trace;
      etape("Mise à jour du GeoJSON…");
      var geo = geojson();
      bilan.segments = geo.features.length;
      bilan.etapes = geo.properties.etapes;
      return bilan;
    });
  }

  // store.js arbitre entre un relevé de terrain et un géocodage, mais la
  // finesse d'un géocodage n'est connue que d'ici. On la lui met à disposition
  // dès le chargement du module, avant tout affichage.
  chargerPrecisions();
  S.setResolveurGeocodageApproche(geocodageApproche);

  return {
    construire: construire,
    preparer: preparer,
    geojson: geojson,
    geojsonCourant: function () { return dernierGeoJSON; },
    construireTrace: construireTrace,
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
