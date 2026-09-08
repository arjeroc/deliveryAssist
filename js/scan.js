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
  // 1 200 px suffit aux petits caractères imprimés tout en restant nettement
  // plus rapide que d'envoyer le flux 1080p entier au moteur. Le cadrage plus
  // serré ci-dessous donne en outre davantage de pixels utiles au texte.
  var LARGEUR_OCR = 1200;   // largeur visée pour le recadrage vidéo

  // Cadre de capture, en fraction de l'image. Ces trois nombres sont aussi
  // ceux du cadre dessiné en CSS (.scan-cadre) : la marge, elle, déborde
  // volontairement du trait visible, pour rattraper un nom écrit de travers.
  //
  // Un rectangle large, pas un carré : le scan se tient en paysage, seule
  // disposition de cet écran (voir .scan-live en CSS), et une adresse s'y
  // lit sur une vraie largeur plutôt que sur une bande pincée.
  // La marge n'est volontairement que de 3 %. Avec 12 %, 90 % de largeur
  // dépassait 100 % : l'OCR lisait donc toute la scène (casier, bureau,
  // expéditeur) et non pas seulement la lettre visée.
  var CADRE = { partLargeur: 0.90, partHauteur: 0.70, marge: 0.03 };

  var INTERVALLE_OCR_DEFAUT = 700; // ms entre deux lectures, jamais par image
  var INTERVALLE_OCR_MIN = 400;    // en dessous, la caméra peine à fournir une image neuve
  var INTERVALLE_OCR_MAX = 1500;   // au-delà, la détection traîne trop pour le terrain
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

  // Orientation. Trois repères se croisent dans cet écran — le buffer de la
  // caméra, la boîte affichée, l'œil de l'utilisateur — et tout le scan tient
  // à ce qu'ils soient réconciliés en un seul endroit : ces deux variables.
  //
  //   verrouActif — le système a bien tourné l'écran (plein écran +
  //                 screen.orientation.lock). Les trois repères se confondent
  //                 alors, il n'y a plus rien à corriger.
  //   pivotForce  — le verrou a été refusé et le viewport reste portrait :
  //                 l'interface se pivote elle-même de ±90° (voir
  //                 .scan-pivote en CSS). L'image caméra, elle, arrive déjà
  //                 droite pour l'œil — c'est le pivot qui la couche — d'où
  //                 la contre-rotation de -pivotForce, appliquée à l'affichage
  //                 comme à la découpe OCR.
  var pivotForce = 0;
  var verrouActif = false;

  // Trace de la dernière lecture, affichée sous les cartes : sur le terrain,
  // c'est la seule façon de distinguer « le cadre ne montre pas ce qui est lu »
  // de « le texte est lu mais ne rapproche rien ».
  var dernierTexteBrut = "";
  var dernierAngle = null;

  var tesseractPret = null;   // promesse de chargement, mise en cache
  var worker = null;
  var workerPret = null;      // évite deux initialisations en parallèle
  var workerEpoch = 0;        // invalide un préchauffage fermé entre-temps
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
    if (workerPret) return workerPret;
    var epoch = workerEpoch;
    moteurEnCharge = true;
    majIndicationVue();
    workerPret = chargerTesseract().then(function (T) {
      return T.createWorker(LANGUE, 1);
    }).then(function (w) {
      // Une étiquette n'est ni une page de livre ni une colonne : le mode
      // « texte épars » trouve mieux un bloc destinataire, même avec un logo,
      // un code DataMatrix ou une seconde adresse dans l'image. Le paramètre
      // est posé une seule fois : pas de coût à chaque image vidéo.
      return w.setParameters({
        tessedit_pageseg_mode: "11",
        user_defined_dpi: "300",
        preserve_interword_spaces: "1"
      }).then(function () { return w; });
    }).then(function (w) {
      // La surcouche a pu être fermée pendant le chargement. Dans ce cas le
      // worker ne doit ni survivre discrètement ni réveiller l'ancien scan.
      if (epoch !== workerEpoch) {
        try { w.terminate(); } catch (e) { /* déjà terminé */ }
        throw new Error("worker périmé");
      }
      worker = w;
      workerPret = null;
      moteurEnCharge = false;
      majIndicationVue();
      return w;
    }, function (e) {
      if (epoch === workerEpoch) {
        workerPret = null;
        moteurEnCharge = false;
        majIndicationVue();
      }
      throw e;
    });
    return workerPret;
  }

  function libererWorker() {
    workerEpoch += 1;
    workerPret = null;
    moteurEnCharge = false;
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

  // Niveaux de gris, contraste local puis léger renforcement des contours :
  // les lettres pâles/imprimées sur une enveloppe brillante ressortent sans
  // les écraser en noir et blanc (qui ferait disparaître les traits fins).
  function accentuer(canvas) {
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    var histo = new Array(256).fill(0);
    var i;

    var gris = new Uint8ClampedArray(canvas.width * canvas.height);
    var p = 0;
    for (i = 0; i < d.length; i += 4, p++) {
      var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      gris[p] = g;
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
    // Un masque très doux (+ 35 % de détail) compense le lissage de la caméra
    // sans fabriquer les halos qui perturbent l'OCR. Les bords restent tels
    // quels pour ne pas rogner les caractères au bord du cadre.
    var w = canvas.width, h = canvas.height;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var pos = y * w + x;
        var voisinage = (gris[pos - 1] + gris[pos + 1] + gris[pos - w] + gris[pos + w]) / 4;
        var net = Math.max(0, Math.min(255, gris[pos] + (gris[pos] - voisinage) * 0.35));
        var di = pos * 4;
        // Le contraste étiré fixe la luminosité ; le détail vient de l'image
        // originale afin de ne pas amplifier le bruit dans les zones blanches.
        var detail = net - gris[pos];
        var final = Math.max(0, Math.min(255, d[di] + detail));
        d[di] = d[di + 1] = d[di + 2] = final;
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

  // Remise droite de l'image sous le pivot forcé.
  //
  // La vidéo tourne à l'envers du pivot (-pivotForce) : son contenu redevient
  // droit pour l'œil, alors que le reste de l'interface — cadre de visée,
  // colonne de résultats — reste dans le repère vu, où il est déjà juste.
  //
  // La clef, c'est l'échange des dimensions : une rotation ne change pas la
  // boîte de mise en page, seulement le dessin. Une vidéo laissée à 100 % ×
  // 100 % puis tournée d'un quart de tour ne couvre plus la boîte, et le cadre
  // blanc cesse de désigner la zone lue — c'est ce qui a fait échouer les deux
  // tentatives précédentes de contre-rotation. On lui donne donc, avant
  // rotation, la hauteur de la boîte pour largeur et sa largeur pour hauteur :
  // une fois tournée, elle retombe exactement dessus.
  //
  // Les dimensions se mesurent sur la boîte réelle plutôt que de se recalculer
  // depuis le 60/40 : le partage peut changer en CSS sans que ce code mente.
  function ajusterViseur() {
    var cadre = document.getElementById("scanViseur");
    if (!cadre || !video) return;
    if (!pivotForce) {
      video.style.width = "";
      video.style.height = "";
      video.style.left = "";
      video.style.top = "";
      video.style.right = "";
      video.style.bottom = "";
      video.style.transform = "";
      return;
    }
    video.style.width = cadre.clientHeight + "px";
    video.style.height = cadre.clientWidth + "px";
    video.style.left = "50%";
    video.style.top = "50%";
    video.style.right = "auto";
    video.style.bottom = "auto";
    video.style.transform = "translate(-50%,-50%) rotate(" + (-pivotForce) + "deg)";
  }

  // ---------------------------------------------------------------------
  // Orientation : le verrou du système d'abord, le pivot forcé en repli
  // ---------------------------------------------------------------------
  function estPortrait() {
    return !!(window.matchMedia && window.matchMedia("(orientation: portrait)").matches);
  }

  // Le viewport a le dernier mot : s'il est paysage — verrou obtenu, ou
  // téléphone simplement tourné sans verrou de rotation — aucun pivot n'a lieu
  // d'être, et la caméra se lit telle quelle.
  function majPivot() {
    pivotForce = estPortrait()
      ? (window.Store.getSettings().scanPivotInverse ? -90 : 90)
      : 0;
    if (els.overlay) {
      els.overlay.classList.toggle("scan-pivote", pivotForce !== 0);
      els.overlay.style.setProperty("--scan-rotation", pivotForce + "deg");
    }
    ajusterViseur();
    majBrutVue();
  }

  // La vraie solution, quand le système l'accepte : on demande le plein écran
  // — Chrome ne concède le verrou qu'à cette condition — puis le paysage.
  // L'écran bascule pour de bon, le flux caméra suit, et les trois repères se
  // confondent : plus de contre-rotation, plus de traduction de coordonnées,
  // plus rien qui puisse se désaligner.
  //
  // Tenté seulement si le viewport est portrait : sur un appareil déjà couché,
  // rien ne justifie de saisir le plein écran. Un refus n'est pas une erreur
  // — iOS ne connaît pas ce verrou — on rend le plein écran, et le pivot forcé
  // prend le relais.
  function verrouillerPaysage() {
    if (verrouActif || !els.overlay || !estPortrait()) return Promise.resolve(false);
    var demande = null;
    try {
      if (els.overlay.requestFullscreen) {
        demande = els.overlay.requestFullscreen({ navigationUI: "hide" });
      }
    } catch (e) { demande = null; }
    return Promise.resolve(demande)
      .catch(function () { return null; })
      .then(function () {
        var o = window.screen && window.screen.orientation;
        if (!o || typeof o.lock !== "function") throw new Error("verrou indisponible");
        return o.lock("landscape");
      })
      .then(function () {
        // Le scan a pu être fermé pendant que le système se décidait : on ne
        // laisse pas un écran verrouillé derrière une surcouche déjà rangée.
        if (!session) { libererOrientation(); return false; }
        verrouActif = true;
        return true;
      }, function () { libererOrientation(); return false; });
  }

  function libererOrientation() {
    verrouActif = false;
    var o = window.screen && window.screen.orientation;
    if (o && typeof o.unlock === "function") {
      try { o.unlock(); } catch (e) { /* jamais verrouillé */ }
    }
    if (document.fullscreenElement && document.fullscreenElement === els.overlay) {
      try {
        var sortie = document.exitFullscreen();
        if (sortie && sortie.catch) sortie.catch(function () {});
      } catch (e) { /* déjà sorti */ }
    }
  }

  // L'écran a tourné, ou l'utilisateur a quitté le plein écran d'un geste : le
  // pivot se recalcule, et la vidéo se remesure sur la boîte devenue autre.
  function surOrientation() {
    if (!session) return;
    if (!document.fullscreenElement) verrouActif = false;
    majPivot();
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

  // La zone de lecture, décidée une fois pour toutes : le rectangle dans le
  // repère du buffer, l'angle qui le remet droit, et ses dimensions telles que
  // l'utilisateur les voit. Contrôle de netteté et découpe OCR s'en servent
  // tous deux — ils ne peuvent donc diverger ni l'un de l'autre, ni du cadre
  // blanc, qui porte les mêmes fractions (voir CADRE et .scan-cadre).
  function zoneLecture() {
    var angle = -pivotForce;
    var r = C.rectCaptureOriente(video.videoWidth, video.videoHeight, angle, CADRE);
    var droit = angle === 90 || angle === -90;
    return { rect: r, angle: angle, w: droit ? r.h : r.w, h: droit ? r.w : r.h };
  }

  // Découpe et remise droite en un seul dessin : le canvas reçoit directement
  // l'étiquette à l'endroit, à la largeur demandée. Rien ne repasse ensuite par
  // une seconde rotation — c'est ce qui garde la chaîne lisible, et ce qui
  // épargne au moteur d'OCR une image pivotée deux fois.
  function dessinerZone(c, z, largeurCible) {
    var f = largeurCible / z.w;
    c.width = Math.max(1, Math.round(z.w * f));
    c.height = Math.max(1, Math.round(z.h * f));
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    if (z.angle) ctx.rotate((z.angle * Math.PI) / 180);
    var dw = z.rect.w * f, dh = z.rect.h * f;
    ctx.drawImage(video, z.rect.x, z.rect.y, z.rect.w, z.rect.h, -dw / 2, -dh / 2, dw, dh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx;
  }

  function mesurerFrame() {
    if (!video || !video.videoWidth) return null;
    var c = canvasAnalyse;
    var ctx = dessinerZone(c, zoneLecture(), ANALYSE_LARGEUR);
    return C.statsZone(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 1);
  }

  // Recadrage plein format de la seule zone du cadre : c'est là que se gagne
  // le temps d'OCR, en soustrayant au moteur tout ce qui n'est pas l'étiquette.
  function capturerZone() {
    if (!video || !video.videoWidth) return null;
    var z = zoneLecture();
    var cible = z.w;
    if (cible > LARGEUR_OCR) cible = LARGEUR_OCR;
    else if (cible < LARGEUR_MIN) cible = Math.min(z.w * 2, LARGEUR_MIN);
    dessinerZone(canvasOCR, z, Math.round(cible));
    return accentuer(canvasOCR);
  }

  function reconnaitreVideo(angles) {
    return lireAngles(capturerZone(), angles).then(function (res) {
      dernierTexteBrut = (res && res.texte) || "";
      dernierAngle = res ? res.angle : null;
      majBrutVue();
      return res;
    });
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
    definirPleinEcran(false);
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
    majPivot();
    els.body.innerHTML =
      '<div class="scan-live">' +
        '<div class="scan-viseur" id="scanViseur">' +
          // Le cadre de visée ne tourne jamais : il vit dans le repère de
          // l'œil, celui de la boîte, où « large » veut dire large. Seule la
          // vidéo porte une contre-rotation, et avec ses dimensions échangées
          // pour retomber pile sur la boîte (voir ajusterViseur) — c'est ce
          // qui manquait aux deux tentatives précédentes, où le cadre suivait
          // la vidéo et finissait par désigner autre chose que la zone lue.
          '<div class="scan-cadre" aria-hidden="true"></div>' +
          '<div class="scan-hint" id="scanHint"></div>' +
          // Le ✕ du bandeau, rendu à l'image : c'est le seul geste de sortie,
          // il ne doit coûter ni une ligne de hauteur ni un aller-retour.
          '<button type="button" class="scan-fermer" data-action="scan-close" ' +
            'aria-label="Fermer le scan">✕</button>' +
        '</div>' +
        '<div class="scan-results">' +
          '<div class="scan-suggestions" id="scanSuggestions"></div>' +
          '<div id="scanBrut"></div>' +
          '<button type="button" class="scan-lien" data-action="scan-photo">' +
            '📷 Prendre une photo à la place</button>' +
        '</div>' +
      '</div>';
    var cadre = document.getElementById("scanViseur");
    cadre.insertBefore(assurerVideo(), cadre.firstChild);
    viseurMonte = true;
    ajusterViseur();
    majBrutVue();
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

  // Ce que la caméra a réellement livré au moteur, et dans quel repère. Un
  // viseur muet ne dit pas s'il ne lit rien ou s'il lit à côté ; ces deux
  // lignes le disent, et évitent de deviner à distance.
  function majBrutVue() {
    var box = document.getElementById("scanBrut");
    if (!box) return;
    var repere = verrouActif
      ? "écran verrouillé en paysage"
      : (pivotForce ? "pivot forcé " + pivotForce + "°, image redressée de " +
          (-pivotForce) + "°" : "paysage natif");
    var flux = (video && video.videoWidth)
      ? video.videoWidth + "×" + video.videoHeight
      : "flux non démarré";
    box.innerHTML = '<details class="scan-brut"><summary>Ce que lit l\'appareil</summary>' +
      '<pre>' + escapeHtml(flux + " · " + repere +
        (dernierAngle ? " · angle OCR " + dernierAngle + "°" : "") +
        "\n\n" + (dernierTexteBrut.trim() || "(rien lu)")) + '</pre></details>';
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

  // Le viseur prend l'écran entier : ni bandeau de titre, ni marge, ni
  // colonne à 760px. Ce bandeau vert en travers du haut est une habitude de
  // portrait — en paysage il mange un sixième de la hauteur, celle-là même
  // qui manque à la capture. Il s'efface donc, et le ✕ passe en pastille sur
  // l'image (voir monterViseur). Les autres écrans — attribution, photo,
  // erreur — le retrouvent tel quel.
  function definirPleinEcran(actif) {
    if (els.overlay) els.overlay.classList.toggle("scan-plein", !!actif);
  }

  // Un seul aiguillage de rendu, appelé à chaque changement d'état : l'écran
  // ne peut donc pas rester en retard sur la mécanique.
  function rendre(info) {
    if (!els.body) return;
    var etat = session.etat();
    titrer(etat === C.ETATS.ATTRIBUTION ? "Attribuer les objets" : "Scanner une étiquette");
    definirPleinEcran(etat === C.ETATS.DEMARRAGE || etat === C.ETATS.VISEUR || etat === C.ETATS.LECTURE);
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

  // Lu à l'ouverture du scan, pas pendant : changer le réglage en cours de
  // session ne redémarrerait pas la cadence pour rien, il s'appliquera à la
  // prochaine ouverture.
  function intervalleOcr() {
    var v = Number(window.Store.getSettings().scanIntervalleMs);
    if (!v || isNaN(v)) return INTERVALLE_OCR_DEFAUT;
    return Math.max(INTERVALLE_OCR_MIN, Math.min(INTERVALLE_OCR_MAX, v));
  }

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  function creerSession() {
    return C.creerSession({
      types: window.Prep.TYPES.map(function (t) { return t.key; }),
      prep: window.Prep,
      idTournee: function () { return window.Store.getIdTournee(); },
      intervalle: intervalleOcr(),
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
    dernierTexteBrut = "";
    dernierAngle = null;

    session = creerSession();
    document.addEventListener("visibilitychange", surVisibilite);
    window.addEventListener("orientationchange", surOrientation);
    window.addEventListener("resize", surOrientation);
    document.addEventListener("fullscreenchange", surOrientation);

    if (!C.videoDisponible(navigator, window.isSecureContext)) { session.modePhoto(); return; }

    // Le téléchargement et l'initialisation WASM sont la seule latence
    // perceptible au premier scan. On les recouvre avec l'ouverture de la
    // caméra et le passage en paysage, au lieu de les faire attendre à la
    // première image stable. Les scans suivants réutilisent ce worker.
    obtenirWorker().catch(function () { /* la lecture réessaiera et signalera l'erreur utile */ });

    // Le plein écran exige le geste qui vient de nous amener ici : la demande
    // part donc maintenant, sans rien attendre. La caméra ne s'ouvre qu'après,
    // pour que le flux naisse dans l'orientation définitive plutôt que d'avoir
    // à s'y rattraper.
    verrouillerPaysage().then(function () {
      if (!session) return;
      majPivot();
      session.demarrer();
    });
  }

  // Disponible dans tous les états : caméra rendue, lecture périmée, worker
  // libéré, surcouche fermée — et rien d'écrit qui n'ait été validé.
  function close() {
    document.removeEventListener("visibilitychange", surVisibilite);
    window.removeEventListener("orientationchange", surOrientation);
    window.removeEventListener("resize", surOrientation);
    document.removeEventListener("fullscreenchange", surOrientation);
    libererOrientation();
    if (session) session.fermer();
    libererCamera();
    libererWorker();
    session = null;
    pivotForce = 0;
    if (els.overlay) els.overlay.classList.remove("scan-pivote");
    definirPleinEcran(false);
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
