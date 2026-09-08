/* ============================================================================
   scan-core.js — la mécanique du scan, sans caméra, sans DOM, sans Tesseract.

   Tout ce qui se raisonne est ici ; tout ce qui se branche est dans scan.js.
   Ce partage a une raison pratique : la boucle vidéo est illisible quand elle
   mêle un flux caméra, un canvas, un moteur d'OCR et sept états d'interface.
   Isolé, chaque morceau se lit — et se met à l'épreuve dans un simple Node,
   sans navigateur (voir tests/scan.js).

   Cinq briques, dans l'ordre où le scan les traverse :

     1. la machine à états      — ce que l'écran a le droit de devenir ;
     2. la cadence              — quand une reconnaissance peut partir ;
     3. la qualité d'image      — si cette image-là mérite qu'on la lise ;
     4. les candidats           — quand remplacer les cartes affichées ;
     5. l'attribution           — ce qui s'écrit, et seulement sur validation.

   La session, en bas, les assemble sans jamais toucher au navigateur.
   ========================================================================== */
window.ScanCore = (function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 1. États et transitions
  //
  // La liste est fermée : un état absent de la table ne peut pas être atteint,
  // et une transition non déclarée est refusée plutôt que subie. C'est ce qui
  // garantit qu'un résultat d'OCR arrivé en retard ne rallume pas le viseur
  // par-dessus l'écran d'attribution.
  // ---------------------------------------------------------------------
  var ETATS = {
    IDLE: "idle",
    DEMARRAGE: "camera-starting",
    VISEUR: "scanning",
    LECTURE: "recognizing",
    ATTRIBUTION: "assigning",
    PHOTO: "fallback-photo",
    ERREUR: "error"
  };

  var TRANSITIONS = {
    "idle":            ["camera-starting", "fallback-photo", "error"],
    "camera-starting": ["scanning", "fallback-photo", "error", "idle"],
    // camera-starting depuis le viseur : la reprise après une mise en veille,
    // un onglet quitté, ou une piste vidéo arrêtée d'elle-même.
    "scanning":        ["recognizing", "assigning", "camera-starting", "fallback-photo", "error", "idle"],
    "recognizing":     ["scanning", "assigning", "camera-starting", "fallback-photo", "error", "idle"],
    "assigning":       ["camera-starting", "fallback-photo", "error", "idle"],
    "fallback-photo":  ["assigning", "camera-starting", "error", "idle"],
    "error":           ["camera-starting", "fallback-photo", "idle"]
  };

  function creerMachine(onChange) {
    var etat = ETATS.IDLE;
    function peut(cible) {
      return cible === etat || (TRANSITIONS[etat] || []).indexOf(cible) >= 0;
    }
    return {
      etat: function () { return etat; },
      peut: peut,
      // Renvoie faux — et ne change rien — si la transition n'est pas prévue.
      aller: function (cible, info) {
        if (cible === etat) return true;
        if (!peut(cible)) return false;
        var avant = etat;
        etat = cible;
        if (onChange) onChange(etat, avant, info);
        return true;
      }
    };
  }

  // ---------------------------------------------------------------------
  // 2. Cadence
  //
  // Deux garde-fous en un : jamais deux reconnaissances en vol, jamais deux
  // départs plus rapprochés que l'intervalle. Le jeton sert au troisième cas,
  // le plus sournois : l'utilisateur touche une carte pendant qu'une lecture
  // court. La lecture ne s'annule pas — on n'interrompt pas le moteur au
  // milieu d'une image — mais son résultat est périmé et ne remontera pas.
  // ---------------------------------------------------------------------
  function creerCadence(opts) {
    opts = opts || {};
    var intervalle = opts.intervalle || 1000;
    var horloge = opts.horloge || function () { return Date.now(); };
    var enVol = false;
    var dernier = -Infinity;
    var jeton = 0;

    function pret() { return !enVol && (horloge() - dernier) >= intervalle; }

    return {
      enVol: function () { return enVol; },
      pret: pret,
      // Lance le travail si la cadence l'autorise, sinon renvoie null sans
      // rien faire. La promesse rendue vaut null quand le résultat est périmé.
      lancer: function (travail) {
        if (!pret()) return null;
        var mien = jeton;
        enVol = true;
        function fin() {
          enVol = false;
          // Une lecture périmée ne décale pas la cadence : le viseur qui
          // repart ne doit pas attendre la fin d'un travail qu'on a jeté.
          if (mien === jeton) dernier = horloge();
        }
        var p;
        try { p = Promise.resolve(travail()); }
        catch (e) { fin(); return Promise.reject(e); }
        return p.then(function (r) {
          fin();
          return (mien === jeton) ? r : null;
        }, function (e) { fin(); throw e; });
      },
      // Périme le travail en cours et libère la cadence pour la suite.
      annuler: function () { jeton += 1; dernier = -Infinity; }
    };
  }

  // ---------------------------------------------------------------------
  // 3. Qualité d'image
  //
  // Trois nombres suffisent à écarter les images qu'il serait vain de lire :
  //   contraste — l'écart-type des niveaux de gris ; un cadre vide ou une
  //               étiquette dans l'ombre s'effondre ;
  //   nettete   — le gradient horizontal moyen ; le flou de bougé l'écrase ;
  //   empreinte — seize moyennes de blocs, comparées d'une image à l'autre,
  //               qui disent si la main s'est stabilisée.
  // Les seuils sont empiriques et regroupés pour s'ajuster d'un seul endroit.
  // ---------------------------------------------------------------------
  var SEUILS = { contraste: 16, nettete: 5, mouvement: 7 };

  function statsZone(data, largeur, hauteur, pas) {
    pas = pas || 1;
    if (!data || !largeur || !hauteur) return null;
    var somme = 0, sommeCarres = 0, n = 0, gradient = 0, nGrad = 0;
    // Empreinte 4×4 : assez grossière pour ignorer le bruit du capteur, assez
    // fine pour voir l'étiquette glisser hors du cadre.
    var blocs = new Array(16), comptes = new Array(16), i;
    for (i = 0; i < 16; i++) { blocs[i] = 0; comptes[i] = 0; }

    for (var y = 0; y < hauteur; y += pas) {
      var precedent = null;
      for (var x = 0; x < largeur; x += pas) {
        var idx = (y * largeur + x) * 4;
        var g = (data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
        somme += g; sommeCarres += g * g; n += 1;
        if (precedent !== null) { gradient += Math.abs(g - precedent); nGrad += 1; }
        precedent = g;
        var b = (Math.min(3, (y * 4 / hauteur) | 0) * 4) + Math.min(3, (x * 4 / largeur) | 0);
        blocs[b] += g; comptes[b] += 1;
      }
    }
    if (!n) return null;
    var moyenne = somme / n;
    var variance = Math.max(0, (sommeCarres / n) - (moyenne * moyenne));
    for (i = 0; i < 16; i++) blocs[i] = comptes[i] ? (blocs[i] / comptes[i]) : 0;
    return {
      moyenne: moyenne,
      contraste: Math.sqrt(variance),
      nettete: nGrad ? (gradient / nGrad) : 0,
      empreinte: blocs
    };
  }

  // Distance moyenne entre deux empreintes. Deux images incomparables sont
  // déclarées très différentes : au doute, on attend une image de plus.
  function ecartEmpreinte(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  // L'ordre des tests est l'ordre des reproches : on ne demande pas de la
  // lumière à quelqu'un dont la main tremble encore.
  function qualiteFrame(stats, precedent, seuils) {
    var s = seuils || SEUILS;
    // Sans image précédente, la stabilité ne se mesure pas : la toute première
    // image d'un viseur qui s'ouvre est une image de calage, jamais une image
    // qu'on lit. Cela coûte un dixième de seconde et évite une lecture lancée
    // sur le mouvement de la main qui approche l'étiquette.
    if (!stats || !precedent) {
      return { utilisable: false, indication: "Placez l'étiquette dans le cadre" };
    }
    if (ecartEmpreinte(stats.empreinte, precedent.empreinte) > s.mouvement) {
      return { utilisable: false, indication: "Stabilisez l'étiquette" };
    }
    if (stats.nettete < s.nettete) {
      return { utilisable: false, indication: "Rapprochez-vous de l'étiquette" };
    }
    if (stats.contraste < s.contraste) {
      return { utilisable: false, indication: "Cherchez un peu plus de lumière" };
    }
    return { utilisable: true, indication: "" };
  }

  // Fenêtre de capture : le cadre visible, élargi d'une marge de sécurité,
  // borné à l'image. Un nom écrit de travers ou une adresse collée au bord de
  // l'étiquette tombe dans la marge plutôt que dehors.
  function rectCapture(largeur, hauteur, opts) {
    opts = opts || {};
    var pl = opts.partLargeur || 0.86;
    var ph = opts.partHauteur || 0.46;
    var marge = (opts.marge == null) ? 0.12 : opts.marge;
    var w = Math.min(largeur, largeur * pl * (1 + marge));
    var h = Math.min(hauteur, hauteur * ph * (1 + marge));
    return {
      x: Math.round((largeur - w) / 2),
      y: Math.round((hauteur - h) / 2),
      w: Math.round(w),
      h: Math.round(h)
    };
  }

  // Le même rectangle, mais quand l'image affichée n'est pas l'image du
  // capteur. C'est le cas du repli « pivot forcé » : écran verrouillé en
  // portrait, téléphone tenu couché, le navigateur livre donc un buffer
  // portrait où l'étiquette gît sur le flanc, et l'interface le redresse
  // d'un quart de tour pour l'œil.
  //
  //   rotation — l'angle qu'il faut faire subir au buffer pour obtenir ce
  //              que l'utilisateur voit : 0, 90 ou -90 (270 accepté).
  //
  // Le cadrage se calcule dans le repère vu — c'est là que « large » veut
  // dire quelque chose, et c'est là que le cadre blanc est dessiné — puis se
  // ramène en coordonnées du buffer, seul repère que sait lire un drawImage.
  // Sans cette traduction, une découpe « 90 % de large » prise sur un buffer
  // portrait désigne une bande verticale : le cadre visé et la zone lue ne
  // parlent plus de la même chose, et plus rien n'est reconnu.
  function rectCaptureOriente(largeur, hauteur, rotation, opts) {
    var a = ((((rotation || 0) % 360) + 360) % 360);
    if (a !== 90 && a !== 270) return rectCapture(largeur, hauteur, opts);
    // Vu de l'utilisateur, les deux axes sont échangés.
    var r = rectCapture(hauteur, largeur, opts);
    return (a === 90)
      ? { x: r.y, y: hauteur - r.x - r.w, w: r.h, h: r.w }
      : { x: largeur - r.y - r.h, y: r.x, w: r.h, h: r.w };
  }

  // Stratégie d'orientation. La photo est ponctuelle : on peut se payer les
  // quatre angles. En vidéo, l'image est déjà redressée lors de la capture
  // (scan.js) pour correspondre au cadre vu. Relancer l'OCR à 90° après un
  // échec double la latence sans aider un smartphone Android récent ; ce repli
  // est donc réservé au mode photo.
  var ANGLES_PHOTO = [0, 90, 270, 180];
  var ANGLES_SECOURS = [90, 270, 180];

  function anglesAEssayer(mode, angleRetenu, essaisVides) {
    if (mode === "photo") return ANGLES_PHOTO.slice();
    return [0];
  }

  // ---------------------------------------------------------------------
  // 4. Candidats
  // ---------------------------------------------------------------------
  function idsDe(liste) {
    return (liste || []).map(function (c) { return (c && c.row) ? c.row.id : ""; }).join("|");
  }

  function scoreTete(liste) {
    return (liste && liste[0] && liste[0].score) || 0;
  }

  // Une lecture vide ne chasse jamais des cartes déjà affichées, et une lecture
  // moins convaincante non plus : entre deux images, le doigt bouge, et une
  // liste qui clignote ne se lit pas. On ne remplace que sur du neuf, et sur du
  // meilleur.
  function doitRemplacer(anciens, nouveaux) {
    if (!nouveaux || !nouveaux.length) return false;
    if (!anciens || !anciens.length) return true;
    if (idsDe(anciens) === idsDe(nouveaux)) return false;
    return scoreTete(nouveaux) >= scoreTete(anciens);
  }

  // Deux têtes trop proches : on n'en désigne aucune. Seuil et calcul repris
  // tels quels du scan photo, pour que les deux modes jugent pareil.
  // Nombre de lectures concordantes qu'il faut pour renverser une proposition
  // mieux notée. Deux : une seconde d'attente, et l'hésitation d'une lecture
  // isolée ne suffit plus à faire danser les cartes.
  var CONFIRMATIONS = 2;

  function ecartFaible(candidats) {
    return !!(candidats && candidats.length > 1 && candidats[0].score &&
      (candidats[0].score - candidats[1].score) / candidats[0].score < 0.15);
  }

  // ---------------------------------------------------------------------
  // 5. Attribution
  // ---------------------------------------------------------------------
  function creerBrouillon(cles) {
    var q = {};
    function vider() { (cles || []).forEach(function (k) { q[k] = 0; }); }
    vider();
    return {
      get: function (k) { return q[k] || 0; },
      ajuster: function (k, delta) {
        if (q[k] === undefined) return 0;
        q[k] = Math.max(0, q[k] + (delta || 0));
        return q[k];
      },
      valeurs: function () {
        var o = {};
        (cles || []).forEach(function (k) { o[k] = q[k] || 0; });
        return o;
      },
      total: function () {
        return (cles || []).reduce(function (n, k) { return n + (q[k] || 0); }, 0);
      },
      vider: vider
    };
  }

  // Le seul point d'écriture vers la préparation de toute la chaîne de scan.
  // Les quantités s'ajoutent à l'existant plutôt que de le remplacer : la même
  // adresse revient souvent, un colis après l'autre.
  function appliquerAttribution(prep, idTournee, addrId, quantites) {
    var ecrit = {};
    if (!prep || !idTournee || !addrId) return ecrit;
    Object.keys(quantites || {}).forEach(function (k) {
      var n = Math.max(0, Math.round(Number(quantites[k]) || 0));
      if (n > 0) { prep.adjust(idTournee, addrId, k, n); ecrit[k] = n; }
    });
    return ecrit;
  }

  // ---------------------------------------------------------------------
  // Diagnostic caméra
  // ---------------------------------------------------------------------
  function videoDisponible(nav, secure) {
    return !!(secure && nav && nav.mediaDevices && nav.mediaDevices.getUserMedia);
  }

  function messageErreurCamera(err) {
    var nom = (err && err.name) || "";
    if (nom === "NotAllowedError" || nom === "PermissionDeniedError" || nom === "SecurityError") {
      return "Accès à la caméra refusé. Autorise-la dans les réglages du navigateur, ou prends une photo.";
    }
    if (nom === "NotFoundError" || nom === "DevicesNotFoundError") {
      return "Aucune caméra n'a été trouvée sur cet appareil.";
    }
    if (nom === "NotReadableError" || nom === "TrackStartError") {
      return "La caméra est déjà utilisée par une autre application.";
    }
    if (nom === "OverconstrainedError" || nom === "ConstraintNotSatisfiedError") {
      return "La caméra ne sait pas fournir l'image demandée.";
    }
    if (nom === "non-securise") {
      return "La caméra n'est accessible qu'en HTTPS. Prends une photo à la place.";
    }
    if (nom === "non-supporte") {
      return "Ce navigateur ne sait pas ouvrir la caméra en continu.";
    }
    return "La caméra n'a pas pu démarrer" + (nom ? " (" + nom + ")" : "") + ".";
  }

  // ---------------------------------------------------------------------
  // Session : l'enchaînement complet, branché par callbacks
  //
  //   viseur → suggestions → choix d'une carte → attribution → viseur
  //
  // Aucune ligne ici ne connaît le DOM ni la caméra : scan.js fournit
  // demarrerCamera / arreterCamera / reconnaitre / qualifier, les tests
  // fournissent des doublures.
  // ---------------------------------------------------------------------
  function creerSession(deps) {
    deps = deps || {};
    var types = deps.types || [];
    var cadence = deps.cadence || creerCadence({ intervalle: deps.intervalle || 1000 });
    var brouillon = creerBrouillon(types);

    var candidats = [];
    var texteLu = "";
    var adresseId = null;
    var indication = "";
    var statsPrec = null;
    var angleRetenu = 0;
    var essaisVides = 0;
    var rejet = "";        // proposition écartée à la lecture précédente
    var rejetsSuivis = 0;  // combien de fois de suite elle est revenue

    var machine = creerMachine(function (etat, avant, info) {
      if (deps.onEtat) deps.onEtat(etat, avant, info);
    });

    // Tout arrêt passe par ici : la cadence d'abord — le résultat en vol
    // devient caduc —, la caméra ensuite. Jamais l'inverse, sinon une lecture
    // rendrait son verdict alors que le flux est déjà coupé.
    //
    // Le motif est transmis tel quel : tous les arrêts ne se valent pas. Une
    // attribution dure quelques secondes et sera suivie d'un retour au viseur,
    // une fermeture non — c'est à l'adhérence de décider si elle suspend le
    // flux ou le rend, mais c'est ici qu'on lui dit pourquoi.
    function arreterAcquisition(motif) {
      cadence.annuler();
      statsPrec = null;
      if (deps.arreterCamera) deps.arreterCamera(motif || "arret");
    }

    function majIndication(texte) {
      if (texte === indication) return;
      indication = texte;
      if (deps.onIndication) deps.onIndication(indication);
    }

    function echec(err) {
      arreterAcquisition("erreur");
      machine.aller(ETATS.ERREUR, err);
      return false;
    }

    function demarrer() {
      if (!machine.aller(ETATS.DEMARRAGE)) return Promise.resolve(false);
      cadence.annuler();
      majIndication("");
      return Promise.resolve()
        .then(function () { return deps.demarrerCamera ? deps.demarrerCamera() : true; })
        .then(function () {
          // Fermé, ou basculé en photo, pendant que la caméra s'ouvrait : on
          // ne rallume pas un viseur que l'utilisateur a quitté.
          if (machine.etat() !== ETATS.DEMARRAGE) return false;
          return machine.aller(ETATS.VISEUR);
        })
        .catch(function (e) { return echec(e); });
    }

    function poser(liste, texte) {
      candidats = liste;
      texteLu = texte || "";
      rejet = "";
      rejetsSuivis = 0;
      if (deps.onCandidats) deps.onCandidats(candidats, texteLu);
    }

    function appliquerLecture(res) {
      // Le lecteur a pu qualifier lui-même : c'est ainsi qu'il départage deux
      // orientations. On ne requalifie pas ce qu'il a déjà jaugé.
      var nouveaux = (res.candidats ||
        (deps.qualifier ? deps.qualifier(res.texte || "") : [])) || [];
      if (nouveaux.length) { angleRetenu = res.angle || 0; essaisVides = 0; }
      else { essaisVides += 1; }

      if (doitRemplacer(candidats, nouveaux)) { poser(nouveaux, res.texte); return; }
      if (!nouveaux.length) return;

      var ids = idsDe(nouveaux);
      if (ids === idsDe(candidats)) { rejet = ""; rejetsSuivis = 0; return; }

      // Insister vaut confirmation. Sans cette clause, la première lecture
      // convaincante gèlerait les cartes pour de bon : l'étiquette suivante,
      // moins bien lue, ne repasserait jamais devant elle — et l'utilisateur
      // croirait le scan arrêté. Deux lectures de suite qui disent la même
      // autre chose, c'est l'étiquette qui a changé, pas le moteur qui hésite.
      rejetsSuivis = (ids === rejet) ? rejetsSuivis + 1 : 1;
      rejet = ids;
      if (rejetsSuivis >= CONFIRMATIONS) poser(nouveaux, res.texte);
    }

    // Un tour de boucle vidéo : la qualité d'abord, la cadence ensuite, l'OCR
    // en dernier. Renvoie la promesse de lecture, ou null si ce tour n'a rien
    // déclenché — ce qui est le cas le plus fréquent, et c'est voulu.
    function evaluerFrame(stats) {
      var q = qualiteFrame(stats, statsPrec, deps.seuils);
      statsPrec = stats || null;
      if (!q.utilisable) { majIndication(q.indication); return q; }
      majIndication("");
      return q;
    }

    function tick(stats) {
      var e = machine.etat();
      if (e !== ETATS.VISEUR && e !== ETATS.LECTURE) return null;

      var q = evaluerFrame(stats);
      if (!q.utilisable) return null;
      if (!cadence.pret()) return null;

      var angles = anglesAEssayer("video", angleRetenu, essaisVides);
      machine.aller(ETATS.LECTURE);
      var p = cadence.lancer(function () { return deps.reconnaitre(angles); });
      if (!p) { machine.aller(ETATS.VISEUR); return null; }
      return p.then(function (res) {
        // res null : lecture périmée par un changement d'état. On ne touche ni
        // aux cartes ni à l'état — l'écran a déjà tourné la page.
        if (res) appliquerLecture(res);
        if (machine.etat() === ETATS.LECTURE) machine.aller(ETATS.VISEUR);
        return res || null;
      }, function () {
        if (machine.etat() === ETATS.LECTURE) machine.aller(ETATS.VISEUR);
        return null;
      });
    }

    // Résultat d'un cliché : là, l'utilisateur a explicitement demandé une
    // nouvelle lecture. Elle remplace l'affichage, même si elle ne donne rien.
    function poserCandidats(liste, texte) {
      poser(liste || [], texte);
    }

    function choisir(id) {
      if (!id || !machine.peut(ETATS.ATTRIBUTION)) return false;
      // Gel avant bascule : les candidats restent tels qu'affichés, la cadence
      // et la caméra s'arrêtent, puis seulement l'écran change.
      adresseId = id;
      brouillon.vider();
      // On annule uniquement une éventuelle lecture en vol. La caméra reste
      // visible sous le panneau d'attribution : le geste suivant repart sans
      // réouverture ni écran noir.
      cadence.annuler();
      machine.aller(ETATS.ATTRIBUTION);
      if (deps.onChoix) deps.onChoix(id);
      return true;
    }

    function ajusterQuantite(type, delta) {
      if (machine.etat() !== ETATS.ATTRIBUTION) return 0;
      var v = brouillon.ajuster(type, delta);
      if (deps.onQuantites) deps.onQuantites(brouillon.valeurs(), brouillon.total());
      return v;
    }

    function reprendre() {
      adresseId = null;
      candidats = [];
      texteLu = "";
      rejet = "";
      rejetsSuivis = 0;
      brouillon.vider();
      return demarrer();
    }

    function ajouterALaTournee() {
      if (machine.etat() !== ETATS.ATTRIBUTION || !adresseId) return null;
      if (brouillon.total() === 0) return null;
      var id = adresseId;
      var ecrit = appliquerAttribution(
        deps.prep, deps.idTournee ? deps.idTournee() : null, id, brouillon.valeurs());
      if (deps.onAjout) deps.onAjout(id, ecrit);
      reprendre();
      return ecrit;
    }

    // N'écrit rien, par construction : aucun appel à appliquerAttribution.
    function changerAdresse() {
      if (machine.etat() !== ETATS.ATTRIBUTION) return false;
      reprendre();
      return true;
    }

    function modePhoto() {
      if (!machine.peut(ETATS.PHOTO)) return false;
      arreterAcquisition("photo");
      candidats = [];
      texteLu = "";
      rejet = "";
      rejetsSuivis = 0;
      return machine.aller(ETATS.PHOTO);
    }

    function fermer() {
      arreterAcquisition("fermeture");
      candidats = [];
      texteLu = "";
      rejet = "";
      rejetsSuivis = 0;
      adresseId = null;
      indication = "";
      angleRetenu = 0;
      essaisVides = 0;
      brouillon.vider();
      machine.aller(ETATS.IDLE);
      if (deps.onFermeture) deps.onFermeture();
      return true;
    }

    return {
      ETATS: ETATS,
      etat: function () { return machine.etat(); },
      peut: function (cible) { return machine.peut(cible); },
      candidats: function () { return candidats.slice(); },
      texteLu: function () { return texteLu; },
      adresseId: function () { return adresseId; },
      indication: function () { return indication; },
      quantites: function () { return brouillon.valeurs(); },
      totalQuantites: function () { return brouillon.total(); },
      cadence: cadence,

      demarrer: demarrer,
      tick: tick,
      evaluerFrame: evaluerFrame,
      poserCandidats: poserCandidats,
      choisir: choisir,
      ajusterQuantite: ajusterQuantite,
      ajouterALaTournee: ajouterALaTournee,
      changerAdresse: changerAdresse,
      modePhoto: modePhoto,
      echec: echec,
      fermer: fermer
    };
  }

  return {
    ETATS: ETATS,
    TRANSITIONS: TRANSITIONS,
    SEUILS: SEUILS,
    creerMachine: creerMachine,
    creerCadence: creerCadence,
    statsZone: statsZone,
    ecartEmpreinte: ecartEmpreinte,
    qualiteFrame: qualiteFrame,
    rectCapture: rectCapture,
    rectCaptureOriente: rectCaptureOriente,
    anglesAEssayer: anglesAEssayer,
    doitRemplacer: doitRemplacer,
    ecartFaible: ecartFaible,
    creerBrouillon: creerBrouillon,
    appliquerAttribution: appliquerAttribution,
    videoDisponible: videoDisponible,
    messageErreurCamera: messageErreurCamera,
    creerSession: creerSession
  };
})();
