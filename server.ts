import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { createFireWatchDb } from './src/server/db.ts';
import { computeFireWeatherBreakdown } from './src/utils/riskEngine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const UB_LAT = 47.9184;
const UB_LON = 106.9177;
const WEATHER_TTL_MS = 10 * 60 * 1000;
const AI_CACHE_TTL_MS = 15 * 60 * 1000;

const db = createFireWatchDb();

interface OpenMeteoPayload {
  current?: Record<string, number | string>;
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
    relative_humidity_2m_max?: number[];
  };
  utc_offset_seconds?: number;
}

interface DailySlice {
  date: string;
  tempMaxC: number;
  tempMinC: number;
  precipitationMm: number;
  windMaxKmh: number;
  humidityMaxPct: number;
}

function countDroughtDays(daily: DailySlice[], todayIso: string): number {
  let i = daily.findIndex((d) => d.date >= todayIso);
  if (i === -1) i = daily.length - 1;
  let days = 0;
  for (; i >= 0; i--) {
    if (daily[i].precipitationMm < 0.2) days += 1;
    else break;
  }
  return days;
}

function formatWeatherResponse(
  rec: ReturnType<typeof db.getLatestWeather>,
  meta: { isLive: boolean; stale: boolean; status: 'live' | 'stale' | 'unavailable'; errorReason?: string }
) {
  if (!rec) {
    return {
      status: 'unavailable' as const,
      isLive: false,
      stale: true,
      errorReason: meta.errorReason || 'No verified observation stored yet.',
    };
  }
  let daily: DailySlice[] = [];
  try {
    daily = JSON.parse(rec.dailyJson) as DailySlice[];
  } catch {
    daily = [];
  }
  return {
    status: meta.status,
    isLive: meta.isLive,
    stale: meta.stale,
    provider: rec.provider,
    fetchedAtMs: rec.fetchedAtMs,
    observedAtIso: rec.observedAtIso,
    utcOffsetSeconds: rec.utcOffsetSeconds,
    tempCelsius: rec.tempCelsius,
    apparentCelsius: rec.apparentCelsius,
    humidityPercent: rec.humidityPercent,
    windSpeedKmh: rec.windSpeedKmh,
    windDirectionDeg: rec.windDirectionDeg,
    gustKmh: rec.gustKmh,
    precipitationMm: rec.precipitationMm,
    weatherCode: rec.weatherCode,
    droughtDays: rec.droughtDays,
    fireWeatherIndex: rec.fireWeatherIndex,
    ignitionReceptivity: rec.ignitionReceptivity,
    spreadPotential: rec.spreadPotential,
    daily,
    errorReason: meta.errorReason,
  };
}

async function fetchLiveOpenMeteo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${UB_LAT}&longitude=${UB_LON}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_max' +
    '&past_days=10&forecast_days=7&timezone=Asia%2FUlaanbaatar';

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const json = (await res.json()) as OpenMeteoPayload;
    const c = json.current;
    if (!c) throw new Error('Missing current observation block');

    const tempCelsius = Math.round(Number(c.temperature_2m) * 10) / 10;
    const humidityPercent = Math.round(Number(c.relative_humidity_2m));
    const windSpeedKmh = Math.round(Number(c.wind_speed_10m) * 10) / 10;
    const windDirectionDeg = Math.round(Number(c.wind_direction_10m ?? 0));
    const gustKmh = Math.round(Number(c.wind_gusts_10m || windSpeedKmh * 1.4));
    const apparentCelsius = Math.round(Number(c.apparent_temperature ?? tempCelsius) * 10) / 10;
    const precipitationMm = Math.round(Number(c.precipitation ?? 0) * 10) / 10;
    const weatherCode = Number(c.weather_code ?? 0);
    if ([tempCelsius, humidityPercent, windSpeedKmh].some((n) => Number.isNaN(n))) {
      throw new Error('Invalid numeric weather observation');
    }

    const daily: DailySlice[] = (json.daily?.time ?? []).map((date, i) => ({
      date,
      tempMaxC: Number(json.daily?.temperature_2m_max?.[i] ?? 0),
      tempMinC: Number(json.daily?.temperature_2m_min?.[i] ?? 0),
      precipitationMm: Number(json.daily?.precipitation_sum?.[i] ?? 0),
      windMaxKmh: Number(json.daily?.wind_speed_10m_max?.[i] ?? 0),
      humidityMaxPct: Number(json.daily?.relative_humidity_2m_max?.[i] ?? 60),
    }));

    const observedAtIso = String(c.time ?? new Date().toISOString());
    const droughtDays = countDroughtDays(daily, observedAtIso.slice(0, 10));
    const breakdown = computeFireWeatherBreakdown({
      tempCelsius,
      humidityPercent,
      windSpeedKmh,
      gustKmh,
      precipitationMm,
      droughtDays,
    });

    const saved = db.saveWeather({
      fetchedAtMs: Date.now(),
      observedAtIso,
      tempCelsius,
      apparentCelsius,
      humidityPercent,
      windSpeedKmh,
      windDirectionDeg,
      gustKmh,
      precipitationMm,
      weatherCode,
      droughtDays,
      fireWeatherIndex: breakdown.fireWeatherIndex,
      ignitionReceptivity: breakdown.ignitionReceptivity,
      spreadPotential: breakdown.spreadPotential,
      utcOffsetSeconds: Number(json.utc_offset_seconds ?? 28800),
      dailyJson: JSON.stringify(daily),
      provider: 'Open-Meteo',
    });

    return saved;
  } finally {
    clearTimeout(timer);
  }
}

let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: 'sqlite',
    hasGemini: Boolean(process.env.GEMINI_API_KEY),
    timestampIso: new Date().toISOString(),
  });
});

app.get('/api/weather', async (req, res) => {
  const force = req.query.force === '1';
  const latest = db.getLatestWeather();

  if (!force && latest && Date.now() - latest.fetchedAtMs < WEATHER_TTL_MS) {
    return res.json(formatWeatherResponse(latest, { isLive: true, stale: false, status: 'live' }));
  }

  try {
    const fresh = await fetchLiveOpenMeteo();
    return res.json(formatWeatherResponse(fresh, { isLive: true, stale: false, status: 'live' }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Weather provider unreachable';
    if (latest) {
      return res.json(
        formatWeatherResponse(latest, {
          isLive: false,
          stale: true,
          status: 'stale',
          errorReason: msg,
        })
      );
    }
    return res.json(
      formatWeatherResponse(null, {
        isLive: false,
        stale: true,
        status: 'unavailable',
        errorReason: msg,
      })
    );
  }
});

app.get('/api/audits', (_req, res) => {
  res.json({ audits: db.listHomeAudits() });
});

app.post('/api/audits', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (
    !b ||
    typeof b.districtId !== 'string' ||
    typeof b.khorooNumber !== 'number' ||
    typeof b.homeType !== 'string' ||
    typeof b.heatingType !== 'string' ||
    typeof b.electricalState !== 'string' ||
    typeof b.ashStorage !== 'string' ||
    typeof b.score !== 'number' ||
    typeof b.riskLevel !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid home audit payload.' });
  }

  const saved = db.saveHomeAudit({
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAtIso: new Date().toISOString(),
    districtId: b.districtId.slice(0, 64),
    khorooNumber: Math.max(1, Math.min(100, Math.round(b.khorooNumber))),
    homeType: b.homeType.slice(0, 32),
    heatingType: b.heatingType.slice(0, 32),
    electricalState: b.electricalState.slice(0, 32),
    hasSmokeDetector: Boolean(b.hasSmokeDetector),
    hasFireExtinguisher: Boolean(b.hasFireExtinguisher),
    ashStorage: b.ashStorage.slice(0, 32),
    hasChildren: Boolean(b.hasChildren),
    hasElderly: Boolean(b.hasElderly),
    score: Math.max(0, Math.min(100, Math.round(b.score))),
    riskLevel: b.riskLevel.slice(0, 24),
    meetingPoint: typeof b.meetingPoint === 'string' ? b.meetingPoint.slice(0, 140) : '',
    emergencyPhone: typeof b.emergencyPhone === 'string' ? b.emergencyPhone.slice(0, 40) : '',
  });

  res.status(201).json({ audit: saved });
});

app.delete('/api/audits/:id', (req, res) => {
  const deleted = db.deleteHomeAudit(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Audit record not found.' });
  res.json({ deleted: true });
});

const VALID_CATEGORIES = new Set([
  'residential_ger',
  'residential_apt',
  'commercial',
  'grass_forest',
  'electrical',
]);
const VALID_SEVERITIES = new Set(['minor', 'moderate', 'critical']);
const DISTRICT_DEFAULT_COORDS: Record<string, [number, number]> = {
  bayanzurkh: [47.9212, 107.0155],
  songinokhairkhan: [47.9325, 106.7932],
  chingeltei: [47.9495, 106.9052],
  sukhbaatar: [47.9295, 106.9205],
  bayangol: [47.9125, 106.8725],
  'khan-uul': [47.8825, 106.8785],
  nalaikh: [47.775, 107.258],
  baganuur: [47.781, 108.361],
  bagakhangai: [47.345, 107.475],
};

function sanitizeIncidentInput(raw: Record<string, unknown>, fallbackSource = 'manual') {
  const districtId =
    typeof raw.districtId === 'string' && raw.districtId.trim()
      ? raw.districtId.trim().toLowerCase().slice(0, 48)
      : '';
  const causeGuessMn =
    typeof raw.causeGuessMn === 'string' && raw.causeGuessMn.trim()
      ? raw.causeGuessMn.trim().slice(0, 180)
      : typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, 180)
      : '';
  if (!districtId || !causeGuessMn) return null;

  const dateRaw = typeof raw.date === 'string' ? raw.date.trim().slice(0, 10) : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : new Date().toISOString().slice(0, 10);
  const khorooNum = Number(raw.khorooNumber ?? 1);
  const khorooNumber = Number.isFinite(khorooNum) ? Math.max(1, Math.min(60, Math.round(khorooNum))) : 1;
  const catRaw = typeof raw.category === 'string' ? raw.category.trim() : 'residential_ger';
  const category = (VALID_CATEGORIES.has(catRaw) ? catRaw : 'residential_ger') as
    | 'residential_ger'
    | 'residential_apt'
    | 'commercial'
    | 'grass_forest'
    | 'electrical';
  const sevRaw = typeof raw.severity === 'string' ? raw.severity.trim() : 'moderate';
  const severity = (VALID_SEVERITIES.has(sevRaw) ? sevRaw : 'moderate') as
    | 'minor'
    | 'moderate'
    | 'critical';
  const respNum = Number(raw.responseTimeMin ?? 12);
  const responseTimeMin = Number.isFinite(respNum) ? Math.max(2, Math.min(90, Math.round(respNum))) : 12;

  const fallbackCoord = DISTRICT_DEFAULT_COORDS[districtId] ?? [UB_LAT, UB_LON];
  const latNum = Number(raw.lat);
  const lngNum = Number(raw.lng);
  const lat = Number.isFinite(latNum) && latNum >= 46 && latNum <= 50 ? +latNum.toFixed(5) : fallbackCoord[0];
  const lng = Number.isFinite(lngNum) && lngNum >= 104 && lngNum <= 111 ? +lngNum.toFixed(5) : fallbackCoord[1];

  const causeGuessEn =
    typeof raw.causeGuessEn === 'string' && raw.causeGuessEn.trim()
      ? raw.causeGuessEn.trim().slice(0, 180)
      : causeGuessMn;

  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 64)
      : `inc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const source =
    typeof raw.source === 'string' && raw.source.trim()
      ? raw.source.trim().slice(0, 32)
      : fallbackSource;

  return {
    id,
    date,
    districtId,
    khorooNumber,
    category,
    severity,
    causeGuessMn,
    causeGuessEn,
    responseTimeMin,
    lat,
    lng,
    source,
    createdAtIso: new Date().toISOString(),
  };
}

app.get('/api/incidents', (_req, res) => {
  res.json({ incidents: db.listIncidents(), stats: db.getStats() });
});

app.post('/api/incidents', (req, res) => {
  const b = req.body as Record<string, unknown>;
  const item = b ? sanitizeIncidentInput(b, 'manual') : null;
  if (!item) {
    return res.status(400).json({ error: 'Invalid incident payload: districtId and causeGuessMn are required.' });
  }
  const saved = db.upsertIncident(item);
  res.status(201).json({ incident: saved, stats: db.getStats() });
});

app.put('/api/incidents/:id', (req, res) => {
  const existing = db.getIncidentById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Incident record not found.' });
  }
  const b = (req.body || {}) as Record<string, unknown>;
  const merged = sanitizeIncidentInput(
    {
      ...existing,
      ...b,
      id: existing.id,
      source: existing.source,
    },
    existing.source
  );
  if (!merged) {
    return res.status(400).json({ error: 'Invalid incident update payload.' });
  }
  const saved = db.upsertIncident({ ...merged, createdAtIso: existing.createdAtIso });
  res.json({ incident: saved, stats: db.getStats() });
});

app.delete('/api/incidents/:id', (req, res) => {
  const deleted = db.deleteIncident(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Incident record not found.' });
  res.json({ deleted: true, stats: db.getStats() });
});

app.post('/api/v1/incidents/batch-sync', (req, res) => {
  const body = req.body as Record<string, unknown> | unknown[];
  const rawList: Record<string, unknown>[] = [];

  if (Array.isArray(body)) {
    for (const entry of body) {
      if (entry && typeof entry === 'object') rawList.push(entry as Record<string, unknown>);
    }
  } else if (body && typeof body === 'object') {
    if (body.type === 'FeatureCollection' && Array.isArray(body.features)) {
      for (const feat of body.features as Array<Record<string, unknown>>) {
        if (!feat || typeof feat !== 'object') continue;
        const props = (feat.properties && typeof feat.properties === 'object' ? feat.properties : {}) as Record<string, unknown>;
        const geom = (feat.geometry && typeof feat.geometry === 'object' ? feat.geometry : {}) as Record<string, unknown>;
        const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
        rawList.push({
          ...props,
          id: feat.id ?? props.id,
          lng: typeof coords[0] === 'number' ? coords[0] : props.lng,
          lat: typeof coords[1] === 'number' ? coords[1] : props.lat,
          source: 'geojson-sync',
        });
      }
    } else if (Array.isArray(body.incidents)) {
      for (const entry of body.incidents) {
        if (entry && typeof entry === 'object') rawList.push(entry as Record<string, unknown>);
      }
    }
  }

  if (rawList.length === 0) {
    return res.status(400).json({
      error: 'Expected a GeoJSON FeatureCollection, { incidents: [...] }, or a JSON array of records.',
    });
  }

  const validItems: ReturnType<typeof sanitizeIncidentInput>[] = [];
  let skippedCount = 0;
  for (const row of rawList.slice(0, 200)) {
    const clean = sanitizeIncidentInput(row, 'batch-sync');
    if (clean) validItems.push(clean);
    else skippedCount += 1;
  }

  const nonNull = validItems.filter((x): x is NonNullable<typeof x> => x !== null);
  const syncedCount = nonNull.length > 0 ? db.batchUpsertIncidents(nonNull) : 0;

  res.status(200).json({
    syncedCount,
    skippedCount,
    incidents: db.listIncidents(),
    stats: db.getStats(),
  });
});

app.get('/api/data-management/status', (_req, res) => {
  const latestWeather = db.getLatestWeather();
  res.json({
    ok: true,
    stats: db.getStats(),
    latestWeatherTimestamp: latestWeather?.observedAtIso ?? null,
    latestWeatherProvider: latestWeather?.provider ?? null,
    hasGemini: Boolean(process.env.GEMINI_API_KEY),
    serverTimeIso: new Date().toISOString(),
  });
});

app.delete('/api/data-management/ai-cache', (_req, res) => {
  const cleared = db.clearAiCache();
  res.json({ cleared, stats: db.getStats() });
});

app.post('/api/ai/explain', async (req, res) => {
  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      error: 'Gemini AI analyst is not configured on this server (missing GEMINI_API_KEY).',
    });
  }

  const body = req.body as {
    language?: 'mn' | 'en';
    areaType?: 'district' | 'khoroo';
    areaId?: string;
    areaName?: string;
    districtName?: string;
    riskScore?: number;
    riskLevel?: string;
    isModelled?: boolean;
    metrics?: Record<string, unknown>;
    contributions?: Array<{ name: string; weight: number; score: number; contribution: number }>;
  };

  if (!body || !body.areaId || !body.areaName || typeof body.riskScore !== 'number') {
    return res.status(400).json({ error: 'Missing required area context for explanation.' });
  }

  const lang = body.language === 'en' ? 'en' : 'mn';
  const weather = db.getLatestWeather();
  const weatherTag = weather ? `${weather.observedAtIso}` : 'unavailable';
  const cacheKey = `${lang}:${body.areaId}:${body.riskScore}:${weatherTag}`;

  const cached = db.getAiCache(cacheKey, AI_CACHE_TTL_MS);
  if (cached) {
    return res.json({ explanation: cached, cached: true });
  }

  const weatherContext = weather
    ? {
        provider: weather.provider,
        observedAtIso: weather.observedAtIso,
        isLive: Date.now() - weather.fetchedAtMs < WEATHER_TTL_MS,
        tempCelsius: weather.tempCelsius,
        humidityPercent: weather.humidityPercent,
        windSpeedKmh: weather.windSpeedKmh,
        gustKmh: weather.gustKmh,
        droughtDays: weather.droughtDays,
        fireWeatherIndex: weather.fireWeatherIndex,
        ignitionReceptivity: weather.ignitionReceptivity,
        spreadPotential: weather.spreadPotential,
      }
    : { status: 'unavailable', note: 'No live weather observation cached yet.' };

  const systemInstruction =
    lang === 'mn'
      ? `Та FireWatch UB орон зайн галын эрсдэлийн аналитик туслах.
ХАТУУ ДҮРЭМ:
1. Зөвхөн доор өгөгдсөн JSON мэдээлэлд тулгуурлан тайлбарлана уу. Шинэ дуудлага, цаг агаарын тоо, эх сурвалж, эсвэл баталгаагүй үйл явдал ХЭЗЭЭ Ч зохиохгүй байх.
2. Энэ эрсдэлийн оноо (0-100) нь олон хүчин зүйлийн аналитик/эвристик индекс бөгөөд гал гарах статистик магадлал (%) БИШ гэдгийг тодорхой ялгаж хэлнэ үү.
3. Салхи нь гал асаах шууд шалтгаан биш, харин нэгэнт гарсан оч, дөлийг тараах хурдыг нэмэгдүүлдэг хүчин зүйл гэдгийг зөв тайлбарлана уу.
4. Цаг агаарын мэдээллийн огноо/цаг болон тухайн хорооны өгөгдөл загварчилсан (isModelled) эсэхийг заавал дурдана уу.
5. Албан ёсны онцгой байдлын зарлан мэдээлэл биш гэдгийг сануулна уу. Хариултаа монгол хэлээр ойлгомжтой, товч тодорхой бичнэ үү.`
      : `You are the FireWatch UB spatial fire-risk analytical assistant.
STRICT GROUNDING RULES:
1. Rely EXCLUSIVELY on the supplied JSON context. NEVER invent incidents, weather readings, data sources, or risk scores.
2. Clearly distinguish that the 0-100 risk score is a composite heuristic index, NOT a calibrated probability of fire ignition.
3. Explain wind accurately: wind increases potential fire spread and ember transport once ignition occurs, rather than causing ignition on its own.
4. Explicitly cite the weather observation timestamp (or unavailability) and whether the area includes modelled estimates (isModelled).
5. Clarify that this is an analytical research assessment, not an official emergency dispatch alert. Respond clearly and concisely in English.`;

  try {
    const requestContents = JSON.stringify({
      areaType: body.areaType,
      areaId: body.areaId,
      areaName: body.areaName,
      districtName: body.districtName,
      compositeRiskIndex: body.riskScore,
      riskLevel: body.riskLevel,
      isModelledArea: Boolean(body.isModelled),
      metrics: body.metrics ?? {},
      factorContributions: body.contributions ?? [],
      weatherObservation: weatherContext,
      dataScopeNote:
        'Historical incident totals are 2024-2026 aggregated demonstration records; khoroos marked isModelled are synthesized from district totals.',
    });
    const requestConfig = {
      systemInstruction,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['summary', 'verifiedFactors', 'weatherInfluence', 'dataLimitations', 'actionableSteps'],
        properties: {
          summary: {
            type: Type.STRING,
            description: '2-3 concise sentences citing exact score, area, and status.',
          },
          verifiedFactors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '2-4 short bullets from the supplied data driving the score.',
          },
          weatherInfluence: {
            type: Type.STRING,
            description: '1-2 sentences on how the timestamped weather observation affects ignition receptivity vs wind spread.',
          },
          dataLimitations: {
            type: Type.STRING,
            description: '1-2 sentences distinguishing verified vs modelled/missing data and timestamps.',
          },
          actionableSteps: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '2-3 short practical household or prevention steps.',
          },
        },
      },
    };

    const parseJsonSafe = (raw?: string) => {
      const cleaned = (raw ?? '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      return JSON.parse(cleaned || '{}');
    };

    let parsed: Record<string, unknown>;
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: requestContents,
        config: {
          ...requestConfig,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      parsed = parseJsonSafe(response.text);
    } catch {
      const fallback = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: requestContents,
        config: {
          ...requestConfig,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });
      parsed = parseJsonSafe(fallback.text);
    }
    const payload = {
      ...parsed,
      generatedAtIso: new Date().toISOString(),
      weatherTimestamp: weather?.observedAtIso ?? null,
      weatherIsLive: weather ? Date.now() - weather.fetchedAtMs < WEATHER_TTL_MS : false,
    };
    db.setAiCache(cacheKey, payload);
    return res.json({ explanation: payload, cached: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gemini request failed';
    return res.status(502).json({ error: `AI explanation unavailable: ${msg}` });
  }
});

async function start() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      const indexHtml = path.join(distDir, 'index.html');
      if (existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Production build not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[FireWatch UB] Server listening on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

start().catch((err) => {
  console.error('[FireWatch UB] Failed to start server:', err);
  process.exit(1);
});
