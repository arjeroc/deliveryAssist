/* ============================================================================
   mapview.js — fine couche au-dessus de Leaflet. Fabrique d'instances : la
   Base de données et le Suivi de tournée ont chacun leur propre carte
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

  function markerIcon(color, size) {
    size = size || 16;
    return L.divIcon({
      className: "",
      html: '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color +
            ';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3);"></div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  function createInstance() {
    var map = null;
    var markersLayer = null;
    var extraLayer = null; // cercles de rayon, marqueur position actuelle…
    var markersById = {};
    var onSelectCallback = null;
    var userMarker = null;

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

    function invalidateSize() {
      if (map) setTimeout(function () { map.invalidateSize(); }, 60);
    }

    function onSelect(cb) { onSelectCallback = cb; }

    function colorFor(row) {
      return Store.hasGPS(row) ? "#2f6b4f" : "#a1301f";
    }

    // Rendu "adresses de la base" (Page 1) : coloration par disponibilité GPS.
    function renderAll(rows, opts) {
      if (!map) return;
      opts = opts || {};
      markersLayer.clearLayers();
      markersById = {};
      var withGPS = [];
      rows.forEach(function (r) {
        if (!Store.hasGPS(r)) return;
        var lat = Number(r.latitude), lon = Number(r.longitude);
        withGPS.push([lat, lon]);
        var names = Store.namesOf(r).join(" / ") || "(sans nom)";
        var addr = [r.numero, r.rue].filter(Boolean).join(" ");
        var marker = L.marker([lat, lon], { icon: markerIcon(colorFor(r)) });
        marker.bindPopup(
          "<strong>" + escapeHtml(names) + "</strong><br>" +
          escapeHtml(addr) + "<br>" +
          escapeHtml([r.code_postal, r.commune].filter(Boolean).join(" ")) + "<br>" +
          "<em>" + escapeHtml(Store.casierLabel(r)) + "</em>"
        );
        marker.on("click", function () { if (onSelectCallback) onSelectCallback(r.id); });
        marker.addTo(markersLayer);
        markersById[r.id] = marker;
      });
      if (withGPS.length && opts.fit !== false) {
        try { map.fitBounds(withGPS, { padding: [30, 30], maxZoom: 15 }); } catch (e) { /* ignore */ }
      }
    }

    // Rendu générique de points (Page 3 - Suivi) : chaque point porte sa
    // propre couleur et son propre contenu de popup, calculés par l'appelant.
    function renderPoints(points, opts) {
      if (!map) return;
      opts = opts || {};
      markersLayer.clearLayers();
      markersById = {};
      var coords = [];
      points.forEach(function (p) {
        coords.push([p.lat, p.lon]);
        var marker = L.marker([p.lat, p.lon], { icon: markerIcon(p.color || "#2f6b4f", p.size) });
        if (p.popupHtml) marker.bindPopup(p.popupHtml);
        if (p.id) {
          marker.on("click", function () { if (onSelectCallback) onSelectCallback(p.id); });
          markersById[p.id] = marker;
        }
        marker.addTo(markersLayer);
      });
      if (coords.length && opts.fit) {
        try { map.fitBounds(coords, { padding: [30, 30], maxZoom: 15 }); } catch (e) { /* ignore */ }
      }
    }

    function setUserMarker(lat, lon) {
      if (!map) return;
      if (userMarker) { extraLayer.removeLayer(userMarker); }
      userMarker = L.circleMarker([lat, lon], {
        radius: 8, color: "#fff", weight: 2, fillColor: "#1e6fd9", fillOpacity: 1
      }).addTo(extraLayer);
    }

    function drawRadiusCircles(lat, lon, radii) {
      if (!map) return;
      extraLayer.eachLayer(function (l) { if (l._radiusRing) extraLayer.removeLayer(l); });
      radii.forEach(function (r) {
        var circle = L.circle([lat, lon], {
          radius: r.meters, color: r.color, weight: 1.5, fillOpacity: 0.04, dashArray: "4,4"
        });
        circle._radiusRing = true;
        circle.addTo(extraLayer);
      });
    }

    function centerOn(lat, lon, zoom) {
      if (!map) return;
      map.setView([lat, lon], zoom || 16);
    }

    function focusRow(id) {
      var m = markersById[id];
      if (!m || !map) return false;
      var ll = m.getLatLng();
      map.setView(ll, 17);
      m.openPopup();
      return true;
    }

    return {
      ensureMap: ensureMap,
      invalidateSize: invalidateSize,
      renderAll: renderAll,
      renderPoints: renderPoints,
      setUserMarker: setUserMarker,
      drawRadiusCircles: drawRadiusCircles,
      centerOn: centerOn,
      focusRow: focusRow,
      onSelect: onSelect
    };
  }

  return {
    create: createInstance,
    distanceMeters: distanceMeters
  };
})();
