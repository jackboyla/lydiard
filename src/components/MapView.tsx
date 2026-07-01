import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildRouteCollection, routeBounds, type ColorBy } from '../data/mapRoutes';
import type { ActivitySummary, Severity } from '../types';

interface MapViewProps {
  activities: ActivitySummary[];
  severityByWeek: Map<string, Severity>;
  colorBy: ColorBy;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const DARK_STYLE: maplibregl.StyleSpecification = {
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
    { id: 'background', type: 'background', paint: { 'background-color': '#0d1015' } },
    { id: 'carto', type: 'raster', source: 'carto', paint: { 'raster-opacity': 0.85 } },
  ],
};

export function MapView({ activities, severityByWeek, colorBy, selectedId, onSelect }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onSelectRef = useRef(onSelect);
  const fittedKeyRef = useRef<string>('');
  const [isLoaded, setIsLoaded] = useState(false);

  onSelectRef.current = onSelect;

  const collection = useMemo(
    () => buildRouteCollection(activities, colorBy, severityByWeek),
    [activities, colorBy, severityByWeek],
  );

  // A key identifying the *set* of routes, so we only re-fit bounds when it changes.
  const routeKey = useMemo(
    () => collection.features.map((feature) => feature.properties.id).sort().join(','),
    [collection],
  );

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return;
    }
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DARK_STYLE,
      center: [-6.26, 53.35],
      zoom: 2,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('routes', { type: 'geojson', data: emptyCollection() });
      map.addLayer({
        id: 'routes-base',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 12, 2.6, 15, 4],
          'line-opacity': 0.72,
        },
      });
      map.addLayer({
        id: 'routes-selected',
        type: 'line',
        source: 'routes',
        filter: ['==', ['get', 'id'], '__none__'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 5, 15, 7],
          'line-opacity': 0.95,
        },
      });

      map.on('click', 'routes-base', (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === 'string') {
          onSelectRef.current(id);
        }
      });
      map.on('click', (event) => {
        const hits = map.queryRenderedFeatures(event.point, { layers: ['routes-base'] });
        if (hits.length === 0) {
          onSelectRef.current(null);
        }
      });
      map.on('mouseenter', 'routes-base', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'routes-base', () => {
        map.getCanvas().style.cursor = '';
      });

      setIsLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setIsLoaded(false);
      fittedKeyRef.current = '';
    };
  }, []);

  // Push route data + fit bounds when routes change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoaded) {
      return;
    }
    const source = map.getSource('routes') as maplibregl.GeoJSONSource | undefined;
    source?.setData(collection as unknown as GeoJSON.FeatureCollection);

    if (routeKey && routeKey !== fittedKeyRef.current) {
      const bounds = routeBounds(collection);
      if (bounds) {
        map.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          { padding: 60, maxZoom: 14, duration: 600 },
        );
      }
      fittedKeyRef.current = routeKey;
    }
  }, [collection, routeKey, isLoaded]);

  // Highlight the selected route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isLoaded) {
      return;
    }
    map.setFilter('routes-selected', ['==', ['get', 'id'], selectedId ?? '__none__']);
  }, [selectedId, isLoaded]);

  return <div className="map-canvas" ref={containerRef} />;
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
