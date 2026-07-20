import type { ActivityWeather } from '../src/types';
import type { StoredActivity } from './db';

const WEATHER_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'rain',
  'snowfall',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
].join(',');

interface OpenMeteoArchiveResponse {
  hourly?: {
    time?: unknown;
    temperature_2m?: unknown;
    apparent_temperature?: unknown;
    relative_humidity_2m?: unknown;
    precipitation?: unknown;
    rain?: unknown;
    snowfall?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_gusts_10m?: unknown;
    wind_direction_10m?: unknown;
  };
}

export class ActivityLocationUnavailableError extends Error {
  constructor() {
    super('Weather is unavailable because this activity has no recorded start location.');
    this.name = 'ActivityLocationUnavailableError';
  }
}

export class HistoricalWeatherUnavailableError extends Error {
  constructor(message = 'Historical weather is temporarily unavailable.') {
    super(message);
    this.name = 'HistoricalWeatherUnavailableError';
  }
}

export async function getHistoricalWeather(activity: StoredActivity): Promise<ActivityWeather> {
  if (!Number.isFinite(activity.startLat) || !Number.isFinite(activity.startLng)) {
    throw new ActivityLocationUnavailableError();
  }
  const startMs = Date.parse(activity.startDate);
  if (!Number.isFinite(startMs)) {
    throw new HistoricalWeatherUnavailableError('This activity has no valid start time.');
  }

  const date = new Date(startMs).toISOString().slice(0, 10);
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.searchParams.set('latitude', String(activity.startLat));
  url.searchParams.set('longitude', String(activity.startLng));
  url.searchParams.set('start_date', date);
  url.searchParams.set('end_date', date);
  url.searchParams.set('hourly', WEATHER_VARIABLES);
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('precipitation_unit', 'mm');

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new HistoricalWeatherUnavailableError();
  }
  if (!response.ok) {
    throw new HistoricalWeatherUnavailableError(`Historical weather provider returned ${response.status}.`);
  }

  const payload = await response.json() as OpenMeteoArchiveResponse;
  const hourly = payload.hourly;
  const timestamps = numberArray(hourly?.time);
  if (!hourly || timestamps.length === 0) {
    throw new HistoricalWeatherUnavailableError('No hourly weather was found for this run.');
  }
  const targetSeconds = startMs / 1000;
  const index = nearestIndex(timestamps, targetSeconds);
  const required = {
    temperatureC: numberAt(hourly.temperature_2m, index),
    feelsLikeC: numberAt(hourly.apparent_temperature, index),
    relativeHumidityPct: numberAt(hourly.relative_humidity_2m, index),
    precipitationMm: numberAt(hourly.precipitation, index),
    rainMm: numberAt(hourly.rain, index),
    snowfallCm: numberAt(hourly.snowfall, index),
    conditionCode: numberAt(hourly.weather_code, index),
    windSpeedKph: numberAt(hourly.wind_speed_10m, index),
    windGustKph: numberAt(hourly.wind_gusts_10m, index),
    windDirectionDeg: numberAt(hourly.wind_direction_10m, index),
  };
  if (Object.values(required).some((value) => value === null)) {
    throw new HistoricalWeatherUnavailableError('The hourly weather record is incomplete.');
  }

  return {
    observedAt: new Date(timestamps[index] * 1000).toISOString(),
    condition: weatherCodeLabel(required.conditionCode as number),
    conditionCode: required.conditionCode as number,
    temperatureC: required.temperatureC as number,
    feelsLikeC: required.feelsLikeC as number,
    relativeHumidityPct: required.relativeHumidityPct as number,
    precipitationMm: required.precipitationMm as number,
    rainMm: required.rainMm as number,
    snowfallCm: required.snowfallCm as number,
    windSpeedKph: required.windSpeedKph as number,
    windGustKph: required.windGustKph as number,
    windDirectionDeg: required.windDirectionDeg as number,
    source: 'open-meteo',
  };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
}

function numberAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const item = value[index];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

function nearestIndex(values: number[], target: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  values.forEach((value, index) => {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function weatherCodeLabel(code: number): string {
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code >= 61 && code <= 65) return 'Rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code >= 71 && code <= 75) return 'Snow';
  if (code === 77) return 'Snow grains';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return 'Weather conditions';
}
