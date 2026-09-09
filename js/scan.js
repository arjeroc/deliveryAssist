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

  // « eng » plutôt que « fra », et ce n'est pas un renoncement.
  //
  // Trois raisons concordent. La norme postale française (AFNOR XP Z10-011)
  // veut les dernières lignes d'une adresse en capitales non accentuées :
  // c'est ce qui est imprimé sur les étiquettes. Store.normalize(), de son
  // côté, retire accents et ponctuation avant tout rapprochement — payer un
  // modèle accentué pour jeter les accents juste après n'a pas de sens. Et le
  // modèle anglais est plus léger, donc plus rapide à charger comme à
  // exécuter, sur un alphabet qui est exactement celui dont on a besoin.
  var LANGUE = "eng";

  // Ce que le moteur a le droit d'écrire. Restreindre la sortie, c'est
  // restreindre l'espace où il peut se tromper : un « É » ou un « § » ne peut
  // plus être proposé à la place d'un « E ». L'apostrophe et le trait d'union
  // restent — ils séparent des mots dans les patronymes — et sont de toute
  // façon ramenés à des espaces par la normalisation.
  var CARACTERES =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'";

  // Le mode photo n'est pas pressé : un cliché, tout le temps qu'il faut.
  var LARGEUR_MAX = 1600;   // au-delà, on réduit : le moteur n'y gagne rien
  var LARGEUR_MIN = 1000;   // en deçà, on agrandit : le moteur y perd

  // La vidéo, elle, se paie chaque image. 900 px, et c'est mesuré : sur les
  // étiquettes de tests/etiquettes, passer de 1 200 à 900 px fait tomber la
  // lecture de 1 500 à 870 ms pour trois points de mots reconnus en moins.
  // Sur une lecture qui se répète toutes les secondes, en tenant une pile de
  // colis d'une main, ces six cents millisecondes valent plus que ces trois
  // points — d'autant que le cumul entre images les rattrape en une lecture
  // de plus.
  var LARGEUR_OCR = 900;    // largeur visée pour la capture vidéo

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

  // L'intervalle entre deux départs de lecture. Il n'a jamais été le facteur
  // limitant : c'était la durée de l'OCR lui-même, qui dépassait largement la
  // seconde. Maintenant que l'image envoyée au moteur est recadrée sur le seul
  // bloc de texte et binarisée, ce plafond redevient réel — et 700 ms de garde
  // reviendraient à laisser dormir le moteur la moitié du temps.
  var INTERVALLE_OCR_DEFAUT = 300; // ms entre deux lectures, jamais par image
  var INTERVALLE_OCR_MIN = 200;    // en dessous, la caméra peine à fournir une image neuve
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
      // Mode 6 — « un bloc de texte uniforme » — et non plus 11, « texte
      // épars ». Le 11 était un choix coûteux à double titre : c'est le mode
      // le plus lent du moteur, qui cherche des caractères blob par blob sans
      // analyse de mise en page, et il rend un texte dont les lignes ne
      // veulent plus rien dire. Or Store.matchTexteLibre s'appuie précisément
      // sur les lignes pour séparer le bloc de l'expéditeur de celui du
      // destinataire : le 11 la nourrissait de bouillie. Le 6 est légitime
      // désormais que l'image envoyée est recadrée sur le seul bloc de texte
      // (voir capturerZone) plutôt que sur toute la scène.
      //
      // Les dictionnaires sont coupés : ils sont faits pour rattraper des
      // mots d'une langue, et une étiquette porte des patronymes et des noms
      // de lieux. « CHEZ FOUR » corrigé en un mot du dictionnaire anglais est
      // une perte sèche.
      return w.setParameters({
        tessedit_pageseg_mode: "6",
        tessedit_char_whitelist: CARACTERES,
        load_system_dawg: "0",
        load_freq_dawg: "0",
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

  // Binarisation locale, méthode de Sauvola.
  //
  // Ce qui se faisait ici — un étirement de contraste global — suppose un
  // éclairage uniforme. Une enveloppe brillante à moitié dans l'ombre du
  // casier n'en offre jamais : le même étirement noie la moitié sombre et
  // brûle la moitié claire, et c'est là que l'OCR ne rendait rien. Un seuil
  // local juge chaque zone sur son propre éclairage :
  //
  //     T = m · (1 + k · (s/R − 1))
  //
  // m et s sont moyenne et écart-type dans la fenêtre, R = 128 la dynamique
  // de référence, k = 0,3 la sévérité. Là où il n'y a pas de texte, s tend
  // vers zéro, T passe nettement sous m, et la zone reste blanche au lieu de
  // se couvrir de poivre et sel — c'est exactement ce qu'un seuil à moyenne
  // seule ne sait pas faire, et pourquoi Sauvola plutôt que Bradley.
  //
  // Deux images intégrales rendent le coût indépendant de la taille de la
  // fenêtre : quatre lectures par pixel, quelle qu'elle soit.
  //
  // ponytail: k, R et la fenêtre sont les trois molettes de ce scan. Elles
  // se règlent sur de vraies étiquettes (tests/etiquettes), pas au raisonnement.
  var SAUVOLA_K = 0.15;
  var SAUVOLA_R = 128;

  function binariser(canvas) {
    var w = canvas.width, h = canvas.height;
    if (!w || !h) return canvas;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var n = w * h;
    var gris = new Uint8Array(n);
    var i, p, x, y;
    for (i = 0, p = 0; p < n; i += 4, p++) {
      gris[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }

    // Une ligne et une colonne de zéros en tête : la boucle chaude n'a alors
    // aucun test de bord à faire.
    var W = w + 1;
    var somme = new Float64Array(W * (h + 1));
    var carres = new Float64Array(W * (h + 1));
    for (y = 0; y < h; y++) {
      var ligne = 0, ligneC = 0;
      for (x = 0; x < w; x++) {
        var g = gris[y * w + x];
        ligne += g; ligneC += g * g;
        somme[(y + 1) * W + x + 1] = somme[y * W + x + 1] + ligne;
        carres[(y + 1) * W + x + 1] = carres[y * W + x + 1] + ligneC;
      }
    }

    // Demi-fenêtre de l'ordre de la hauteur d'un caractère : plus petite, elle
    // creuse l'intérieur des lettres grasses ; plus grande, elle redevient un
    // seuil global et perd tout l'intérêt.
    var r = Math.max(7, Math.min(30, Math.round(w / 48)));
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        var aire = (x1 - x0 + 1) * (y1 - y0 + 1);
        var s = somme[(y1 + 1) * W + x1 + 1] - somme[y0 * W + x1 + 1] -
                somme[(y1 + 1) * W + x0] + somme[y0 * W + x0];
        var sc = carres[(y1 + 1) * W + x1 + 1] - carres[y0 * W + x1 + 1] -
                 carres[(y1 + 1) * W + x0] + carres[y0 * W + x0];
        var m = s / aire;
        var ecart = Math.sqrt(Math.max(0, (sc / aire) - m * m));
        var seuil = m * (1 + SAUVOLA_K * ((ecart / SAUVOLA_R) - 1));
        var v = gris[y * w + x] > seuil ? 255 : 0;
        var di = (y * w + x) * 4;
        d[di] = d[di + 1] = d[di + 2] = v;
        d[di + 3] = 255;
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
      var stats = mesurerFrame();
      if (modeCapture() === "photo") session.evaluerFrame(stats);
      else session.tick(stats);
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
  //
  // Rien de plus fin que le cadre visé, et c'est une décision mesurée, pas un
  // renoncement. Une détection automatique du bloc de texte a été écrite,
  // testée, puis éprouvée sur les photos de tests/etiquettes : elle resserrait
  // bien — de 6 à 18 % de l'image — mais sur le mauvais bloc une fois sur
  // deux, et faisait passer une étiquette de 88 % des mots lus à 0 %. Le cadre
  // que l'utilisateur vise reste le meilleur détecteur de texte disponible :
  // c'est lui qui sait où est l'étiquette, et il ne se trompe pas.
  //
  // ponytail: si un jour le banc tourne sur de vraies captures de viseur — et
  // non sur des photos plein cadre — la question mérite d'être reposée : le
  // bloc d'adresse y est dominant, là où il ne l'est pas dans une photo qui
  // embrasse tout le casier.
  function capturerZone() {
    if (!video || !video.videoWidth) return null;
    var z = zoneLecture();
    var cible = z.w;
    if (cible > LARGEUR_OCR) cible = LARGEUR_OCR;
    else if (cible < LARGEUR_OCR) cible = Math.min(z.w * 2, LARGEUR_OCR);
    dessinerZone(canvasOCR, z, Math.round(cible));
    return binariser(canvasOCR);
  }

  function reconnaitreVideo(angles) {
    return lireAngles(capturerZone(), angles).then(function (res) {
      dernierTexteBrut = (res && res.texte) || "";
      dernierAngle = res ? res.angle : null;
      majTexteLuVue();
      return res;
    });
  }

  function modeCapture() {
    return window.Store.getSettings().scanModeCapture === "photo" ? "photo" : "video";
  }

  // Le mode Photo garde le même flux caméra et la même zone de cadrage. Il ne
  // s'agit pas d'un sélecteur de fichier : l'utilisateur fige volontairement
  // l'image courante, puis l'OCR travaille une seule fois dessus.
  function capturerPhoto() {
    if (!session || modeCapture() !== "photo") return;
    session.tick(mesurerFrame());
  }

  // ---------------------------------------------------------------------
  // Mode photo (repli)
  // ---------------------------------------------------------------------
  function analyserPhoto(file) {
    afficherTravail("Préparation de l'image…");
    chargerImage(file)
      .then(function (img) {
        afficherTravail("Lecture de l'étiquette…");
        return lireAngles(binariser(versCanvas(img)), C.anglesAEssayer("photo"));
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
          '<button type="button" class="scan-fermer" data-action="scan-close" ' +
            'aria-label="Fermer le scan"><span>✕</span></button>' +
          (modeCapture() === "photo"
            ? '<button type="button" class="scan-capture" data-action="scan-capture" ' +
                'aria-label="Prendre la photo">📷</button>'
            : "") +
        '</div>' +
        '<div class="scan-results">' +
          '<div class="scan-suggestions" id="scanSuggestions"></div>' +
          '<div id="scanLu"></div>' +
        '</div>' +
      '</div>';
    var cadre = document.getElementById("scanViseur");
    cadre.insertBefore(assurerVideo(), cadre.firstChild);
    viseurMonte = true;
    ajusterViseur();
  }

  // Le passage scanning ↔ recognizing survient une fois par seconde : il ne
  // redessine que l'indication. Les cartes, elles, ne bougent que lorsqu'une
  // lecture apporte mieux (onCandidats) — sinon elles clignoteraient.
  function rendreViseur() {
    var attribution = document.getElementById("scanAttribution");
    if (attribution) attribution.remove();
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

  // Ce que le moteur a réellement lu, sous les cartes.
  //
  // C'est le seul moyen, sur le terrain, de distinguer les deux échecs qui se
  // ressemblent à l'écran : « le cadre ne montre pas ce qui est lu » et « le
  // texte est bien lu mais ne rapproche aucune adresse ». Sans cette ligne, la
  // seule chose observable est une colonne vide, et il n'y a rien à en tirer.
  // La variable existait déjà et n'était affichée nulle part.
  function texteLuHTML() {
    if (!dernierTexteBrut) return "";
    var brut = dernierTexteBrut.replace(/\s+/g, " ").trim();
    if (!brut) return '<p class="scan-lu scan-lu-vide">Rien de lisible dans le cadre.</p>';
    return '<p class="scan-lu">Lu : ' + escapeHtml(brut.slice(0, 160)) + '</p>';
  }

  // Nœud à part, rafraîchi à chaque lecture : les cartes, elles, ne bougent
  // que lorsque le cumul change d'avis. Mélanger les deux ferait clignoter des
  // boutons sous le doigt une fois par seconde.
  function majTexteLuVue() {
    var box = document.getElementById("scanLu");
    if (box) box.innerHTML = texteLuHTML();
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
    var row = window.Store.findRow(session.adresseId());
    if (!row) { session.changerAdresse(); return; }
    var q = session.quantites();
    var total = session.totalQuantites();
    if (!viseurMonte) monterViseur();
    var viseur = document.getElementById("scanViseur");
    var overlay = document.getElementById("scanAttribution");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "scanAttribution";
      overlay.className = "scan-attribution-overlay";
      viseur.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div class="scan-attribution-panel">' +
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
      '<button type="button" class="scan-lien" data-action="scan-changer">Changer d\'adresse</button>' +
      '</div>';
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
      texteLuHTML() +
      '<label class="scan-cta">📷 ' + (candidats.length ? "Reprendre une photo" : "Prendre une photo") +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden></label>' +
      (videoDispo
        ? '<button type="button" class="scan-lien" data-action="scan-video">🎥 Revenir au viseur</button>'
        : "") +
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
      '<button type="button" class="scan-cta" data-action="scan-video">🎥 Réessayer la caméra</button>';
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
    titrer("Scanner une étiquette");
    definirPleinEcran(etat === C.ETATS.DEMARRAGE || etat === C.ETATS.VISEUR ||
      etat === C.ETATS.LECTURE || etat === C.ETATS.ATTRIBUTION);
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
  function capturePhoto() { capturerPhoto(); }
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
    capturePhoto: capturePhoto,
    changerAdresse: changerAdresse,
    modePhoto: modePhoto,
    modeVideo: modeVideo,
    etat: etat
  };
})();
