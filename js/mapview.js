/* ============================================================================
   mapview.js — fine couche au-dessus de Leaflet. Fabrique d'instances : la
   les Données et la Course ont chacune leur propre carte
   indépendante (deux conteneurs, deux instances Leaflet).
   ========================================================================== */
window.MapView = (function () {
  "use strict";

  var DEFAULT_CENTER = [45.82, 0.42]; // Charente, zone couverte par la tournée observée
  var DEFAULT_ZOOM = 12;

  function escapeHtml(s) {
    return (s || "").toString().replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Distance à vol d'oiseau (mètres) entre deux points GPS — formule de haversine.
  function distanceMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function createInstance() {
    var map = null;
    var markersLayer = null;
    var extraLayer = null; // marqueur de position actuelle et son halo de précision
    var markersById = {};
    var onSelectCallback = null;
    var userMarker = null;
    var accuracyCircle = null;

    function ensureMap(containerId) {
      if (map) return map;
      map = L.map(containerId, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap"
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      extraLayer = L.layerGroup().addTo(map);
      return map;
    }

    // Leaflet ne sait pas cadrer un conteneur encore masqué : il faut d'abord
    // lui rendre sa taille, puis seulement recadrer. Le rappel sert à cela.
    function invalidateSize(apres) {
      if (!map) return;
      setTimeout(function () {
        map.invalidateSize();
        if (apres) apres();
      }, 60);
    }

    function onSelect(cb) { onSelectCallback = cb; }

    // Rendu générique de points (Page 3 - Course) : chaque point porte son
    // propre dessin et son propre contenu de popup, calculés par l'appelant.
    // Sans taille imposée, le marqueur prend celle de son contenu — une
    // pastille de comptage s'élargit avec son nombre ; le CSS le centre.
    function renderPoints(points) {
      if (!map) return;
      markersLayer.clearLayers();
      markersById = {};
      points.forEach(function (p) {
        var marker = L.marker([p.lat, p.lon], {
          icon: L.divIcon({ className: "", html: p.html, iconSize: null }),
          zIndexOffset: p.zIndexOffset || 0
        });
        if (p.popupHtml) marker.bindPopup(p.popupHtml);
        if (p.id) {
          marker.on("click", function () { if (onSelectCallback) onSelectCallback(p.id); });
          markersById[p.id] = marker;
        }
        marker.addTo(markersLayer);
      });
    }

    // Position du livreur : volontairement d'une autre nature que les
    // pastilles — halo, anneau blanc, cœur bleu. Les pastilles portent la
    // couleur de leur commune et pourraient être bleues elles aussi : c'est la
    // forme, pas la teinte, qui doit distinguer « moi » de « à distribuer ».
    function setUserMarker(lat, lon, accuracy) {
      if (!map) return;
      if (userMarker) { extraLayer.removeLayer(userMarker); userMarker = null; }
      if (accuracyCircle) { extraLayer.removeLayer(accuracyCircle); accuracyCircle = null; }
      if (accuracy && accuracy > 15) {
        accuracyCircle = L.circle([lat, lon], {
          radius: accuracy, color: "#1e6fd9", weight: 1, opacity: 0.35,
          fillColor: "#1e6fd9", fillOpacity: 0.08, interactive: false
        }).addTo(extraLayer);
      }
      userMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 2000,
        interactive: false
      }).addTo(extraLayer);
    }

    function fitPoints(points, maxZoom) {
      if (!map || !points.length) return;
      try {
        map.fitBounds(points.map(function (p) { return [p.lat, p.lon]; }),
          { padding: [30, 30], maxZoom: maxZoom || 15 });
      } catch (e) { /* ignore */ }
    }

    function centerOn(lat, lon, zoom) {
      if (!map) return;
      map.setView([lat, lon], zoom || 16);
    }

    return {
      ensureMap: ensureMap,
      // Accès à l'instance Leaflet brute, pour les calques dessinés par
      // d'autres modules (le parcours de tournée) sans passer par ici.
      getMap: function () { return map; },
      invalidateSize: invalidateSize,
      renderPoints: renderPoints,
      setUserMarker: setUserMarker,
      centerOn: centerOn,
      fitPoints: fitPoints,
      onSelect: onSelect
    };
  }

  return {
    create: createInstance,
    distanceMeters: distanceMeters
  };
})();
