/* ============================================================================
   scan.js — lecture d'une étiquette par la caméra.

   Chaîne : image → prétraitement → OCR → rapprochement dans la base → choix
   de l'utilisateur → attribution des objets suivis → retour au viseur.

   L'OCR n'a pas besoin d'être exact : c'est Store.matchTexteLibre qui décide,
   en cherchant l'adresse connue la plus proche du texte lu. Un texte à moitié
   faux reste donc exploitable, et l'adresse de l'expéditeur — absente de la
   tournée — s'élimine d'elle-même. Rien n'est jamais choisi à la place de
   l'utilisateur : les cartes sont des propositions, le doigt tranche.

   Deux modes, une seule mécanique :

     vidéo — le viseur cadre l'étiquette, une lecture par seconde environ, les
             cartes se mettent à jour sous le flux ; c'est le mode courant ;
     photo — un cliché, quatre orientations, tout le temps qu'il faut ; c'est
             le repli quand la caméra est refusée, occupée, absente, ou quand
             l'image bougée ne donne rien.

   Ce fichier ne contient que l'adhérence au navigateur : caméra, canvas,
   Tesseract, DOM. L'enchaînement des états, la cadence, la qualité d'image et
   l'attribution vivent dans scan-core.js, où ils se testent sans navigateur.

   Module volontairement isolé : Tesseract n'est chargé qu'à la première
   utilisation, et si ce chargement échoue, le reste de l'application n'en
   sait rien.
   ========================================================================== */
window.Scan = (function () {
  "use strict";

  var C = window.ScanCore;

  var TESSERACT_URL = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/7.0.0/tesseract.min.js";
  var LANGUE = "fra";

  var LARGEUR_MAX = 1600;   // au-delà, on réduit : le moteur n'y gagne rien
  var LARGEUR_MIN = 1000;   // en deçà, on agrandit : le moteur y perd
  var LARGEUR_OCR = 1200;   // largeur visée pour le recadrage vidéo

  // Cadre de capture, en fraction de l'image. Ces trois nombres sont aussi
  // ceux du cadre dessiné en CSS (.scan-cadre) : la marge, elle, déborde
  // volontairement du trait visible, pour rattraper un nom écrit de travers.
  var CADRE = { partLargeur: 0.86, partHauteur: 0.46, marge: 0.12 };

  var INTERVALLE_OCR = 1100; // ms entre deux lectures : ~1 s, jamais par image
  var PERIODE_MESURE = 150;  // ms entre deux contrôles de netteté
  var PERIODE_BOUCLE = 120;  // ms de la boucle de repli, sans rVFC
  var GARDE_RVFC = 500;      // ms sans image avant de déclarer rVFC muet
  var ANALYSE_LARGEUR = 160; // le contrôle de qualité se fait en vignette

  // L'ordre de l'écran d'attribution : le colis d'abord, c'est l'objet qu'on
  // scanne le plus souvent. Les catégories inconnues d'ici (une catégorie
  // ajoutée dans Prep.TYPES) suivent, dans leur ordre d'origine.
  var ORDRE_ATTRIBUTION = ["colis", "lettres", "presse"];

  var els = {};
  var onPick = null;
  var onAjout = null;

  var session = null;
  var flux = null;            // MediaStream en cours
  var video = null;           // <video> créé une fois, réutilisé
  var boucleTimer = null;
  var boucleFrame = null;
  var derniereMesure = 0;
  var canvasAnalyse = null;
  var canvasOCR = null;
  var viseurMonte = false;
  var rvfcMuet = false;      // annoncé par le navigateur, mais jamais servi

  var tesseractPret = null;   // promesse de chargement, mise en cache
  var worker = null;
  var moteurEnCharge = false;

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------------------------------------------------------------------
  // Chargement paresseux de Tesseract
  // ---------------------------------------------------------------------
  function chargerTesseract() {
    if (tesseractPret) return tesseractPret;
    tesseractPret = new Promise(function (resolve, reject) {
      if (window.Tesseract) { resolve(window.Tesseract); return; }
      var s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.onload = function () {
        window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract indisponible"));
      };
      s.onerror = function () { reject(new Error("réseau")); };
      document.head.appendChild(s);
    }).catch(function (e) {
      tesseractPret = null; // laisser une nouvelle tentative possible
      throw e;
    });
    return tesseractPret;
  }

  // Un seul worker pour toute la session de scan : le créer coûte plusieurs
  // secondes, et l'utilisateur enchaîne les étiquettes. Il est libéré à la
  // fermeture, pas avant.
  //
  // Ce chargement se dit à l'écran : au premier usage, il dure assez longtemps
  // pour qu'un viseur muet passe pour une panne.
  function obtenirWorker() {
    if (worker) return Promise.resolve(worker);
    moteurEnCharge = true;
    majIndicationVue();
    return chargerTesseract().then(function (T) {
      return T.createWorker(LANGUE, 1);
    }).then(function (w) {
      worker = w;
      moteurEnCharge = false;
      majIndicationVue();
      return w;
    }, function (e) {
      moteurEnCharge = false;
      majIndicationVue();
      throw e;
    });
  }

  function libererWorker() {
    if (!worker) return;
    var w = worker;
    worker = null;
    try { w.terminate(); } catch (e) { /* rien à sauver ici */ }
  }

  // ---------------------------------------------------------------------
  // Prétraitement : c'est lui, plus que le moteur, qui sauve un cliché pâle
  // ---------------------------------------------------------------------
  function versCanvas(img) {
    var largeur = img.naturalWidth || img.width;
    var hauteur = img.naturalHeight || img.height;
    var facteur = 1;
    if (largeur > LARGEUR_MAX) facteur = LARGEUR_MAX / largeur;
    else if (largeur < LARGEUR_MIN) facteur = Math.min(2, LARGEUR_MIN / largeur);

    var c = document.createElement("canvas");
    c.width = Math.round(largeur * facteur);
    c.height = Math.round(hauteur * facteur);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // Niveaux de gris puis étirement de contraste sur les centiles 2 et 98 :
  // une encre grise sur papier blanc redevient franche.
  function accentuer(canvas) {
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    var histo = new Array(256).fill(0);
    var i;

    for (i = 0; i < d.length; i += 4) {
      var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      histo[g] += 1;
    }

    var total = canvas.width * canvas.height;
    var bas = Math.round(total * 0.02), haut = Math.round(total * 0.98);
    var cumul = 0, min = 0, max = 255;
    for (i = 0; i < 256; i++) {
      cumul += histo[i];
      if (cumul >= bas) { min = i; break; }
    }
    cumul = 0;
    for (i = 0; i < 256; i++) {
      cumul += histo[i];
      if (cumul >= haut) { max = i; break; }
    }
    if (max - min > 20) {
      var echelle = 255 / (max - min);
      for (i = 0; i < d.length; i += 4) {
        var v = Math.max(0, Math.min(255, (d[i] - min) * echelle));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function pivoter(canvas, angle) {
    if (!angle) return canvas;
    var c = document.createElement("canvas");
    var droit = angle === 90 || angle === 270;
    c.width = droit ? canvas.height : canvas.width;
    c.height = droit ? canvas.width : canvas.height;
    var ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }

  function chargerImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image illisible")); };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------
  // Reconnaissance
  //
  // Un point de passage unique pour les deux modes : on essaie les angles
  // dans l'ordre reçu et on s'arrête au premier résultat franc. La liste des
  // angles, elle, est décidée par ScanCore.anglesAEssayer — parcimonieuse en
  // vidéo, complète en photo.
  // ---------------------------------------------------------------------
  function lectureFranche(candidats) {
    return !!(candidats[0] && candidats[0].touches >= 4 && candidats[0].score >= 6);
  }

  function lireAngles(base, angles) {
    if (!base) return Promise.resolve(null);
    return obtenirWorker().then(function (w) {
      return angles.reduce(function (chaine, angle) {
        return chaine.then(function (acc) {
          if (acc && acc.franc) return acc;
          return w.recognize(pivoter(base, angle)).then(function (res) {
            var texte = (res && res.data && res.data.text) || "";
            var candidats = window.Store.matchTexteLibre(texte, 5);
            var mieux = !acc || !acc.candidats.length ||
              (candidats[0] && (!acc.candidats[0] || candidats[0].score > acc.candidats[0].score));
            var retenu = mieux
              ? { texte: texte, angle: angle, candidats: candidats }
              : acc;
            retenu.franc = lectureFranche(retenu.candidats);
            return retenu;
          });
        });
      }, Promise.resolve(null));
    });
  }

  // ---------------------------------------------------------------------
  // Caméra
  // ---------------------------------------------------------------------
  function contraintes(large) {
    var v = { facingMode: { ideal: "environment" } };
    // Du texte de 3 mm sur une étiquette : il faut de la définition. On la
    // demande, sans l'exiger — une caméra qui ne sait pas la fournir est
    // reprise telle qu'elle est plutôt que refusée.
    if (large) { v.width = { ideal: 1920 }; v.height = { ideal: 1080 }; }
    return { video: v, audio: false };
  }

  function assurerVideo() {
    if (video) return video;
    video = document.createElement("video");
    video.id = "scanVideo";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.muted = true;
    video.autoplay = true;
    return video;
  }

  function assurerCanvas() {
    if (!canvasAnalyse) canvasAnalyse = document.createElement("canvas");
    if (!canvasOCR) canvasOCR = document.createElement("canvas");
  }

  function fluxVivant() {
    return !!(flux && flux.getTracks().some(function (t) { return t.readyState === "live"; }));
  }

  function demarrerCamera() {
    if (!C.videoDisponible(navigator, window.isSecureContext)) {
      var e = new Error("caméra indisponible");
      e.name = window.isSecureContext ? "non-supporte" : "non-securise";
      return Promise.reject(e);
    }
    assurerVideo();
    assurerCanvas();
    // Le flux tenu pendant l'attribution repart tel quel : redemander la
    // caméra entre deux étiquettes coûte une seconde d'attente et, sur
    // certains navigateurs, une demande d'autorisation de plus. Or le geste
    // est répétitif : une étiquette, une adresse, des objets, l'étiquette
    // suivante. Le flux n'est vraiment rendu qu'en quittant le scan.
    if (fluxVivant()) return reprendreFlux();
    return navigator.mediaDevices.getUserMedia(contraintes(true))
      .catch(function (err) {
        // Résolution impossible : on redemande la caméra sans exigence de
        // taille plutôt que de renvoyer l'utilisateur à la photo.
        if (err && (err.name === "OverconstrainedError" || err.name === "ConstraintNotSatisfiedError")) {
          return navigator.mediaDevices.getUserMedia(contraintes(false));
        }
        throw err;
      })
      .then(function (s) {
        flux = s;
        video.srcObject = s;
        eveillerPistes(true);
        // play() ne rend pas de promesse partout : on ne l'attend que si elle
        // existe, et un refus de lecture automatique n'arrête pas le viseur.
        var joue = video.play();
        return (joue && joue.catch) ? joue.catch(function () {}) : null;
      })
      .then(function () {
        ajusterViseur();
        demarrerBoucle();
        return true;
      });
  }

  function reprendreFlux() {
    eveillerPistes(true);
    if (video.srcObject !== flux) video.srcObject = flux;
    var joue = video.play();
    return Promise.resolve((joue && joue.catch) ? joue.catch(function () {}) : null)
      .then(function () { ajusterViseur(); demarrerBoucle(); return true; });
  }

  // Une piste désactivée ne délivre plus d'image et ne coûte plus rien, mais
  // reste la nôtre : c'est la différence entre mettre la caméra en veille et
  // la rendre.
  function eveillerPistes(actif) {
    if (!flux) return;
    flux.getTracks().forEach(function (t) { t.enabled = !!actif; });
  }

  // Deux façons de s'arrêter, et le motif tranche. L'attribution dure quelques
  // secondes et se termine par un retour au viseur : on met la caméra en
  // veille. Tout le reste — fermeture, repli photo, erreur, application mise
  // de côté — la rend : une piste vidéo laissée ouverte garde la lampe du
  // capteur allumée et la caméra prise pour les autres applications.
  function arreterCamera(motif) {
    arreterBoucle();
    if (motif === "attribution" && fluxVivant()) {
      eveillerPistes(false);
      try { video.pause(); } catch (e) { /* rien */ }
      return;
    }
    libererCamera();
  }

  function libererCamera() {
    arreterBoucle();
    if (flux) {
      flux.getTracks().forEach(function (t) {
        try { t.stop(); } catch (e) { /* piste déjà morte */ }
      });
      flux = null;
    }
    if (video) {
      try { video.pause(); } catch (e) { /* rien */ }
      video.srcObject = null;
    }
  }

  // Le conteneur prend le rapport de l'image : le cadre dessiné en CSS tombe
  // alors exactement sur la zone découpée pour l'OCR, sans lettre-boîte ni
  // recadrage implicite du navigateur.
  function ajusterViseur() {
    var cadre = document.getElementById("scanViseur");
    if (!cadre || !video || !video.videoWidth) return;
    cadre.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
  }

  // ---------------------------------------------------------------------
  // Boucle d'images
  //
  // requestVideoFrameCallback quand il existe — il se cale sur les images
  // réellement décodées —, un timer sinon. Dans les deux cas, la mesure de
  // qualité est bridée : contrôler la netteté soixante fois par seconde
  // chaufferait le téléphone sans rien apprendre de plus.
  // ---------------------------------------------------------------------
  function demarrerBoucle() {
    arreterBoucle();
    derniereMesure = 0;
    programmerBoucle();
  }

  function programmerBoucle() {
    if (!flux || !video) return;
    if (!rvfcMuet && typeof video.requestVideoFrameCallback === "function") {
      boucleFrame = video.requestVideoFrameCallback(function () { tourDeBoucle(); });
      // Garde-fou : des navigateurs annoncent requestVideoFrameCallback sans
      // jamais le servir — vu sur un flux synthétique, vu aussi sur une vidéo
      // que le compositeur juge invisible. Une demi-seconde sans image, et on
      // ne l'attend plus : le timer prend la suite pour toute la session.
      boucleTimer = setTimeout(function () { rvfcMuet = true; tourDeBoucle(); }, GARDE_RVFC);
    } else {
      boucleTimer = setTimeout(tourDeBoucle, PERIODE_BOUCLE);
    }
  }

  function arreterBoucle() {
    if (boucleFrame !== null && video && typeof video.cancelVideoFrameCallback === "function") {
      try { video.cancelVideoFrameCallback(boucleFrame); } catch (e) { /* déjà passé */ }
    }
    boucleFrame = null;
    if (boucleTimer !== null) { clearTimeout(boucleTimer); boucleTimer = null; }
  }

  function tourDeBoucle() {
    arreterBoucle();
    if (!flux || !session) return;
    var maintenant = Date.now();
    if (maintenant - derniereMesure >= PERIODE_MESURE) {
      derniereMesure = maintenant;
      session.tick(mesurerFrame());
    }
    programmerBoucle();
  }

  function mesurerFrame() {
    if (!video || !video.videoWidth) return null;
    var r = C.rectCapture(video.videoWidth, video.videoHeight, CADRE);
    var h = Math.max(1, Math.round(ANALYSE_LARGEUR * r.h / r.w));
    var c = canvasAnalyse;
    if (c.width !== ANALYSE_LARGEUR || c.height !== h) { c.width = ANALYSE_LARGEUR; c.height = h; }
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return C.statsZone(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 1);
  }

  // Recadrage plein format de la seule zone du cadre : c'est là que se gagne
  // le temps d'OCR, en soustrayant au moteur tout ce qui n'est pas l'étiquette.
  function capturerZone() {
    if (!video || !video.videoWidth) return null;
    var r = C.rectCapture(video.videoWidth, video.videoHeight, CADRE);
    var facteur = 1;
    if (r.w > LARGEUR_OCR) facteur = LARGEUR_OCR / r.w;
    else if (r.w < LARGEUR_MIN) facteur = Math.min(2, LARGEUR_MIN / r.w);
    var c = canvasOCR;
    c.width = Math.round(r.w * facteur);
    c.height = Math.round(r.h * facteur);
    c.getContext("2d").drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return accentuer(c);
  }

  function reconnaitreVideo(angles) {
    return lireAngles(capturerZone(), angles);
  }

  // ---------------------------------------------------------------------
  // Mode photo (repli)
  // ---------------------------------------------------------------------
  function analyserPhoto(file) {
    afficherTravail("Préparation de l'image…");
    chargerImage(file)
      .then(function (img) {
        afficherTravail("Lecture de l'étiquette…");
        return lireAngles(accentuer(versCanvas(img)), C.anglesAEssayer("photo"));
      })
      // poserCandidats redessine l'écran photo de lui-même, par onCandidats.
      .then(function (res) {
        session.poserCandidats((res && res.candidats) || [], (res && res.texte) || "");
      })
      .catch(function (e) { afficherErreurPhoto(e); });
  }

  function brancherFichier() {
    var input = document.getElementById("scanFile");
    if (!input) return;
    input.addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (f) analyserPhoto(f);
    });
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function titrer(texte) {
    if (els.titre) els.titre.textContent = texte;
  }

  function candidatHTML(c, premier, ecartFaible) {
    var row = c.row;
    var noms = window.Store.namesOf(row).join(" / ") || "(sans nom)";
    var adresse = [row.numero, row.rue].filter(Boolean).join(" ");
    var lieu = window.Store.communeLabelOf(row);
    return '<button type="button" class="scan-candidat' + (premier && !ecartFaible ? " probable" : "") + '" ' +
      'data-action="scan-pick" data-id="' + row.id + '">' +
      '<span class="scan-candidat-nom">' + escapeHtml(noms) + '</span>' +
      '<span class="scan-candidat-adr">' + escapeHtml([adresse, lieu].filter(Boolean).join(" · ")) + '</span>' +
      (premier && !ecartFaible ? '<span class="scan-candidat-tag">Correspondance la plus probable</span>' : "") +
    '</button>';
  }

  function candidatsHTML(candidats) {
    if (!candidats.length) return "";
    var faible = C.ecartFaible(candidats);
    return '<div class="scan-titre">' +
        (faible ? "Plusieurs adresses possibles" : "Adresse reconnue") +
      '</div>' +
      candidats.map(function (x, i) { return candidatHTML(x, i === 0, faible); }).join("");
  }

  // Le texte brut reste consultable : pendant la phase de test, c'est ce qui
  // permet de comprendre pourquoi une étiquette n'a pas été reconnue.
  function texteLuHTML(texte) {
    if (!texte || !texte.trim()) return "";
    return '<details class="scan-brut"><summary>Texte lu par l\'appareil</summary>' +
      '<pre>' + escapeHtml(texte.trim()) + '</pre></details>';
  }

  function afficherTravail(message) {
    els.body.innerHTML =
      '<div class="scan-travail">' +
        '<div class="scan-spinner"></div>' +
        '<div class="scan-etat">' + escapeHtml(message) + '</div>' +
      '</div>';
    viseurMonte = false;
  }

  // Le viseur se monte une fois et ne se démonte plus tant qu'on scanne :
  // réécrire le conteneur à chaque lecture arracherait la vidéo de la page.
  function monterViseur() {
    els.body.innerHTML =
      '<div class="scan-viseur" id="scanViseur">' +
        '<div class="scan-cadre" aria-hidden="true"></div>' +
        '<div class="scan-hint" id="scanHint"></div>' +
      '</div>' +
      '<div class="scan-suggestions" id="scanSuggestions"></div>' +
      '<button type="button" class="scan-lien" data-action="scan-photo">' +
        '📷 Prendre une photo à la place</button>';
    var cadre = document.getElementById("scanViseur");
    cadre.insertBefore(assurerVideo(), cadre.firstChild);
    viseurMonte = true;
    ajusterViseur();
  }

  // Le passage scanning ↔ recognizing survient une fois par seconde : il ne
  // redessine que l'indication. Les cartes, elles, ne bougent que lorsqu'une
  // lecture apporte mieux (onCandidats) — sinon elles clignoteraient.
  function rendreViseur() {
    if (!viseurMonte) { monterViseur(); majCandidatsVue(); }
    majIndicationVue();
  }

  function majIndicationVue() {
    var hint = document.getElementById("scanHint");
    if (!hint || !session) return;
    var etat = session.etat();
    var texte = session.indication() ||
      (moteurEnCharge ? "Chargement du moteur de lecture…" : "") ||
      (etat === C.ETATS.DEMARRAGE ? "Démarrage de la caméra…" : "Placez l'étiquette dans le cadre");
    hint.textContent = texte;
    hint.classList.toggle("scan-hint-alerte", !!session.indication());
  }

  function majCandidatsVue() {
    var box = document.getElementById("scanSuggestions");
    if (!box) return;
    var candidats = session.candidats();
    box.innerHTML = candidats.length
      ? candidatsHTML(candidats)
      : '<p class="scan-attente">Les adresses possibles s\'afficheront ici.</p>';
  }

  function adresseCarteHTML(row) {
    var noms = window.Store.namesOf(row).join(" / ") || "(sans nom)";
    var rue = [row.numero, row.rue].filter(Boolean).join(" ");
    var lieu = window.Store.communeLabelOf(row);
    return '<div class="scan-adresse">' +
      '<span class="scan-adresse-nom">' + escapeHtml(noms) + '</span>' +
      (rue ? '<span class="scan-adresse-ligne">' + escapeHtml(rue) + '</span>' : "") +
      (lieu ? '<span class="scan-adresse-ligne">' + escapeHtml(lieu) + '</span>' : "") +
    '</div>';
  }

  // Les catégories dans l'ordre du scan, sans jamais en perdre une : celles
  // que ORDRE_ATTRIBUTION ne connaît pas suivent, telles que Prep les déclare.
  function typesAttribution() {
    var types = window.Prep.TYPES;
    var connus = ORDRE_ATTRIBUTION
      .map(function (k) { return types.filter(function (t) { return t.key === k; })[0]; })
      .filter(Boolean);
    var reste = types.filter(function (t) { return ORDRE_ATTRIBUTION.indexOf(t.key) < 0; });
    return connus.concat(reste);
  }

  function dejaDansTourneeHTML(row) {
    var e = window.Prep.getEntry(window.Store.getIdTournee(), row.id);
    var parts = window.Prep.TYPES
      .filter(function (t) { return e[t.key] > 0; })
      .map(function (t) { return e[t.key] + " " + t.label.toLowerCase(); });
    if (!parts.length) return "";
    return '<p class="scan-deja">Déjà dans la tournée : ' + escapeHtml(parts.join(", ")) + '.</p>';
  }

  function rendreAttribution() {
    viseurMonte = false;
    var row = window.Store.findRow(session.adresseId());
    if (!row) { session.changerAdresse(); return; }
    var q = session.quantites();
    var total = session.totalQuantites();
    els.body.innerHTML =
      '<div class="scan-titre">Adresse sélectionnée</div>' +
      adresseCarteHTML(row) +
      dejaDansTourneeHTML(row) +
      '<div class="scan-attrib">' +
        typesAttribution().map(function (t) {
          return '<div class="stepper-row">' +
            '<span class="stepper-label">' + t.icon + ' ' + escapeHtml(t.labelLong || t.label) + '</span>' +
            '<div class="stepper">' +
              '<button type="button" data-action="scan-qty" data-type="' + t.key + '" data-delta="-1">−</button>' +
              '<span class="stepper-value' + (q[t.key] > 1 ? " multi" : "") + '">' + (q[t.key] || 0) + '</span>' +
              '<button type="button" data-action="scan-qty" data-type="' + t.key + '" data-delta="1">+</button>' +
            '</div>' +
          '</div>';
        }).join("") +
      '</div>' +
      '<button type="button" class="scan-valider" data-action="scan-ajouter"' +
        (total ? "" : " disabled") + '>Ajouter à la tournée</button>' +
      '<button type="button" class="scan-lien" data-action="scan-changer">Changer d\'adresse</button>';
  }

  function rendrePhoto() {
    viseurMonte = false;
    var candidats = session.candidats();
    var videoDispo = C.videoDisponible(navigator, window.isSecureContext);
    els.body.innerHTML =
      (candidats.length
        ? candidatsHTML(candidats)
        : '<p class="scan-intro">Prends l\'étiquette en photo, bien à plat et sans ombre portée. ' +
          'Le texte lu est ensuite rapproché des adresses de ta tournée.</p>') +
      '<label class="scan-cta">📷 ' + (candidats.length ? "Reprendre une photo" : "Prendre une photo") +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden></label>' +
      (videoDispo
        ? '<button type="button" class="scan-lien" data-action="scan-video">🎥 Revenir au viseur</button>'
        : "") +
      texteLuHTML(session.texteLu()) +
      '<p class="scan-note">Le moteur de lecture (quelques Mo) est téléchargé au ' +
      'premier usage : prévois-le avant de partir en tournée.</p>';
    brancherFichier();
  }

  function afficherErreurPhoto(e) {
    var reseau = e && e.message === "réseau";
    viseurMonte = false;
    els.body.innerHTML =
      '<div class="status err">' +
        (reseau
          ? "Le moteur de lecture n'a pas pu être téléchargé. Il faut une connexion au premier usage."
          : "La lecture a échoué (" + escapeHtml(e && e.message) + ").") +
      '</div>' +
      '<label class="scan-cta">📷 Réessayer' +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden></label>';
    brancherFichier();
  }

  function rendreErreur(err) {
    viseurMonte = false;
    els.body.innerHTML =
      '<div class="status err">' + escapeHtml(C.messageErreurCamera(err)) + '</div>' +
      '<button type="button" class="scan-cta" data-action="scan-video">🎥 Réessayer la caméra</button>' +
      '<button type="button" class="scan-lien" data-action="scan-photo">📷 Prendre une photo</button>';
  }

  // Un seul aiguillage de rendu, appelé à chaque changement d'état : l'écran
  // ne peut donc pas rester en retard sur la mécanique.
  function rendre(info) {
    if (!els.body) return;
    var etat = session.etat();
    titrer(etat === C.ETATS.ATTRIBUTION ? "Attribuer les objets" : "Scanner une étiquette");
    switch (etat) {
      case C.ETATS.DEMARRAGE:
      case C.ETATS.VISEUR:
      case C.ETATS.LECTURE:
        rendreViseur();
        break;
      case C.ETATS.ATTRIBUTION:
        rendreAttribution();
        break;
      case C.ETATS.PHOTO:
        rendrePhoto();
        break;
      case C.ETATS.ERREUR:
        rendreErreur(info);
        break;
      case C.ETATS.IDLE:
        els.body.innerHTML = "";
        viseurMonte = false;
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  function creerSession() {
    return C.creerSession({
      types: window.Prep.TYPES.map(function (t) { return t.key; }),
      prep: window.Prep,
      idTournee: function () { return window.Store.getIdTournee(); },
      intervalle: INTERVALLE_OCR,
      demarrerCamera: demarrerCamera,
      arreterCamera: arreterCamera,
      reconnaitre: reconnaitreVideo,
      qualifier: function (texte) { return window.Store.matchTexteLibre(texte, 5); },
      onEtat: function (etat, avant, info) { rendre(info); },
      onIndication: function () { majIndicationVue(); },
      onCandidats: function () {
        if (session.etat() === C.ETATS.PHOTO) rendrePhoto();
        else majCandidatsVue();
      },
      onQuantites: function () { rendreAttribution(); },
      // Le scan ne fait que désigner : il cible l'adresse dans la préparation,
      // qui reste prête derrière la surcouche.
      onChoix: function (id) { if (onPick) onPick(id); },
      onAjout: function (id, ecrit) { if (onAjout) onAjout(id, ecrit); }
    });
  }

  // Écran éteint, appel entrant, autre onglet : la caméra n'a plus personne à
  // renseigner. On la rend pour de bon — y compris depuis l'écran
  // d'attribution, où elle n'était qu'en veille — et on la reprend au retour
  // si le viseur était affiché.
  function surVisibilite() {
    if (!session) return;
    var etat = session.etat();
    if (document.hidden) {
      libererCamera();
    } else if ((etat === C.ETATS.VISEUR || etat === C.ETATS.LECTURE) && !fluxVivant()) {
      session.demarrer();
    }
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  function open(options) {
    onPick = (options && options.onPick) || null;
    onAjout = (options && options.onAjout) || null;
    els.overlay = document.getElementById("scanOverlay");
    els.body = document.getElementById("scanBody");
    els.titre = els.overlay.querySelector(".topbar h1");
    els.overlay.classList.add("open");
    viseurMonte = false;

    session = creerSession();
    document.addEventListener("visibilitychange", surVisibilite);

    if (C.videoDisponible(navigator, window.isSecureContext)) session.demarrer();
    else session.modePhoto();
  }

  // Disponible dans tous les états : caméra rendue, lecture périmée, worker
  // libéré, surcouche fermée — et rien d'écrit qui n'ait été validé.
  function close() {
    document.removeEventListener("visibilitychange", surVisibilite);
    if (session) session.fermer();
    libererCamera();
    libererWorker();
    session = null;
    if (els.body) els.body.innerHTML = "";
    viseurMonte = false;
    titrer("Scanner une étiquette");
    if (els.overlay) els.overlay.classList.remove("open");
  }

  function pick(id) { if (session) session.choisir(id); }
  function ajusterQuantite(type, delta) { if (session) session.ajusterQuantite(type, delta); }
  function ajouterALaTournee() { if (session) session.ajouterALaTournee(); }
  function changerAdresse() { if (session) session.changerAdresse(); }
  function modePhoto() { if (session) session.modePhoto(); }
  function modeVideo() { if (session) session.demarrer(); }
  function etat() { return session ? session.etat() : C.ETATS.IDLE; }

  return {
    open: open,
    close: close,
    pick: pick,
    ajusterQuantite: ajusterQuantite,
    ajouterALaTournee: ajouterALaTournee,
    changerAdresse: changerAdresse,
    modePhoto: modePhoto,
    modeVideo: modeVideo,
    etat: etat
  };
})();
