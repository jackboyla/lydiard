import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { decodePolyline } from '../data/mapRoutes';
import type { ActivityDetail, ActivitySummary } from '../types';

interface ActivityRouteMapProps {
  activity: ActivityDetail | ActivitySummary;
}

const DETAIL_MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#1b1b19' } },
    { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 0.84 } },
  ],
};

export default function ActivityRouteMap({ activity }: ActivityRouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const coordinates = useMemo(() => activityCoordinates(activity), [activity]);
  const routeKey = useMemo(
    () => coordinates.length > 1
      ? `${activity.id}:${coordinates.length}:${coordinates[0]?.join(',')}:${coordinates.at(-1)?.join(',')}`
      : `${activity.id}:empty`,
    [activity.id, coordinates],
  );

  useEffect(() => {
    if (!containerRef.current || coordinates.length < 2) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DETAIL_MAP_STYLE,
      center: coordinates[0],
      zoom: 12,
      attributionControl: { compact: true },
      interactive: false,
      fadeDuration: 0,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('activity-route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates },
        },
      });
      map.addLayer({
        id: 'activity-route-shadow',
        type: 'line',
        source: 'activity-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0e0e0d', 'line-width': 8, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'activity-route-line',
        type: 'line',
        source: 'activity-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e0533f', 'line-width': 4.5, 'line-opacity': 0.98 },
      });
      map.addSource('activity-route-points', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            pointFeature(coordinates[0], 'start'),
            pointFeature(coordinates[coordinates.length - 1], 'finish'),
          ],
        },
      });
      map.addLayer({
        id: 'activity-route-points',
        type: 'circle',
        source: 'activity-route-points',
        paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'kind'], 'finish', '#e3ad55', '#5cc391'],
          'circle-stroke-color': '#0e0e0d',
          'circle-stroke-width': 2.5,
        },
      });

      const bounds = coordinates.reduce(
        (current, coordinate) => current.extend(coordinate),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
      );
      map.fitBounds(bounds, { padding: 42, maxZoom: 15, duration: 0 });
    });

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [routeKey]);

  if (coordinates.length < 2) {
    return <div className="activity-route-map-empty">No GPS route is available for this run.</div>;
  }

  return <div className="activity-route-map-canvas" ref={containerRef} aria-label={`Route map for ${activity.name}`} />;
}

function activityCoordinates(activity: ActivityDetail | ActivitySummary): Array<[number, number]> {
  if ('streams' in activity && activity.streams?.latlng && activity.streams.latlng.length > 1) {
    return activity.streams.latlng
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))
      .map(([lat, lng]) => [lng, lat]);
  }
  return activity.summaryPolyline ? decodePolyline(activity.summaryPolyline) : [];
}

function pointFeature(coordinates: [number, number], kind: 'start' | 'finish'): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    properties: { kind },
    geometry: { type: 'Point', coordinates },
  };
}
