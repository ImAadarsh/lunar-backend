/** Haversine distance in meters. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const a1 = toRad(Number(lat1));
  const a2 = toRad(Number(lat2));
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** If radius is null, treat as no circular fence (allow). */
export function isInsideCircularGeofence(site, lat, lng) {
  if (site.geofence_radius_m == null) return true;
  const d = distanceMeters(lat, lng, site.center_lat, site.center_lng);
  return d <= Number(site.geofence_radius_m);
}

function normalizePolygon(raw) {
  if (!raw) return null;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const points = Array.isArray(value?.coordinates)
    ? value.coordinates
    : Array.isArray(value?.points)
      ? value.points
      : Array.isArray(value)
        ? value
        : null;
  if (!points || points.length < 3) return null;
  return points
    .map((p) => {
      if (Array.isArray(p)) return { lat: Number(p[0]), lng: Number(p[1]) };
      return { lat: Number(p.lat ?? p.latitude), lng: Number(p.lng ?? p.longitude) };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function isInsidePolygon(rawPolygon, lat, lng) {
  const polygon = normalizePolygon(rawPolygon);
  if (!polygon || polygon.length < 3) return true;

  const y = Number(lat);
  const x = Number(lng);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].lat;
    const xi = polygon[i].lng;
    const yj = polygon[j].lat;
    const xj = polygon[j].lng;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Prefer precise polygon fences when present; fall back to the existing circular
 * radius check for sites that only have a center point.
 */
export function isInsideGeofence(site, lat, lng) {
  if (site.geofence_polygon) return isInsidePolygon(site.geofence_polygon, lat, lng);
  return isInsideCircularGeofence(site, lat, lng);
}

/** Max horizontal distance from checkpoint center to accept a patrol scan (meters). */
export const CHECKPOINT_SCAN_RADIUS_M = 5;

/** Reject scans when reported GPS accuracy is worse than this (meters). */
export const MAX_PATROL_GPS_ACCURACY_M = 5;

/**
 * Guard must be within CHECKPOINT_SCAN_RADIUS_M of the checkpoint and report
 * accuracy no worse than MAX_PATROL_GPS_ACCURACY_M when accuracy is provided.
 */
export function validateCheckpointScanLocation(checkpoint, lat, lng, accuracyM) {
  const cpLat = Number(checkpoint.lat);
  const cpLng = Number(checkpoint.lng);
  if (!Number.isFinite(cpLat) || !Number.isFinite(cpLng)) {
    return { ok: false, message: 'Checkpoint has no GPS coordinates configured' };
  }
  if (accuracyM != null && Number.isFinite(Number(accuracyM))) {
    const acc = Number(accuracyM);
    if (acc > MAX_PATROL_GPS_ACCURACY_M) {
      return {
        ok: false,
        message: `GPS accuracy too low (${Math.round(acc)}m). Move closer and wait for a stronger signal (need ≤${MAX_PATROL_GPS_ACCURACY_M}m).`,
      };
    }
  }
  const distance = distanceMeters(lat, lng, cpLat, cpLng);
  if (distance > CHECKPOINT_SCAN_RADIUS_M) {
    return {
      ok: false,
      message: `You must be within ${CHECKPOINT_SCAN_RADIUS_M}m of the checkpoint (${Math.round(distance)}m away).`,
    };
  }
  return { ok: true, distanceM: distance };
}
