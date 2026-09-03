/* ============================================================================
   scan.js — lecture d'une étiquette par la caméra (fonction expérimentale).

   Chaîne : photo → prétraitement → OCR → rapprochement dans la base → choix.
   L'OCR n'a pas besoin d'être exact : c'est Store.matchTexteLibre qui décide,
   en cherchant l'adresse connue la plus proche du texte lu. Un texte à moitié
   faux reste donc exploitable, et l'adresse de l'expéditeur — absente de la
   tournée — s'élimine d'elle-même.

   Module volontairement isolé : Tesseract n'est chargé qu'à la première
   utilisation, et si ce chargement échoue, le reste de l'application n'en
   sait rien.
   ========================================================================== */
window.Scan = (function () {
  "use strict";

  var TESSERACT_URL = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/7.0.0/tesseract.min.js";
  var LANGUE = "fra";

  // Angles essayés successivement : deux clichés de test sur cinq étaient
  // pivotés d'un quart de tour. On s'arrête au premier résultat convaincant.
  var ANGLES = [0, 90, 270, 180];
  var LARGEUR_MAX = 1600;
  var LARGEUR_MIN = 1000;

  var els = {};
  var onPick = null;
  var tesseractPret = null; // promesse de chargement, mise en cache
  var worker = null;
  var enCours = false;

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

  function obtenirWorker(onProgress) {
    if (worker) return Promise.resolve(worker);
    return chargerTesseract().then(function (T) {
      return T.createWorker(LANGUE, 1, {
        logger: function (m) {
          if (m.status === "recognizing text" && onProgress) onProgress(m.progress);
        }
      });
    }).then(function (w) {
      worker = w;
      return w;
    });
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
  // Analyse
  // ---------------------------------------------------------------------
  function analyser(file) {
    if (enCours) return;
    enCours = true;
    var base = null;
    var meilleur = { candidats: [], texte: "", angle: 0 };

    afficherTravail("Préparation de l'image…", 0);

    chargerImage(file)
      .then(function (img) {
        base = accentuer(versCanvas(img));
        afficherTravail("Chargement du moteur de lecture…", 0);
        return obtenirWorker();
      })
      .then(function (w) {
        // Passes successives : on tente les orientations tant que le résultat
        // n'est pas net. La base d'adresses sert de juge de la qualité.
        return ANGLES.reduce(function (chaine, angle, idx) {
          return chaine.then(function (fini) {
            if (fini) return true;
            afficherTravail(
              idx === 0 ? "Lecture de l'étiquette…" : "Nouvel essai, image pivotée de " + angle + "°…",
              0
            );
            return w.recognize(pivoter(base, angle)).then(function (res) {
              var texte = (res && res.data && res.data.text) || "";
              var candidats = window.Store.matchTexteLibre(texte, 5);
              if (!meilleur.candidats.length ||
                  (candidats[0] && (!meilleur.candidats[0] || candidats[0].score > meilleur.candidats[0].score))) {
                meilleur = { candidats: candidats, texte: texte, angle: angle };
              }
              // Résultat franc : inutile d'essayer les autres orientations.
              return !!(candidats[0] && candidats[0].touches >= 4 && candidats[0].score >= 6);
            });
          });
        }, Promise.resolve(false));
      })
      .then(function () {
        enCours = false;
        afficherResultats(meilleur);
      })
      .catch(function (e) {
        enCours = false;
        afficherErreur(e);
      });
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function ecranDepart() {
    els.body.innerHTML =
      '<p class="scan-intro">Prends l\'étiquette en photo, bien à plat et sans ombre portée. ' +
      'Le texte lu est ensuite rapproché des adresses de ta tournée.</p>' +
      '<label class="scan-cta">' +
        '📷 Prendre une photo' +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden>' +
      '</label>' +
      '<p class="scan-note">Fonction expérimentale. Le moteur de lecture (quelques Mo) ' +
      'est téléchargé au premier usage : prévois-le avant de partir en tournée.</p>';
    document.getElementById("scanFile").addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (f) analyser(f);
    });
  }

  function afficherTravail(message, progression) {
    els.body.innerHTML =
      '<div class="scan-travail">' +
        '<div class="scan-spinner"></div>' +
        '<div class="scan-etat">' + escapeHtml(message) + '</div>' +
        '<div class="scan-barre"><div class="scan-barre-fill" style="width:' +
          Math.round((progression || 0) * 100) + '%;"></div></div>' +
      '</div>';
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

  function afficherResultats(res) {
    var c = res.candidats;
    if (!c.length) {
      els.body.innerHTML =
        '<div class="scan-vide">Aucune adresse de la tournée ne correspond à cette étiquette.</div>' +
        texteLuHTML(res.texte) +
        '<label class="scan-cta">📷 Reprendre une photo' +
          '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden>' +
        '</label>';
      brancherFichier();
      return;
    }
    // Deux candidats trop proches : on ne désigne pas de gagnant, on laisse choisir.
    var ecartFaible = c.length > 1 && (c[0].score - c[1].score) / c[0].score < 0.15;
    els.body.innerHTML =
      '<div class="scan-titre">' + (ecartFaible ? "Plusieurs adresses possibles" : "Adresse reconnue") + '</div>' +
      c.map(function (x, i) { return candidatHTML(x, i === 0, ecartFaible); }).join("") +
      texteLuHTML(res.texte) +
      '<label class="scan-cta secondaire">📷 Reprendre une photo' +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden>' +
      '</label>';
    brancherFichier();
  }

  function brancherFichier() {
    var input = document.getElementById("scanFile");
    if (!input) return;
    input.addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (f) analyser(f);
    });
  }

  // Le texte brut reste consultable : pendant la phase de test, c'est ce qui
  // permet de comprendre pourquoi une étiquette n'a pas été reconnue.
  function texteLuHTML(texte) {
    if (!texte || !texte.trim()) return "";
    return '<details class="scan-brut"><summary>Texte lu par l\'appareil</summary>' +
      '<pre>' + escapeHtml(texte.trim()) + '</pre></details>';
  }

  function afficherErreur(e) {
    var reseau = e && e.message === "réseau";
    els.body.innerHTML =
      '<div class="status err">' +
        (reseau
          ? "Le moteur de lecture n'a pas pu être téléchargé. Il faut une connexion au premier usage."
          : "La lecture a échoué (" + escapeHtml(e && e.message) + ").") +
      '</div>' +
      '<label class="scan-cta">📷 Réessayer' +
        '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden>' +
      '</label>';
    brancherFichier();
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  function open(options) {
    onPick = (options && options.onPick) || null;
    els.overlay = document.getElementById("scanOverlay");
    els.body = document.getElementById("scanBody");
    els.overlay.classList.add("open");
    ecranDepart();
  }

  function close() {
    if (els.overlay) els.overlay.classList.remove("open");
  }

  function pick(id) {
    close();
    if (onPick) onPick(id);
  }

  return { open: open, close: close, pick: pick };
})();
