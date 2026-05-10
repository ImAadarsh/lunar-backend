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
