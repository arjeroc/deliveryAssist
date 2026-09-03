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
  var M = window.MapView.create();       // carte de la Base de données
  var suiviMap = window.MapView.create(); // carte du Suivi tournée (instance indépendante)

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
  // Navigation — 3 pages principales (Base de données / Préparation / Suivi),
  // et à l'intérieur de la Base de données : Recherche / Carte / Fiche.
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
      if (suiviTab === "proximite") {
        suiviMap.invalidateSize();
        dessinerTraceSuivi();
      }
      startSuiviWatch();
      renderSuivi();
    } else {
      stopSuiviWatch();
    }
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
  // Onglet Carte — parcours de tournée reconstruit, ou nuage d'adresses
  // ---------------------------------------------------------------------
  var mapMode = "parcours";      // 'parcours' | 'points'
  var parcoursDeplie = false;    // résumé replié par défaut
  var parcoursDernier = null;

  function setMapView(mode) {
    mapMode = mode;
    els.mapSubNav.querySelectorAll("[data-mapview]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-mapview") === mode);
    });
    renderMapView();
  }

  function renderMapView() {
    if (mapMode === "points") {
      Parcours.effacer(M);
      els.parcoursPanel.innerHTML = "";
      M.renderAll(S.getRows());
      return;
    }
    M.renderPoints([], {});   // libère les marqueurs du mode adresses
    renderParcoursPanel(null, "Reconstruction du parcours…");
    Parcours.afficher(M, {
      onSelect: function (id) { openFiche(id); }
    }).then(function (res) {
      parcoursDernier = res;
      renderParcoursPanel(res, null);
    });
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
    var metres = Parcours.distanceRoutee(res.trace);
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
              '<div class="pc-legende">' +
                legendeItem("reel", p.reel + " GPS relevé(s)") +
                legendeItem("geocode", p.geocode + " géocodée(s)") +
                legendeItem("approx", p.approx + " approchée(s)") +
                (r.etapesEstimees ? legendeItem("estime", r.etapesEstimees + " étape(s) estimée(s)") : "") +
              '</div>' +
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
      Parcours.effacer(suiviMap); // la trace du Suivi sera refaite à la prochaine visite
    }).catch(function () {
      toast("Géocodage indisponible (pas de réseau ou service hors service).", "err");
      renderMapView();
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
      ? '<span class="tag tag-ok">' + escapeHtml(S.casierLabel(row)) + '</span>'
      : '<span class="tag tag-warn">Hors casier</span>';
    out += S.hasGPS(row)
      ? '<span class="tag tag-ok">📍 GPS</span>'
      : '<span class="tag tag-warn">⚠ GPS manquant</span>';
    if (row.geocode_statut === "geocode") out += '<span class="tag tag-info">à vérifier</span>';
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
      // enchaîne directement sur les compteurs lettres/colis.
      var row = S.findRow(id);
      if (!row) return;
      els.prepSearchBox.value = [row.numero, row.rue, row.commune].filter(Boolean).join(" ");
      renderPrep();
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
        '<div class="quick-actions">' +
          '<button data-action="voir-carte" ' + (S.hasGPS(row) ? "" : "disabled") + '>📍 Voir sur carte</button>' +
          '<button data-action="ma-position">🎯 Ma position</button>' +
          '<button data-action="itineraire" ' + (S.hasGPS(row) ? "" : "disabled") + '>🧭 Itinéraire</button>' +
        '</div>' +
      '</section>' +

      '<section class="fiche-section">' +
        '<h3>🗂️ Tri de tournée</h3>' +
        '<div class="kv"><span>Colonne</span><strong>' + (escapeHtml(row.casier_c) || "—") + '</strong></div>' +
        '<div class="kv"><span>Ligne</span><strong>' + (escapeHtml(row.casier_l) || "—") + '</strong></div>' +
        '<div class="kv"><span>Casier</span><strong>' + escapeHtml(S.casierLabel(row)) + '</strong></div>' +
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
  function useMyPosition(targetIsDraft) {
    if (!navigator.geolocation) { toast("Géolocalisation non disponible sur cet appareil.", "err"); return; }
    toast("Recherche de la position…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude.toFixed(6), lon = pos.coords.longitude.toFixed(6);
      if (targetIsDraft) {
        editDraft.latitude = lat; editDraft.longitude = lon; editDraft.geocode_statut = "verifie";
        renderFicheEdit(editDraft);
      } else {
        S.updateRow(currentFicheId, { latitude: lat, longitude: lon, geocode_statut: "verifie" });
        renderFicheView(S.findRow(currentFicheId));
      }
      toast("Position enregistrée.", "ok");
    }, function (err) {
      toast("Impossible d'obtenir la position (" + err.message + ").", "err");
    }, { enableHighAccuracy: true, timeout: 8000 });
  }

  function openItineraire(row) {
    if (!S.hasGPS(row)) return;
    var url = "https://www.google.com/maps/dir/?api=1&destination=" + row.latitude + "," + row.longitude;
    window.open(url, "_blank");
  }

  function voirSurCarte(row) {
    if (!S.hasGPS(row)) return;
    showView("map");
    setTimeout(function () { M.focusRow(row.id); }, 120);
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
  // Page 2 — Préparation tournée (lettres/colis du jour, séparés de la base)
  // ---------------------------------------------------------------------
  var prepFilter = "toutes"; // 'toutes' | 'tournee'

  function setPrepFilter(f) {
    prepFilter = f;
    els.prepSubNav.querySelectorAll("[data-prepfilter]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-prepfilter") === f);
    });
    renderPrep();
  }

  function prepCardHTML(row, entry, query) {
    var names = S.namesOf(row);
    var title = names.length ? names.map(function (n) { return highlight(n, query); }).join(" / ") : "(sans nom)";
    var addr = [row.numero, row.rue].filter(Boolean).join(" ");
    var contexte = [addr, S.communeLabelOf(row), S.casierLabel(row)].filter(Boolean).join(" · ");
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
        '<span class="commune-summary-figures">' + t.adresses + ' adr. ' + itemBadgesHTML(t) + '</span>' +
      '</div>';
    }).join("") + '</div>';
  }

  function renderPrep() {
    var idT = S.getIdTournee();
    var totals = Prep.totals(idT);
    els.btnScan.style.display = (S.getSettings().scanActif === false) ? "none" : "block";
    els.prepTotals.innerHTML =
      '<div class="totals-line"><strong>' + totals.adresses + '</strong> adresse(s) · ' +
      Prep.TYPES.map(function (t) {
        return '<strong>' + totals[t.key] + '</strong> ' + t.icon;
      }).join(" · ") + '</div>' +
      '<div class="totals-sub">Tournée « ' + escapeHtml(idT) + ' »</div>';

    els.prepCommuneSummary.innerHTML = (prepFilter === "tournee") ? communeSummaryHTML(idT) : "";

    var q = els.prepSearchBox.value;
    var rows;
    if (prepFilter === "tournee") {
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
      els.prepList.innerHTML = rows.map(function (r) {
        return prepCardHTML(r, Prep.getEntry(idT, r.id), q);
      }).join("");
    }
  }

  // ---------------------------------------------------------------------
  // Page 3 — Suivi tournée (position actuelle, proximité, avancement)
  // ---------------------------------------------------------------------
  var suiviWatchId = null;
  var suiviUserPos = null;    // { lat, lon, accuracy }
  var suiviCentered = false;  // ne recentrer la carte qu'une seule fois sur le 1er relevé
  var suiviTab = "tournee";   // 'tournee' | 'proximite'

  function suiviGeoStatusHTML(text, kind) {
    return '<span class="' + (kind || "") + '">' + escapeHtml(text) + '</span>';
  }

  function setSuiviTab(tab) {
    suiviTab = tab;
    ["tournee", "proximite"].forEach(function (t) {
      document.getElementById("suivi-view-" + t).classList.toggle("active", t === tab);
    });
    els.suiviSubNav.querySelectorAll("[data-suivitab]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-suivitab") === tab);
    });
    if (tab === "proximite") {
      suiviMap.invalidateSize();
      dessinerTraceSuivi();
    }
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

  // Un item isolé : l'icône seule suffit. Plusieurs : le nombre devient une
  // pastille contrastée, parce que confondre 1 colis et 3 colis coûte un
  // deuxième passage.
  function itemBadgesHTML(entry) {
    return Prep.TYPES.map(function (t) {
      var n = entry[t.key] || 0;
      if (!n) return "";
      return '<span class="item-badge' + (n > 1 ? " multi" : "") + '" title="' + escapeHtml(n + " " + t.label) + '">' +
        '<span class="item-icon">' + t.icon + '</span>' +
        (n > 1 ? '<span class="item-count">' + n + '</span>' : "") +
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
    if (S.hasGPS(row)) {
      ouvrirItineraire(row.latitude + "," + row.longitude);
      return;
    }
    var dest = [row.numero, row.rue, row.code_postal, row.commune].filter(Boolean).join(" ");
    if (!dest) { toast("Cette adresse n'a ni GPS ni libellé exploitable.", "warn"); return; }
    ouvrirItineraire(dest);
  }

  // Itinéraire vers une zone : on vise sa première adresse localisée, à défaut
  // le nom de la rue.
  function naviguerVersZone(key) {
    var g = findGroup(key);
    if (!g) return;
    if (g.ancreId) { naviguerVers(g.ancreId); return; }
    var dest = [g.rue, g.commune].filter(Boolean).join(" ");
    if (!dest) { toast("Cette zone n'a pas de libellé exploitable.", "warn"); return; }
    ouvrirItineraire(dest);
  }

  function refreshSuiviAfterChange() {
    renderSuiviProgress();
    renderSuiviTournee();
    renderSuiviProximite();
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

  // ✓ et ⊘ font aussi office de retour arrière : ré-appuyer sur le bouton
  // actif remet l'adresse "à faire", sans passer par un menu.
  function addrValider(addrId) {
    var entry = Prep.getEntry(S.getIdTournee(), addrId);
    if (entry.statut === Prep.STATUTS.DISTRIBUE) {
      applyStatut([addrId], Prep.STATUTS.A_FAIRE, "", "Adresse remise à faire.");
    } else {
      applyStatut([addrId], Prep.STATUTS.DISTRIBUE, "", "Adresse distribuée.");
    }
  }

  function addrAbandonner(addrId) {
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
    var ids = sheetTarget.ids;
    var estZone = sheetTarget.scope === "zone";
    closeSheet();
    applyStatut(ids, Prep.STATUTS.ABANDONNE, motifKey,
      estZone ? ids.length + " adresse(s) abandonnée(s) — " + Prep.motifLabel(motifKey)
              : "Non distribuée — " + Prep.motifLabel(motifKey));
  }

  // --- onglet Tournée : cards par rue, parcourues dans l'ordre de la tournée ---
  var tourneeIndex = 0;
  var tourneeSwipeStartX = null;
  var tourneeSwipeStartY = null;

  function tourneeGroupKeyOf(row) {
    return (row.rue || "").trim().toUpperCase() + "|" + (row.commune || "").trim().toUpperCase();
  }

  function ordreDe(valeur) {
    return (valeur !== "" && valeur !== undefined && valeur !== null && !isNaN(Number(valeur))) ? Number(valeur) : null;
  }

  // Regroupe les adresses par rue, ordonnées comme la tournée (ordre_zone puis,
  // à égalité, nom de rue) ; à l'intérieur d'une rue, par ordre_rue puis numéro.
  //
  // En mode "distributions" on ne part que des adresses ayant des items ; en
  // mode "complete" on parcourt toute la base, ce qui fait apparaître les zones
  // de distribution standard, sans item enregistré.
  function buildTourneeGroups(idT) {
    var complet = S.getSettings().modeSuivi === "complete";
    var rows = complet
      ? S.getRows()
      : Prep.listEntries(idT).map(function (e) { return S.findRow(e.addressId); }).filter(Boolean);

    var groups = {};
    var order = [];
    rows.forEach(function (row) {
      var entry = Prep.getEntry(idT, row.id);
      var key = tourneeGroupKeyOf(row);
      if (!groups[key]) {
        groups[key] = {
          key: key, rue: row.rue || "(rue non renseignée)", commune: row.commune || "",
          lieuxDits: {}, ordreZone: null, items: [], autres: 0
        };
        order.push(key);
      }
      var g = groups[key];
      if (row.lieu_dit) g.lieuxDits[row.lieu_dit.trim()] = true;
      if (g.ordreZone === null) g.ordreZone = ordreDe(row.ordre_zone);
      // Dans une zone qui a des items, les adresses sans item resteraient du
      // bruit : on les compte sans les lister.
      if (Prep.countItems(entry) > 0) g.items.push({ row: row, entry: entry });
      else g.autres += 1;
    });

    var list = order.map(function (k) { return groups[k]; });
    list.forEach(function (g) {
      g.items.sort(function (a, b) {
        var oa = ordreDe(a.row.ordre_rue), ob = ordreDe(b.row.ordre_rue);
        if (oa === null) oa = Infinity;
        if (ob === null) ob = Infinity;
        if (oa !== ob) return oa - ob;
        return (Number(a.row.numero) || 0) - (Number(b.row.numero) || 0);
      });
      Prep.TYPES.forEach(function (t) {
        g[t.key] = g.items.reduce(function (s, it) { return s + it.entry[t.key]; }, 0);
      });
      g.distribuees = g.items.filter(function (it) { return it.entry.statut === Prep.STATUTS.DISTRIBUE; }).length;
      g.abandonnees = g.items.filter(function (it) { return it.entry.statut === Prep.STATUTS.ABANDONNE; }).length;
      g.restantes = g.items.length - g.distribuees - g.abandonnees;
      g.terminee = g.restantes === 0;
      // Zone de distribution standard : aucun item enregistré, donc rien à valider.
      g.standard = g.items.length === 0;
      // Le lieu-dit n'étiquette la zone que si toutes ses adresses le partagent.
      var lieux = Object.keys(g.lieuxDits);
      g.lieuDit = (lieux.length === 1 && g.autres + g.items.length > 0) ? lieux[0] : "";
      // Cible d'itinéraire : la première adresse localisée de la zone.
      var ancre = g.items.concat([]).map(function (it) { return it.row; })
        .concat(S.getRows().filter(function (r) { return tourneeGroupKeyOf(r) === g.key; }))
        .find(function (r) { return S.hasGPS(r); });
      g.ancreId = ancre ? ancre.id : null;
    });
    list.sort(function (a, b) {
      var za = a.ordreZone === null ? Infinity : a.ordreZone;
      var zb = b.ordreZone === null ? Infinity : b.ordreZone;
      if (za !== zb) return za - zb;
      return a.rue.localeCompare(b.rue, "fr");
    });
    return list;
  }

  function clampTourneeIndex(groups) {
    if (!groups.length) { tourneeIndex = 0; return; }
    if (tourneeIndex < 0) tourneeIndex = 0;
    if (tourneeIndex > groups.length - 1) tourneeIndex = groups.length - 1;
  }

  function tourneeAddrRowHTML(item) {
    var names = S.namesOf(item.row).join(" / ") || "(sans nom)";
    var label = [item.row.numero, names].filter(Boolean).join(" — ");
    var meta = itemBadgesHTML(item.entry);
    if (item.entry.statut === Prep.STATUTS.ABANDONNE) {
      meta += '<span class="addr-motif">⊘ ' + escapeHtml(Prep.motifLabel(item.entry.motif)) + '</span>';
    }
    return '<div class="tournee-addr-row is-' + item.entry.statut + '">' +
      '<div class="tournee-addr-main">' +
        '<div class="tournee-addr-name">' + escapeHtml(label) + '</div>' +
        (meta ? '<div class="tournee-addr-meta">' + meta + '</div>' : "") +
      '</div>' +
      addrActionsHTML(item.row.id, item.entry) +
    '</div>';
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

  function zoneTotauxHTML(g) {
    var faux = {};
    Prep.TYPES.forEach(function (t) { faux[t.key] = g[t.key]; });
    return itemBadgesHTML(faux);
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

  function zoneActionsHTML(g) {
    var key = escapeHtml(g.key);
    // Zone de distribution standard : rien à valider, seulement s'y rendre.
    if (g.standard) return "";
    if (g.terminee) {
      return '<div class="zone-actions">' +
        '<button class="zone-btn reopen" data-action="zone-rouvrir" data-key="' + key + '">↺ Rouvrir la zone</button>' +
      '</div>';
    }
    return '<div class="zone-actions">' +
      '<button class="zone-btn stop" data-action="zone-abandonner" data-key="' + key + '">⊘ Abandonner</button>' +
      '<button class="zone-btn ok" data-action="zone-valider" data-key="' + key + '">✓ Valider la zone</button>' +
    '</div>';
  }

  function renderSuiviTournee() {
    var idT = S.getIdTournee();
    var groups = buildTourneeGroups(idT);
    clampTourneeIndex(groups);

    if (!groups.length) {
      els.suiviTourneeWrap.innerHTML = '<div class="tournee-empty">' +
        (S.getSettings().modeSuivi === "complete"
          ? "Aucune adresse dans la base. Importe un CSV depuis les réglages (⚙️)."
          : "Aucun item à distribuer. Ajoute des lettres, colis ou presse depuis la page Préparation, ou passe en « Tournée complète » dans les réglages.") +
      '</div>';
      return;
    }

    var g = groups[tourneeIndex];
    els.suiviTourneeWrap.innerHTML =
      '<div class="tournee-nav">' +
        '<button class="tournee-nav-btn" data-action="tournee-prev" ' + (tourneeIndex === 0 ? "disabled" : "") + ' aria-label="Rue précédente">‹</button>' +
        '<div class="tournee-index">Rue ' + (tourneeIndex + 1) + ' / ' + groups.length + '</div>' +
        '<button class="tournee-nav-btn" data-action="tournee-next" ' + (tourneeIndex === groups.length - 1 ? "disabled" : "") + ' aria-label="Rue suivante">›</button>' +
      '</div>' +
      '<div class="tournee-card' + (g.standard ? " zone-standard" : "") + '" id="tourneeCardSwipe">' +
        '<div class="tournee-card-head">' +
          (g.commune ? '<span class="commune-dot" style="background:' + S.getCommuneColor(g.commune) + ';"></span>' : "") +
          '<div class="tournee-card-title">' + escapeHtml(g.rue) + '</div>' +
          '<button class="addr-btn nav zone-nav" data-action="zone-naviguer" data-key="' + escapeHtml(g.key) + '" aria-label="Se rendre dans cette zone">🧭</button>' +
        '</div>' +
        (g.commune ? '<div class="tournee-card-sub">' + escapeHtml(S.communeLabel(g.commune, g.lieuDit)) + '</div>' : "") +
        (g.standard
          ? '<div class="zone-standard-line"><span class="tag">Distribution standard</span>' +
              (g.autres ? '<span class="muted small">' + g.autres + ' adresse(s)</span>' : "") +
            '</div>'
          : '<div class="tournee-card-figures">' + zoneTotauxHTML(g) + '</div>' +
            zoneProgressHTML(g) +
            '<div class="tournee-addr-list">' + g.items.map(tourneeAddrRowHTML).join("") + '</div>' +
            (g.autres ? '<div class="zone-autres">+ ' + g.autres + ' adresse(s) en distribution standard</div>' : "")) +
        zoneActionsHTML(g) +
      '</div>';

    bindTourneeSwipe();
  }

  function tourneeNav(delta) {
    var groups = buildTourneeGroups(S.getIdTournee());
    tourneeIndex += delta;
    clampTourneeIndex(groups);
    renderSuiviTournee();
  }

  function findGroup(key) {
    return buildTourneeGroups(S.getIdTournee()).filter(function (g) { return g.key === key; })[0];
  }

  function idsRestants(g) {
    return g.items.filter(function (it) { return it.entry.statut === Prep.STATUTS.A_FAIRE; })
                  .map(function (it) { return it.row.id; });
  }

  // Une action de masse ne demande confirmation qu'à partir de deux adresses :
  // en dessous, l'annulation proposée dans le toast suffit largement.
  function zoneValider(key) {
    var g = findGroup(key);
    if (!g) return;
    var ids = idsRestants(g);
    if (!ids.length) return;
    if (ids.length > 1 && !confirmAction("Marquer les " + ids.length + " adresses restantes de " + g.rue + " comme distribuées ?")) return;
    applyStatut(ids, Prep.STATUTS.DISTRIBUE, "", ids.length + " adresse(s) distribuée(s).");
  }

  function zoneAbandonner(key) {
    var g = findGroup(key);
    if (!g) return;
    var ids = idsRestants(g);
    if (!ids.length) return;
    openMotifSheet("Abandonner la zone", ids.length + " adresse(s) restante(s) — " + g.rue, { scope: "zone", ids: ids });
  }

  function zoneRouvrir(key) {
    var g = findGroup(key);
    if (!g) return;
    var ids = g.items.map(function (it) { return it.row.id; });
    if (!confirmAction("Remettre les " + ids.length + " adresses de " + g.rue + " à faire ?")) return;
    applyStatut(ids, Prep.STATUTS.A_FAIRE, "", "Zone rouverte.");
  }

  function startSuiviWatch() {
    if (!navigator.geolocation) {
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Géolocalisation non disponible sur cet appareil.", "tag-warn");
      return;
    }
    if (suiviWatchId !== null) return;
    els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Recherche de la position…");
    suiviWatchId = navigator.geolocation.watchPosition(function (pos) {
      suiviUserPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("📡 Position à jour (précision ~" + Math.round(pos.coords.accuracy || 0) + " m)");
      if (!suiviCentered) {
        suiviMap.centerOn(suiviUserPos.lat, suiviUserPos.lon, 15);
        suiviCentered = true;
      }
      renderSuivi();
    }, function (err) {
      els.suiviGeoStatus.innerHTML = suiviGeoStatusHTML("Position indisponible (" + err.message + ").", "tag-warn");
    }, { enableHighAccuracy: true, maximumAge: 8000, timeout: 15000 });
  }

  function stopSuiviWatch() {
    if (suiviWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(suiviWatchId);
      suiviWatchId = null;
    }
  }

  function zoneFor(distanceM) {
    var s = S.getSettings();
    if (distanceM <= s.rayonImmediat) return { key: "immediat", label: "Immédiat", color: "#e63946" };
    if (distanceM <= s.rayonProche) return { key: "proche", label: "Proche", color: "#f4b400" };
    if (distanceM <= s.rayonEloigne) return { key: "eloigne", label: "Éloigné", color: "#6b7268" };
    return null; // hors zone : pas affiché dans la liste de proximité
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
          (item.zone ? '<span class="proximity-dist zone-' + item.zone.key + '">' + fmtDistance(item.distance) + '</span>' : '') +
        '</div>' +
        '<div class="proximity-foot">' +
          '<div class="proximity-objects">' + objets + '</div>' +
          addrActionsHTML(row.id, entry) +
        '</div>' +
      '</div>'
    );
  }

  function renderSuiviProgress() {
    var p = Prep.progress(S.getIdTournee());
    var a = p.adresses;
    var pctDist = a.total ? (a.distribuees / a.total) * 100 : 0;
    var pctAband = a.total ? (a.abandonnees / a.total) * 100 : 0;
    function ligne(libelle, bag, classe) {
      var badges = itemBadgesHTML(bag);
      return '<div class="suivi-progress-row' + (classe === "total" ? " total" : "") + '">' +
        '<span>' + libelle + '</span>' +
        '<span class="' + (classe === "total" ? "" : classe) + '">' + (badges || '<span class="muted">—</span>') + '</span>' +
      '</div>';
    }
    els.suiviProgress.innerHTML =
      ligne("Tournée", p.total, "total") +
      ligne("Distribués", p.distribues, "ok") +
      (a.abandonnees ? ligne("Non distribués", p.abandonnes, "skipped") : "") +
      ligne("Restants", p.restants, "pending") +
      '<div class="suivi-progressbar">' +
        '<div class="suivi-progressbar-fill" style="width:' + pctDist + '%;"></div>' +
        '<div class="suivi-progressbar-skip" style="width:' + pctAband + '%;"></div>' +
      '</div>' +
      '<div class="suivi-progress-addr">' + a.distribuees + " / " + a.total + ' adresses distribuées' +
        (a.abandonnees ? ' · ' + a.abandonnees + ' abandonnée(s)' : "") + '</div>';
  }

  function renderSuivi() {
    renderSuiviProgress();
    renderSuiviTournee();
    renderSuiviProximite();
  }

  function renderSuiviProximite() {
    var idT = S.getIdTournee();
    var entries = Prep.listEntries(idT);
    var withGPS = [], withoutGPS = 0, horsZone = 0;

    entries.forEach(function (e) {
      var row = S.findRow(e.addressId);
      if (!row) return;
      if (!S.hasGPS(row)) { withoutGPS++; return; }
      var item = { row: row, entry: e };
      if (suiviUserPos) {
        item.distance = MapView.distanceMeters(suiviUserPos.lat, suiviUserPos.lon, Number(row.latitude), Number(row.longitude));
        item.zone = zoneFor(item.distance);
        if (!item.zone) { horsZone++; return; }
      }
      withGPS.push(item);
    });

    if (suiviUserPos) withGPS.sort(function (a, b) { return a.distance - b.distance; });

    // --- carte ---
    suiviMap.ensureMap("suiviMapContainer");
    var points = withGPS.map(function (item) {
      var color = "#6b7268";
      if (item.entry.statut === Prep.STATUTS.DISTRIBUE) color = "#2f6b4f";
      else if (item.entry.statut === Prep.STATUTS.ABANDONNE) color = "#a15c00";
      else if (item.zone) color = item.zone.color;
      var names = S.namesOf(item.row).join(" / ") || "(sans nom)";
      return {
        id: item.row.id, lat: Number(item.row.latitude), lon: Number(item.row.longitude), color: color,
        popupHtml: "<strong>" + names + "</strong><br>" + objetsTexte(item.entry)
      };
    });
    suiviMap.renderPoints(points, { fit: !suiviUserPos && points.length > 0 });
    if (suiviUserPos) {
      suiviMap.setUserMarker(suiviUserPos.lat, suiviUserPos.lon);
      var s = S.getSettings();
      suiviMap.drawRadiusCircles(suiviUserPos.lat, suiviUserPos.lon, [
        { meters: s.rayonImmediat, color: "#e63946" },
        { meters: s.rayonProche, color: "#f4b400" },
        { meters: s.rayonEloigne, color: "#6b7268" }
      ]);
    }

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
    if (!withGPS.length) {
      els.suiviProximityList.innerHTML = "";
      els.suiviEmptyState.style.display = "block";
      els.suiviEmptyState.textContent = "Aucune adresse à proximité pour l'instant" +
        (horsZone ? " (" + horsZone + " adresse(s) au-delà de " + fmtDistance(S.getSettings().rayonEloigne) + ")" : "") +
        (withoutGPS ? " · " + withoutGPS + " adresse(s) sans coordonnées GPS" : "") + ".";
      return;
    }
    els.suiviEmptyState.style.display = "none";
    var note = "";
    if (horsZone || withoutGPS) {
      note = '<div class="empty" style="padding:10px;">' +
        (horsZone ? horsZone + " adresse(s) au-delà de " + fmtDistance(S.getSettings().rayonEloigne) + ". " : "") +
        (withoutGPS ? withoutGPS + " adresse(s) sans coordonnées GPS." : "") +
      '</div>';
    }
    els.suiviProximityList.innerHTML = withGPS.map(proximityCardHTML).join("") + note;
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

  function renderAdmin() {
    var s = S.getSettings();
    els.adminBody.innerHTML =
      '<div class="field"><label>Identifiant de tournée</label><input type="text" id="admIdTournee" value="' + escapeHtml(S.getIdTournee()) + '"></div>' +
      '<div class="field"><label>Importer un fichier CSV</label><input type="file" id="admFileInput" accept=".csv,text/csv"></div>' +
      '<div class="toolbar">' +
        '<button class="primary" data-action="admin-export">Exporter le CSV</button>' +
        '<button data-action="admin-sample">Charger un exemple</button>' +
        '<button class="danger" data-action="admin-clear">Vider les données</button>' +
      '</div>' +
      '<div id="adminStatus"></div>' +
      '<hr>' +
      '<label class="switch-row"><input type="checkbox" id="admGeocodage" ' + (s.geocodageActif ? "checked" : "") + '> Activer le géocodage automatique (API adresse gouvernementale)</label>' +
      '<label class="switch-row"><input type="checkbox" id="admScan" ' + (s.scanActif !== false ? "checked" : "") + '> Scan d\'étiquette par la caméra (expérimental)</label>' +
      '<label class="switch-row"><input type="checkbox" id="admAdressesCarte" ' + (s.afficherAdressesCarte === true ? "checked" : "") + '> Afficher les adresses sur la carte (au zoom rapproché)</label>' +
      '<hr>' +
      '<div class="fieldset-title">Couleurs par commune</div>' +
      '<div id="communeColors">' + communeColorRowsHTML() + '</div>' +
      '<hr>' +
      '<div class="fieldset-title">Mode de suivi de la tournée</div>' +
      '<div class="field">' +
        '<select id="admModeSuivi">' +
          '<option value="distributions"' + (s.modeSuivi !== "complete" ? " selected" : "") + '>Suivi des distributions (recommandé)</option>' +
          '<option value="complete"' + (s.modeSuivi === "complete" ? " selected" : "") + '>Tournée complète</option>' +
        '</select>' +
      '</div>' +
      '<small class="hint">« Suivi des distributions » n\'affiche que les zones ayant des items à distribuer. ' +
      '« Tournée complète » montre aussi les zones de distribution standard, sans item enregistré.</small>' +
      '<hr>' +
      '<div class="fieldset-title">Rayons de proximité (Suivi tournée)</div>' +
      '<div class="radius-settings">' +
        '<div class="field"><label>🔴 Immédiat (mètres)</label><input type="number" min="1" id="admRayonImmediat" value="' + s.rayonImmediat + '"></div>' +
        '<div class="field"><label>🟡 Proche (mètres)</label><input type="number" min="1" id="admRayonProche" value="' + s.rayonProche + '"></div>' +
        '<div class="field"><label>⚪ Éloigné (mètres, au-delà = masqué)</label><input type="number" min="1" id="admRayonEloigne" value="' + s.rayonEloigne + '"></div>' +
      '</div>' +
      '<small class="hint">Séparateur des noms multiples&nbsp;: <code>|</code>. Les données restent uniquement dans ce navigateur.</small>';
  }

  function showAdminStatus(kind, text) {
    var el = document.getElementById("adminStatus");
    if (!el) return;
    el.innerHTML = text ? '<div class="status ' + kind + '">' + escapeHtml(text) + '</div>' : "";
  }

  var SAMPLE_CSV =
'id,id_tournee,nom_famille,numero,rue,code_postal,commune,lieu_dit,latitude,longitude,geocode_statut,casier_c,casier_l,ordre_zone,ordre_rue,position_manuelle,type_objet,notes,stoppub,date_maj\n' +
'tm002-0001,tm002,MOODY,5,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,45.6155,0.4801,manuel,"1","1",1,1,,lettre,,false,\n' +
'tm002-0002,tm002,OBZAI|NONNIN|DELAUGE|DELMOTTE,9-2,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,,,,"1","1",1,2,,lettre,,true,\n' +
'tm002-0003,tm002,NEBOUT,8,RUE DU MEMORIAL,16260,CHASSENEUIL-SUR-BONNIEURE,,45.6152,0.4801,manuel,"1","1",1,3,,lettre,batterie,false,\n' +
'tm002-0004,tm002,CHEZ FOUR,4,ROUTE DU PUITS,16700,LA TACHE,Chez Four,45.6180,0.4801,manuel,,,30,1,,lettre,,false,\n' +
'tm002-0005,tm002,CHEZ FOUR,3,ROUTE DU PUITS,16700,LA TACHE,Chez Four,45.6250,0.4801,manuel,,,30,2,,lettre,,true,\n' +
'tm002-0006,tm002,CHEZ FOUR,1,ROUTE DU PUITS,16700,LA TACHE,Chez Four,,,,,,30,3,,lettre,,false,\n';

  function bindAdminEvents() {
    document.getElementById("admIdTournee").addEventListener("change", function (e) {
      S.setIdTournee(e.target.value.trim());
      refreshHeader();
      renderPrep();
      suiviCentered = false;
      tourneeIndex = 0;
      renderSuivi();
    });
    document.getElementById("admFileInput").addEventListener("change", function (ev) {
      var file = ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var res = S.importFromCSV(String(reader.result));
        if (!res.ok) { showAdminStatus("err", res.message); return; }
        var msg = "Import : " + res.count + " ligne(s).";
        if (res.missingCols.length) msg += " Colonnes absentes : " + res.missingCols.join(", ") + ".";
        if (res.errors.length) msg += " " + res.errors.length + " erreur(s).";
        if (res.warnings.length) msg += " " + res.warnings.length + " avertissement(s).";
        showAdminStatus(res.errors.length ? "err" : (res.warnings.length ? "warn" : "ok"), msg);
        renderSearch();
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
    document.getElementById("admAdressesCarte").addEventListener("change", function (e) {
      S.setSetting("afficherAdressesCarte", e.target.checked);
      Parcours.rafraichirAffichage();
    });
    document.getElementById("admModeSuivi").addEventListener("change", function (e) {
      S.setSetting("modeSuivi", e.target.value);
      tourneeIndex = 0;
      renderSuivi();
    });
    [["admRayonImmediat", "rayonImmediat"], ["admRayonProche", "rayonProche"], ["admRayonEloigne", "rayonEloigne"]].forEach(function (pair) {
      document.getElementById(pair[0]).addEventListener("change", function (e) {
        var v = Math.max(1, Math.round(Number(e.target.value) || 1));
        S.setSetting(pair[1], v);
        e.target.value = v;
        renderSuivi();
      });
    });
    document.querySelectorAll("#communeColors input[type=color]").forEach(function (el) {
      el.addEventListener("change", function () {
        S.setCommuneColor(el.getAttribute("data-commune"), el.value);
        renderSearch();
      });
    });
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
      case "admin-sample":
        if (S.getRows().length && !confirmAction("Remplacer les données actuelles par l'exemple ?")) return;
        var res = S.importFromCSV(SAMPLE_CSV);
        showAdminStatus("ok", "Exemple chargé (" + res.count + " lignes).");
        renderSearch();
        break;
      case "admin-clear":
        if (!confirmAction("Vider toutes les données locales ? Pense à exporter avant si besoin.")) return;
        S.setRows([]);
        showAdminStatus("ok", "Données vidées.");
        renderSearch();
        break;
      case "open-admin":
        openAdmin();
        break;
      case "close-admin":
        closeAdmin();
        break;
      case "add-new-address":
        var blank = S.blankRow();
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
      case "prep-remove":
        if (confirmAction("Retirer cette adresse de la préparation de tournée ?")) {
          Prep.remove(S.getIdTournee(), actionEl.getAttribute("data-id"));
          renderPrep();
        }
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
      case "zone-valider":
        zoneValider(actionEl.getAttribute("data-key"));
        break;
      case "zone-abandonner":
        zoneAbandonner(actionEl.getAttribute("data-key"));
        break;
      case "zone-rouvrir":
        zoneRouvrir(actionEl.getAttribute("data-key"));
        break;
      case "zone-naviguer":
        naviguerVersZone(actionEl.getAttribute("data-key"));
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
      case "scan-open":
        // Le scan ne fait que désigner une adresse : il la cible dans la
        // préparation, où les compteurs sont déjà sous le pouce.
        Scan.open({ onPick: function (id) { pickSuggestion(id, "prep"); } });
        break;
      case "scan-close":
        Scan.close();
        break;
      case "scan-pick":
        Scan.pick(actionEl.getAttribute("data-id"));
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
        if (confirmAction('Vider la préparation de la tournée "' + S.getIdTournee() + '" ? Les adresses de la base ne sont pas affectées, seules les quantités lettres/colis sont effacées.')) {
          Prep.resetTournee(S.getIdTournee());
          renderPrep();
          tourneeIndex = 0;
          toast("Nouvelle tournée : préparation vidée.", "ok");
        }
        break;
    }
  }

  function exportCSV() {
    var csv = S.exportCSVText();
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = S.getIdTournee() + "_tournee_" + S.todayISO() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showAdminStatus("ok", "Export généré (" + S.getRows().length + " lignes).");
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
    els.mapSubNav = document.getElementById("mapSubNav");
    els.parcoursPanel = document.getElementById("parcoursPanel");
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
    els.prepCommuneSummary = document.getElementById("prepCommuneSummary");

    els.suiviProgress = document.getElementById("suiviProgress");
    els.suiviSubNav = document.getElementById("suiviSubNav");
    els.suiviTourneeWrap = document.getElementById("suiviTourneeWrap");
    els.suiviGeoStatus = document.getElementById("suiviGeoStatus");
    els.suiviProximityList = document.getElementById("suiviProximityList");
    els.suiviEmptyState = document.getElementById("suiviEmptyState");

    document.body.addEventListener("click", function (e) {
      // Un clic ailleurs referme les propositions d'autocomplétion.
      if (!e.target.closest(".search-wrap")) { closeSuggest("db"); closeSuggest("prep"); closeFieldSuggests(); }
      handleClick(e);
      if (e.target.closest("[data-dbview]")) showView(e.target.closest("[data-dbview]").getAttribute("data-dbview"));
      if (e.target.closest("[data-mainpage]")) showMainPage(e.target.closest("[data-mainpage]").getAttribute("data-mainpage"));
      if (e.target.closest("[data-prepfilter]")) setPrepFilter(e.target.closest("[data-prepfilter]").getAttribute("data-prepfilter"));
      if (e.target.closest("[data-suivitab]")) setSuiviTab(e.target.closest("[data-suivitab]").getAttribute("data-suivitab"));
      if (e.target.closest("[data-mapview]")) setMapView(e.target.closest("[data-mapview]").getAttribute("data-mapview"));
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
    els.prepSearchBox.addEventListener("input", function () { renderPrep(); renderSuggest("prep"); });
    els.searchBox.addEventListener("focus", function () { renderSuggest("db"); });
    els.prepSearchBox.addEventListener("focus", function () { renderSuggest("prep"); });

    var adminObserver = new MutationObserver(function () {
      if (els.adminOverlay.classList.contains("open") && document.getElementById("admIdTournee")) {
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
