/* ============================================================================
   ui.js — écrans : Recherche/Liste, Fiche (consultation/édition), Carte,
   Administration (import/export/réglages). Un seul état de "vue active" à la
   fois, rendu par ré-écriture du innerHTML des conteneurs + délégation
   d'événements (pas de framework).
   ========================================================================== */
window.UI = (function () {
  "use strict";

  var S = window.Store;
  var G = window.Geocode;
  var M = window.MapView.create();       // carte des Données
  var suiviMap = window.MapView.create(); // carte de la Course (instance indépendante)

  var els = {}; // rempli dans init()
  var currentView = "search";
  var currentFicheId = null;
  var ficheEditing = false;
  var editDraft = null;       // copie de travail pendant l'édition d'une fiche
  var geocodeResults = [];
  var lastToastTimer = null;

  // ---------------------------------------------------------------------
  // Aides génériques
  // ---------------------------------------------------------------------
  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Un toast peut porter une action d'annulation : sur le terrain, pouvoir
  // revenir en arrière après coup vaut mieux qu'une confirmation avant chaque geste.
  var pendingUndo = null;

  function toast(msg, kind, undoFn) {
    clearTimeout(lastToastTimer);
    pendingUndo = undoFn || null;
    if (undoFn) {
      els.toast.innerHTML = '<span>' + escapeHtml(msg) + '</span>' +
        '<button class="toast-undo" data-action="toast-undo">Annuler</button>';
    } else {
      els.toast.textContent = msg;
    }
    els.toast.className = "toast show " + (undoFn ? "has-action " : "") + (kind || "");
    lastToastTimer = setTimeout(function () {
      els.toast.className = "toast";
      pendingUndo = null;
    }, undoFn ? 6000 : 3200);
  }

  function hideToast() {
    clearTimeout(lastToastTimer);
    els.toast.className = "toast";
    pendingUndo = null;
  }

  function runUndo() {
    if (!pendingUndo) return;
    var fn = pendingUndo;
    hideToast();
    fn();
  }

  function confirmAction(msg) { return window.confirm(msg); }

  // Normalise caractère par caractère en gardant la correspondance vers le
  // texte d'origine, pour pouvoir surligner malgré accents et ponctuation.
  function normalizeWithMap(text) {
    var norm = "", map = [];
    for (var i = 0; i < text.length; i++) {
      var c = S.normalize(text[i]);
      if (!c) c = " "; // ponctuation et espaces : conservés comme séparateurs
      for (var k = 0; k < c.length; k++) { norm += c[k]; map.push(i); }
    }
    return { norm: norm, map: map };
  }

  // Surligne chaque terme de la recherche, quelle que soit la façon dont il a
  // été saisi : "republique" met en évidence "République".
  function highlight(text, query) {
    text = text || "";
    var tokens = S.tokenize(query).filter(function (t) { return t.length > 1; });
    if (!tokens.length) return escapeHtml(text);

    var m = normalizeWithMap(text);
    var ranges = [];
    tokens.forEach(function (t) {
      var from = 0, idx;
      while ((idx = m.norm.indexOf(t, from)) !== -1) {
        ranges.push([m.map[idx], m.map[idx + t.length - 1] + 1]);
        from = idx + t.length;
      }
    });
    if (!ranges.length) return escapeHtml(text);

    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    ranges.slice(1).forEach(function (r) {
      var last = merged[merged.length - 1];
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    });

    var out = "", pos = 0;
    merged.forEach(function (r) {
      out += escapeHtml(text.slice(pos, r[0])) + "<mark>" + escapeHtml(text.slice(r[0], r[1])) + "</mark>";
      pos = r[1];
    });
    return out + escapeHtml(text.slice(pos));
  }

  // ---------------------------------------------------------------------
  // Navigation — 3 pages principales (Données / Préparation / Course),
  // et à l'intérieur des Données : Recherche / Carte / Fiche.
  // ---------------------------------------------------------------------
  var currentMainPage = "db";

  function showMainPage(name) {
    currentMainPage = name;
    ["db", "prep", "suivi"].forEach(function (p) {
      document.getElementById("page-" + p).classList.toggle("active", p === name);
    });
    els.mainTabBar.querySelectorAll("[data-mainpage]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-mainpage") === name);
    });
    if (name === "prep") renderPrep();
    if (name === "suivi") {
      suiviMap.ensureMap("suiviMapContainer");
      if (suiviTab === "carte") {
        suiviMap.invalidateSize();
        dessinerTraceSuivi();
      }
      renderSuivi();
    }
    majSuiviWatch();
    window.scrollTo(0, 0);
  }

  function showView(name) {
    currentView = name;
    ["search", "map", "fiche"].forEach(function (v) {
      els["view-" + v].classList.toggle("active", v === name);
    });
    els.fab.style.display = (name === "search") ? "flex" : "none";
    els.dbSubNav.querySelectorAll("[data-dbview]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-dbview") === name);
    });
    els.dbSubNav.style.display = (name === "fiche") ? "none" : "flex";
    els.mainTabBar.style.display = (name === "fiche") ? "none" : "flex";
    if (name === "map") {
      M.ensureMap("mapContainer");
      M.invalidateSize();
      renderMapView();
    }
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------
  // Onglet Carte — la trace de la tournée, et rien d'autre. Aucun marqueur n'y
  // est posé : ni adresse, ni étape, ni pastille d'information. Ce qu'on vient
  // y chercher, c'est la forme du parcours ; le détail d'une adresse s'ouvre
  // depuis la case de casier, sous la carte.
  // ---------------------------------------------------------------------
  var parcoursDeplie = false;    // résumé replié par défaut
  var parcoursDernier = null;

  function renderMapView() {
    renderParcoursPanel(null, "Reconstruction du parcours…");
    renderCasierBrowser();
    Parcours.afficher(M, {}).then(function (res) {
      parcoursDernier = res;
      renderParcoursPanel(res, null);
      // La trace vient d'être (re)dessinée : elle a repris la main sur le
      // cadrage. On redonne la vue à la case de casier consultée.
      montrerCasierSurCarte();
      casierFocusId = null;
    });
  }

  // ---------------------------------------------------------------------
  // Données → Carte : parcours des cases du casier, dans l'ordre de la grille
  //
  // Contrôle de cohérence, pas outil de navigation : on fait défiler les cases
  // C1L1 → C1L2 → … → C5L5 telles que les données les décrivent, et on vérifie
  // que les adresses s'y présentent dans l'ordre où elles ont été préparées.
  // Cette vue ne consulte jamais la carte — c'est la carte qui la suit.
  // ---------------------------------------------------------------------
  var casierIndex = 0;
  var casierFocusId = null;   // adresse à cadrer au prochain affichage, puis oubliée
  var casierSwipeStartX = null;
  var casierSwipeStartY = null;

  function casierEtapes() { return S.etapesCasier(); }

  function clampCasierIndex(etapes) {
    if (!etapes.length) { casierIndex = 0; return; }
    if (casierIndex < 0) casierIndex = 0;
    if (casierIndex > etapes.length - 1) casierIndex = etapes.length - 1;
  }

  // Une ligne d'adresse, telle qu'elle sort du casier. La rue n'est répétée
  // qu'au changement de rue : une rue qui réapparaît deux fois dans la même
  // case saute alors aux yeux, ce qui est précisément ce qu'on cherche à voir.
  function casierLigneHTML(row, precedent) {
    var memeRue = precedent &&
      S.normalize(precedent.rue) === S.normalize(row.rue) &&
      S.normalize(precedent.commune) === S.normalize(row.commune);
    var noms = S.namesOf(row).join(" / ") || "(sans nom)";
    var numero = (row.numero || "").trim();
    return (memeRue ? "" :
        '<div class="casier-rue">' +
          '<span class="commune-dot" style="background:' + S.getCommuneColor(row.commune) + ';"></span>' +
          escapeHtml(row.rue || "(rue non renseignée)") +
          '<span class="casier-rue-commune">' + escapeHtml(S.communeLabelOf(row)) + '</span>' +
        '</div>') +
      '<button class="casier-addr" data-action="open-fiche" data-id="' + escapeHtml(row.id) + '">' +
        '<span class="casier-num">' + (numero ? escapeHtml(numero) : "—") + '</span>' +
        '<span class="casier-noms">' + escapeHtml(noms) + '</span>' +
        (S.hasPosition(row) ? "" : '<span class="casier-flag" title="Adresse sans position GPS">⚠</span>') +
      '</button>';
  }

  function renderCasierBrowser() {
    if (!els.casierBrowser) return;
    var etapes = casierEtapes();
    clampCasierIndex(etapes);

    if (!etapes.length) {
      els.casierBrowser.innerHTML = "";
      return;
    }

    var e = etapes[casierIndex];
    var rues = e.rows.map(function (r) { return S.normalize(r.rue) + "|" + S.normalize(r.commune); })
      .filter(function (v, i, t) { return t.indexOf(v) === i; }).length;
    var sansGPS = e.rows.filter(function (r) { return !S.hasPosition(r); }).length;

    var lignes = "";
    e.rows.forEach(function (r, i) { lignes += casierLigneHTML(r, i ? e.rows[i - 1] : null); });

    els.casierBrowser.innerHTML =
      '<div class="casier-nav">' +
        '<button class="tournee-nav-btn" data-action="casier-prev" ' + (casierIndex === 0 ? "disabled" : "") + ' aria-label="Case précédente">‹</button>' +
        '<div class="tournee-index">' + escapeHtml(e.cle === "hors" ? e.label : "Casier " + e.label) +
          ' · ' + (casierIndex + 1) + ' / ' + etapes.length + '</div>' +
        '<button class="tournee-nav-btn" data-action="casier-next" ' + (casierIndex === etapes.length - 1 ? "disabled" : "") + ' aria-label="Case suivante">›</button>' +
      '</div>' +
      '<div class="casier-card" id="casierCardSwipe">' +
        '<div class="casier-head">' +
          '<div class="casier-label">' + escapeHtml(e.label) + '</div>' +
          '<div class="casier-meta">' + e.rows.length + ' adresse(s) · ' + rues + ' rue(s)' +
            (sansGPS ? ' · <span class="casier-flag">⚠ ' + sansGPS + ' sans position</span>' : "") +
          '</div>' +
        '</div>' +
        '<div class="casier-liste">' + lignes + '</div>' +
      '</div>';

    bindCasierSwipe();
    montrerCasierSurCarte();
  }

  // Projection de la case courante sur la carte : un cadrage, plus un point.
  // La carte ne porte que la trace — elle se déplace sur la case consultée
  // plutôt que d'y poser des pastilles. Un aller simple : la carte reçoit son
  // cadrage, elle ne renvoie rien vers les données.
  function montrerCasierSurCarte() {
    if (currentView !== "map") return;
    var etapes = casierEtapes();
    if (!etapes.length) return;
    clampCasierIndex(etapes);
    var points = etapes[casierIndex].rows.filter(S.hasPosition).map(function (r) {
      var pos = S.positionUtile(r);
      return { id: r.id, lat: pos.lat, lon: pos.lon };
    });
    if (!points.length) return;
    var cible = casierFocusId && points.filter(function (p) { return p.id === casierFocusId; })[0];
    if (cible) M.centerOn(cible.lat, cible.lon, 17);
    else M.fitPoints(points, 16);
  }

  function bindCasierSwipe() {
    var el = document.getElementById("casierCardSwipe");
    if (!el) return;
    el.addEventListener("touchstart", function (ev) {
      var t = ev.changedTouches[0];
      casierSwipeStartX = t.clientX;
      casierSwipeStartY = t.clientY;
    }, { passive: true });
    el.addEventListener("touchend", function (ev) {
      if (casierSwipeStartX === null) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - casierSwipeStartX;
      var dy = t.clientY - casierSwipeStartY;
      casierSwipeStartX = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      casierNav(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function casierNav(delta) {
    casierIndex += delta;
    casierFocusId = null;
    renderCasierBrowser();
  }

  function fmtKm(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
  }

  function renderParcoursPanel(res, message) {
    if (message) {
      els.parcoursPanel.innerHTML = '<div class="pc-panel"><div class="muted small">' + escapeHtml(message) + '</div></div>';
      return;
    }
    if (!res || !res.modele.etapes.length) {
      els.parcoursPanel.innerHTML = '<div class="pc-panel"><div class="muted small">' +
        'Aucune adresse dans la base : importe un CSV depuis les réglages (⚙️).</div></div>';
      return;
    }

    var r = Parcours.resume(res.modele);
    var p = r.positions;
    var sansPosition = p.sans;

    // La distance n'est annoncée que si la trace la porte : routière si le
    // calcul a abouti, à vol d'oiseau sinon, et masquée si trop d'estimations.
    var distance = "";
    var metres = Parcours.distanceRoutee(res.trace, res.points);
    if (metres > 0) distance = fmtKm(metres) + " par la route";
    else if (r.distanceFiable) distance = "~" + fmtKm(r.distanceVolOiseau) + " à vol d'oiseau";

    // Replié, le résumé tient sur une ligne et laisse la carte respirer ;
    // le détail reste à un appui.
    els.parcoursPanel.innerHTML =
      '<div class="pc-panel">' +
        '<div class="pc-entete">' +
          '<button class="pc-toggle" data-action="parcours-basculer">' +
            '<span class="pc-chevron">' + (parcoursDeplie ? "▾" : "▸") + '</span>' +
            '<strong>' + r.etapes + '</strong> étape(s)' +
            (distance ? ' · <strong>' + escapeHtml(distance) + '</strong>' : "") +
          '</button>' +
          '<button class="pc-btn" data-action="parcours-recentrer" aria-label="Recentrer sur la tournée">🎯</button>' +
        '</div>' +
        (parcoursDeplie
          ? '<div class="pc-detail">' +
              '<div class="pc-stats">' +
                '<span><strong>' + r.communes + '</strong> commune(s)</span>' +
                '<span><strong>' + r.rues + '</strong> rue(s)</span>' +
                '<span><strong>' + r.adresses + '</strong> adresse(s)</span>' +
              '</div>' +
              (r.depart
                ? '<div class="pc-bornes">' +
                    '<span class="pc-borne-txt"><b>Départ</b> ' + escapeHtml(r.depart.rue) + ' · ' + escapeHtml(r.depart.commune) + '</span>' +
                    '<span class="pc-borne-txt"><b>Arrivée</b> ' + escapeHtml(r.arrivee.rue) + ' · ' + escapeHtml(r.arrivee.commune) + '</span>' +
                  '</div>'
                : "") +
              // Empilement : la couleur du trait dit la tournée, c'est donc
              // elle que la légende doit nommer. La qualité des positions garde
              // son compte, mais sans pastille — elle se lit dans le trait
              // (plein, fin, pointillé), plus dans la couleur.
              (r.fichiers && r.fichiers.length
                ? '<div class="pc-legende">' +
                    r.fichiers.map(function (f) {
                      return '<span class="pc-leg"><i style="background:' + f.couleur + '"></i>' +
                        escapeHtml(f.id) + ' · ' + f.etapes + ' étape(s)</span>';
                    }).join("") +
                  '</div>' +
                  '<div class="pc-legende pc-legende-qualite">' +
                    '<span class="pc-leg-txt">' + p.reel + ' GPS relevé(s) · ' + p.geocode +
                    ' géocodée(s) · ' + p.approx + ' approchée(s)' +
                    (r.etapesEstimees ? ' · ' + r.etapesEstimees + ' étape(s) estimée(s)' : "") +
                    '</span>' +
                  '</div>'
                : '<div class="pc-legende">' +
                    legendeItem("reel", p.reel + " GPS relevé(s)") +
                    legendeItem("geocode", p.geocode + " géocodée(s)") +
                    legendeItem("approx", p.approx + " approchée(s)") +
                    (r.etapesEstimees ? legendeItem("estime", r.etapesEstimees + " étape(s) estimée(s)") : "") +
                  '</div>') +
            '</div>'
          : "") +
        (parcoursDeplie
          ? '<div class="pc-actions">' +
              '<button class="pc-btn" data-action="parcours-construire">🧭 Construire la trace</button>' +
              '<button class="pc-btn" data-action="parcours-export">⬇ Exporter la trace (GeoJSON)</button>' +
            '</div>'
          : "") +
        (sansPosition
          ? '<div class="pc-alerte">' + sansPosition + ' adresse(s) sans position. ' +
              '<button class="pc-btn" data-action="parcours-geocoder">Géocoder</button></div>'
          : "") +
      '</div>';
  }

  function legendeItem(niveau, texte) {
    return '<span class="pc-leg"><i style="background:' + Parcours.COULEURS[niveau] + '"></i>' + escapeHtml(texte) + '</span>';
  }

  function geocoderParcours() {
    var n = Parcours.aGeocoder().length;
    if (!n) return;
    if (!confirmAction("Géocoder " + n + " adresse(s) sans position ? Les coordonnées trouvées seront enregistrées dans la base (pense à exporter avant si besoin).")) return;
    renderParcoursPanel(null, "Géocodage en cours…");
    Parcours.geocoderManquants(function (traites, total) {
      renderParcoursPanel(null, "Géocodage… " + traites + " / " + total);
    }).then(function (bilan) {
      toast(bilan.places + " adresse(s) positionnée(s) sur " + bilan.demandes + ".", "ok");
      renderSearch();
      renderMapView();
      Parcours.effacer(suiviMap); // la trace de la Course sera refaite à la prochaine visite
    }).catch(function () {
      toast("Géocodage indisponible (pas de réseau ou service hors service).", "err");
      renderMapView();
    });
  }

  // La trace vit dans un cache tant que les positions ne bougent pas : elle se
  // construit au chargement des données puis se tait, sans repasser par le
  // service de routage à chaque ouverture de la carte. « Construire la trace »
  // est la reprise en main : géocoder ce qui n'a pas de position, jeter le
  // cache, refaire le calcul routier, régénérer le GeoJSON.
  //
  // Le compte rendu passe par un rappel plutôt que par un toast imposé : le
  // même enchaînement sert au panneau de la carte et aux réglages, et chacun
  // affiche l'avancement là où l'utilisateur a les yeux.
  function construireTrace(annoncer) {
    annoncer("Construction de la trace…");
    return Parcours.construireTrace(annoncer).then(function (bilan) {
      Parcours.effacer(suiviMap); // la Course refera la sienne à sa prochaine visite
      if (currentView === "map") renderMapView();
      var dit = [];
      if (bilan.demandes) {
        dit.push(bilan.geocodageEchoue
          ? "géocodage indisponible, " + bilan.demandes + " adresse(s) sans position"
          : bilan.geocodees + " adresse(s) géocodée(s) sur " + bilan.demandes);
      }
      dit.push(bilan.segments + " segment(s) · " + bilan.etapes + " étape(s)");
      if (!bilan.routee) dit.push("routage indisponible : lignes directes");
      return "Trace construite — " + dit.join(" · ") + ".";
    });
  }

  function construireTraceDepuisCarte() {
    construireTrace(function (texte) { renderParcoursPanel(null, texte); })
      .then(function (texte) { toast(texte, "ok"); })
      .catch(function () {
        toast("Construction de la trace impossible.", "err");
        renderMapView();
      });
  }

  function construireTraceDepuisAdmin() {
    construireTrace(function (texte) { showTraceStatus("", texte); })
      .then(function (texte) { showTraceStatus("ok", texte); })
      .catch(function () { showTraceStatus("err", "Construction de la trace impossible."); });
  }

  // L'export attend que la trace routière soit disponible : sans cela, un
  // export lancé juste après un import livrerait des lignes droites d'étape à
  // étape là où le cache aurait donné le tracé des routes. Si le routage est
  // hors service, on exporte quand même — en lignes directes, ce que la
  // propriété « routee » du fichier dit sans ambiguïté.
  function exporterTrace() {
    toast("Préparation de la trace…");
    Parcours.preparer().then(function () {
      var geo = Parcours.geojson();
      if (!geo.features.length) {
        toast("Aucun segment traçable : les adresses n'ont pas encore de position.", "warn");
        return;
      }
      telecharger(
        JSON.stringify(geo, null, 2),
        "application/geo+json",
        S.getIdTournee() + "_trace_" + S.todayISO() + ".geojson");
      toast(geo.features.length + " segment(s) exporté(s).", "ok");
    });
  }

  function openAdmin() { els.adminOverlay.classList.add("open"); renderAdmin(); }
  function closeAdmin() { els.adminOverlay.classList.remove("open"); }

  // ---------------------------------------------------------------------
  // Ecran Recherche / Liste
  // ---------------------------------------------------------------------
  function badgeFor(row) {
    var out = "";
    out += S.hasCasier(row)
      ? '<span class="tag tag-ok">' + escapeHtml(S.casierLabelEtape(row)) + '</span>'
      : '<span class="tag tag-warn">Hors casier</span>';
    out += S.hasPosition(row)
      ? '<span class="tag tag-ok">📍 GPS</span>'
      : '<span class="tag tag-warn">⚠ GPS manquant</span>';
    if (row.geocode_statut === "geocode") out += '<span class="tag tag-info">à vérifier</span>';
    if (S.hasReleve(row) && row.geocode_statut !== "verifie") out += '<span class="tag tag-info">relevé terrain</span>';
    if (S.isStopPub(row)) out += '<span class="tag tag-stoppub">🚫 Stop Pub</span>';
    return out;
  }

  function cardHTML(row, query) {
    var names = S.namesOf(row);
    var title = names.length ? names.map(function (n) { return highlight(n, query); }).join(" / ") : "(sans nom)";
    var addr = [row.numero, row.rue].filter(Boolean).join(" ");
    var cpCommune = [row.code_postal, S.communeLabelOf(row)].filter(Boolean).join(" ");
    var communeColor = S.getCommuneColor(row.commune);
    return (
      '<div class="card" data-id="' + row.id + '" data-action="open-fiche" style="border-left:5px solid ' + communeColor + ';">' +
        '<div class="card-title">' + title + '</div>' +
        (addr ? '<div class="card-line">' + highlight(addr, query) + '</div>' : "") +
        (cpCommune ? '<div class="card-line muted">' + highlight(cpCommune, query) + '</div>' : "") +
        '<div class="tag-row">' + badgeFor(row) + '</div>' +
      '</div>'
    );
  }

  function renderSearch() {
    // L'identifiant affiché dans l'en-tête est déduit des données chargées : il
    // se rafraîchit donc avec la liste, et non depuis un champ de saisie qui
    // n'existe plus. Un import qui change de tournée change l'en-tête avec lui.
    refreshHeader();
    var q = els.searchBox.value;
    var results = S.search(q);
    els.resultCount.textContent = results.length + " résultat(s) sur " + S.getRows().length;
    els.cardList.innerHTML = results.map(function (r) { return cardHTML(r, q); }).join("");
    els.emptyState.style.display = S.getRows().length === 0 ? "block" : "none";
  }

  // ---------------------------------------------------------------------
  // Autocomplétion — assez de contexte sur chaque ligne pour reconnaître
  // la bonne adresse sans avoir à ouvrir la fiche.
  // ---------------------------------------------------------------------
  function suggestItemHTML(row, query, cible) {
    var adresse = [row.numero, row.rue].filter(Boolean).join(" ") || "(adresse non renseignée)";
    var noms = S.namesOf(row).join(" / ");
    var contexte = [row.code_postal, S.communeLabelOf(row)].filter(Boolean).join(" ");
    return '<button type="button" class="suggest-item" data-action="suggest-pick" data-id="' + row.id + '" data-cible="' + cible + '">' +
      '<span class="suggest-main">' + highlight(adresse, query) +
        (noms ? ' <span class="suggest-sep">—</span> ' + highlight(noms, query) : "") + '</span>' +
      (contexte ? '<span class="suggest-context">' + highlight(contexte, query) + '</span>' : "") +
    '</button>';
  }

  function renderSuggest(cible) {
    var input = cible === "prep" ? els.prepSearchBox : els.searchBox;
    var box = cible === "prep" ? els.prepSuggest : els.searchSuggest;
    var q = input.value;
    // Rien à proposer sans saisie ; et sur une correspondance unique, déjà
    // visible dans la liste en dessous, la proposer n'apporte rien.
    var scored = S.normalize(q) ? S.searchScored(q) : [];
    if (scored.length < 2) {
      box.innerHTML = "";
      box.classList.remove("open");
      return;
    }
    box.innerHTML = scored.slice(0, 8).map(function (x) { return suggestItemHTML(x.row, q, cible); }).join("");
    box.classList.add("open");
  }

  function closeSuggest(cible) {
    var box = cible === "prep" ? els.prepSuggest : els.searchSuggest;
    box.innerHTML = "";
    box.classList.remove("open");
  }

  function pickSuggestion(id, cible) {
    closeSuggest(cible);
    if (cible === "prep") {
      showMainPage("prep");
      // Sur la préparation, on cible l'adresse dans la liste : le livreur
      // enchaîne directement sur les compteurs lettres/colis. La barre se vide
      // pour que la recherche suivante parte d'un champ propre — sans quoi il
      // faudrait effacer la précédente à la main avant chaque adresse.
      var row = S.findRow(id);
      if (!row) return;
      prepCibleId = id;
      els.prepSearchBox.value = "";
      renderPrep();
      var carte = els.prepList.querySelector('.prep-card[data-id="' + id + '"]');
      if (carte) carte.scrollIntoView({ block: "center" });
    } else {
      openFiche(id);
    }
  }

  // ---------------------------------------------------------------------
  // Chips (noms / destinataires)
  // ---------------------------------------------------------------------
  function chipsStaticHTML(names) {
    if (!names.length) return '<span class="muted">(aucun nom)</span>';
    return names.map(function (n) { return '<span class="chip">' + escapeHtml(n) + '</span>'; }).join("");
  }

  function chipsEditableHTML(names) {
    var chips = names.map(function (n, i) {
      return '<span class="chip chip-editable">' + escapeHtml(n) +
        '<button type="button" class="chip-remove" data-action="remove-chip" data-idx="' + i + '" aria-label="Supprimer">×</button></span>';
    }).join("");
    return (
      '<div class="chips-wrap">' + chips + '</div>' +
      '<div class="chip-add-row">' +
        '<input type="text" id="chipInput" placeholder="Ajouter un nom…" />' +
        '<button type="button" class="btn-add-chip" data-action="add-chip">+ Ajouter</button>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------
  // Fiche — consultation
  // ---------------------------------------------------------------------
  function positionBadge(row) {
    var info = S.positionInfo(row);
    if (!info.value) return '<span class="tag">Position inconnue</span>';
    var label = S.POSITION_LABELS[info.value];
    return '<span class="tag tag-info">' + escapeHtml(label) + (info.source === "manuel" ? " (manuel)" : " (auto)") + '</span>';
  }

  function renderFicheView(row) {
    var names = S.namesOf(row);
    var addr = [row.numero, row.rue].filter(Boolean).join(" ");
    els.viewFiche.innerHTML =
      '<div class="fiche-header">' +
        '<button class="btn-back" data-action="back-to-search">‹ Retour</button>' +
        '<button class="btn-edit" data-action="edit-fiche">✏️ Modifier</button>' +
      '</div>' +
      '<div class="fiche-names">' + chipsStaticHTML(names) + '</div>' +
      '<div class="quick-actions fiche-add-name">' +
        '<button data-action="ajouter-destinataire">➕ Ajouter un destinataire ici</button>' +
      '</div>' +

      '<section class="fiche-section">' +
        '<h3>📬 Boîte</h3>' +
        '<div class="kv"><span>Adresse</span><strong>' + (escapeHtml(addr) || '<span class="muted">non renseignée</span>') + '</strong></div>' +
        '<div class="kv"><span>Code postal / Commune</span><strong>' +
          (row.commune ? '<span class="commune-dot" style="background:' + S.getCommuneColor(row.commune) + ';"></span>' : "") +
          (escapeHtml([row.code_postal, S.communeLabelOf(row)].filter(Boolean).join(" · ")) || '<span class="muted">non renseigné</span>') + '</strong></div>' +
        '<div class="kv"><span>GPS</span><strong>' +
          (S.hasGPS(row) ? escapeHtml(Number(row.latitude).toFixed(5) + ", " + Number(row.longitude).toFixed(5)) : '<span class="muted">manquant</span>') +
        '</strong></div>' +
        releveKvHTML(row) +
        '<div class="quick-actions">' +
          '<button data-action="voir-carte" ' + (S.hasPosition(row) ? "" : "disabled") + '>📍 Voir sur carte</button>' +
          '<button data-action="ma-position">🎯 Ma position</button>' +
          '<button data-action="itineraire" ' + (S.hasPosition(row) ? "" : "disabled") + '>🧭 Itinéraire</button>' +
        '</div>' +
      '</section>' +

      '<section class="fiche-section">' +
        '<h3>🗂️ Tri de tournée</h3>' +
        '<div class="kv"><span>Colonne</span><strong>' + (escapeHtml(row.casier_c) || "—") + '</strong></div>' +
        '<div class="kv"><span>Ligne</span><strong>' + (escapeHtml(row.casier_l) || "—") + '</strong></div>' +
        (S.getFichiers().length > 1
          ? '<div class="kv"><span>Tournée</span><strong>' + escapeHtml(row.id_tournee || "—") + '</strong></div>'
          : "") +
        '<div class="kv"><span>Casier</span><strong>' + escapeHtml(S.casierLabelEtape(row)) + '</strong></div>' +
        '<div class="kv"><span>Position dans la tournée</span>' + positionBadge(row) + '</div>' +
      '</section>' +

      '<section class="fiche-section">' +
        '<h3>📝 Observations</h3>' +
        '<div class="notes-view">' + (escapeHtml(row.notes).replace(/\n/g, "<br>") || '<span class="muted">Aucune note.</span>') + '</div>' +
        '<div class="kv"><span>Stop Pub</span><strong>' + (S.isStopPub(row) ? '<span class="tag tag-stoppub">🚫 Oui, ne pas distribuer de publicité</span>' : '<span class="muted">Non</span>') + '</strong></div>' +
      '</section>' +

      '<div class="fiche-danger">' +
        '<button class="danger" data-action="delete-fiche">🗑 Supprimer cette adresse</button>' +
      '</div>';
  }

  // ---------------------------------------------------------------------
  // Fiche — édition
  // ---------------------------------------------------------------------
  function renderFicheEdit(row) {
    var names = S.namesOf(row);
    var posValue = row.position_manuelle || "";
    els.viewFiche.innerHTML =
      '<div class="fiche-header">' +
        '<button class="btn-back" data-action="cancel-edit">‹ Annuler</button>' +
        '<button class="btn-save" data-action="save-fiche">✓ Enregistrer</button>' +
      '</div>' +

      '<section class="fiche-section">' +
        '<h3>📬 Boîte</h3>' +
        '<div class="fieldset-title">Noms / destinataires</div>' +
        chipsEditableHTML(names) +

        // Saisie en cascade : la commune restreint les rues, la rue révèle les
        // numéros déjà connus. Le livreur retape rarement ce que la base sait déjà.
        '<div class="field search-wrap">' +
          '<label>Commune</label>' +
          '<input type="text" data-field="commune" data-suggest="commune" autocomplete="off" value="' + escapeHtml(row.commune) + '">' +
          '<div class="suggest" id="suggest-commune"></div>' +
        '</div>' +
        '<div class="field search-wrap">' +
          '<label>Rue / lieu-dit</label>' +
          '<input type="text" data-field="rue" data-suggest="rue" autocomplete="off" value="' + escapeHtml(row.rue) + '">' +
          '<div class="suggest" id="suggest-rue"></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field search-wrap">' +
            '<label>N°</label>' +
            '<input type="text" data-field="numero" data-suggest="numero" autocomplete="off" value="' + escapeHtml(row.numero) + '">' +
            '<div class="suggest" id="suggest-numero"></div>' +
          '</div>' +
          '<div class="field"><label>Code postal</label><input type="text" inputmode="numeric" maxlength="5" data-field="code_postal" value="' + escapeHtml(row.code_postal) + '"></div>' +
        '</div>' +
        '<div id="dupNotice"></div>' +

        '<div class="fieldset-title">GPS</div>' +
        '<div class="grid2">' +
          '<div class="field"><label>Latitude</label><input type="text" data-field="latitude" value="' + escapeHtml(row.latitude) + '"></div>' +
          '<div class="field"><label>Longitude</label><input type="text" data-field="longitude" value="' + escapeHtml(row.longitude) + '"></div>' +
        '</div>' +
        '<div class="quick-actions">' +
          '<button type="button" data-action="ma-position">🎯 Utiliser ma position</button>' +
          '<button type="button" data-action="geocoder" ' + (S.getSettings().geocodageActif ? "" : "disabled") + '>🔎 Géocoder l\'adresse</button>' +
        '</div>' +
        '<div id="geocodeResults"></div>' +
      '</section>' +

      '<section class="fiche-section">' +
        '<h3>🗂️ Tri de tournée</h3>' +
        // La tournée se choisit avant la case : deux fichiers peuvent porter la
        // même C1L3, et rien d'autre ne dirait auquel des deux l'adresse revient.
        ficheTourneeHTML(row) +
        '<div class="grid2">' +
          '<div class="field"><label>Colonne (1-5)</label><input type="number" min="1" max="5" data-field="casier_c" value="' + escapeHtml(row.casier_c) + '"></div>' +
          '<div class="field"><label>Ligne (1-4)</label><input type="number" min="1" max="4" data-field="casier_l" value="' + escapeHtml(row.casier_l) + '"></div>' +
        '</div>' +
        '<div class="field"><label>Position dans la tournée</label>' +
          '<select data-field="position_manuelle">' +
            '<option value=""' + (posValue === "" ? " selected" : "") + '>Automatique</option>' +
            '<option value="debut"' + (posValue === "debut" ? " selected" : "") + '>Début de tournée</option>' +
            '<option value="milieu"' + (posValue === "milieu" ? " selected" : "") + '>Milieu de tournée</option>' +
            '<option value="fin"' + (posValue === "fin" ? " selected" : "") + '>Fin de tournée</option>' +
          '</select>' +
        '</div>' +
        '<details class="advanced">' +
          '<summary>Avancé (zone, ordre de dépose)</summary>' +
          '<div class="grid2">' +
            '<div class="field"><label>Lieu-dit / secteur</label><input type="text" data-field="lieu_dit" value="' + escapeHtml(row.lieu_dit) + '"></div>' +
            '<div class="field"><label>Type d\'objet</label>' +
              '<select data-field="type_objet">' +
                '<option value=""' + (!row.type_objet ? " selected" : "") + '>—</option>' +
                '<option value="lettre"' + (row.type_objet === "lettre" ? " selected" : "") + '>Lettre</option>' +
                '<option value="colis"' + (row.type_objet === "colis" ? " selected" : "") + '>Colis</option>' +
                '<option value="presse"' + (row.type_objet === "presse" ? " selected" : "") + '>Presse</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="grid2">' +
            '<div class="field"><label>Ordre de zone (indicatif)</label><input type="number" data-field="ordre_zone" value="' + escapeHtml(row.ordre_zone) + '"></div>' +
            '<div class="field"><label>Ordre dans la rue</label><input type="number" data-field="ordre_rue" value="' + escapeHtml(row.ordre_rue) + '"></div>' +
          '</div>' +
        '</details>' +
      '</section>' +

      '<section class="fiche-section">' +
        '<h3>📝 Observations</h3>' +
        '<textarea data-field="notes" rows="4" placeholder="Consignes, accès, particularités…">' + escapeHtml(row.notes) + '</textarea>' +
        '<label class="switch-row stoppub-row">' +
          '<input type="checkbox" data-field-bool="stoppub" ' + (S.isStopPub(row) ? "checked" : "") + '>' +
          '🚫 Stop Pub — cette adresse n\'accepte pas la publicité' +
        '</label>' +
      '</section>';

    renderDupNotice();
  }

  // ---------------------------------------------------------------------
  // Saisie assistée d'adresse — commune, rue puis numéro, alimentés par ce que
  // la tournée contient déjà. Les mises à jour sont chirurgicales : re-rendre
  // le formulaire entier ferait perdre le focus à chaque frappe.
  // ---------------------------------------------------------------------
  function champValeur(nom) {
    var el = els.viewFiche.querySelector('[data-field="' + nom + '"]');
    return el ? el.value : "";
  }

  function fieldSuggestHTML(kind, valeurs) {
    return valeurs.map(function (v) {
      return '<button type="button" class="suggest-item" data-action="field-pick" data-kind="' + kind + '" data-value="' + escapeHtml(v.value) + '">' +
        '<span class="suggest-main">' + escapeHtml(v.label) + '</span>' +
        (v.contexte ? '<span class="suggest-context">' + escapeHtml(v.contexte) + '</span>' : "") +
      '</button>';
    }).join("");
  }

  function renderFieldSuggest(kind) {
    var box = document.getElementById("suggest-" + kind);
    if (!box) return;
    // Une seule liste ouverte à la fois : superposées, elles seraient illisibles.
    closeFieldSuggests();
    var saisie = champValeur(kind);
    var valeurs = [];

    if (kind === "commune") {
      valeurs = S.filterValues(S.listCommunes(), saisie, 8).map(function (c) {
        return { value: c, label: c, contexte: "" };
      });
    } else if (kind === "rue") {
      valeurs = S.filterValues(S.listRues(champValeur("commune")), saisie, 8).map(function (r) {
        return { value: r, label: r, contexte: "" };
      });
    } else if (kind === "numero") {
      var rue = champValeur("rue");
      if (!rue) { box.innerHTML = ""; box.classList.remove("open"); return; }
      valeurs = S.listAdressesDeRue(rue, champValeur("commune"))
        .filter(function (r) { return r.id !== currentFicheId && r.numero; })
        .filter(function (r) { return !S.normalize(saisie) || S.normalize(r.numero).indexOf(S.normalize(saisie)) === 0; })
        .slice(0, 8)
        .map(function (r) {
          return { value: r.numero, label: "N° " + r.numero, contexte: S.namesOf(r).join(" / ") || "(sans nom)" };
        });
    }

    if (!valeurs.length) { box.innerHTML = ""; box.classList.remove("open"); return; }
    box.innerHTML = fieldSuggestHTML(kind, valeurs);
    box.classList.add("open");
  }

  function closeFieldSuggests() {
    ["commune", "rue", "numero"].forEach(function (k) {
      var box = document.getElementById("suggest-" + k);
      if (box) { box.innerHTML = ""; box.classList.remove("open"); }
    });
  }

  function pickFieldValue(kind, value) {
    var el = els.viewFiche.querySelector('[data-field="' + kind + '"]');
    if (!el) return;
    el.value = value;
    closeFieldSuggests();
    // Choisir une commune ou une rue renseigne le code postal quand la base le connaît.
    if (kind === "commune" || kind === "rue") {
      var refs = kind === "commune"
        ? S.getRows().filter(function (r) { return S.normalize(r.commune) === S.normalize(value); })
        : S.listAdressesDeRue(value, champValeur("commune"));
      var cp = els.viewFiche.querySelector('[data-field="code_postal"]');
      var ref = refs.find(function (r) { return r.code_postal; });
      if (cp && !cp.value && ref) cp.value = ref.code_postal;
      if (kind === "rue" && ref && !champValeur("commune")) {
        var communeEl = els.viewFiche.querySelector('[data-field="commune"]');
        if (communeEl) communeEl.value = ref.commune;
      }
    }
    renderDupNotice();
  }

  // Prévenir le doublon au moment où il se dessine, pas après coup.
  function renderDupNotice() {
    var box = document.getElementById("dupNotice");
    if (!box) return;
    var doublon = S.findDoublon({
      id: currentFicheId, numero: champValeur("numero"),
      rue: champValeur("rue"), commune: champValeur("commune")
    });
    if (!doublon) { box.innerHTML = ""; return; }
    var noms = S.namesOf(doublon).join(" / ") || "(sans nom)";
    box.innerHTML =
      '<div class="dup-notice">' +
        '<div class="dup-text">Cette adresse existe déjà : <strong>' + escapeHtml(noms) + '</strong></div>' +
        '<button type="button" class="dup-btn" data-action="fusionner-adresse" data-id="' + doublon.id + '">➕ Ajouter le destinataire à cette adresse</button>' +
      '</div>';
  }

  // Verse les noms saisis dans l'adresse existante et abandonne le brouillon :
  // une boîte aux lettres, une fiche.
  function fusionnerAvecAdresse(existanteId) {
    var existante = S.findRow(existanteId);
    if (!existante) return;
    readFormIntoDraft();
    var nouveaux = S.namesOf(editDraft);
    if (nouveaux.length) {
      var noms = S.namesOf(existante);
      nouveaux.forEach(function (n) {
        if (noms.indexOf(n) === -1) noms.push(n);
      });
      var patch = {};
      S.setNames(patch, noms);
      S.updateRow(existanteId, patch);
    }
    S.deleteRow(currentFicheId);
    ficheEditing = false;
    renderSearch();
    openFiche(existanteId);
    toast(nouveaux.length ? "Destinataire ajouté à l'adresse existante." : "Adresse déjà présente.", "ok");
  }

  function geocodeResultsHTML(results) {
    if (!results.length) return '<div class="muted small">Aucun résultat. Tu peux saisir les coordonnées à la main.</div>';
    return '<div class="geo-results">' + results.map(function (r, i) {
      var pct = Math.round((r.score || 0) * 100);
      return '<button type="button" class="geo-result" data-action="pick-geocode" data-idx="' + i + '">' +
        '<span class="geo-label">' + escapeHtml(r.label) + '</span>' +
        '<span class="geo-score' + (pct < 60 ? ' geo-score-low' : '') + '">' + pct + '%</span>' +
      '</button>';
    }).join("") + '</div>';
  }

  // ---------------------------------------------------------------------
  // Edition : entrée / sortie / sauvegarde
  // ---------------------------------------------------------------------
  function openFiche(id) {
    currentFicheId = id;
    ficheEditing = false;
    var row = S.findRow(id);
    if (!row) { showView("search"); return; }
    renderFicheView(row);
    showView("fiche");
  }

  function enterEdit() {
    var row = S.findRow(currentFicheId);
    if (!row) return;
    editDraft = Object.assign({}, row);
    ficheEditing = true;
    geocodeResults = [];
    renderFicheEdit(editDraft);
  }

  function estVierge(row) {
    return !S.namesOf(row).length && !row.rue && !row.numero && !row.commune;
  }

  function cancelEdit() {
    ficheEditing = false;
    var row = S.findRow(currentFicheId);
    // Une création abandonnée ne doit pas laisser de fiche vide dans la base.
    if (row && estVierge(row)) {
      S.deleteRow(row.id);
      currentFicheId = null;
      renderSearch();
      showView("search");
      return;
    }
    if (row) renderFicheView(row); else showView("search");
  }

  // Sous empilement, une adresse doit dire de quelle tournée elle est : sa case
  // ne suffit plus à la situer, puisque plusieurs fichiers peuvent porter la
  // même. Le champ liste les fichiers chargés ; l'adresse en cours garde le sien
  // même s'il ne figure plus dans la pile, pour ne pas la déplacer en silence.
  function ficheTourneeHTML(row) {
    var fichiers = S.getFichiers();
    if (fichiers.length <= 1) return "";
    var courant = row.id_tournee || "";
    var options = fichiers.map(function (f) {
      return '<option value="' + escapeHtml(f.id) + '"' + (f.id === courant ? " selected" : "") + '>' +
        escapeHtml(f.id) + '</option>';
    });
    if (courant && !fichiers.some(function (f) { return f.id === courant; })) {
      options.unshift('<option value="' + escapeHtml(courant) + '" selected>' +
        escapeHtml(courant) + ' (absent de la pile)</option>');
    }
    return '<div class="field">' +
      '<label>Tournée</label>' +
      '<select data-field="id_tournee">' + options.join("") + '</select>' +
    '</div>';
  }

  function readFormIntoDraft() {
    els.viewFiche.querySelectorAll("[data-field]").forEach(function (el) {
      editDraft[el.getAttribute("data-field")] = el.value;
    });
    els.viewFiche.querySelectorAll("[data-field-bool]").forEach(function (el) {
      editDraft[el.getAttribute("data-field-bool")] = el.checked ? "true" : "false";
    });
  }

  function saveFiche() {
    readFormIntoDraft();
    S.updateRow(currentFicheId, editDraft);
    ficheEditing = false;
    var row = S.findRow(currentFicheId);
    renderFicheView(row);
    toast("Adresse enregistrée.", "ok");
  }

  function addChip() {
    var input = document.getElementById("chipInput");
    var val = (input.value || "").trim();
    if (!val) return;
    // Le formulaire est re-rendu juste après : sans cette relecture, l'adresse
    // en cours de saisie serait effacée par l'ajout d'un nom.
    readFormIntoDraft();
    var names = S.namesOf(editDraft);
    names.push(val);
    S.setNames(editDraft, names);
    renderFicheEdit(editDraft);
    var newInput = document.getElementById("chipInput");
    if (newInput) newInput.focus();
  }

  function removeChip(idx) {
    var names = S.namesOf(editDraft);
    var name = names[idx];
    if (!confirmAction('Supprimer le nom "' + name + '" de cette adresse ?')) return;
    readFormIntoDraft();
    names.splice(idx, 1);
    S.setNames(editDraft, names);
    renderFicheEdit(editDraft);
  }

  // ---------------------------------------------------------------------
  // Actions géo (position actuelle / itinéraire / géocodage / voir carte)
  // ---------------------------------------------------------------------

  // Le relevé de terrain se lit sur la fiche même quand il n'a pas été promu :
  // c'est là qu'on décide, en connaissance de cause, de l'officialiser ou pas.
  function releveKvHTML(row) {
    var r = S.releveInfo(row);
    if (!r) return "";
    var jour = (r.date || "").slice(0, 10);
    var detail = [
      r.precision === null ? "" : "± " + Math.round(r.precision) + " m",
      "score " + r.score.toFixed(2),
      jour
    ].filter(Boolean).join(" · ");
    var tag = r.score >= S.SCORE_SUR ? "tag-ok" : "tag-info";
    return '<div class="kv"><span>Relevé terrain</span><strong>' +
      escapeHtml(r.lat.toFixed(5) + ", " + r.lon.toFixed(5)) +
      ' <span class="tag ' + tag + '">' + escapeHtml(detail) + '</span></strong></div>';
  }

  // Relevé posé à la main : le seul geste autorisé à écraser un point déjà
  // vérifié. La capture automatique de la Course, elle, s'interdit d'y toucher.
  function useMyPosition(targetIsDraft) {
    if (!navigator.geolocation) { toast("Géolocalisation non disponible sur cet appareil.", "err"); return; }
    toast("Recherche de la position…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude, prec = pos.coords.accuracy;
      if (targetIsDraft) {
        editDraft.latitude = lat.toFixed(6);
        editDraft.longitude = lon.toFixed(6);
        editDraft.geocode_statut = "verifie";
        editDraft.lat_relevee = editDraft.latitude;
        editDraft.lon_relevee = editDraft.longitude;
        editDraft.precision_m = isNaN(Number(prec)) ? "" : String(Math.round(prec));
        editDraft.releve_le = new Date().toISOString();
        renderFicheEdit(editDraft);
      } else {
        S.enregistrerReleveManuel(currentFicheId, lat, lon, prec);
        renderFicheView(S.findRow(currentFicheId));
      }
      toast("Position enregistrée" + (isNaN(Number(prec)) ? "" : " (± " + Math.round(prec) + " m)") + ".", "ok");
    }, function (err) {
      toast("Impossible d'obtenir la position (" + err.message + ").", "err");
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  function openItineraire(row) {
    var pos = S.positionUtile(row);
    if (!pos) return;
    var url = "https://www.google.com/maps/dir/?api=1&destination=" + pos.lat + "," + pos.lon;
    window.open(url, "_blank");
  }

  // La carte n'affiche plus un marqueur par adresse : on s'y rend en centrant
  // sur les coordonnées, ce qui fonctionne que les pastilles soient visibles ou non.
  // « Voir sur la carte » ouvre aussi la case de casier qui contient l'adresse :
  // on arrive sur la carte avec le contexte de préparation déjà en place, plutôt
  // que sur un point isolé dont on ignore à quel moment de la tournée il tombe.
  function voirSurCarte(row) {
    if (!S.hasPosition(row)) return;
    var etapes = casierEtapes();
    for (var i = 0; i < etapes.length; i++) {
      if (etapes[i].rows.some(function (r) { return r.id === row.id; })) { casierIndex = i; break; }
    }
    casierFocusId = row.id;
    showView("map");
  }

  function runGeocode() {
    if (!S.getSettings().geocodageActif) { toast("Géocodage désactivé dans les réglages.", "warn"); return; }
    readFormIntoDraft();
    var box = document.getElementById("geocodeResults");
    box.innerHTML = '<div class="muted small">Recherche en cours…</div>';
    G.search({ numero: editDraft.numero, rue: editDraft.rue, code_postal: editDraft.code_postal, commune: editDraft.commune })
      .then(function (results) {
        geocodeResults = results;
        box.innerHTML = geocodeResultsHTML(results);
      })
      .catch(function () {
        box.innerHTML = '<div class="status err">Géocodage indisponible (pas de réseau ou service momentanément hors service). Tu peux saisir les coordonnées à la main.</div>';
      });
  }

  function pickGeocodeResult(idx) {
    var r = geocodeResults[idx];
    if (!r) return;
    if (r.numero) editDraft.numero = r.numero;
    if (r.rue) editDraft.rue = r.rue;
    if (r.code_postal) editDraft.code_postal = r.code_postal;
    if (r.commune) editDraft.commune = r.commune;
    editDraft.latitude = r.latitude;
    editDraft.longitude = r.longitude;
    editDraft.geocode_statut = "geocode";
    renderFicheEdit(editDraft);
    toast("Coordonnées récupérées — vérifie-les avant de valider si besoin.", "ok");
  }

  // ---------------------------------------------------------------------
  // Page 2 — Préparation tournée (séparée de la base d'adresses)
  //
  // Deux gestes de nature différente, donc deux modes, jamais mélangés :
  //
  //   « Objets standard » — on désigne des *zones* : les cases de casier dont
  //     les rues recevront du courrier ordinaire. Un appui par ligne de casier
  //     couvre des dizaines d'adresses ; rien ne se compte à l'unité.
  //   « Objets suivis »   — on attribue des *objets* à une adresse précise :
  //     colis, lettres suivies, presse. Chacun se compte, se valide et se
  //     justifie s'il n'est pas distribué.
  // ---------------------------------------------------------------------
  var prepMode = "standard";  // 'standard' | 'suivis'
  var prepFilter = "toutes"; // 'toutes' | 'tournee'

  // Adresse désignée par une proposition de recherche ou par le scan.
  // Elle est mémorisée à part, justement pour que la barre de recherche puisse
  // être vidée sans perdre l'adresse en cours : sur le terrain, on enchaîne une
  // adresse après l'autre, et effacer sa recherche à la main à chaque fois est
  // un geste de trop.
  var prepCibleId = null;

  function prepViderCible() { prepCibleId = null; }

  function setPrepFilter(f) {
    prepFilter = f;
    prepViderCible();
    els.prepSubNav.querySelectorAll("[data-prepfilter]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-prepfilter") === f);
    });
    renderPrep();
  }

  function setPrepMode(mode) {
    prepMode = mode;
    ["standard", "suivis"].forEach(function (m) {
      document.getElementById("prep-mode-" + m).classList.toggle("active", m === mode);
    });
    els.prepModeNav.querySelectorAll("[data-prepmode]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-prepmode") === mode);
    });
    renderPrep();
    window.scrollTo(0, 0);
  }

  function prepCardHTML(row, entry, query) {
    var names = S.namesOf(row);
    var title = names.length ? names.map(function (n) { return highlight(n, query); }).join(" / ") : "(sans nom)";
    var addr = [row.numero, row.rue].filter(Boolean).join(" ");
    var contexte = [addr, S.communeLabelOf(row), S.casierLabelEtape(row)].filter(Boolean).join(" · ");
    return (
      '<div class="prep-card" data-id="' + row.id + '" style="border-left:5px solid ' + S.getCommuneColor(row.commune) + ';">' +
        '<div class="prep-card-head">' +
          '<div>' +
            '<div class="card-title">' + title + '</div>' +
            '<div class="card-line muted">' + highlight(contexte, query) + '</div>' +
          '</div>' +
        '</div>' +
        Prep.TYPES.map(function (t) {
          return '<div class="stepper-row">' +
            '<span class="stepper-label">' + t.icon + ' ' + escapeHtml(t.label) + '</span>' +
            '<div class="stepper">' +
              '<button data-action="prep-dec" data-id="' + row.id + '" data-type="' + t.key + '">−</button>' +
              '<span class="stepper-value' + (entry[t.key] > 1 ? " multi" : "") + '">' + entry[t.key] + '</span>' +
              '<button data-action="prep-inc" data-id="' + row.id + '" data-type="' + t.key + '">+</button>' +
            '</div>' +
          '</div>';
        }).join("") +
        (Prep.countItems(entry) > 0
          ? '<button class="danger prep-remove-btn" data-action="prep-remove" data-id="' + row.id + '">🗑 Supprimer de la tournée</button>'
          : "") +
      '</div>'
    );
  }

  function prepAdjust(addrId, type, delta) {
    Prep.adjust(S.getIdTournee(), addrId, type, delta);
    renderPrep();
  }

  function communeSummaryHTML(idT) {
    var byCommune = {}; // commune -> compteurs par type + nombre d'adresses
    Prep.listEntries(idT).forEach(function (e) {
      var row = S.findRow(e.addressId);
      var commune = (row && row.commune) ? row.commune.toUpperCase().trim() : "(commune inconnue)";
      if (!byCommune[commune]) {
        byCommune[commune] = { adresses: 0 };
        Prep.TYPES.forEach(function (t) { byCommune[commune][t.key] = 0; });
      }
      Prep.TYPES.forEach(function (t) { byCommune[commune][t.key] += e[t.key]; });
      byCommune[commune].adresses += 1;
    });
    var communes = Object.keys(byCommune).sort();
    if (!communes.length) return "";
    return '<div class="commune-summary">' + communes.map(function (c) {
      var t = byCommune[c];
      return '<div class="commune-summary-row">' +
        '<span class="commune-dot" style="background:' + S.getCommuneColor(c) + ';"></span>' +
        '<span class="commune-summary-name">' + escapeHtml(c) + '</span>' +
        '<span class="commune-summary-figures">' + t.adresses + ' adr. ' + itemBadgesHTML(t, true) + '</span>' +
      '</div>';
    }).join("") + '</div>';
  }

  // --- mode « Objets standard » : une carte par colonne de casier ------------
  //
  // La colonne est l'unité que la main atteint d'un seul mouvement devant le
  // casier ; on la fait donc défiler du doigt, une carte à la fois, plutôt que
  // d'empiler cinq colonnes dans une page à faire rouler. À l'intérieur, chaque
  // ligne se résume à ses deux bornes — première et dernière rue — parce que
  // c'est ainsi qu'on la reconnaît en la regardant : par où elle commence, par
  // où elle finit.
  var prepZoneIndex = 0;
  // Tournée dont on prépare les colonnes. Vide = toutes, seul cas possible hors
  // empilement. Sous empilement, le sélecteur en désigne une, et la navigation
  // C1 → C2 → … se fait alors dans son casier à elle.
  var prepFichierId = "";

  // Le fichier choisi peut disparaître — retiré, renommé, vidé. On retombe alors
  // sur le premier de la pile plutôt que sur une préparation vide sans raison
  // visible.
  function prepFichierCourant() {
    var fichiers = S.getFichiers();
    if (fichiers.length <= 1) return "";
    var existe = fichiers.some(function (f) { return f.id === prepFichierId; });
    if (!existe) prepFichierId = fichiers[0].id;
    return prepFichierId;
  }

  function prepColonnes() {
    var id = prepFichierCourant();
    return id ? S.casierColonnes(id) : S.casierColonnes();
  }

  function prepSelecteurTourneeHTML() {
    var fichiers = S.getFichiers();
    if (fichiers.length < 2) return "";
    var courant = prepFichierCourant();
    return '<div class="prep-tournee">' +
        '<label for="prepTourneeSel">Tournée</label>' +
        '<select id="prepTourneeSel">' +
          fichiers.map(function (f) {
            return '<option value="' + escapeHtml(f.id) + '"' + (f.id === courant ? " selected" : "") + '>' +
              escapeHtml(f.id) + ' · ' + f.count + ' adr' + '</option>';
          }).join("") +
        '</select>' +
        '<span class="prep-tournee-pastille" style="background:' + S.getTourneeColor(courant) + '"></span>' +
      '</div>';
  }

  function setPrepFichier(id) {
    prepFichierId = id;
    prepZoneIndex = 0;
    renderPrep();
  }
  var prepZoneSwipeStartX = null;
  var prepZoneSwipeStartY = null;

  function clampPrepZoneIndex(colonnes) {
    if (!colonnes.length) { prepZoneIndex = 0; return; }
    if (prepZoneIndex < 0) prepZoneIndex = 0;
    if (prepZoneIndex > colonnes.length - 1) prepZoneIndex = colonnes.length - 1;
  }

  // Les bornes d'une ligne : deux rues, ou une seule quand la ligne n'en
  // contient qu'une — répéter le même nom des deux côtés ne dirait rien.
  function zoneBornesHTML(ligne) {
    if (!ligne.derniereRue || ligne.premiereRue === ligne.derniereRue) {
      return '<span class="zl-rue">' + escapeHtml(ligne.premiereRue) + '</span>';
    }
    return '<span class="zl-rue">' + escapeHtml(ligne.premiereRue) + '</span>' +
      '<span class="zl-fleche">→</span>' +
      '<span class="zl-rue">' + escapeHtml(ligne.derniereRue) + '</span>';
  }

  // Les objets suivis déjà attribués à une adresse de la ligne, agrégés par
  // type : le lien visuel entre une zone de courrier standard et les objets
  // suivis qu'elle porte, demandé pour que l'utilisateur les rapproche d'un
  // coup d'œil. Rien ne s'affiche quand la ligne n'en porte aucun.
  function zoneLigneObjetsHTML(idT, ligne) {
    var bag = {};
    Prep.TYPES.forEach(function (t) { bag[t.key] = 0; });
    ligne.rows.forEach(function (row) {
      var entry = Prep.getEntry(idT, row.id);
      Prep.TYPES.forEach(function (t) { bag[t.key] += entry[t.key] || 0; });
    });
    var html = itemBadgesHTML(bag);
    return html ? '<span class="zl-objets">' + html + '</span>' : "";
  }

  function zoneLigneHTML(idT, ligne) {
    var retenue = Prep.isZoneStandard(idT, ligne.cle);
    // La case garde toujours son numéro de ligne : c'est par lui qu'on la
    // retrouve dans le casier. L'état retenu se dit par la couleur et par la
    // coche en fin de ligne, jamais en effaçant l'identité de la case.
    return '<button class="zone-ligne' + (retenue ? " retenue" : "") + '" ' +
        'data-action="prep-zone-basculer" data-cle="' + escapeHtml(ligne.cle) + '" ' +
        'aria-pressed="' + retenue + '">' +
      '<span class="zl-case">L' + ligne.l + '</span>' +
      '<span class="zl-corps">' +
        '<span class="zl-bornes">' + zoneBornesHTML(ligne) +
          // Deux fichiers empilés peuvent poser chacun leur ligne sur la même
          // case : sans son étiquette, on ne saurait pas laquelle on retient.
          (ligne.fichier ? '<span class="zl-fichier">' + escapeHtml(ligne.fichier) + '</span>' : "") +
        '</span>' +
        '<span class="zl-meta">' +
          '<span class="commune-dot" style="background:' + S.getCommuneColor(ligne.commune) + ';"></span>' +
          escapeHtml(ligne.commune || "commune inconnue") +
          ' · ' + ligne.nbAdresses + ' adr · ' + ligne.nbRues + (ligne.nbRues > 1 ? " rues" : " rue") +
        '</span>' +
        zoneLigneObjetsHTML(idT, ligne) +
      '</span>' +
      '<span class="zl-coche">' + (retenue ? "✓" : "") + '</span>' +
    '</button>';
  }

  function bindPrepZoneSwipe() {
    var el = document.getElementById("prepZoneCardSwipe");
    if (!el) return;
    el.addEventListener("touchstart", function (ev) {
      var t = ev.changedTouches[0];
      prepZoneSwipeStartX = t.clientX;
      prepZoneSwipeStartY = t.clientY;
    }, { passive: true });
    el.addEventListener("touchend", function (ev) {
      if (prepZoneSwipeStartX === null) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - prepZoneSwipeStartX;
      var dy = t.clientY - prepZoneSwipeStartY;
      prepZoneSwipeStartX = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      prepZoneNav(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function prepZoneNav(delta) {
    prepZoneIndex += delta;
    renderPrepZones();
  }

  // Tout retenir / tout relâcher sur la colonne affichée : devant le casier,
  // une colonne entière de courrier standard est un cas courant.
  function prepZoneColonneBasculer() {
    var colonnes = prepColonnes();
    clampPrepZoneIndex(colonnes);
    var col = colonnes[prepZoneIndex];
    if (!col) return;
    var idT = S.getIdTournee();
    var toutes = col.lignes.every(function (li) { return Prep.isZoneStandard(idT, li.cle); });
    col.lignes.forEach(function (li) { Prep.setZoneStandard(idT, li.cle, !toutes); });
    renderPrep();
  }

  function prepZoneBasculer(cle) {
    Prep.toggleZoneStandard(S.getIdTournee(), cle);
    renderPrep();
  }

  function renderPrepZones() {
    var idT = S.getIdTournee();
    var colonnes = prepColonnes();
    var retenues = Prep.countZonesStandard(idT);
    var adressesRetenues = 0;
    colonnes.forEach(function (col) {
      col.lignes.forEach(function (li) {
        if (Prep.isZoneStandard(idT, li.cle)) adressesRetenues += li.nbAdresses;
      });
    });

    els.prepZonesTotals.innerHTML =
      '<div class="totals-line"><strong>' + retenues + '</strong> zone(s) de courrier standard · ' +
        '<strong>' + adressesRetenues + '</strong> adresse(s)</div>' +
      '<div class="totals-sub">Tournée « ' + escapeHtml(idT) + ' »</div>';

    var selecteur = prepSelecteurTourneeHTML();

    if (!colonnes.length) {
      els.prepZonesWrap.innerHTML = selecteur + '<div class="empty">' +
        (prepFichierCourant()
          ? "Aucune case de casier retenue pour la tournée « " + escapeHtml(prepFichierCourant()) +
            " ». Vérifie ses zones intégrées dans les réglages (⚙️)."
          : "Aucune case de casier dans la base. Importe un CSV renseignant les colonnes " +
            "<code>casier_c</code> et <code>casier_l</code> depuis les réglages (⚙️).") +
      '</div>';
      bindPrepTournee();
      return;
    }

    clampPrepZoneIndex(colonnes);
    var col = colonnes[prepZoneIndex];
    var retenuesCol = col.lignes.filter(function (li) { return Prep.isZoneStandard(idT, li.cle); }).length;
    var toutes = retenuesCol === col.lignes.length;

    els.prepZonesWrap.innerHTML =
      selecteur +
      '<div class="casier-nav">' +
        '<button class="tournee-nav-btn" data-action="prep-zone-prev" ' + (prepZoneIndex === 0 ? "disabled" : "") + ' aria-label="Colonne précédente">‹</button>' +
        '<div class="tournee-index">Colonne C' + col.c + ' · ' + (prepZoneIndex + 1) + ' / ' + colonnes.length + '</div>' +
        '<button class="tournee-nav-btn" data-action="prep-zone-next" ' + (prepZoneIndex === colonnes.length - 1 ? "disabled" : "") + ' aria-label="Colonne suivante">›</button>' +
      '</div>' +
      '<div class="casier-card zone-card" id="prepZoneCardSwipe">' +
        '<div class="casier-head">' +
          '<div class="casier-label">C' + col.c + '</div>' +
          '<div class="casier-meta">' + col.lignes.length + (col.lignes.length > 1 ? " lignes" : " ligne") + ' · ' + col.nbAdresses + ' adr' +
            (retenuesCol ? ' · <strong>' + retenuesCol + ' retenue' + (retenuesCol > 1 ? "s" : "") + '</strong>' : "") +
          '</div>' +
          '<button class="pc-btn zone-tout" data-action="prep-zone-colonne">' +
            (toutes ? "Tout relâcher" : "Tout retenir") +
          '</button>' +
        '</div>' +
        '<div class="zone-lignes">' +
          col.lignes.map(function (li) { return zoneLigneHTML(idT, li); }).join("") +
        '</div>' +
      '</div>' +
      '<div class="zone-aide">Une ligne retenue devient une zone de distribution du courrier standard, ' +
        'reprise telle quelle dans l\'onglet Course.</div>';

    bindPrepZoneSwipe();
    bindPrepTournee();
  }

  function bindPrepTournee() {
    var sel = document.getElementById("prepTourneeSel");
    if (sel) sel.addEventListener("change", function () { setPrepFichier(sel.value); });
  }

  function renderPrep() {
    if (prepMode === "standard") { renderPrepZones(); return; }

    var idT = S.getIdTournee();
    var totals = Prep.totals(idT);
    els.btnScan.style.display = (S.getSettings().scanActif === false) ? "none" : "block";
    els.prepTotals.innerHTML =
      '<div class="totals-line"><strong>' + totals.adresses + '</strong> adresse(s) · ' +
      Prep.TYPES.map(function (t) {
        return '<strong>' + totals[t.key] + '</strong> ' + t.icon;
      }).join(" · ") + '</div>' +
      '<div class="totals-sub">Objets suivis · Tournée « ' + escapeHtml(idT) + ' »</div>';

    els.prepCommuneSummary.innerHTML = (prepFilter === "tournee") ? communeSummaryHTML(idT) : "";

    var q = els.prepSearchBox.value;

    // Une adresse ciblée l'emporte sur la liste tant que rien n'est retapé :
    // l'écran ne montre qu'elle, ses compteurs sont sous le pouce, et la barre
    // est déjà libre pour la suivante.
    var cible = (prepCibleId && !S.normalize(q)) ? S.findRow(prepCibleId) : null;
    if (prepCibleId && !cible) prepViderCible(); // adresse supprimée entre-temps

    var rows;
    if (cible) {
      rows = [cible];
    } else if (prepFilter === "tournee") {
      var entries = Prep.listEntries(idT);
      var idsInTournee = {};
      entries.forEach(function (e) { idsInTournee[e.addressId] = true; });
      rows = S.getRows().filter(function (r) { return idsInTournee[r.id]; });
      if (q) rows = rows.filter(function (r) { return S.search(q).indexOf(r) !== -1; });
    } else {
      rows = S.search(q);
    }

    if (!rows.length) {
      els.prepList.innerHTML = "";
      els.prepEmptyState.style.display = "block";
      els.prepEmptyState.textContent = (prepFilter === "tournee")
        ? "Aucune adresse dans la tournée pour l'instant. Cherche une adresse dans \"Toutes les adresses\" pour l'ajouter."
        : "Aucune adresse ne correspond à cette recherche.";
    } else {
      els.prepEmptyState.style.display = "none";
      els.prepList.innerHTML =
        (cible
          ? '<div class="prep-cible-bandeau">' +
              '<span>Adresse ciblée</span>' +
              '<button class="pc-btn" data-action="prep-cible-effacer">Voir toutes les adresses</button>' +
            '</div>'
          : "") +
        rows.map(function (r) {
          return prepCardHTML(r, Prep.getEntry(idT, r.id), cible ? "" : q);
        }).join("");
    }
  }

  // ---------------------------------------------------------------------
  // Page 3 — Course (position actuelle, proximité, avancement)
  // ---------------------------------------------------------------------
  var suiviWatchId = null;
  var suiviUserPos = null;    // { lat, lon, accuracy }
  var suiviCentered = false;  // ne recentrer la carte qu'une seule fois sur le 1er relevé
  var suiviCarteCadree = false; // cadrage initial sur l'ensemble des points, une seule fois
  var suiviTab = "tournee";   // 'tournee' | 'carte'
  var suiviDernierRelevé = 0; // horodatage du dernier rendu déclenché par le GPS

  // Le GPS est le poste de consommation le plus lourd d'un téléphone en
  // tournée. Il ne tourne donc que pendant que la carte est réellement
  // regardée : changer d'onglet, quitter la Course ou passer l'application en
  // arrière-plan l'arrête. Voir startSuiviWatch/stopSuiviWatch.
  function carteOuverte() {
    return currentMainPage === "suivi" && suiviTab === "carte" && !document.hidden;
  }

  function majSuiviWatch() {
    if (carteOuverte()) startSuiviWatch();
    else stopSuiviWatch();
  }

  function suiviGeoStatusHTML(text, kind) {
    return '<span class="' + (kind || "") + '">' + escapeHtml(text) + '</span>';
  }

  function setSuiviTab(tab) {
    suiviTab = tab;
    ["tournee", "carte"].forEach(function (t) {
      document.getElementById("suivi-view-" + t).classList.toggle("active", t === tab);
    });
    els.suiviSubNav.querySelectorAll("[data-suivitab]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-suivitab") === tab);
    });
    if (tab === "carte") {
      dessinerTraceSuivi();
      // Le conteneur vient seulement d'être démasqué : on attend qu'il ait
      // repris ses dimensions avant de cadrer, sinon Leaflet cadre dans le vide.
      suiviMap.invalidateSize(renderSuiviCarte);
    }
    majSuiviWatch();
  }

  // La même trace que la carte de synthèse, en fond discret : elle situe la
  // position du livreur dans l'ensemble de la tournée sans concurrencer les
  // marqueurs de distribution. Dessinée à la navigation seulement — la
  // redessiner à chaque relevé GPS serait du gaspillage.
  function dessinerTraceSuivi() {
    Parcours.afficher(suiviMap, { leger: true, recentrer: false });
  }

  // ---------------------------------------------------------------------
  // Actions sur une adresse — mêmes gestes dans l'onglet Tournée et dans
  // l'onglet À proximité. Trois boutons explicites plutôt qu'un swipe : le
  // balayage horizontal sert déjà à passer d'une rue à l'autre.
  // ---------------------------------------------------------------------
  function addrActionsHTML(addrId, entry) {
    var estDistribue = entry.statut === Prep.STATUTS.DISTRIBUE;
    var estAbandonne = entry.statut === Prep.STATUTS.ABANDONNE;
    return '<div class="addr-actions">' +
      '<button class="addr-btn nav" data-action="addr-naviguer" data-id="' + addrId + '" aria-label="Ouvrir la navigation">🧭</button>' +
      '<button class="addr-btn stop' + (estAbandonne ? " active" : "") + '" data-action="addr-abandonner" data-id="' + addrId + '" aria-label="Ne pas distribuer">⊘</button>' +
      '<button class="addr-btn ok' + (estDistribue ? " active" : "") + '" data-action="addr-valider" data-id="' + addrId + '" aria-label="Valider la distribution">✓</button>' +
    '</div>';
  }

  // Deux niveaux de lecture, jamais le même poids graphique :
  //
  //   adresse → ce qu'il faut sortir de la sacoche ici  → pastille pleine
  //   résumé  → combien il en reste au total            → « ×3 » discret
  //
  // C'est le nombre de l'adresse qu'on lit en marchant vers une boîte aux
  // lettres : trois colis pour ce numéro-là, c'est trois gestes à ne pas
  // oublier. Les totaux d'une zone ou de la tournée, eux, se consultent — ils
  // reprennent donc la notation du menu « Résumé », discrète et uniforme.
  function itemBadgesHTML(entry, discret) {
    return Prep.TYPES.map(function (t) {
      var n = entry[t.key] || 0;
      if (!n) return "";
      var classe = "item-badge" + (discret ? " discret" : "") + (n > 1 && !discret ? " multi" : "");
      return '<span class="' + classe + '" title="' + escapeHtml(n + " " + t.label) + '">' +
        '<span class="item-icon">' + t.icon + '</span>' +
        (n > 1 ? '<span class="item-count">' + (discret ? "×" : "") + n + '</span>' : "") +
      '</span>';
    }).join("");
  }

  // Même information en texte, pour les infobulles de carte.
  function objetsTexte(entry) {
    return Prep.TYPES.map(function (t) {
      var n = entry[t.key] || 0;
      return n ? n + " " + t.label.toLowerCase() : "";
    }).filter(Boolean).join(", ") || "aucun item";
  }

  function ouvrirItineraire(destination) {
    window.open("https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(destination), "_blank");
  }

  // Itinéraire vers l'adresse : coordonnées GPS si on les a, sinon l'adresse
  // en toutes lettres — l'application de cartographie du téléphone fera le reste.
  function naviguerVers(addrId) {
    var row = S.findRow(addrId);
    if (!row) return;
    var pos = S.positionUtile(row);
    if (pos) {
      ouvrirItineraire(pos.lat + "," + pos.lon);
      return;
    }
    var dest = [row.numero, row.rue, row.code_postal, row.commune].filter(Boolean).join(" ");
    if (!dest) { toast("Cette adresse n'a ni GPS ni libellé exploitable.", "warn"); return; }
    ouvrirItineraire(dest);
  }

  function refreshSuiviAfterChange() {
    renderSuivi();
  }

  function applyStatut(addrIds, statut, motif, message) {
    var idT = S.getIdTournee();
    var snapshot = Prep.setStatutMany(idT, addrIds, statut, motif);
    refreshSuiviAfterChange();
    toast(message, "ok", function () {
      Prep.restore(idT, snapshot);
      refreshSuiviAfterChange();
    });
  }

  // Relevé automatique du point de livraison.
  //
  // Il part *après* la validation et ne la retient jamais : une tournée ne
  // s'interrompt pas parce qu'un GPS hésite, et un refus de géolocalisation
  // reste sans conséquence. Rien n'est signalé par un toast : celui de la
  // validation porte le « Annuler », et le remplacer coûterait le retour arrière.
  //
  // La position que la Course tient à jour n'est reprise que si elle vient
  // d'arriver. L'ancienneté d'un point ne se lit pas dans sa précision : un
  // relevé à 20 m pris quinze secondes plus tôt, en roulant, est faux de deux
  // cents mètres tout en affichant un score excellent — et une fois promu, il
  // ne se corrige plus depuis la Course. D'où cette fenêtre très courte, et un
  // maximumAge nul sur la demande ponctuelle, pour que le navigateur ne
  // réponde pas non plus avec un point qu'il gardait sous le coude.
  var RELEVE_FRAICHEUR_MS = 5000;

  function capterReleve(addrId) {
    var row = S.findRow(addrId);
    // Un point déjà vérifié ne se reprend que depuis les Données : le relever à
    // nouveau à chaque passage ne ferait qu'ajouter du bruit à une donnée sûre.
    if (!row || row.geocode_statut === "verifie") return;

    if (suiviUserPos && suiviUserPos.horodatage &&
        Date.now() - suiviUserPos.horodatage < RELEVE_FRAICHEUR_MS) {
      appliquerReleve(addrId, suiviUserPos.lat, suiviUserPos.lon, suiviUserPos.accuracy);
      return;
    }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      appliquerReleve(addrId, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    }, function () {
      // Position indisponible : la livraison reste validée, sans un mot.
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
  }

  function appliquerReleve(addrId, lat, lon, precision) {
    var res = S.enregistrerReleveAuto(addrId, lat, lon, precision);
    if (!res.ok) return;
    // Le seul retour visible tient dans la ligne d'état de la Course, qui sera
    // de toute façon réécrite au relevé suivant.
    if (els.suiviGeoStatus) {
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML(
        (res.promu ? "📍 Position vérifiée" : "📍 Point relevé") +
        " (± " + Math.round(precision) + " m · score " + res.score.toFixed(2) + ")",
        res.promu ? "" : "tag-info");
    }
  }

  // ✓ et ⊘ font aussi office de retour arrière : ré-appuyer sur le bouton
  // actif remet l'adresse "à faire", sans passer par un menu.
  function addrValider(addrId) {
    if (tourneeVerrouillee()) return;
    var entry = Prep.getEntry(S.getIdTournee(), addrId);
    if (entry.statut === Prep.STATUTS.DISTRIBUE) {
      applyStatut([addrId], Prep.STATUTS.A_FAIRE, "", "Adresse remise à faire.");
    } else {
      applyStatut([addrId], Prep.STATUTS.DISTRIBUE, "", "Adresse distribuée.");
      // Une validation d'adresse est le seul geste qui vaut « je suis devant
      // cette boîte ». La validation de zone couvre une rue entière et
      // l'abandon peut se décider de loin : ni l'un ni l'autre ne relève.
      capterReleve(addrId);
    }
  }

  function addrAbandonner(addrId) {
    if (tourneeVerrouillee()) return;
    var entry = Prep.getEntry(S.getIdTournee(), addrId);
    if (entry.statut === Prep.STATUTS.ABANDONNE) {
      applyStatut([addrId], Prep.STATUTS.A_FAIRE, "", "Adresse remise à faire.");
      return;
    }
    var row = S.findRow(addrId);
    var titre = row ? [row.numero, S.namesOf(row).join(" / ")].filter(Boolean).join(" — ") : "cette adresse";
    openMotifSheet("Ne pas distribuer", titre, { scope: "addr", ids: [addrId] });
  }

  // ---------------------------------------------------------------------
  // Panneau de motifs (bas d'écran) — sert pour une adresse comme pour une zone
  // ---------------------------------------------------------------------
  var sheetTarget = null;

  function openMotifSheet(titre, sousTitre, target) {
    sheetTarget = target;
    els.sheetBody.innerHTML =
      '<div class="sheet-title">' + escapeHtml(titre) + '</div>' +
      '<div class="sheet-sub">' + escapeHtml(sousTitre) + '</div>' +
      '<div class="sheet-motifs">' +
        Prep.MOTIFS.map(function (m) {
          return '<button class="sheet-motif" data-action="motif-pick" data-motif="' + m.key + '">' +
            '<span class="sheet-motif-icon">' + m.icon + '</span>' + escapeHtml(m.label) +
          '</button>';
        }).join("") +
      '</div>' +
      '<button class="sheet-cancel" data-action="sheet-close">Annuler</button>';
    els.sheetOverlay.classList.add("open");
  }

  function closeSheet() {
    els.sheetOverlay.classList.remove("open");
    sheetTarget = null;
  }

  function pickMotif(motifKey) {
    if (!sheetTarget) return;
    var cible = sheetTarget;
    var ids = cible.ids;
    closeSheet();
    if (cible.scope === "etape") {
      appliquerEtape(ids, cible.idsStd, Prep.STATUTS.ABANDONNE, motifKey,
        (ids.length + cible.idsStd.length) + " non distribué(s) — " + Prep.motifLabel(motifKey));
      return;
    }
    if (cible.scope === "standard") {
      applyStatutStandard(ids, Prep.STATUTS.ABANDONNE, motifKey,
        ids.length + " numéro(s) non distribué(s) — " + Prep.motifLabel(motifKey));
      return;
    }
    applyStatut(ids, Prep.STATUTS.ABANDONNE, motifKey,
      "Non distribuée — " + Prep.motifLabel(motifKey));
  }

  // --- onglet Tournée : cards par rue, parcourues dans l'ordre de la tournée ---
  var tourneeIndex = 0;
  var tourneeSwipeStartX = null;
  var tourneeSwipeStartY = null;
  // Dépliement d'une card d'objet suivi, adresse par adresse : replié par
  // défaut, pour rester compact sur le terrain ; l'état ne survit pas au
  // rechargement, il n'a rien d'une donnée métier.
  var tourneeAddrDepliees = {};
  // Zone dont le bloc standard attend qu'on désigne un numéro de destination.
  // Une seule card est à l'écran à la fois : une clé suffit.
  var stdItineraireKey = "";

  // Identité d'une étape de course. La case de casier vient en tête, et ce
  // n'est pas un détail de tri : c'est elle qui fait l'étape.
  //
  // Une clé bâtie sur la seule rue fusionnait tout ce que la tournée traverse
  // sous un même nom, où que ce soit dans le casier — « 10 route de Mansle »
  // en C3L3 et « 40/42 route de Mansle » en C3L4 se retrouvaient sur une seule
  // card, placée au rang du premier passage. Deux arrêts distincts du casier
  // disparaissaient ainsi en un seul, et l'ordre de la tournée s'en trouvait
  // contredit — le même travers que le parcours a déjà corrigé sur la carte.
  //
  // Les adresses hors casier viennent d'une autre tournée : elles partagent un
  // compartiment à part, qui ne peut collisionner avec aucune case réelle.
  //
  // Quand plusieurs fichiers sont empilés, le fichier d'origine entre dans la
  // clé : deux fichiers posant chacun une C1L1 sur la même rue décrivent deux
  // paquets réels, à deux moments distincts de la tournée. Hors empilement, le
  // discriminant est vide et la clé reste celle d'avant, au caractère près.
  function tourneeGroupKeyOf(row) {
    return (S.casierCle(row) || "HORS") + S.suffixeFichier(row) + "|" +
      (row.rue || "").trim().toUpperCase() + "|" +
      (row.commune || "").trim().toUpperCase();
  }

  function ordreDe(valeur) {
    return (valeur !== "" && valeur !== undefined && valeur !== null && !isNaN(Number(valeur))) ? Number(valeur) : null;
  }

  // Regroupe par rue les deux apports de la Préparation, et eux seuls :
  //
  //   — les adresses porteuses d'objets suivis (colis, lettres, presse) ;
  //   — les adresses des cases de casier retenues comme zones de courrier
  //     standard, qui n'ont aucun item à compter mais bien une distribution à
  //     faire, et donc un état propre.
  //
  // Une rue qui reçoit les deux ne fait qu'une zone, en deux blocs : la liste
  // de ses objets suivis, puis les numéros qu'elle dessert en standard. Les
  // deux se valident séparément — on peut avoir déposé le colis sans avoir
  // encore fait la rue.
  //
  // Les rues se suivent dans l'ordre du casier — la source de vérité de la
  // tournée — et non dans un ordre recalculé ici ; à l'intérieur d'une rue,
  // par ordre_rue puis numéro.
  function buildTourneeGroups(idT) {
    var zonesStandard = Prep.getZonesStandard(idT);
    var retenue = {};
    Prep.listEntries(idT).forEach(function (e) { retenue[e.addressId] = true; });
    S.getRows().forEach(function (r) {
      if (S.hasCasier(r) && zonesStandard[S.casierCle(r) + S.suffixeFichier(r)]) retenue[r.id] = true;
    });
    var rows = S.rowsOrdreTournee().filter(function (r) { return retenue[r.id]; });

    var groups = {};
    var order = [];
    rows.forEach(function (row) {
      var entry = Prep.getEntry(idT, row.id);
      var key = tourneeGroupKeyOf(row);
      if (!groups[key]) {
        groups[key] = {
          key: key, rue: row.rue || "(rue non renseignée)", commune: row.commune || "",
          // Toutes les adresses du groupe partagent la case, par construction :
          // la première la donne pour toutes.
          casier: S.casierCle(row), casierLabel: S.casierLabelEtape(row),
          fichier: S.cleFichier(row),
          lieuxDits: {}, items: [], standards: []
        };
        order.push(key);
      }
      var g = groups[key];
      if (row.lieu_dit) g.lieuxDits[row.lieu_dit.trim()] = true;
      if (Prep.countItems(entry) > 0) g.items.push({ row: row, entry: entry });
      else g.standards.push({ row: row, entry: Prep.getStandardEntry(idT, row.id) });
    });

    var list = order.map(function (k) { return groups[k]; });
    list.forEach(function (g) {
      g.items.sort(trierDansLaRue);
      g.standards.sort(trierDansLaRue);
      Prep.TYPES.forEach(function (t) {
        g[t.key] = g.items.reduce(function (s, it) { return s + it.entry[t.key]; }, 0);
      });
      g.distribuees = compterStatut(g.items, Prep.STATUTS.DISTRIBUE);
      g.abandonnees = compterStatut(g.items, Prep.STATUTS.ABANDONNE);
      g.restantes = g.items.length - g.distribuees - g.abandonnees;
      g.terminee = g.restantes === 0;
      // Courrier standard de la rue : les mêmes trois compteurs, tenus à part.
      g.stdDistribuees = compterStatut(g.standards, Prep.STATUTS.DISTRIBUE);
      g.stdAbandonnees = compterStatut(g.standards, Prep.STATUTS.ABANDONNE);
      g.stdRestantes = g.standards.length - g.stdDistribuees - g.stdAbandonnees;
      g.stdTerminee = g.standards.length > 0 && g.stdRestantes === 0;
      g.stdMotif = (g.standards.filter(function (it) { return it.entry.motif; })[0] || { entry: {} }).entry.motif || "";
      g.autres = g.standards.length;
      // Zone entièrement standard : elle n'a aucun objet suivi à lister.
      g.standard = g.items.length === 0;
      // Ce que les confirmations et les panneaux nomment : une rue seule ne
      // suffit plus à désigner l'étape, puisqu'une même rue peut en occuper
      // plusieurs à la file.
      g.libelle = g.rue + (g.casier ? " · " + g.casierLabel : "");
      // Le lieu-dit n'étiquette la zone que si toutes ses adresses le partagent.
      var lieux = Object.keys(g.lieuxDits);
      g.lieuDit = (lieux.length === 1 && g.autres + g.items.length > 0) ? lieux[0] : "";
    });
    return list;
  }

  // Ordre de passage à l'intérieur d'une rue : l'ordre préparé s'il existe,
  // le numéro sinon.
  function trierDansLaRue(a, b) {
    var oa = ordreDe(a.row.ordre_rue), ob = ordreDe(b.row.ordre_rue);
    if (oa === null) oa = Infinity;
    if (ob === null) ob = Infinity;
    if (oa !== ob) return oa - ob;
    return (Number(a.row.numero) || 0) - (Number(b.row.numero) || 0);
  }

  function compterStatut(liste, statut) {
    return liste.filter(function (it) { return it.entry.statut === statut; }).length;
  }

  // La borne haute inclut désormais une étape de plus que les groupes réels :
  // l'index groups.length est la card « Terminer la tournée », toujours après
  // la dernière rue.
  function clampTourneeIndex(groups) {
    if (!groups.length) { tourneeIndex = 0; return; }
    if (tourneeIndex < 0) tourneeIndex = 0;
    if (tourneeIndex > groups.length) tourneeIndex = groups.length;
  }

  // Dépliée, une card d'objet suivi montre ce que le repli tait pour rester
  // compact : la liste complète des destinataires (le repli la tronque au fil
  // d'une seule ligne), l'adresse en toutes lettres, et les notes de terrain —
  // stop pub en tête, puisque c'est la plus fréquente.
  function tourneeAddrDetailHTML(row) {
    var noms = S.namesOf(row).join(" · ") || "—";
    var adresse = [row.numero, row.rue].filter(Boolean).join(" ");
    var lieu = [row.code_postal, row.commune].filter(Boolean).join(" ");
    var lignes =
      '<div class="kv"><span>Destinataire(s)</span><strong>' + escapeHtml(noms) + '</strong></div>' +
      '<div class="kv"><span>Adresse</span><strong>' + escapeHtml([adresse, lieu].filter(Boolean).join(", ") || "—") + '</strong></div>';
    if (row.notes || S.isStopPub(row)) {
      lignes += '<div class="kv"><span>Notes</span><strong>' +
        (row.notes ? escapeHtml(row.notes) + " " : "") +
        (S.isStopPub(row) ? '<span class="tag tag-stoppub">🚫 Stop Pub</span>' : "") +
      '</strong></div>';
    }
    return '<div class="tournee-addr-detail">' + lignes + '</div>';
  }

  function tourneeAddrRowHTML(item) {
    var row = item.row;
    var names = S.namesOf(row).join(" / ") || "(sans nom)";
    var label = [row.numero, names].filter(Boolean).join(" — ");
    var meta = itemBadgesHTML(item.entry);
    if (item.entry.statut === Prep.STATUTS.ABANDONNE) {
      meta += '<span class="addr-motif">⊘ ' + escapeHtml(Prep.motifLabel(item.entry.motif)) + '</span>';
    }
    var ouvert = !!tourneeAddrDepliees[row.id];
    return '<div class="tournee-addr-row is-' + item.entry.statut + '">' +
      '<button type="button" class="tournee-addr-main" data-action="addr-detail-basculer" data-id="' + escapeHtml(row.id) + '" aria-expanded="' + ouvert + '">' +
        '<div class="tournee-addr-name">' + escapeHtml(label) + ' <span class="pc-chevron">' + (ouvert ? "▾" : "▸") + '</span></div>' +
        (meta ? '<div class="tournee-addr-meta">' + meta + '</div>' : "") +
      '</button>' +
      addrActionsHTML(row.id, item.entry) +
      (ouvert ? tourneeAddrDetailHTML(row) : "") +
    '</div>';
  }

  function addrDetailBasculer(addrId) {
    tourneeAddrDepliees[addrId] = !tourneeAddrDepliees[addrId];
    renderSuiviTournee();
  }

  function bindTourneeSwipe() {
    var el = document.getElementById("tourneeCardSwipe");
    if (!el) return;
    el.addEventListener("touchstart", function (e) {
      var t = e.changedTouches[0];
      tourneeSwipeStartX = t.clientX;
      tourneeSwipeStartY = t.clientY;
    }, { passive: true });
    el.addEventListener("touchend", function (e) {
      if (tourneeSwipeStartX === null) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - tourneeSwipeStartX;
      var dy = t.clientY - tourneeSwipeStartY;
      tourneeSwipeStartX = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      tourneeNav(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  // Total des objets d'une zone : un résumé, donc la notation du menu
  // « Résumé » — « ×3 » discret — et non la pastille réservée aux adresses.
  function zoneTotauxHTML(g) {
    var total = {};
    Prep.TYPES.forEach(function (t) { total[t.key] = g[t.key]; });
    return itemBadgesHTML(total, true);
  }

  function zoneProgressHTML(g) {
    var total = g.items.length;
    var pctDist = total ? (g.distribuees / total) * 100 : 0;
    var pctAband = total ? (g.abandonnees / total) * 100 : 0;
    var details = [g.distribuees + " / " + total + " distribuées"];
    if (g.abandonnees) details.push(g.abandonnees + " abandonnée(s)");
    details.push(g.restantes + " restante(s)");
    return '<div class="zone-progress">' +
      '<div class="zone-progress-bar">' +
        '<div class="zone-progress-done" style="width:' + pctDist + '%;"></div>' +
        '<div class="zone-progress-skip" style="width:' + pctAband + '%;"></div>' +
      '</div>' +
      '<div class="zone-progress-text">' + escapeHtml(details.join(" · ")) + '</div>' +
    '</div>';
  }

  // --- bloc de distribution standard ------------------------------------
  //
  // Un objet suivi se valide adresse par adresse : on sait ce qu'on dépose et
  // chez qui. Le courrier standard, lui, ne se compte pas — il se dessert. Ce
  // bloc dit donc la seule chose utile devant la rue : quels numéros sont à
  // faire. D'où une carte volontairement différente de celle des objets suivis
  // — fond crème, liseré pointillé, numéros en pastilles — pour qu'on ne
  // confonde jamais « déposer ce colis-là » et « faire cette rue ».
  // Chaque numéro est son propre bouton de validation : un appui le barre et
  // capte le point GPS courant, sans passer par le bouton groupé de la rue.
  // L'apparence reste strictement celle d'avant — seul le tag change.
  function stdNumeroHTML(item, arme) {
    var num = (item.row.numero || "").trim();
    var etat = item.entry.statut === Prep.STATUTS.DISTRIBUE ? " is-distribue"
             : item.entry.statut === Prep.STATUTS.ABANDONNE ? " is-abandonne" : "";
    var titre = [num, item.row.lieu_dit || "", S.namesOf(item.row).join(" / ")]
      .filter(Boolean).join(" · ") || "Adresse sans numéro";
    return '<button type="button" class="std-num' + (num ? "" : " sans-numero") + etat + '" ' +
      'data-action="std-num-valider" data-id="' + escapeHtml(item.row.id) + '" title="' +
      escapeHtml((arme ? "Itinéraire vers " : "") + titre) + '">' + escapeHtml(num || "—") + '</button>';
  }

  // Même geste que addrValider, sur le registre du courrier standard : un
  // appui valide et capte le relevé GPS, un second appui remet à faire — sans
  // confirmation, exactement comme pour un objet suivi.
  function stdNumValider(addrId) {
    // Mode itinéraire armé : le numéro ne sert qu'à désigner la destination.
    // Rien n'est rayé, distribué ni validé — partir vers une boîte n'est pas y
    // avoir déposé le courrier.
    if (stdItineraireKey) {
      stdItineraireKey = "";
      naviguerVers(addrId);
      renderSuiviTournee();
      return;
    }
    if (tourneeVerrouillee()) return;
    var entry = Prep.getStandardEntry(S.getIdTournee(), addrId);
    if (entry.statut === Prep.STATUTS.DISTRIBUE) {
      applyStatutStandard([addrId], Prep.STATUTS.A_FAIRE, "", "Numéro remis à faire.");
    } else {
      applyStatutStandard([addrId], Prep.STATUTS.DISTRIBUE, "", "Numéro distribué.");
      capterReleve(addrId);
    }
  }

  function stdEtatHTML(g) {
    if (!g.stdTerminee) return { classe: "", texte: g.standards.length + " numéro(s) à desservir" };
    if (!g.stdAbandonnees) return { classe: "est-ok", texte: "Distribution faite" };
    if (!g.stdDistribuees) {
      return { classe: "est-ko", texte: "Non distribuée" + (g.stdMotif ? " — " + Prep.motifLabel(g.stdMotif) : "") };
    }
    return { classe: "est-ok", texte: g.stdDistribuees + " distribué(s) · " + g.stdAbandonnees + " non distribué(s)" };
  }

  function zoneStandardHTML(g) {
    if (!g.standards.length) return "";
    var key = escapeHtml(g.key);
    var etat = stdEtatHTML(g);
    var arme = stdItineraireKey === g.key;
    return '<div class="std-bloc' + (g.stdTerminee ? " est-fait" : "") + '">' +
      '<div class="std-entete">' +
        '<span class="std-pastille">📮</span>' +
        '<div class="std-titre">Distribution standard' +
          '<div class="std-sous ' + etat.classe + '">' + escapeHtml(etat.texte) + '</div>' +
        '</div>' +
        // Mêmes trois gestes que sur une adresse d'objet suivi — même
        // gabarit, même ordre, même bascule — à la place du compteur, que la
        // ligne d'état sous le titre redit déjà.
        '<div class="addr-actions">' +
          '<button class="addr-btn nav' + (arme ? " active" : "") + '" data-action="zone-std-itineraire" data-key="' + key + '" aria-label="Itinéraire vers un numéro">🧭</button>' +
          '<button class="addr-btn stop' + (g.stdAbandonnees === g.standards.length ? " active" : "") + '" data-action="zone-std-abandonner" data-key="' + key + '" aria-label="Ne pas distribuer">⊘</button>' +
          '<button class="addr-btn ok' + (g.stdDistribuees === g.standards.length ? " active" : "") + '" data-action="zone-std-valider" data-key="' + key + '" aria-label="Valider la distribution">✓</button>' +
        '</div>' +
      '</div>' +
      (arme ? '<div class="std-itin-hint">🧭 Sélectionnez un numéro pour lancer l&rsquo;itinéraire.</div>' : "") +
      '<div class="std-numeros' + (arme ? " en-itineraire" : "") + '">' +
        g.standards.map(function (it) { return stdNumeroHTML(it, arme); }).join("") +
      '</div>' +
    '</div>';
  }

  // Ce qui reste à faire dans l'étape, les deux registres confondus : c'est
  // une rue qu'on quitte, pas deux comptabilités qu'on solde l'une après
  // l'autre.
  function etapeRestantes(g) {
    return g.restantes + g.stdRestantes;
  }

  // Les deux seules actions d'ensemble de la card, tout en bas : elles
  // couvrent d'un geste les objets suivis et les numéros standard. Le détail
  // — telle adresse, tel bloc — se joue plus haut, sur les icônes.
  function etapeActionsHTML(g) {
    var key = escapeHtml(g.key);
    if (!etapeRestantes(g)) {
      return '<div class="zone-actions">' +
        '<button class="zone-btn reopen" data-action="etape-rouvrir" data-key="' + key + '">↺ Rouvrir la distribution</button>' +
      '</div>';
    }
    return '<div class="zone-actions">' +
      '<button class="zone-btn stop" data-action="etape-abandonner" data-key="' + key + '">⊘ Abandonner</button>' +
      '<button class="zone-btn ok" data-action="etape-valider" data-key="' + key + '">✓ Valider la distribution</button>' +
    '</div>';
  }

  // ---------------------------------------------------------------------
  // Clôture de tournée : récapitulatif, mini-rapport HTML, verrouillage.
  // ---------------------------------------------------------------------

  function formatDateHeure(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatHeure(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  function formatDuree(debutISO, finISO) {
    if (!debutISO || !finISO) return "";
    var ms = new Date(finISO).getTime() - new Date(debutISO).getTime();
    if (isNaN(ms) || ms < 0) return "";
    var totalMin = Math.round(ms / 60000);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h ? (h + " h " + (m < 10 ? "0" : "") + m + " min") : (m + " min");
  }

  // Bilan de la tournée à l'instant présent — utilisé aussi bien par la
  // feuille de confirmation, la vue verrouillée après clôture, et le rapport
  // HTML : une seule règle de calcul, jamais recalculée différemment selon
  // l'endroit où elle s'affiche.
  function tourneeBilan(idT, groups) {
    var p = Prep.progress(idT);
    var std = { total: 0, distribue: 0, abandonne: 0, restant: 0 };
    var typees = [], standards = [];
    groups.forEach(function (g) {
      std.total += g.standards.length;
      std.distribue += g.stdDistribuees;
      std.abandonne += g.stdAbandonnees;
      std.restant += g.stdRestantes;
      g.items.forEach(function (it) { typees.push(it); });
      g.standards.forEach(function (it) { standards.push(it); });
    });

    var vusGPS = {}, gpsCount = 0, vusNotes = {}, notes = [], horodatages = [];
    typees.concat(standards).forEach(function (it) {
      var row = it.row;
      if (!vusGPS[row.id] && S.hasPosition(row)) { vusGPS[row.id] = true; gpsCount++; }
      if (!vusNotes[row.id] && row.notes) { vusNotes[row.id] = true; notes.push(row); }
      if (it.entry.horodatage) horodatages.push(it.entry.horodatage);
    });
    horodatages.sort();

    var nonDistributions = typees
      .filter(function (it) { return it.entry.statut === Prep.STATUTS.ABANDONNE; })
      .map(function (it) { return { type: objetsTexte(it.entry), row: it.row, entry: it.entry }; })
      .concat(standards
        .filter(function (it) { return it.entry.statut === Prep.STATUTS.ABANDONNE; })
        .map(function (it) { return { type: "Courrier standard", row: it.row, entry: it.entry }; }));

    var categories = Prep.TYPES.map(function (t) {
      return {
        icon: t.icon, label: t.label, total: p.total[t.key],
        distribue: p.distribues[t.key], abandonne: p.abandonnes[t.key], restant: p.restants[t.key]
      };
    }).concat([{ icon: "📮", label: "Standard", total: std.total, distribue: std.distribue, abandonne: std.abandonne, restant: std.restant }]);

    var total = p.adresses.total + std.total;
    var distribuees = p.adresses.distribuees + std.distribue;
    var abandonnees = p.adresses.abandonnees + std.abandonne;
    var restantes = p.adresses.restantes + std.restant;

    return {
      total: total, distribuees: distribuees, abandonnees: abandonnees, restantes: restantes,
      pct: total ? Math.round((distribuees / total) * 100) : 0,
      categories: categories, zones: groups.length,
      gpsCount: gpsCount, notes: notes, nonDistributions: nonDistributions,
      debut: horodatages.length ? horodatages[0] : ""
    };
  }

  // Accepte aussi bien le bilan complet (calculé en direct) que le résumé
  // allégé archivé avec un rapport — les deux portent les mêmes totaux.
  function recapLignesHTML(bilan) {
    return '<div class="kv"><span>Total éléments</span><strong>' + bilan.total + '</strong></div>' +
      '<div class="kv"><span>Distribués</span><strong>' + bilan.distribuees + '</strong></div>' +
      '<div class="kv"><span>Non distribués</span><strong>' + bilan.abandonnees + '</strong></div>' +
      (bilan.restantes ? '<div class="kv"><span>Restants</span><strong>' + bilan.restantes + '</strong></div>' : "") +
      '<div class="kv"><span>Progression</span><strong>' + bilan.pct + ' %</strong></div>';
  }

  function tourneeNavHTML(idx, total) {
    return '<div class="tournee-nav">' +
      '<button class="tournee-nav-btn" data-action="tournee-prev" ' + (idx === 0 ? "disabled" : "") + ' aria-label="Étape précédente">‹</button>' +
      '<div class="tournee-index">Étape ' + (idx + 1) + ' / ' + total + '</div>' +
      '<button class="tournee-nav-btn" data-action="tournee-next" ' + (idx === total - 1 ? "disabled" : "") + ' aria-label="Étape suivante">›</button>' +
    '</div>';
  }

  function tourneeFinaleCardHTML(bilan) {
    return '<div class="tournee-card tournee-finale">' +
      '<div class="tournee-card-head"><div class="tournee-card-title">🏁 Fin de tournée</div></div>' +
      '<div class="tournee-finale-recap">' + recapLignesHTML(bilan) + '</div>' +
      '<button class="cloture-btn" data-action="tournee-terminer-ouvrir">Terminer la tournée</button>' +
    '</div>';
  }

  function ouvrirClotureSheet() {
    if (tourneeVerrouillee()) return;
    var idT = S.getIdTournee();
    var bilan = tourneeBilan(idT, buildTourneeGroups(idT));
    sheetTarget = null;
    els.sheetBody.innerHTML =
      '<div class="sheet-title">Terminer la tournée ?</div>' +
      '<div class="sheet-sub">Vérifie le récapitulatif avant de clôturer — cette action est définitive.</div>' +
      '<div class="cloture-recap">' + recapLignesHTML(bilan) + '</div>' +
      '<div class="cloture-note">' +
        '<button type="button" class="cloture-note-toggle" data-action="cloture-note-basculer" aria-expanded="false">' +
          '<span class="pc-chevron">▸</span> Souhaitez-vous ajouter une note de fin de tournée ?' +
        '</button>' +
        '<textarea id="clotureNote" rows="3" placeholder="Ce qu&rsquo;il faut retenir de cette tournée…" hidden></textarea>' +
      '</div>' +
      '<button class="cloture-btn" data-action="tournee-terminer-confirmer">Confirmer la clôture</button>' +
      '<button class="sheet-cancel" data-action="sheet-close">Annuler</button>';
    els.sheetOverlay.classList.add("open");
  }

  // Replier la question vaut renoncement : le champ est vidé, donc rien ne
  // partira dans le rapport. Une note n'y figure que si elle a été écrite et
  // laissée visible au moment de confirmer.
  function clotureNoteBasculer(btn) {
    var ta = document.getElementById("clotureNote");
    if (!ta) return;
    var ouvre = ta.hidden;
    ta.hidden = !ouvre;
    if (!ouvre) ta.value = "";
    btn.setAttribute("aria-expanded", ouvre);
    btn.querySelector(".pc-chevron").textContent = ouvre ? "▾" : "▸";
    if (ouvre) ta.focus();
  }

  function clotureNoteSaisie() {
    var ta = document.getElementById("clotureNote");
    return (ta && !ta.hidden && ta.value.trim()) || "";
  }

  // Document HTML autonome — style inline, aucune dépendance à styles.css —
  // construit uniquement à partir de ce que la tournée contient au moment de
  // la clôture. Lecture seule : rien ici ne touche aux données métier.
  function genererRapportTourneeHTML(ctx) {
    var bilan = ctx.bilan;
    var dateTournee = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    var debutTxt = formatHeure(ctx.debut) || "—";
    var finTxt = formatHeure(ctx.fin) || "—";
    var dureeTxt = formatDuree(ctx.debut, ctx.fin) || "—";

    function ligneNonDistrib(x) {
      return '<tr>' +
        '<td>' + escapeHtml(x.type) + '</td>' +
        '<td>' + escapeHtml(S.namesOf(x.row).join(" / ") || "—") + '</td>' +
        '<td>' + escapeHtml([x.row.numero, x.row.rue].filter(Boolean).join(" ") + (x.row.commune ? ", " + x.row.commune : "")) + '</td>' +
        '<td><strong>' + escapeHtml(Prep.motifLabel(x.entry.motif) || "—") + '</strong></td>' +
        '<td>' + escapeHtml(x.row.notes || "") + '</td>' +
        '<td>' + escapeHtml(formatHeure(x.entry.horodatage)) + '</td>' +
      '</tr>';
    }

    // Mini-résumé des motifs de non-distribution, en proportion du total : ce
    // que le détail ligne à ligne, plus bas, n'offre pas d'un coup d'œil.
    function motifResumeHTML(nonDistributions) {
      var total = nonDistributions.length;
      var comptes = {}, ordre = [];
      nonDistributions.forEach(function (x) {
        var key = x.entry.motif || "autre";
        if (comptes[key] === undefined) { comptes[key] = 0; ordre.push(key); }
        comptes[key]++;
      });
      ordre.sort(function (a, b) { return comptes[b] - comptes[a]; });
      return '<div class="motif-resume">' + ordre.map(function (key) {
        var n = comptes[key];
        var pct = total ? Math.round((n / total) * 100) : 0;
        return '<span class="motif-resume-item">' + escapeHtml(Prep.motifLabel(key) || "Autre") +
          ' — ' + pct + ' % (' + n + ')</span>';
      }).join("") + '</div>';
    }

    var categoriesLignes = bilan.categories.map(function (c) {
      return '<tr><td>' + c.icon + ' ' + escapeHtml(c.label) + '</td><td>' + c.total + '</td><td>' + c.distribue + '</td><td>' + c.abandonne + '</td><td>' + c.restant + '</td></tr>';
    }).join("");

    // Un fichier par tournée empilée : la source de vérité de ce qui a été
    // livré ce jour-là, au-delà du seul id_tournee courant.
    var fichiersTxt = S.getFichiers().map(function (f) { return escapeHtml(f.id); }).join(", ") || "—";

    return '<!doctype html><html lang="fr"><head><meta charset="UTF-8">' +
      '<title>Rapport de distribution courrier-colis — ' + escapeHtml(dateTournee) + '</title>' +
      '<style>' +
        'body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px 40px;color:#1c1e1b;background:#f4f5f3;}' +
        'h1{font-size:20px;margin-bottom:4px;} h2{font-size:15px;margin:28px 0 10px;border-bottom:2px solid #2f6b4f;padding-bottom:4px;}' +
        '.entete{color:#6b7268;font-size:13.5px;margin-bottom:6px;}' +
        '.entete-fichiers{color:#6b7268;font-size:13.5px;margin-bottom:20px;}' +
        'table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;}' +
        'th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #dfe2dc;}' +
        'th{color:#6b7268;font-weight:700;font-size:11.5px;text-transform:uppercase;}' +
        '.kpis{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px;}' +
        '.kpi{background:#fff;border:1px solid #dfe2dc;border-radius:10px;padding:10px 14px;min-width:110px;}' +
        '.kpi b{display:block;font-size:20px;} .kpi span{font-size:11.5px;color:#6b7268;}' +
        '.non-distrib{background:#fdeceb;border:1px solid #eec5c0;border-radius:10px;padding:4px 12px;}' +
        '.non-distrib table{background:transparent;}' +
        '.motif-resume{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;}' +
        '.motif-resume-item{background:#fff;border:1px solid #eec5c0;border-radius:20px;padding:4px 10px;font-size:12.5px;}' +
        'ul{padding-left:18px;font-size:13px;}' +
        '.note-fin{background:#fff;border:1px solid #dfe2dc;border-radius:10px;padding:12px 14px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;}' +
        '.muted{color:#6b7268;}' +
      '</style></head><body>' +
      '<h1>Rapport de distribution courrier-colis</h1>' +
      '<div class="entete">' + escapeHtml(dateTournee) + ' · Début ' + debutTxt + ' · Fin ' + finTxt + ' · Durée ' + dureeTxt + '</div>' +
      '<div class="entete-fichiers">Tournées chargées : <strong>' + fichiersTxt + '</strong></div>' +
      '<h2>Résumé</h2>' +
      '<div class="kpis">' +
        '<div class="kpi"><b>' + bilan.pct + ' %</b><span>Progression finale</span></div>' +
        '<div class="kpi"><b>' + bilan.total + '</b><span>Total éléments</span></div>' +
        '<div class="kpi"><b>' + bilan.distribuees + '</b><span>Distribués</span></div>' +
        '<div class="kpi"><b>' + bilan.abandonnees + '</b><span>Non distribués</span></div>' +
      '</div>' +
      '<table><thead><tr><th>Catégorie</th><th>Total</th><th>Distribués</th><th>Non distribués</th><th>Restants</th></tr></thead><tbody>' +
        categoriesLignes +
      '</tbody></table>' +
      '<h2>Non-distributions' + (bilan.nonDistributions.length ? "" : " — aucune") + '</h2>' +
      (bilan.nonDistributions.length
        ? '<div class="non-distrib">' +
            motifResumeHTML(bilan.nonDistributions) +
            '<table><thead><tr><th>Type</th><th>Destinataire</th><th>Adresse</th><th>Raison</th><th>Note</th><th>Heure</th></tr></thead><tbody>' +
              bilan.nonDistributions.map(ligneNonDistrib).join("") +
            '</tbody></table></div>'
        : '<p class="muted">Toutes les distributions ont abouti.</p>') +
      // Les notes de terrain des fiches ne remontent plus d'elles-mêmes : la
      // seule observation du rapport est celle que le livreur a voulu écrire
      // en clôturant. Elle n'apparaît donc que s'il en a écrit une.
      (ctx.note
        ? '<h2>Note de fin de tournée</h2><p class="note-fin">' + escapeHtml(ctx.note) + '</p>'
        : "") +
      '</body></html>';
  }

  // Même montage que telecharger() (Blob + URL objet), mais ouvert dans un
  // nouvel onglet plutôt que déclenché en téléchargement : consulter un
  // rapport ne doit pas systématiquement en laisser un fichier sur l'appareil.
  function ouvrirRapportDansOnglet(html) {
    var blob = new Blob([html], { type: "text/html;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function tourneeTerminerConfirmer() {
    var idT = S.getIdTournee();
    var groups = buildTourneeGroups(idT);
    var bilan = tourneeBilan(idT, groups);
    var note = clotureNoteSaisie();
    var html = genererRapportTourneeHTML({ idTournee: idT, debut: bilan.debut, fin: new Date().toISOString(), bilan: bilan, note: note });
    // L'archive garde un résumé allégé : les lignes détaillées (destinataires,
    // adresses, notes) restent uniquement dans le HTML déjà généré, pas
    // dupliquées une deuxième fois dans le stockage.
    var resumeArchive = {
      total: bilan.total, distribuees: bilan.distribuees, abandonnees: bilan.abandonnees,
      restantes: bilan.restantes, pct: bilan.pct, zones: bilan.zones, gpsCount: bilan.gpsCount,
      notesCount: bilan.notes.length, categories: bilan.categories, debut: bilan.debut
    };
    Prep.cloturer(idT, html, resumeArchive);
    // La tournée est close : sa préparation (quantités, zones, statuts) est
    // vidée pour repartir propre la prochaine fois, sans lever le verrou de
    // clôture qui vient d'être posé.
    Prep.viderPreparation(idT);
    closeSheet();
    ouvrirRapportDansOnglet(html);
    toast("Tournée clôturée. Rapport généré.", "ok");
    renderSuivi();
  }

  function rapportConsulter(id) {
    var r = Prep.getRapport(id);
    if (r) ouvrirRapportDansOnglet(r.html);
  }

  function rapportTelecharger(id) {
    var r = Prep.getRapport(id);
    if (!r) return;
    telecharger(r.html, "text/html", "rapport_" + r.idTournee + "_" + (r.dateFermeture || "").slice(0, 10) + ".html");
  }

  function renderSuiviCloturee(idT, groups) {
    var rapport = Prep.getRapportActif(idT);
    var bilan = (rapport && rapport.resume && rapport.resume.categories) ? rapport.resume : tourneeBilan(idT, groups);
    var quand = rapport ? formatDateHeure(rapport.fin) : "";
    els.suiviTourneeWrap.innerHTML =
      '<div class="tournee-card tournee-cloturee">' +
        '<div class="tournee-card-head"><div class="tournee-card-title">🔒 Tournée clôturée</div></div>' +
        (quand ? '<div class="tournee-card-sub">Clôturée le ' + escapeHtml(quand) + '</div>' : "") +
        '<div class="tournee-finale-recap">' + recapLignesHTML(bilan) + '</div>' +
        (rapport
          ? '<div class="zone-actions">' +
              '<button class="zone-btn" data-action="rapport-telecharger" data-id="' + escapeHtml(rapport.id) + '">⬇️ Télécharger</button>' +
              '<button class="zone-btn ok" data-action="rapport-consulter" data-id="' + escapeHtml(rapport.id) + '">📄 Voir le rapport</button>' +
            '</div>'
          : "") +
      '</div>';
  }

  function renderSuiviTournee(groups) {
    var idT = S.getIdTournee();
    groups = groups || buildTourneeGroups(idT);

    // Une tournée clôturée n'a plus de carrousel à parcourir : la vue
    // verrouillée remplace tout, quel que soit l'index où on l'a laissée.
    if (Prep.estCloturee(idT)) { renderSuiviCloturee(idT, groups); return; }

    clampTourneeIndex(groups);

    if (!groups.length) {
      els.suiviTourneeWrap.innerHTML = '<div class="tournee-empty">' +
        "Rien à distribuer pour l'instant. Depuis la page Préparation, retiens des zones " +
        "de courrier standard ou attribue des objets suivis à des adresses." +
      '</div>';
      return;
    }

    var totalEtapes = groups.length + 1;

    // Dernière étape du carrousel, systématiquement après la dernière rue :
    // la card de clôture, pas une card de rue.
    if (tourneeIndex === groups.length) {
      els.suiviTourneeWrap.innerHTML =
        tourneeNavHTML(tourneeIndex, totalEtapes) +
        tourneeFinaleCardHTML(tourneeBilan(idT, groups));
      return;
    }

    var g = groups[tourneeIndex];
    els.suiviTourneeWrap.innerHTML =
      tourneeNavHTML(tourneeIndex, totalEtapes) +
      '<div class="tournee-card' + (g.standard ? " zone-standard" : "") + '" id="tourneeCardSwipe">' +
        '<div class="tournee-card-head">' +
          (g.commune ? '<span class="commune-dot" style="background:' + S.getCommuneColor(g.commune) + ';"></span>' : "") +
          '<div class="tournee-card-title">' + escapeHtml(g.rue) + '</div>' +
          '<span class="tournee-casier' + (g.casier ? "" : " hors") + '">' + escapeHtml(g.casierLabel) + '</span>' +
        '</div>' +
        (g.commune ? '<div class="tournee-card-sub">' + escapeHtml(S.communeLabel(g.commune, g.lieuDit)) + '</div>' : "") +
        (g.standard
          ? ""
          : '<div class="tournee-card-figures">' + zoneTotauxHTML(g) + '</div>' +
            zoneProgressHTML(g) +
            '<div class="tournee-addr-list">' + g.items.map(tourneeAddrRowHTML).join("") + '</div>') +
        zoneStandardHTML(g) +
        etapeActionsHTML(g) +
      '</div>';

    bindTourneeSwipe();
  }

  function tourneeNav(delta) {
    var groups = buildTourneeGroups(S.getIdTournee());
    stdItineraireKey = "";
    tourneeIndex += delta;
    clampTourneeIndex(groups);
    renderSuiviTournee(groups);
  }

  function findGroup(key) {
    return buildTourneeGroups(S.getIdTournee()).filter(function (g) { return g.key === key; })[0];
  }

  // Point de garde unique pour toute action qui changerait l'état de
  // distribution : une tournée clôturée ne se modifie plus, dans l'onglet
  // Tournée comme dans l'onglet Carte (qui partage les mêmes actions).
  function tourneeVerrouillee() {
    if (!Prep.estCloturee(S.getIdTournee())) return false;
    toast("Tournée déjà clôturée : aucune modification possible.", "warn");
    return true;
  }

  function idsRestants(g) {
    return g.items.filter(function (it) { return it.entry.statut === Prep.STATUTS.A_FAIRE; })
                  .map(function (it) { return it.row.id; });
  }

  // Un seul instantané pour les deux registres : l'annulation offerte par le
  // toast doit défaire l'étape entière, pas la moitié qu'elle connaîtrait.
  function appliquerEtape(ids, idsStd, statut, motif, message) {
    var idT = S.getIdTournee();
    var snap = Prep.setStatutMany(idT, ids, statut, motif);
    var snapStd = Prep.setStandardStatutMany(idT, idsStd, statut, motif);
    refreshSuiviAfterChange();
    toast(message, "ok", function () {
      Prep.restore(idT, snap);
      Prep.restoreStandard(idT, snapStd);
      refreshSuiviAfterChange();
    });
  }

  // Pas de confirmation : le toast porte son « Annuler », et c'est déjà ainsi
  // que se validait le courrier standard. Rouvrir, en revanche, en garde une —
  // c'est le geste qui défait du travail déjà fait.
  function etapeValider(key) {
    if (tourneeVerrouillee()) return;
    var g = findGroup(key);
    if (!g) return;
    var ids = idsRestants(g), idsStd = idsStdRestants(g);
    var n = ids.length + idsStd.length;
    if (!n) return;
    appliquerEtape(ids, idsStd, Prep.STATUTS.DISTRIBUE, "", n + " distribution(s) validée(s).");
  }

  function etapeAbandonner(key) {
    if (tourneeVerrouillee()) return;
    var g = findGroup(key);
    if (!g) return;
    var ids = idsRestants(g), idsStd = idsStdRestants(g);
    var n = ids.length + idsStd.length;
    if (!n) return;
    openMotifSheet("Abandonner la distribution", n + " restante(s) — " + g.libelle,
      { scope: "etape", ids: ids, idsStd: idsStd });
  }

  function etapeRouvrir(key) {
    if (tourneeVerrouillee()) return;
    var g = findGroup(key);
    if (!g) return;
    if (!confirmAction("Remettre toute la distribution de " + g.libelle + " à faire ?")) return;
    appliquerEtape(g.items.map(function (it) { return it.row.id; }), idsStdTous(g),
      Prep.STATUTS.A_FAIRE, "", "Distribution rouverte.");
  }

  // Mêmes gestes que pour les objets suivis, sur l'autre registre : valider,
  // abandonner avec un motif, rouvrir. Un seul appui couvre toute la rue —
  // c'est bien ainsi que le courrier standard se distribue.
  function idsStdRestants(g) {
    return g.standards.filter(function (it) { return it.entry.statut === Prep.STATUTS.A_FAIRE; })
                      .map(function (it) { return it.row.id; });
  }

  function applyStatutStandard(addrIds, statut, motif, message) {
    var idT = S.getIdTournee();
    var snapshot = Prep.setStandardStatutMany(idT, addrIds, statut, motif);
    refreshSuiviAfterChange();
    toast(message, "ok", function () {
      Prep.restoreStandard(idT, snapshot);
      refreshSuiviAfterChange();
    });
  }

  // Armer / désarmer la désignation du point d'arrivée. Un second appui
  // annule : on ne reste jamais coincé dans un mode dont on ne veut plus.
  function zoneStdItineraire(key) {
    stdItineraireKey = stdItineraireKey === key ? "" : key;
    renderSuiviTournee();
  }

  function idsStdTous(g) {
    return g.standards.map(function (it) { return it.row.id; });
  }

  function idsStdSauf(g, statut) {
    return g.standards.filter(function (it) { return it.entry.statut !== statut; })
                      .map(function (it) { return it.row.id; });
  }

  // Exactement la bascule du ✓ d'une adresse, appliquée au bloc entier :
  // ré-appuyer quand tout est distribué remet à faire, et un premier appui
  // rattrape aussi les numéros qui avaient été abandonnés.
  function zoneStdValider(key) {
    if (tourneeVerrouillee()) return;
    var g = findGroup(key);
    if (!g) return;
    if (g.stdDistribuees === g.standards.length) {
      applyStatutStandard(idsStdTous(g), Prep.STATUTS.A_FAIRE, "", "Numéros remis à faire.");
      return;
    }
    var ids = idsStdSauf(g, Prep.STATUTS.DISTRIBUE);
    applyStatutStandard(ids, Prep.STATUTS.DISTRIBUE, "", ids.length + " numéro(s) distribué(s).");
  }

  function zoneStdAbandonner(key) {
    if (tourneeVerrouillee()) return;
    var g = findGroup(key);
    if (!g) return;
    if (g.stdAbandonnees === g.standards.length) {
      applyStatutStandard(idsStdTous(g), Prep.STATUTS.A_FAIRE, "", "Numéros remis à faire.");
      return;
    }
    var ids = idsStdSauf(g, Prep.STATUTS.ABANDONNE);
    openMotifSheet("Ne pas distribuer", ids.length + " numéro(s) — " + g.libelle,
      { scope: "standard", ids: ids });
  }

  // Un relevé n'entraîne un nouveau rendu que s'il apprend quelque chose : le
  // GPS d'un piéton renvoie plusieurs points par seconde, dont l'essentiel est
  // du bruit à l'échelle d'une boîte aux lettres. En dessous de ces seuils, la
  // position est mémorisée sans redessiner la carte ni recalculer les distances.
  var MAJ_MIN_MS = 4000;
  var MAJ_MIN_M = 12;

  function startSuiviWatch() {
    if (!navigator.geolocation) {
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Géolocalisation non disponible sur cet appareil.", "tag-warn");
      return;
    }
    if (suiviWatchId !== null) return;
    if (!suiviUserPos) els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Recherche de la position…");
    suiviWatchId = navigator.geolocation.watchPosition(function (pos) {
      var suivante = {
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy, horodatage: Date.now()
      };
      var maintenant = Date.now();
      var bouge = !suiviUserPos ||
        MapView.distanceMeters(suiviUserPos.lat, suiviUserPos.lon, suivante.lat, suivante.lon) >= MAJ_MIN_M;
      var premier = !suiviUserPos;
      suiviUserPos = suivante;
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("📡 Position à jour (précision ~" + Math.round(pos.coords.accuracy || 0) + " m)");
      if (!suiviCentered) {
        suiviMap.centerOn(suiviUserPos.lat, suiviUserPos.lon, 15);
        suiviCentered = true;
      }
      if (!premier && !bouge && maintenant - suiviDernierRelevé < MAJ_MIN_MS) {
        // Immobile : on repositionne le seul marqueur, sans refaire l'écran.
        suiviMap.setUserMarker(suiviUserPos.lat, suiviUserPos.lon, suiviUserPos.accuracy);
        return;
      }
      suiviDernierRelevé = maintenant;
      renderSuivi();
    }, function (err) {
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Position indisponible (" + err.message + ").", "tag-warn");
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  function stopSuiviWatch() {
    if (suiviWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(suiviWatchId);
      suiviWatchId = null;
    }
  }

  function fmtDistance(m) {
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km";
  }

  function proximityCardHTML(item) {
    var row = item.row, entry = item.entry;
    var names = S.namesOf(row).join(" / ") || "(sans nom)";
    var addr = [row.numero, row.rue].filter(Boolean).join(" ");
    var lieu = S.communeLabelOf(row);
    var objets = itemBadgesHTML(entry);
    if (entry.statut === Prep.STATUTS.ABANDONNE) {
      objets += '<span class="addr-motif">⊘ ' + escapeHtml(Prep.motifLabel(entry.motif)) + '</span>';
    }
    return (
      '<div class="proximity-card is-' + entry.statut + '">' +
        '<div class="proximity-head">' +
          '<div><div class="card-title">' + escapeHtml(names) + '</div>' +
          '<div class="card-line muted">' + escapeHtml([addr, lieu].filter(Boolean).join(" · ")) + '</div></div>' +
          (item.distance !== undefined ? '<span class="proximity-dist">' + fmtDistance(item.distance) + '</span>' : '') +
        '</div>' +
        '<div class="proximity-foot">' +
          '<div class="proximity-objects">' + objets + '</div>' +
          addrActionsHTML(row.id, entry) +
        '</div>' +
      '</div>'
    );
  }

  // Le résumé prend la place d'un tiers d'écran pour trois nombres. La barre,
  // elle, dit l'essentiel en 8 pixels de haut : elle reste toujours visible,
  // les compteurs se replient. Barre et compteurs partagent le même code
  // couleur — vert distribué, rouge non distribué, gris restant — pour que
  // déplier ne soit qu'un agrandissement de ce qu'on lisait déjà.
  var suiviResumeDeplie = false;

  // Une ligne du volet déroulant, par catégorie plutôt que par état : icône,
  // puis les quatre mêmes chiffres pour toutes — total / distribué / non
  // distribué / restant — dans le même ordre que l'en-tête. Les zones
  // standard y prennent place au même titre que lettres, presse et colis :
  // même gabarit, même hiérarchie, seule l'icône change.
  function categorieLigneHTML(icon, label, n) {
    return '<div class="suivi-cat-row">' +
      '<span class="suivi-cat-icon">' + icon + '</span>' +
      '<span class="suivi-cat-label">' + escapeHtml(label) + '</span>' +
      '<span class="suivi-cat-fig">' + n.total + '</span>' +
      '<span class="suivi-cat-fig est-ok">' + n.distribue + '</span>' +
      '<span class="suivi-cat-fig est-ko">' + n.abandonne + '</span>' +
      '<span class="suivi-cat-fig est-reste">' + n.restant + '</span>' +
    '</div>';
  }

  function renderSuiviProgress(groups) {
    var idT = S.getIdTournee();
    var p = Prep.progress(idT);
    groups = groups || buildTourneeGroups(idT);
    // Les zones de courrier standard ne portent aucun objet à compter, mais
    // elles ont désormais un état : les laisser hors du compteur d'adresses
    // ferait mentir la barre — on pourrait faire la moitié de la tournée sans
    // qu'elle bouge. Les compteurs d'objets, eux, restent ceux des suivis.
    var a = { total: p.adresses.total, distribuees: p.adresses.distribuees,
              abandonnees: p.adresses.abandonnees, restantes: p.adresses.restantes };
    var std = { total: 0, distribue: 0, abandonne: 0, restant: 0 };
    groups.forEach(function (g) {
      a.total += g.standards.length;
      a.distribuees += g.stdDistribuees;
      a.abandonnees += g.stdAbandonnees;
      a.restantes += g.stdRestantes;
      std.total += g.standards.length;
      std.distribue += g.stdDistribuees;
      std.abandonne += g.stdAbandonnees;
      std.restant += g.stdRestantes;
    });
    var pctDist = a.total ? (a.distribuees / a.total) * 100 : 0;
    var pctAband = a.total ? (a.abandonnees / a.total) * 100 : 0;

    els.suiviProgress.innerHTML =
      '<div class="suivi-progressbar">' +
        '<div class="suivi-progressbar-fill" style="width:' + pctDist + '%;"></div>' +
        '<div class="suivi-progressbar-skip" style="width:' + pctAband + '%;"></div>' +
      '</div>' +
      '<button class="suivi-resume-toggle" data-action="suivi-resume-basculer" aria-expanded="' + suiviResumeDeplie + '">' +
        '<span class="pc-chevron">' + (suiviResumeDeplie ? "▾" : "▸") + '</span>' +
        '<span class="suivi-resume-titre"><strong>' + Math.round(pctDist) + ' %</strong> — ' +
          a.distribuees + ' / ' + a.total + ' adresses distribuées</span>' +
        (a.abandonnees ? '<span class="suivi-resume-aband">' + a.abandonnees + ' non distribuée(s)</span>' : "") +
      '</button>' +
      (suiviResumeDeplie
        ? '<div class="suivi-resume-detail">' +
            '<div class="suivi-cat-head">' +
              '<span class="suivi-cat-icon"></span><span class="suivi-cat-label"></span>' +
              '<span class="suivi-cat-fig">Total</span>' +
              '<span class="suivi-cat-fig">Distr.</span>' +
              '<span class="suivi-cat-fig">Non distr.</span>' +
              '<span class="suivi-cat-fig">Reste</span>' +
            '</div>' +
            Prep.TYPES.map(function (t) {
              return categorieLigneHTML(t.icon, t.label, {
                total: p.total[t.key], distribue: p.distribues[t.key],
                abandonne: p.abandonnes[t.key], restant: p.restants[t.key]
              });
            }).join("") +
            categorieLigneHTML("📮", "Standard", std) +
          '</div>'
        : "");
  }

  function renderSuivi() {
    var groups = buildTourneeGroups(S.getIdTournee());
    renderSuiviProgress(groups);
    renderSuiviTournee(groups);
    renderSuiviCarte();
  }

  // Carte opérationnelle de la Course.
  //
  // Deux principes : la carte montre *tous* les points à distribuer, quelle que
  // soit la distance — sans quoi on ne voit pas comment la tournée se répartit —
  // et chaque pastille porte la couleur de sa commune, rien d'autre. L'état de
  // distribution ne change que l'intensité : plein pour ce qui reste, effacé
  // pour ce qui est fait. La liste en dessous classe les mêmes adresses de la
  // plus proche à la plus lointaine : elle répond à « qu'est-ce qui est à
  // portée de main » sans qu'on ait à lui régler un rayon — sur le terrain,
  // c'est l'ordre qui renseigne, pas le seuil.
  function renderSuiviCarte() {
    var idT = S.getIdTournee();
    var entries = Prep.listEntries(idT);
    var tous = [], aProximite = [], withoutGPS = 0;

    entries.forEach(function (e) {
      var row = S.findRow(e.addressId);
      if (!row) return;
      var pos = S.positionUtile(row);
      if (!pos) { withoutGPS++; return; }
      var item = { row: row, entry: e, pos: pos };
      tous.push(item);
      if (!suiviUserPos) return;
      item.distance = MapView.distanceMeters(suiviUserPos.lat, suiviUserPos.lon, pos.lat, pos.lon);
      aProximite.push(item);
    });
    aProximite.sort(function (a, b) { return a.distance - b.distance; });

    // --- carte ---
    suiviMap.ensureMap("suiviMapContainer");
    var points = tous.map(function (item) {
      var traite = item.entry.statut !== Prep.STATUTS.A_FAIRE;
      return {
        id: item.row.id,
        lat: item.pos.lat, lon: item.pos.lon,
        color: S.getCommuneColor(item.row.commune),
        size: traite ? 11 : 15,
        creux: item.entry.statut === Prep.STATUTS.DISTRIBUE,
        opacity: traite ? 0.5 : 1,
        popupHtml: "<strong>" + escapeHtml(S.namesOf(item.row).join(" / ") || "(sans nom)") + "</strong><br>" +
          escapeHtml([item.row.numero, item.row.rue].filter(Boolean).join(" ")) + "<br>" +
          escapeHtml(S.communeLabelOf(item.row)) + "<br>" + escapeHtml(objetsTexte(item.entry))
      };
    });
    // Cadrage initial sur l'ensemble de la tournée, tant qu'aucune position
    // n'est connue — et seulement quand la carte est réellement à l'écran :
    // un conteneur masqué n'a pas de dimensions, donc pas de cadrage possible.
    var carteVisible = suiviTab === "carte" && els.suiviMapContainer.offsetHeight > 0;
    var cadrer = carteVisible && !suiviCarteCadree && !suiviUserPos && points.length > 0;
    if (cadrer) suiviCarteCadree = true;
    suiviMap.renderPoints(points, { fit: cadrer });
    if (suiviUserPos) suiviMap.setUserMarker(suiviUserPos.lat, suiviUserPos.lon, suiviUserPos.accuracy);

    // --- liste de proximité ---
    if (!entries.length) {
      els.suiviProximityList.innerHTML = "";
      els.suiviEmptyState.style.display = "block";
      els.suiviEmptyState.textContent = "Aucune adresse dans la tournée. Ajoute des lettres/colis depuis la page Préparation.";
      return;
    }
    if (!suiviUserPos) {
      els.suiviProximityList.innerHTML = "";
      els.suiviEmptyState.style.display = "block";
      els.suiviEmptyState.textContent = "En attente de ta position GPS pour calculer les distances…";
      return;
    }
    if (!aProximite.length) {
      els.suiviProximityList.innerHTML = "";
      els.suiviEmptyState.style.display = "block";
      els.suiviEmptyState.textContent = "Aucune adresse localisée dans la tournée" +
        (withoutGPS ? " · " + withoutGPS + " adresse(s) sans coordonnées GPS" : "") + ".";
      return;
    }
    els.suiviEmptyState.style.display = "none";
    var note = withoutGPS
      ? '<div class="empty" style="padding:10px;">' + withoutGPS + " adresse(s) sans coordonnées GPS." + '</div>'
      : "";
    els.suiviProximityList.innerHTML = aProximite.map(proximityCardHTML).join("") + note;
  }

  // ---------------------------------------------------------------------
  // Administration (import / export / réglages)
  // ---------------------------------------------------------------------
  function communeColorRowsHTML() {
    var communes = S.listCommunes();
    if (!communes.length) return '<div class="muted small">Importe des adresses pour pouvoir personnaliser leurs couleurs.</div>';
    return communes.map(function (c) {
      return '<div class="commune-color-row">' +
        '<input type="color" data-commune="' + escapeHtml(c) + '" value="' + S.getCommuneColor(c) + '">' +
        '<span>' + escapeHtml(c) + '</span>' +
      '</div>';
    }).join("");
  }

  // Les réglages se lisent comme un parcours : on importe, on exporte, on règle
  // l'apparence. Les titres de section portent ce découpage ; tout ce qui ne
  // sert qu'une fois (jeu d'essai, remise à zéro, options techniques) descend
  // dans les réglages avancés, replié.
  // --- empilement des fichiers de tournée -----------------------------------
  //
  // La pile se lit de haut en bas et c'est l'ordre de passage : à position de
  // casier égale, le fichier du haut passe avant celui du dessous. Deux gestes
  // pour la même chose — le glisser-déposer sous la souris, deux flèches sous
  // le pouce — parce qu'aucun des deux ne suffit seul sur un terminal qu'on
  // tient d'une main.
  // --- cartes des fichiers de tournée ---------------------------------------
  //
  // Un fichier n'est pas qu'une ligne dans une pile : c'est un identifiant de
  // tournée, une couleur de trace, une place dans l'ordre de passage, et un jeu
  // de cases dont toutes ne sont pas forcément du jour. Tout cela tient sur une
  // carte, une par fichier, qu'on fait défiler comme les colonnes du casier.
  //
  // L'identifiant de tournée appartient donc au fichier, et se change ici.
  var fichierIndex = 0;      // carte affichée
  var fichierZonesDepliees = false;

  function clampFichierIndex(fichiers) {
    if (!fichiers.length) { fichierIndex = 0; return; }
    if (fichierIndex < 0) fichierIndex = 0;
    if (fichierIndex > fichiers.length - 1) fichierIndex = fichiers.length - 1;
  }

  // Les cases du fichier, en grille : une colonne par ligne d'écran, ses cases
  // à cocher à la suite. Cocher, c'est intégrer la case à la tournée.
  function fichierZonesHTML(f) {
    var colonnes = S.colonnesDuFichier(f.id);
    if (!colonnes.length) {
      return '<div class="muted small">Ce fichier ne renseigne aucune case de casier.</div>';
    }
    var zones = S.zonesDuFichier(f.id);
    var retenues = zones.filter(function (z) { return z.integree; }).length;
    var toutes = retenues === zones.length;
    return '<div class="fz-entete">' +
        '<span class="fz-compte"><strong>' + retenues + '</strong> / ' + zones.length + ' case(s) dans la tournée</span>' +
        '<button class="pile-btn fz-tout" data-action="fichier-zones-toutes" data-id="' + escapeHtml(f.id) + '"' +
          ' data-etat="' + (toutes ? "1" : "0") + '">' +
          (toutes ? "Tout décocher" : "Tout cocher") +
        '</button>' +
      '</div>' +
      colonnes.map(function (col) {
        var toutesCol = col.zones.every(function (z) { return z.integree; });
        return '<div class="fz-colonne">' +
          '<button class="fz-col-btn" data-action="fichier-zones-colonne" data-id="' + escapeHtml(f.id) + '"' +
            ' data-col="' + col.c + '" data-etat="' + (toutesCol ? "1" : "0") + '"' +
            ' aria-label="' + (toutesCol ? "Décocher" : "Cocher") + ' toute la colonne ' + col.label + '">' +
            escapeHtml(col.label) +
          '</button>' +
          '<div class="fz-cases">' +
            col.zones.map(function (z) {
              return '<label class="fz-case' + (z.integree ? " on" : "") + '">' +
                '<input type="checkbox" data-zone-fichier="' + escapeHtml(f.id) + '"' +
                  ' data-zone="' + escapeHtml(z.cle) + '"' + (z.integree ? " checked" : "") + '>' +
                '<span>L' + z.l + '</span>' +
                '<small>· ' + z.nbAdresses + '</small>' +
              '</label>';
            }).join("") +
          '</div>' +
        '</div>';
      }).join("");
  }

  function fichierCardHTML(f, i, total) {
    var id = escapeHtml(f.id);
    return '<div class="casier-nav">' +
        '<button class="tournee-nav-btn" data-action="fichier-prec"' + (i === 0 ? " disabled" : "") +
          ' aria-label="Fichier précédent">‹</button>' +
        '<div class="tournee-index">Fichier ' + (i + 1) + ' / ' + total + '</div>' +
        '<button class="tournee-nav-btn" data-action="fichier-suiv"' + (i === total - 1 ? " disabled" : "") +
          ' aria-label="Fichier suivant">›</button>' +
      '</div>' +
      '<div class="fichier-card" id="fichierCardSwipe" data-id="' + id + '">' +
        '<div class="fc-entete">' +
          '<input type="color" class="pile-couleur" data-fichier="' + id + '"' +
            ' value="' + S.getTourneeColor(f.id) + '" aria-label="Couleur de la trace ' + id + '">' +
          '<div class="fc-titre">' +
            '<div class="fc-fichier">' + escapeHtml(f.nom || "(fichier sans nom)") + '</div>' +
            '<div class="fc-rang">' + (i + 1) + '<sup>' + (i === 0 ? "er" : "e") + '</sup> de la pile · ' +
              f.count + ' adresse(s)</div>' +
          '</div>' +
          '<div class="pile-actions">' +
            '<button class="pile-btn" data-action="fichier-monter" data-id="' + id + '"' +
              (i === 0 ? " disabled" : "") + ' aria-label="Monter ' + id + '">↑</button>' +
            '<button class="pile-btn" data-action="fichier-descendre" data-id="' + id + '"' +
              (i === total - 1 ? " disabled" : "") + ' aria-label="Descendre ' + id + '">↓</button>' +
            '<button class="pile-btn retirer" data-action="fichier-retirer" data-id="' + id + '"' +
              ' aria-label="Retirer ' + id + '">✕</button>' +
          '</div>' +
        '</div>' +
        // L'identifiant vient de la colonne id_tournee du fichier : il se lit,
        // il ne se saisit pas. Le corriger ici reviendrait à faire diverger
        // l'application de son fichier source.
        '<div class="fc-id">' +
          '<span class="fc-id-label">Tournée</span>' +
          '<span class="fc-id-valeur">' + id + '</span>' +
        '</div>' +
        '<details class="advanced fc-zones"' + (fichierZonesDepliees ? " open" : "") + ' id="fcZones">' +
          '<summary>Zones de casier intégrées</summary>' +
          '<div id="fichierZonesWrap">' + fichierZonesHTML(f) + '</div>' +
        '</details>' +
      '</div>';
  }

  function fichiersPileHTML() {
    var fichiers = S.getFichiers();
    if (!fichiers.length) {
      return '<div class="muted small">Aucun fichier chargé pour l\'instant.</div>';
    }
    clampFichierIndex(fichiers);
    return fichierCardHTML(fichiers[fichierIndex], fichierIndex, fichiers.length);
  }

  // Étape d'import : les cartes de fichiers empilés, et un champ qui ajoute
  // au fichier déjà chargé plutôt que de le remplacer.
  function etapeFichiersHTML() {
    return '<div class="field admin-step">' +
      '<div class="admin-step-title"><span class="admin-step-num">1</span>Fichiers de tournée</div>' +
      '<div id="pileFichiersWrap">' + fichiersPileHTML() + '</div>' +
      '<label class="pile-ajout" for="admFileInput">Ajouter un fichier</label>' +
      '<input type="file" id="admFileInput" accept=".csv,text/csv">' +
      '<small class="hint">L\'ordre de la pile départage les fichiers qui occupent la même case : ' +
        'le premier passe avant. Chaque fichier trace sa propre ligne sur la carte, ' +
        'de la couleur choisie ici. Réimporter un fichier déjà présent le met à jour ' +
        'sans changer sa place.</small>' +
      '<div id="adminStatus"></div>' +
    '</div>';
  }

  // Redessine la seule carte affichée : le message d'import et le repli des
  // réglages avancés survivent au réordonnancement.
  function refreshPileFichiers() {
    var wrap = document.getElementById("pileFichiersWrap");
    if (!wrap) { renderAdmin(); return; }
    var champ = document.getElementById("fcZones");
    fichierZonesDepliees = !!(champ && champ.open);
    wrap.innerHTML = fichiersPileHTML();
    bindPileFichiers();
  }

  // Redessine les seules cases : cocher une case ne doit pas replier le
  // sélecteur ni faire sauter la carte sous le doigt.
  function refreshFichierZones() {
    var wrap = document.getElementById("fichierZonesWrap");
    var fichiers = S.getFichiers();
    if (!wrap || !fichiers.length) { refreshPileFichiers(); return; }
    clampFichierIndex(fichiers);
    wrap.innerHTML = fichierZonesHTML(fichiers[fichierIndex]);
    bindPileFichiers();
  }

  // La trace se construit toute seule au chargement d'un fichier : en faire une
  // étape numérotée du parcours d'import laissait croire qu'il restait un geste
  // à poser. Il n'en reste qu'un, et seulement quand des adresses n'ont pas de
  // position : les géocoder. C'est ce que dit cette ligne, et rien d'autre.
  function traceEtatHTML() {
    // Seules les adresses de la tournée comptent : une case écartée n'a pas à
    // faire clignoter un avertissement sur une trace qui ne la traverse pas.
    var sansPosition = S.rowsOrdreTournee().filter(function (r) { return !S.hasPosition(r); }).length;
    var etat = sansPosition
      ? sansPosition + " adresse(s) sans position — la trace les saute."
      : "Trace construite au chargement, à jour.";
    return '<div class="trace-etat' + (sansPosition ? " manque" : "") + '" id="traceEtat">' +
        '<span class="trace-etat-pastille" aria-hidden="true">' + (sansPosition ? "⚠" : "🧭") + '</span>' +
        '<span class="trace-etat-txt">' + escapeHtml(etat) + '</span>' +
        '<button class="pile-btn trace-etat-btn" data-action="admin-construire-trace"' +
          ' aria-label="Géocoder les adresses sans position et reconstruire la trace"' +
          ' title="Géocoder les adresses sans position et reconstruire la trace">⟳</button>' +
      '</div>' +
      '<div id="traceStatus"></div>';
  }

  // Le panneau est rendu à l'ouverture, souvent avant tout import : sans ce
  // rafraîchissement, il annoncerait une trace à jour sur une base qui vient de
  // changer sous lui.
  function refreshTraceEtat() {
    var el = document.getElementById("traceEtat");
    if (!el) return;
    var neuf = document.createElement("div");
    neuf.innerHTML = traceEtatHTML();
    var remplacant = neuf.querySelector("#traceEtat");
    if (remplacant) el.replaceWith(remplacant);
  }

  // L'export ne suppose plus que tout doit sortir : sous empilement, on coche
  // les tournées à livrer. Tout est coché au départ — c'est le cas courant, et
  // décocher est un geste plus rare que de tout prendre.
  var exportExclus = {};

  function exportSelectionHTML() {
    var fichiers = S.getFichiers();
    if (fichiers.length < 2) return "";
    var retenus = fichiers.filter(function (f) { return !exportExclus[f.id]; }).length;
    return '<small class="hint admin-section-hint">Tournées à exporter.</small>' +
      '<div class="export-liste">' +
        '<div class="fz-entete">' +
          '<span class="fz-compte"><strong>' + retenus + '</strong> / ' + fichiers.length + ' tournée(s)</span>' +
          '<button class="pile-btn fz-tout" data-action="export-toutes"' +
            ' data-etat="' + (retenus === fichiers.length ? "1" : "0") + '">' +
            (retenus === fichiers.length ? "Tout décocher" : "Tout cocher") +
          '</button>' +
        '</div>' +
        fichiers.map(function (f) {
          var id = escapeHtml(f.id);
          return '<label class="export-ligne">' +
            '<input type="checkbox" data-export-fichier="' + id + '"' +
              (exportExclus[f.id] ? "" : " checked") + '>' +
            '<span class="export-pastille" style="background:' + S.getTourneeColor(f.id) + '"></span>' +
            '<span class="export-nom">' + id + '</span>' +
            '<span class="export-meta">' + f.count + ' adresse(s)' +
              (f.nom ? ' · ' + escapeHtml(f.nom) : "") + '</span>' +
          '</label>';
        }).join("") +
      '</div>';
  }

  function fichiersExportes() {
    var fichiers = S.getFichiers();
    if (fichiers.length < 2) return [];
    return fichiers.filter(function (f) { return !exportExclus[f.id]; }).map(function (f) { return f.id; });
  }

  function basculerToutExport(toutesCochees) {
    S.getFichiers().forEach(function (f) {
      if (toutesCochees) exportExclus[f.id] = true;
      else delete exportExclus[f.id];
    });
    refreshExportSelection();
  }

  function refreshExportSelection() {
    var wrap = document.getElementById("exportSelection");
    if (!wrap) return;
    wrap.innerHTML = exportSelectionHTML();
    bindExportSelection();
  }

  function bindExportSelection() {
    document.querySelectorAll("input[data-export-fichier]").forEach(function (el) {
      el.addEventListener("change", function () {
        var id = el.getAttribute("data-export-fichier");
        if (el.checked) delete exportExclus[id];
        else exportExclus[id] = true;
        refreshExportSelection();
      });
    });
  }

  // --- Réglages : archive des rapports de fin de tournée ---------------------
  //
  // L'espace demandé par la clôture (point 8) : consulter, télécharger ou
  // supprimer un rapport déjà généré. Supprimer un rapport ne touche jamais au
  // verrou de clôture de la tournée en cours — voir Prep.supprimerRapport.
  function rapportLigneHTML(r) {
    var quand = formatDateHeure(r.dateFermeture);
    var resume = (r.resume && r.resume.total !== undefined)
      ? r.resume.distribuees + " / " + r.resume.total + " distribué(s) · " + r.resume.pct + " %"
      : "";
    return '<div class="rapport-ligne">' +
      '<div class="rapport-ligne-main">' +
        '<div class="rapport-ligne-titre">' + escapeHtml(r.idTournee) + ' — ' + escapeHtml(quand) + '</div>' +
        (resume ? '<div class="rapport-ligne-sub muted">' + escapeHtml(resume) + '</div>' : "") +
      '</div>' +
      '<div class="rapport-ligne-actions">' +
        '<button class="pc-btn" data-action="rapport-consulter" data-id="' + escapeHtml(r.id) + '">Consulter</button>' +
        '<button class="pc-btn" data-action="rapport-telecharger" data-id="' + escapeHtml(r.id) + '">Télécharger</button>' +
        '<button class="pc-btn rapport-btn-danger" data-action="rapport-supprimer" data-id="' + escapeHtml(r.id) + '">Supprimer</button>' +
      '</div>' +
    '</div>';
  }

  function rapportsListHTML() {
    var rapports = Prep.listRapports();
    if (!rapports.length) return '<div class="empty">Aucun rapport de tournée archivé pour l\'instant.</div>';
    return rapports.map(rapportLigneHTML).join("");
  }

  function refreshRapports() {
    var wrap = document.getElementById("rapportsListe");
    if (wrap) wrap.innerHTML = rapportsListHTML();
  }

  function rapportSupprimer(id) {
    if (!confirmAction("Supprimer définitivement ce rapport de tournée ?")) return;
    Prep.supprimerRapport(id);
    refreshRapports();
  }

  function renderAdmin() {
    var s = S.getSettings();
    els.adminBody.innerHTML =
      '<section class="admin-section">' +
        '<h2 class="admin-section-title">Import des données</h2>' +
        etapeFichiersHTML() +
        traceEtatHTML() +
      '</section>' +
      '<section class="admin-section">' +
        '<h2 class="admin-section-title">Export des données</h2>' +
        '<div id="exportSelection">' + exportSelectionHTML() + '</div>' +
        '<div class="toolbar">' +
          '<button class="primary" data-action="admin-export">Exporter le CSV</button>' +
          '<button data-action="admin-export-trace">Exporter la trace (GeoJSON)</button>' +
        '</div>' +
      '</section>' +
      '<section class="admin-section">' +
        '<h2 class="admin-section-title">Rapports de tournée</h2>' +
        '<small class="hint admin-section-hint">Générés à la clôture d\'une tournée, depuis l\'onglet Course.</small>' +
        '<div id="rapportsListe">' + rapportsListHTML() + '</div>' +
      '</section>' +
      '<section class="admin-section">' +
        '<h2 class="admin-section-title">Apparence</h2>' +
        '<small class="hint admin-section-hint">Couleur du repère et de la pastille de chaque commune.</small>' +
        '<div id="communeColors">' + communeColorRowsHTML() + '</div>' +
      '</section>' +
      // Les options techniques ne servent qu'une fois : au réglage initial, ou
      // le jour où l'une d'elles déçoit. Les laisser dépliées dans la page
      // ferait passer chaque jour devant des cases auxquelles on ne touche pas.
      // Le jeu d'essai et la remise à zéro les rejoignent : hors de la première
      // découverte, on ne les cherche pas.
      '<details class="advanced" id="admAvances">' +
        '<summary>Réglages avancés</summary>' +
        '<label class="switch-row"><input type="checkbox" id="admGeocodage" ' + (s.geocodageActif ? "checked" : "") + '> Activer le géocodage automatique (API adresse gouvernementale)</label>' +
        '<label class="switch-row"><input type="checkbox" id="admScan" ' + (s.scanActif !== false ? "checked" : "") + '> Scan d\'étiquette par la caméra (expérimental)</label>' +
        '<label for="admScanMode">Mode de capture</label>' +
        '<select id="admScanMode"><option value="video"' + (s.scanModeCapture !== "photo" ? " selected" : "") + '>Vidéo — recherche continue</option>' +
        '<option value="photo"' + (s.scanModeCapture === "photo" ? " selected" : "") + '>Photo — déclenchement manuel</option></select>' +
        '<div class="range-row">' +
          '<label for="admScanIntervalle">Fréquence de recherche du scan (<span id="admScanIntervalleValeur">' +
            (s.scanIntervalleMs || 300) + '</span>&nbsp;ms entre deux lectures)</label>' +
          '<input type="range" id="admScanIntervalle" min="200" max="1500" step="50" value="' + (s.scanIntervalleMs || 300) + '">' +
        '</div>' +
        '<label class="switch-row"><input type="checkbox" id="admScanPivot" ' + (s.scanPivotInverse ? "checked" : "") + '> Inverser le sens de rotation de l\'écran de scan (téléphone verrouillé en portrait)</label>' +
        '<label class="switch-row"><input type="checkbox" id="admFleches" ' + (s.flechesSens !== false ? "checked" : "") + '> Flèches de sens sur la trace (au zoom rapproché)</label>' +
        '<div class="toolbar">' +
          '<button data-action="admin-sample">Charger un exemple</button>' +
          '<button class="danger" data-action="admin-clear">Vider les données</button>' +
        '</div>' +
        '<small class="hint">Séparateur des noms multiples&nbsp;: <code>|</code>. Les données restent uniquement dans ce navigateur.</small>' +
      '</details>';
  }

  function showAdminStatus(kind, text) {
    afficherStatut("adminStatus", kind, text);
  }

  // La construction de la trace parle sous son propre bouton : mêlée aux
  // messages d'import, sa progression se lirait à l'autre bout de la page.
  function showTraceStatus(kind, text) {
    afficherStatut("traceStatus", kind, text);
  }

  function afficherStatut(id, kind, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = text ? '<div class="status ' + kind + '">' + escapeHtml(text) + '</div>' : "";
  }

  // Jeu d'essai : vingt adresses, des noms inventés mais une géographie réelle.
  // Il porte tout ce que l'application doit savoir tenir — position vérifiée,
  // relevé de terrain non promu, adresse sans position, hors casier, deux
  // communes à relier et l'écart rural qui les sépare. Aucune donnée de tournée
  // réelle n'entre dans le dépôt : le fichier de travail y reste étranger.
  var SAMPLE_CSV =
'id,id_tournee,nom_famille,numero,rue,code_postal,commune,lieu_dit,latitude,longitude,geocode_statut,lat_relevee,lon_relevee,precision_m,releve_le,casier_c,casier_l,ordre_zone,ordre_rue,position_manuelle,type_objet,notes,stoppub,date_maj\n' +
'tm002-0001,tm002,MARTIN,5,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,45.822892,0.447845,verifie,45.822892,0.447845,12,2026-09-04T09:12:00.000Z,1,1,1,1,,lettre,,false,2026-09-04\n' +
'tm002-0002,tm002,DUBOIS|LEROY|GIRARD,9-2,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,,,,,,,,1,1,1,2,,lettre,,true,2026-09-04\n' +
'tm002-0003,tm002,PETIT,8,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,45.823310,0.448120,geocode,45.823295,0.448210,68,2026-09-04T09:19:00.000Z,1,1,1,3,,lettre,batterie,false,2026-09-04\n' +
'tm002-0004,tm002,ROUSSEL,,LE CHATEAU,16260,CHASSENEUIL-SUR-BONNIEURE,LE CHATEAU,45.820024,0.439499,geocode,,,,,1,1,8,8,,colis,portail vert,false,2026-09-04\n' +
'tm002-0005,tm002,FONTAINE,13,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,45.823001,0.446780,geocode,,,,,1,2,21,7,,lettre,,false,2026-09-04\n' +
'tm002-0006,tm002,BONNET,16,RUE DE CELLEFROUIN,16260,CHASSENEUIL-SUR-BONNIEURE,,45.824075,0.447159,geocode,,,,,1,2,24,2,,lettre,,true,2026-09-04\n' +
'tm002-0007,tm002,MOREAU,19,ROUTE DE CELLEFROUIN,16260,CHASSENEUIL-SUR-BONNIEURE,,45.837796,0.442022,geocode,,,,,1,2,30,5,,presse,,false,2026-09-04\n' +
'tm002-0008,tm002,LAURENT,4,MONTEE DU CHATEAU,16260,CELLEFROUIN,CHEZ CASTERNAUD,45.887271,0.394959,geocode,,,,,1,2,86,1,,lettre,,false,2026-09-04\n' +
'tm002-0009,tm002,GARNIER,7,RUE DE LA FIFAUDET,16260,CELLEFROUIN,LA FORET,45.886385,0.408040,geocode,45.886402,0.408015,22,2026-09-04T11:02:00.000Z,1,3,90,5,,lettre,,false,2026-09-04\n' +
'tm002-0010,tm002,CHEVALIER,1,IMPASSE DES ELOTS,16260,CELLEFROUIN,LES ELOTS,45.890127,0.390784,geocode,,,,,1,3,100,5,,colis,,false,2026-09-04\n' +
'tm002-0011,tm002,ROBIN,2,ROUTE DES GRANGES,16260,CELLEFROUIN,CHEZ PICAUD,45.888423,0.390453,geocode,,,,,1,3,105,10,,lettre,chien,false,2026-09-04\n' +
'tm002-0012,tm002,MASSON,7,LE MAS DES ELOTS,16260,CELLEFROUIN,LE MAS DES ELOTS,45.890461,0.388870,geocode,,,,,1,3,108,2,,lettre,,true,2026-09-04\n' +
'tm002-0013,tm002,BRUN,43,ROUTE DE MANSLE,16260,CELLEFROUIN,LE BOURG DE CELLEFROUIN,45.891376,0.390093,geocode,,,,,1,4,118,1,,lettre,,false,2026-09-04\n' +
'tm002-0014,tm002,RENARD,2,LA MATASSE,16260,CELLEFROUIN,MOULIN DE LA MATASSE,45.893237,0.405618,geocode,,,,,1,4,138,6,,presse,,false,2026-09-04\n' +
'tm002-0015,tm002,COLIN,11,GRAND RUE,16260,CELLEFROUIN,LASCOUX,45.892404,0.417685,geocode,,,,,1,4,140,8,,lettre,,false,2026-09-04\n' +
'tm002-0016,tm002,VIDAL,19,GRAND RUE,16260,CELLEFROUIN,LASCOUX,45.892453,0.418585,geocode,,,,,2,1,144,12,,lettre,,false,2026-09-04\n' +
'tm002-0017,tm002,NOEL,4,RUE DU LAVOIR,16260,CELLEFROUIN,,45.891706,0.418520,geocode,,,,,2,1,146,1,,lettre,,false,2026-09-04\n' +
'tm002-0018,tm002,PERRIN,6,LA RUETTE,16260,CELLEFROUIN,,,,,,,,,2,1,161,1,,lettre,adresse à repérer,false,2026-09-04\n' +
'tm002-0019,tm002,LEFEVRE,38,RUE DES ECOLES,16260,CHASSENEUIL-SUR-BONNIEURE,,45.823936,0.443162,geocode,,,,,,,22,1,,lettre,,false,2026-09-04\n' +
'tm002-0020,tm002,BERGER,6,RUE DU MONTET,16260,CHASSENEUIL-SUR-BONNIEURE,CHEZ GIRAUDEAU,45.825941,0.441750,geocode,,,,,,,30,2,,lettre,,false,2026-09-04\n';

  function bindAdminEvents() {
    document.getElementById("admFileInput").addEventListener("change", function (ev) {
      var file = ev.target.files[0];
      if (!file) return;
      // Le fichier s'ajoute à ceux déjà chargés, dans la pile.
      var avant = etatEmpilement();
      var reader = new FileReader();
      reader.onload = function () {
        var res = S.importFromCSV(String(reader.result), {
          mode: "ajouter",
          nomFichier: file.name
        });
        if (!res.ok) { showAdminStatus("err", res.message); return; }
        var msg = "Fichier « " + res.idFichier + " » : " + res.count + " ligne(s)";
        msg += " · " + res.total + " au total.";
        if (res.missingCols.length) msg += " Colonnes absentes : " + res.missingCols.join(", ") + ".";
        if (res.errors.length) msg += " " + res.errors.length + " erreur(s).";
        if (res.warnings.length) msg += " " + res.warnings.length + " avertissement(s).";
        showAdminStatus(res.errors.length ? "err" : (res.warnings.length ? "warn" : "ok"), msg);
        suivreEmpilementDansLaPreparation(avant);
        refreshPileFichiers();
        refreshTraceEtat();
        refreshExportSelection();
        casierIndex = 0;
        prepZoneIndex = 0;
        refreshCommuneColors();
        renderSearch();
        renderPrep();
        // La trace de la tournée se construit ici, au chargement des données,
        // et se met en cache : les jours suivants n'y reviennent pas.
        Parcours.viderCacheRoute();
        Parcours.preparer();
      };
      reader.readAsText(file, "UTF-8");
      ev.target.value = "";
    });
    document.getElementById("admGeocodage").addEventListener("change", function (e) {
      S.setSetting("geocodageActif", e.target.checked);
    });
    document.getElementById("admScan").addEventListener("change", function (e) {
      S.setSetting("scanActif", e.target.checked);
      renderPrep();
    });
    document.getElementById("admScanMode").addEventListener("change", function (e) {
      S.setSetting("scanModeCapture", e.target.value);
    });
    document.getElementById("admScanIntervalle").addEventListener("input", function (e) {
      document.getElementById("admScanIntervalleValeur").textContent = e.target.value;
    });
    document.getElementById("admScanIntervalle").addEventListener("change", function (e) {
      S.setSetting("scanIntervalleMs", Number(e.target.value));
    });
    document.getElementById("admScanPivot").addEventListener("change", function (e) {
      S.setSetting("scanPivotInverse", e.target.checked);
    });
    document.getElementById("admFleches").addEventListener("change", function (e) {
      S.setSetting("flechesSens", e.target.checked);
      Parcours.rafraichirAffichage();
    });
    bindPileFichiers();
    bindExportSelection();
    bindCommuneColorEvents();
  }

  // ---------------------------------------------------------------------
  // Empilement des fichiers de tournée
  // ---------------------------------------------------------------------
  //
  // Une case de casier se nomme par sa seule position tant qu'un fichier est
  // chargé, et par sa position et son fichier dès qu'ils sont plusieurs. Les
  // zones de courrier standard déjà retenues sont renommées avec elle : passer
  // d'un fichier à deux — ou revenir — ne doit pas effacer une préparation déjà
  // faite.
  function etatEmpilement() {
    return { actif: S.multiActif(), fichiers: S.getFichiers() };
  }

  function suivreEmpilementDansLaPreparation(avant) {
    var actif = S.multiActif();
    if (avant.actif === actif) return;
    var idT = S.getIdTournee();
    if (actif) {
      var origine = avant.fichiers[0];
      if (!origine) return;
      Prep.remapZonesStandard(idT, function (cle) {
        return cle.indexOf("@") === -1 ? cle + "@" + origine.id : cle;
      });
    } else {
      // Retour au fichier unique : seules les zones du fichier qui reste ont
      // encore une case à désigner. Celles des fichiers partis s'en vont avec
      // eux, sinon elles retiendraient les cases du survivant à sa place.
      var reste = S.getFichiers()[0];
      Prep.remapZonesStandard(idT, function (cle) {
        var i = cle.indexOf("@");
        if (i === -1) return cle;
        return (reste && cle.slice(i + 1) === reste.id) ? cle.slice(0, i) : "";
      });
    }
  }

  // Après un changement de pile — ajout, retrait, réordonnancement — l'ordre de
  // passage a bougé : le cache de routage ne décrit plus la tournée.
  function apresChangementDePile(avant) {
    suivreEmpilementDansLaPreparation(avant);
    casierIndex = 0;
    prepZoneIndex = 0;
    tourneeIndex = 0;
    Parcours.viderCacheRoute();
    renderSearch();
    renderPrep();
    renderSuivi();
  }

  function deplacerFichierDansLaPile(id, delta) {
    if (!S.deplacerFichier(id, delta)) return;
    apresChangementDePile(etatEmpilement());
    refreshPileFichiers();
  }

  function retirerFichierDeLaPile(id) {
    var avant = etatEmpilement();
    if (!confirmAction("Retirer le fichier « " + id + " » et toutes ses adresses de la tournée ?")) return;
    var perdues = S.retirerFichier(id);
    showAdminStatus("ok", "Fichier « " + id + " » retiré : " + perdues + " adresse(s).");
    apresChangementDePile(avant);
    refreshCommuneColors();
    refreshPileFichiers();
    refreshTraceEtat();
    refreshExportSelection();
  }

  // La carte d'un fichier se feuillette comme les colonnes du casier : deux
  // flèches, et le balayage sous le pouce.
  var fichierSwipeStartX = null;
  var fichierSwipeStartY = null;

  function bindPileFichiers() {
    var carte = document.getElementById("fichierCardSwipe");
    if (!carte) return;

    carte.querySelectorAll("input.pile-couleur").forEach(function (el) {
      el.addEventListener("change", function () {
        S.setTourneeColor(el.getAttribute("data-fichier"), el.value);
        // La carte du parcours se redessine chaque fois qu'on y revient : elle
        // prendra la nouvelle couleur sans qu'on la force d'ici.
        parcoursDernier = null;
      });
    });

    carte.querySelectorAll("input[data-zone]").forEach(function (el) {
      el.addEventListener("change", function () {
        S.setZoneIntegree(el.getAttribute("data-zone-fichier"), el.getAttribute("data-zone"), el.checked);
        apresChangementDeZones();
      });
    });

    carte.addEventListener("touchstart", function (ev) {
      var t = ev.changedTouches[0];
      fichierSwipeStartX = t.clientX;
      fichierSwipeStartY = t.clientY;
    }, { passive: true });
    carte.addEventListener("touchend", function (ev) {
      if (fichierSwipeStartX === null) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - fichierSwipeStartX;
      var dy = t.clientY - fichierSwipeStartY;
      fichierSwipeStartX = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      naviguerFichier(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function naviguerFichier(delta) {
    fichierIndex += delta;
    refreshPileFichiers();
  }

  // Une case entre ou sort de la tournée : l'ordre, le casier, la préparation et
  // la trace en dépendent tous. On les rafraîchit ensemble.
  function apresChangementDeZones() {
    casierIndex = 0;
    prepZoneIndex = 0;
    tourneeIndex = 0;
    parcoursDernier = null;
    Parcours.viderCacheRoute();
    refreshTraceEtat();
    renderSearch();
    renderPrep();
    renderSuivi();
  }

  function basculerZonesColonne(id, col, toutesCochees) {
    S.colonnesDuFichier(id).forEach(function (c) {
      if (c.c !== Number(col)) return;
      c.zones.forEach(function (z) { S.setZoneIntegree(id, z.cle, !toutesCochees); });
    });
    apresChangementDeZones();
    refreshFichierZones();
  }

  function basculerToutesZones(id, toutesCochees) {
    S.zonesDuFichier(id).forEach(function (z) { S.setZoneIntegree(id, z.cle, !toutesCochees); });
    apresChangementDeZones();
    refreshFichierZones();
  }

  function bindCommuneColorEvents() {
    document.querySelectorAll("#communeColors input[type=color]").forEach(function (el) {
      el.addEventListener("change", function () {
        S.setCommuneColor(el.getAttribute("data-commune"), el.value);
        renderSearch();
      });
    });
  }

  // La liste des couleurs ne connaît que les communes chargées. Comme l'import,
  // l'exemple et la remise à zéro se déclenchent désormais sans quitter les
  // réglages, la section Apparence se remet à jour derrière eux.
  function refreshCommuneColors() {
    var wrap = document.getElementById("communeColors");
    if (!wrap) return;
    wrap.innerHTML = communeColorRowsHTML();
    bindCommuneColorEvents();
  }

  // ---------------------------------------------------------------------
  // Délégation d'événements globale
  // ---------------------------------------------------------------------
  function handleClick(e) {
    var actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    var action = actionEl.getAttribute("data-action");
    var row;

    switch (action) {
      case "open-fiche":
        openFiche(actionEl.getAttribute("data-id"));
        break;
      case "back-to-search":
        showView("search");
        break;
      case "edit-fiche":
        enterEdit();
        break;
      case "cancel-edit":
        cancelEdit();
        break;
      case "save-fiche":
        saveFiche();
        break;
      case "delete-fiche":
        row = S.findRow(currentFicheId);
        if (row && confirmAction("Supprimer définitivement cette adresse ?")) {
          S.deleteRow(currentFicheId);
          toast("Adresse supprimée.", "ok");
          showView("search");
          renderSearch();
        }
        break;
      case "add-chip":
        addChip();
        break;
      case "remove-chip":
        removeChip(Number(actionEl.getAttribute("data-idx")));
        break;
      case "ma-position":
        useMyPosition(ficheEditing);
        break;
      case "itineraire":
        row = S.findRow(currentFicheId);
        if (row) openItineraire(row);
        break;
      case "voir-carte":
        row = S.findRow(currentFicheId);
        if (row) voirSurCarte(row);
        break;
      case "geocoder":
        runGeocode();
        break;
      case "pick-geocode":
        pickGeocodeResult(Number(actionEl.getAttribute("data-idx")));
        break;
      case "admin-export":
        exportCSV();
        break;
      case "admin-export-trace":
        exportGeoJSONAdmin();
        break;
      case "admin-construire-trace":
        construireTraceDepuisAdmin();
        break;
      case "fichier-prec":
        naviguerFichier(-1);
        break;
      case "fichier-suiv":
        naviguerFichier(1);
        break;
      case "fichier-zones-colonne":
        basculerZonesColonne(actionEl.getAttribute("data-id"),
          actionEl.getAttribute("data-col"), actionEl.getAttribute("data-etat") === "1");
        break;
      case "export-toutes":
        basculerToutExport(actionEl.getAttribute("data-etat") === "1");
        break;
      case "fichier-zones-toutes":
        basculerToutesZones(actionEl.getAttribute("data-id"), actionEl.getAttribute("data-etat") === "1");
        break;
      case "fichier-monter":
        deplacerFichierDansLaPile(actionEl.getAttribute("data-id"), -1);
        break;
      case "fichier-descendre":
        deplacerFichierDansLaPile(actionEl.getAttribute("data-id"), 1);
        break;
      case "fichier-retirer":
        retirerFichierDeLaPile(actionEl.getAttribute("data-id"));
        break;
      case "admin-sample":
        if (S.getRows().length && !confirmAction("Remplacer les données actuelles par l'exemple ?")) return;
        var avantExemple = etatEmpilement();
        var res = S.importFromCSV(SAMPLE_CSV, { nomFichier: "exemple.csv" });
        showAdminStatus("ok", "Exemple chargé (" + res.count + " lignes).");
        casierIndex = 0;
        prepZoneIndex = 0;
        suivreEmpilementDansLaPreparation(avantExemple);
        refreshCommuneColors();
        refreshPileFichiers();
        refreshTraceEtat();
        refreshExportSelection();
        renderSearch();
        renderPrep();
        break;
      case "admin-clear":
        if (!confirmAction("Vider toutes les données locales ? Pense à exporter avant si besoin.")) return;
        var avantVidage = etatEmpilement();
        S.setRows([]);
        showAdminStatus("ok", "Données vidées.");
        casierIndex = 0;
        prepZoneIndex = 0;
        suivreEmpilementDansLaPreparation(avantVidage);
        refreshCommuneColors();
        refreshPileFichiers();
        refreshTraceEtat();
        refreshExportSelection();
        renderSearch();
        renderPrep();
        break;
      case "open-admin":
        openAdmin();
        break;
      case "close-admin":
        closeAdmin();
        break;
      case "add-new-address":
        var blank = S.blankRow();
        // Sous empilement, la nouvelle adresse naît dans la tournée que
        // l'utilisateur prépare — jamais dans celle que l'application avait en
        // tête. Le champ Tournée de la fiche reste là pour la déplacer.
        var tourneeNeuve = prepFichierCourant();
        if (tourneeNeuve) blank.id_tournee = tourneeNeuve;
        S.addRow(blank);
        openFiche(blank.id);
        enterEdit();
        break;
      case "prep-inc":
        prepAdjust(actionEl.getAttribute("data-id"), actionEl.getAttribute("data-type"), 1);
        break;
      case "prep-dec":
        prepAdjust(actionEl.getAttribute("data-id"), actionEl.getAttribute("data-type"), -1);
        break;
      case "prep-cible-effacer":
        prepViderCible();
        renderPrep();
        break;
      case "prep-zone-basculer":
        prepZoneBasculer(actionEl.getAttribute("data-cle"));
        break;
      case "prep-zone-colonne":
        prepZoneColonneBasculer();
        break;
      case "prep-zone-prev":
        prepZoneNav(-1);
        break;
      case "prep-zone-next":
        prepZoneNav(1);
        break;
      case "prep-remove":
        if (confirmAction("Retirer cette adresse de la préparation de tournée ?")) {
          Prep.remove(S.getIdTournee(), actionEl.getAttribute("data-id"));
          renderPrep();
        }
        break;
      case "casier-prev":
        casierNav(-1);
        break;
      case "casier-next":
        casierNav(1);
        break;
      case "suivi-resume-basculer":
        suiviResumeDeplie = !suiviResumeDeplie;
        renderSuiviProgress();
        break;
      case "tournee-prev":
        tourneeNav(-1);
        break;
      case "tournee-next":
        tourneeNav(1);
        break;
      case "addr-valider":
        addrValider(actionEl.getAttribute("data-id"));
        break;
      case "addr-abandonner":
        addrAbandonner(actionEl.getAttribute("data-id"));
        break;
      case "addr-naviguer":
        naviguerVers(actionEl.getAttribute("data-id"));
        break;
      case "addr-detail-basculer":
        addrDetailBasculer(actionEl.getAttribute("data-id"));
        break;
      case "etape-valider":
        etapeValider(actionEl.getAttribute("data-key"));
        break;
      case "etape-abandonner":
        etapeAbandonner(actionEl.getAttribute("data-key"));
        break;
      case "etape-rouvrir":
        etapeRouvrir(actionEl.getAttribute("data-key"));
        break;
      case "zone-std-itineraire":
        zoneStdItineraire(actionEl.getAttribute("data-key"));
        break;
      case "zone-std-valider":
        zoneStdValider(actionEl.getAttribute("data-key"));
        break;
      case "zone-std-abandonner":
        zoneStdAbandonner(actionEl.getAttribute("data-key"));
        break;
      case "std-num-valider":
        stdNumValider(actionEl.getAttribute("data-id"));
        break;
      case "tournee-terminer-ouvrir":
        ouvrirClotureSheet();
        break;
      case "cloture-note-basculer":
        clotureNoteBasculer(actionEl);
        break;
      case "tournee-terminer-confirmer":
        tourneeTerminerConfirmer();
        break;
      case "rapport-consulter":
        rapportConsulter(actionEl.getAttribute("data-id"));
        break;
      case "rapport-telecharger":
        rapportTelecharger(actionEl.getAttribute("data-id"));
        break;
      case "rapport-supprimer":
        rapportSupprimer(actionEl.getAttribute("data-id"));
        break;
      case "motif-pick":
        pickMotif(actionEl.getAttribute("data-motif"));
        break;
      case "sheet-close":
        // Seul un appui sur le fond (ou sur "Annuler") ferme le panneau.
        if (actionEl === e.target || actionEl.classList.contains("sheet-cancel")) closeSheet();
        break;
      case "toast-undo":
        runUndo();
        break;
      case "suggest-pick":
        pickSuggestion(actionEl.getAttribute("data-id"), actionEl.getAttribute("data-cible"));
        break;
      case "parcours-recentrer":
        Parcours.recentrer(M);
        break;
      case "parcours-basculer":
        parcoursDeplie = !parcoursDeplie;
        renderParcoursPanel(parcoursDernier, null);
        break;
      case "parcours-geocoder":
        geocoderParcours();
        break;
      case "parcours-construire":
        construireTraceDepuisCarte();
        break;
      case "parcours-export":
        exporterTrace();
        break;
      case "scan-open":
        // Le scan désigne une adresse et lui attribue ses objets sans quitter
        // la surcouche : la préparation, derrière, est tenue à jour au fur et
        // à mesure pour être prête dès la fermeture.
        Scan.open({
          onPick: function (id) { pickSuggestion(id, "prep"); },
          onAjout: function () { renderPrep(); }
        });
        break;
      case "scan-close":
        Scan.close();
        break;
      case "scan-pick":
        Scan.pick(actionEl.getAttribute("data-id"));
        break;
      case "scan-qty":
        Scan.ajusterQuantite(actionEl.getAttribute("data-type"),
          parseInt(actionEl.getAttribute("data-delta"), 10) || 0);
        break;
      case "scan-ajouter":
        Scan.ajouterALaTournee();
        break;
      case "scan-changer":
        Scan.changerAdresse();
        break;
      case "scan-capture":
        Scan.capturePhoto();
        break;
      case "scan-photo":
        Scan.modePhoto();
        break;
      case "scan-video":
        Scan.modeVideo();
        break;
      case "field-pick":
        pickFieldValue(actionEl.getAttribute("data-kind"), actionEl.getAttribute("data-value"));
        break;
      case "fusionner-adresse":
        fusionnerAvecAdresse(actionEl.getAttribute("data-id"));
        break;
      case "ajouter-destinataire":
        enterEdit();
        var chipInput = document.getElementById("chipInput");
        if (chipInput) chipInput.focus();
        break;
      case "prep-new-tournee":
        if (confirmAction('Vider la préparation de la tournée "' + S.getIdTournee() + '" ? Les adresses de la base ne sont pas affectées : seules les zones de courrier standard et les quantités d\'objets suivis sont effacées.')) {
          Prep.resetTournee(S.getIdTournee());
          prepZoneIndex = 0;
          renderPrep();
          tourneeIndex = 0;
          toast("Nouvelle tournée : préparation vidée.", "ok");
        }
        break;
    }
  }

  function telecharger(contenu, type, nom) {
    var blob = new Blob([contenu], { type: type + ";charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = nom;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportCSV() {
    var choisis = fichiersExportes();
    if (choisis && choisis.length === 0 && S.getFichiers().length > 1) {
      showAdminStatus("err", "Aucune tournée cochée : rien à exporter.");
      return;
    }
    var texte = S.exportCSVText(choisis);
    // Le compte annoncé est celui du fichier produit, pas celui de la base :
    // exporter une tournée sur trois et lire le total de la base ferait douter
    // de ce qu'on vient de télécharger.
    var lignes = Math.max(0, texte.split("\n").filter(Boolean).length - 1);
    var nom = (choisis && choisis.length === 1 ? choisis[0] : S.getIdTournee());
    telecharger(texte, "text/csv", nom + "_tournee_" + S.todayISO() + ".csv");
    showAdminStatus("ok", "Export généré (" + lignes + " ligne(s)" +
      (choisis && choisis.length ? " · " + choisis.join(", ") : "") + ").");
  }

  function exportGeoJSONAdmin() {
    showAdminStatus("", "Préparation de la trace…");
    Parcours.preparer().then(function () {
      var geo = Parcours.geojson();
      if (!geo.features.length) {
        showAdminStatus("warn", "Aucun segment traçable : les adresses n'ont pas encore de position.");
        return;
      }
      telecharger(
        JSON.stringify(geo, null, 2), "application/geo+json",
        S.getIdTournee() + "_trace_" + S.todayISO() + ".geojson");
      showAdminStatus("ok", "Trace exportée (" + geo.features.length + " segment(s)).");
    });
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    els.viewSearch = document.getElementById("view-search");
    els["view-search"] = els.viewSearch;
    els["view-map"] = document.getElementById("view-map");
    els["view-fiche"] = document.getElementById("view-fiche");
    els.viewFiche = els["view-fiche"];
    els.cardList = document.getElementById("cardList");
    els.searchBox = document.getElementById("searchBox");
    els.searchSuggest = document.getElementById("searchSuggest");
    els.prepSuggest = document.getElementById("prepSuggest");
    els.resultCount = document.getElementById("resultCount");
    els.emptyState = document.getElementById("emptyState");
    els.fab = document.getElementById("fab");
    els.dbSubNav = document.getElementById("dbSubNav");
    els.parcoursPanel = document.getElementById("parcoursPanel");
    els.casierBrowser = document.getElementById("casierBrowser");
    els.mainTabBar = document.getElementById("mainTabBar");
    els.adminOverlay = document.getElementById("adminOverlay");
    els.adminBody = document.getElementById("adminBody");
    els.toast = document.getElementById("toast");
    els.sheetOverlay = document.getElementById("sheetOverlay");
    els.sheetBody = document.getElementById("sheetBody");

    els.prepSearchBox = document.getElementById("prepSearchBox");
    els.btnScan = document.querySelector('[data-action="scan-open"]');
    els.prepList = document.getElementById("prepList");
    els.prepEmptyState = document.getElementById("prepEmptyState");
    els.prepTotals = document.getElementById("prepTotals");
    els.prepSubNav = document.getElementById("prepSubNav");
    els.prepModeNav = document.getElementById("prepModeNav");
    els.prepZonesTotals = document.getElementById("prepZonesTotals");
    els.prepZonesWrap = document.getElementById("prepZonesWrap");
    els.prepCommuneSummary = document.getElementById("prepCommuneSummary");

    els.suiviProgress = document.getElementById("suiviProgress");
    els.suiviSubNav = document.getElementById("suiviSubNav");
    els.suiviTourneeWrap = document.getElementById("suiviTourneeWrap");
    els.suiviGeoStatus = document.getElementById("suiviGeoStatus");
    els.suiviMapContainer = document.getElementById("suiviMapContainer");
    els.suiviProximityList = document.getElementById("suiviProximityList");
    els.suiviEmptyState = document.getElementById("suiviEmptyState");

    document.body.addEventListener("click", function (e) {
      // Un clic ailleurs referme les propositions d'autocomplétion.
      if (!e.target.closest(".search-wrap")) { closeSuggest("db"); closeSuggest("prep"); closeFieldSuggests(); }
      handleClick(e);
      if (e.target.closest("[data-dbview]")) showView(e.target.closest("[data-dbview]").getAttribute("data-dbview"));
      if (e.target.closest("[data-mainpage]")) showMainPage(e.target.closest("[data-mainpage]").getAttribute("data-mainpage"));
      if (e.target.closest("[data-prepmode]")) setPrepMode(e.target.closest("[data-prepmode]").getAttribute("data-prepmode"));
      if (e.target.closest("[data-prepfilter]")) setPrepFilter(e.target.closest("[data-prepfilter]").getAttribute("data-prepfilter"));
      if (e.target.closest("[data-suivitab]")) setSuiviTab(e.target.closest("[data-suivitab]").getAttribute("data-suivitab"));
    });

    // Champs assistés de la fiche : le formulaire étant re-rendu, on délègue.
    els.viewFiche.addEventListener("input", function (e) {
      var kind = e.target.getAttribute && e.target.getAttribute("data-suggest");
      if (kind) { renderFieldSuggest(kind); renderDupNotice(); }
    });
    els.viewFiche.addEventListener("focusin", function (e) {
      // Appuyer sur une proposition lui donne le focus avant que le clic
      // n'aboutisse : fermer la liste ici la ferait disparaître sous le doigt.
      if (e.target.closest && e.target.closest(".suggest")) return;
      var kind = e.target.getAttribute && e.target.getAttribute("data-suggest");
      if (kind) renderFieldSuggest(kind);
      else closeFieldSuggests();
    });

    els.searchBox.addEventListener("input", function () { renderSearch(); renderSuggest("db"); });
    // Toute nouvelle saisie relâche la cible : on repart d'une recherche libre.
    els.prepSearchBox.addEventListener("input", function () {
      prepViderCible();
      renderPrep();
      renderSuggest("prep");
    });
    els.searchBox.addEventListener("focus", function () { renderSuggest("db"); });
    els.prepSearchBox.addEventListener("focus", function () { renderSuggest("prep"); });

    // Application masquée (écran éteint, autre onglet, appel entrant) : le GPS
    // n'a plus personne à renseigner, il s'arrête. Il repart au retour.
    document.addEventListener("visibilitychange", function () { majSuiviWatch(); });

    var adminObserver = new MutationObserver(function () {
      // admGeocodage est présent dans les deux dispositions du panneau, avec ou
      // sans empilement : c'est lui qui dit que le corps vient d'être rendu.
      if (els.adminOverlay.classList.contains("open") && document.getElementById("admGeocodage")) {
        bindAdminEvents();
      }
    });
    adminObserver.observe(els.adminBody, { childList: true });

    S.load();
    Prep.load();
    document.getElementById("headerSub").textContent = S.getIdTournee();
    renderSearch();
    showView("search");
    showMainPage("db");
  }

  function refreshHeader() {
    document.getElementById("headerSub").textContent = S.getIdTournee();
  }

  return { init: init };
})();
