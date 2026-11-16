import { DistrictData, FireStation, KhorooData } from '../types';

export interface BuildingFootprint {
  id: string;
  /** Center [lat, lng] */
  center: [number, number];
  /** Polygon ring [lat, lng][] */
  corners: [number, number][];
  /** Extruded height in screen units at reference zoom Z15 (0 = flat footprint only) */
  heightPx: number;
  tone: 'blue_footprint' | 'slate_tower' | 'risk_red' | 'risk_amber';
  /** Screen-space order / priority */
  tier: number;
}

export interface DispatchRouteSegment {
  from: [number, number];
  to: [number, number];
  color: '#10B981' | '#F59E0B' | '#EF4444' | '#3B82F6';
}

export interface TacticalPOI {
  coord: [number, number];
  kind: 'alert_amber' | 'house_red' | 'hydrant_blue' | 'flame_red';
}

export interface Tactical3DScene {
  targetCoord: [number, number];
  targetLabelMn: string;
  targetLabelEn: string;
  targetScore: number;
  secondaryCoord: [number, number] | null;
  secondaryLabelMn: string;
  secondaryLabelEn: string;
  secondaryScore: number;
  primaryZonePolygon: [number, number][];
  secondaryZonePolygon: [number, number][];
  nearestStation: FireStation;
  dispatchStartCoord: [number, number];
  distanceKm: number;
  etaMin: number;
  dispatchSegments: DispatchRouteSegment[];
  evacuationSegments: DispatchRouteSegment[];
  evacuationOrigin: [number, number];
  evacuationDistanceM: number;
  pois: TacticalPOI[];
  buildings: BuildingFootprint[];
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Deterministic PRNG so building blocks never jitter on re-render */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRotatedRect(
  lat: number,
  lng: number,
  halfW: number,
  halfH: number,
  angleRad: number
): [number, number][] {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const lngScale = 1.48; // UB latitude (~47.9 deg) longitude projection compensation
  const pts: [number, number][] = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ];
  return pts.map(([dx, dy]) => [
    lat + (dx * sin + dy * cos),
    lng + (dx * cos - dy * sin) * lngScale,
  ]);
}

function expandBlockPolygon(
  center: [number, number],
  rLat: number,
  rLng: number,
  tilt = 0.08
): [number, number][] {
  return makeRotatedRect(center[0], center[1], rLng * 0.68, rLat, tilt);
}

export function findNearestStation(
  target: [number, number],
  stations: FireStation[]
): { station: FireStation; straightKm: number; routeKm: number; etaMin: number } {
  let best = stations[0];
  let bestDist = Infinity;
  for (const s of stations) {
    const d = haversineKm(target, s.coordinates);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  const routeKm = Math.max(0.6, +(bestDist * 1.28).toFixed(1));
  const etaMin = Math.max(3, Math.round(routeKm * 2.3 + 2));
  return { station: best, straightKm: bestDist, routeKm, etaMin };
}

/**
 * Generates clean urban-grid arterial segments from foreground entry / evacuation origin to incident target
 * matching Image 3's green -> amber -> red fire response corridor & blue responder path.
 */
function buildStreetAlignedRoute(
  from: [number, number],
  to: [number, number],
  isDispatch: boolean
): DispatchRouteSegment[] {
  const dLat = to[0] - from[0];
  const dLng = to[1] - from[1];

  const pts: [number, number][] = isDispatch
    ? [
        from,
        [from[0] + dLat * 0.08, from[1] + dLng * 0.28],
        [from[0] + dLat * 0.45, from[1] + dLng * 0.36],
        [from[0] + dLat * 0.50, from[1] + dLng * 0.72],
        [from[0] + dLat * 0.82, from[1] + dLng * 0.80],
        to,
      ]
    : [
        from,
        [from[0] - dLat * 0.10, from[1] + dLng * 0.26],
        [from[0] + dLat * 0.26, from[1] + dLng * 0.36],
        [from[0] + dLat * 0.48, from[1] + dLng * 0.64],
        [from[0] + dLat * 0.72, from[1] + dLng * 0.82],
        to,
      ];

  const dispatchColors: Array<'#10B981' | '#F59E0B' | '#EF4444'> = [
    '#10B981',
    '#10B981',
    '#10B981',
    '#F59E0B',
    '#EF4444',
  ];

  const segs: DispatchRouteSegment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({
      from: pts[i],
      to: pts[i + 1],
      color: isDispatch ? dispatchColors[i] : '#3B82F6',
    });
  }
  return segs;
}

export function generateCityBlueFootprints(khoroos: KhorooData[]): BuildingFootprint[] {
  const buildings: BuildingFootprint[] = [];

  for (let idx = 0; idx < khoroos.length; idx++) {
    const kh = khoroos[idx];
    const rand = mulberry32(idx * 9301 + kh.khorooNumber * 497);
    const clusterCount = kh.riskScore >= 70 ? 6 : 3;
    const baseAngle = (rand() - 0.5) * 0.25;

    for (let b = 0; b < clusterCount; b++) {
      const latOff = (rand() - 0.5) * 0.0072;
      const lngOff = (rand() - 0.5) * 0.0108;
      const halfW = 0.00024 + rand() * 0.00032;
      const halfH = 0.00018 + rand() * 0.00026;
      const center: [number, number] = [kh.center[0] + latOff, kh.center[1] + lngOff];
      buildings.push({
        id: `fp-${kh.id}-${b}`,
        center,
        corners: makeRotatedRect(center[0], center[1], halfW, halfH, baseAngle + (b % 2) * 0.05),
        heightPx: 0,
        tone: 'blue_footprint',
        tier: 0,
      });
    }
  }
  return buildings;
}

function shortKhorooTitle(name: string): string {
  const cleaned = name.replace(/\s*\([^)]*\)/g, '').trim();
  const paren = name.match(/\(([^)]+)\)/);
  if (paren && paren[1]) {
    const firstTag = paren[1].split(',')[0].trim();
    const combined = `${cleaned} · ${firstTag}`;
    return combined.length <= 22 ? combined : cleaned;
  }
  return cleaned;
}

export function buildTactical3DScene(params: {
  activeDistrict: DistrictData | null;
  selectedKhoroo: KhorooData | null;
  khoroos: KhorooData[];
  stations: FireStation[];
  baseFootprints: BuildingFootprint[];
}): Tactical3DScene {
  const { activeDistrict, selectedKhoroo, khoroos, stations, baseFootprints } = params;

  const districtKhoroos = activeDistrict
    ? khoroos
        .filter((k) => k.districtId === activeDistrict.id)
        .sort((a, b) => b.riskScore - a.riskScore)
    : [...khoroos].sort((a, b) => b.riskScore - a.riskScore);

  const primaryKhoroo = selectedKhoroo ?? districtKhoroos[0] ?? khoroos[0];
  const targetCoord = primaryKhoroo.center;

  // Pick a true high-risk neighbor or place secondary alert cluster harmoniously on the upper-right boulevard
  const nearbyCandidate = districtKhoroos.find(
    (k) =>
      k.id !== primaryKhoroo.id &&
      haversineKm(k.center, targetCoord) >= 0.55 &&
      haversineKm(k.center, targetCoord) <= 1.25
  );
  const secondaryKhoroo =
    nearbyCandidate ?? districtKhoroos.find((k) => k.id !== primaryKhoroo.id) ?? null;

  // Anchor secondary zone smoothly upper-right (~550m away) when spatial neighbors are far out of the Z15 frame
  const secondaryCoord: [number, number] | null = secondaryKhoroo
    ? haversineKm(secondaryKhoroo.center, targetCoord) <= 0.95
      ? secondaryKhoroo.center
      : [targetCoord[0] + 0.0014, targetCoord[1] + 0.0052]
    : null;

  const nearest = findNearestStation(targetCoord, stations);

  // Keep dispatch origin inside the visible lower-right Z15 boulevard corridor while preserving true route distance/ETA
  const stationStraight = haversineKm(nearest.station.coordinates, targetCoord);
  const dispatchStartCoord: [number, number] =
    stationStraight <= 1.05
      ? nearest.station.coordinates
      : [targetCoord[0] - 0.0029, targetCoord[1] + 0.0068];

  const dispatchSegments = buildStreetAlignedRoute(dispatchStartCoord, targetCoord, true);

  // Evacuation/responder route sweeps gracefully up-left toward upper-midground boulevard (Image 3)
  const evacuationOrigin: [number, number] = [
    targetCoord[0] + 0.0033,
    targetCoord[1] - 0.0044,
  ];
  const evacuationSegments = buildStreetAlignedRoute(evacuationOrigin, targetCoord, false);
  const evacuationDistanceM = Math.round(haversineKm(evacuationOrigin, targetCoord) * 1000);

  const sceneBuildings: BuildingFootprint[] = [...baseFootprints];

  // Full-viewport street-aligned urban fabric around targetCoord (eliminates isolated floating block island)
  const rng = mulberry32(primaryKhoroo.khorooNumber * 1319 + Math.round(targetCoord[0] * 10000));
  const streetAngle = 0.08;
  const cosA = Math.cos(streetAngle);
  const sinA = Math.sin(streetAngle);

  const gridCols = [-9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const gridRows = [-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8];

  for (const row of gridRows) {
    for (const col of gridCols) {
      // Reserve central tactical stage & primary dispatch boulevard cleanly
      if (Math.abs(row) <= 1 && Math.abs(col) <= 1) continue;
      if (row === -2 && col >= 1 && col <= 4) continue;
      // Wide arterial road corridors every 4 blocks for realistic urban breathing room
      if (col === -4 || col === 4 || row === 3) {
        if (rng() < 0.72) continue;
      }

      const cellLat = row * 0.00142;
      const cellLng = col * 0.00208;
      const blockLat = targetCoord[0] + (cellLat * cosA - cellLng * sinA * 0.65);
      const blockLng = targetCoord[1] + (cellLng * cosA + cellLat * sinA * 1.45);

      const distBlocks = Math.hypot(row, col * 0.85);
      // Taper density toward outer margins so city fabric dissolves organically instead of a hard box edge
      if (distBlocks > 9.6 && rng() < 0.45) continue;

      const isOuter = distBlocks > 5.5;
      const towersInBlock = isOuter ? 1 + (rng() > 0.55 ? 1 : 0) : 2;

      for (let t = 0; t < towersInBlock; t++) {
        if (rng() < 0.18) continue;
        const subOffLat = (t === 0 ? -0.00024 : 0.00024) + (rng() - 0.5) * 0.00018;
        const subOffLng = (t === 0 ? -0.00038 : 0.00038) + (rng() - 0.5) * 0.00024;
        const c: [number, number] = [blockLat + subOffLat, blockLng + subOffLng];

        // Varied apartment slab vs tower proportions (never identical uniform cubes)
        const isWideSlab = rng() > 0.45;
        const halfW = isWideSlab ? 0.00034 + rng() * 0.00026 : 0.00019 + rng() * 0.00016;
        const halfH = isWideSlab ? 0.00014 + rng() * 0.00012 : 0.00018 + rng() * 0.00014;
        const baseH =
          row >= 4
            ? 24 + Math.round(rng() * 44)
            : isWideSlab
            ? 14 + Math.round(rng() * 24)
            : 22 + Math.round(rng() * 38);

        sceneBuildings.push({
          id: `grid-${row}-${col}-${t}`,
          center: c,
          corners: makeRotatedRect(c[0], c[1], halfW, halfH, streetAngle + (rng() > 0.8 ? 1.57 : 0)),
          heightPx: baseH,
          tone: 'slate_tower',
          tier: 1,
        });
      }
    }
  }

  // Primary High-Risk Focal Red Cluster (wide architectural complex inside red zone polygon)
  const redCenter: [number, number] = [targetCoord[0] - 0.0001, targetCoord[1] - 0.0016];
  const redOffsets: [number, number, number, number, number, BuildingFootprint['tone']][] = [
    [0.00018, -0.00045, 0.00032, 0.00024, 78, 'risk_red'],
    [-0.00028, -0.00095, 0.00036, 0.00026, 56, 'slate_tower'],
    [-0.00042, 0.00012, 0.00030, 0.00022, 42, 'risk_red'],
    [0.00046, 0.00025, 0.00028, 0.00021, 36, 'slate_tower'],
    [-0.00005, 0.00052, 0.00026, 0.00020, 28, 'risk_red'],
  ];
  redOffsets.forEach(([dLat, dLng, hw, hh, h, tone], i) => {
    const c: [number, number] = [redCenter[0] + dLat, redCenter[1] + dLng];
    sceneBuildings.push({
      id: `cluster-red-${i}`,
      center: c,
      corners: makeRotatedRect(c[0], c[1], hw, hh, streetAngle),
      heightPx: h,
      tone,
      tier: 2,
    });
  });

  // Secondary Elevated Cluster (amber + red translucent apartment cluster on upper-right)
  if (secondaryCoord) {
    const secOffsets: [number, number, number, number, number, BuildingFootprint['tone']][] = [
      [0.00024, -0.00035, 0.00030, 0.00024, 68, 'risk_red'],
      [-0.00026, 0.00028, 0.00034, 0.00025, 44, 'risk_amber'],
      [0.00036, 0.00046, 0.00030, 0.00022, 54, 'slate_tower'],
      [-0.00022, -0.00052, 0.00028, 0.00022, 40, 'slate_tower'],
      [0.00002, 0.00072, 0.00026, 0.00020, 34, 'slate_tower'],
    ];
    secOffsets.forEach(([dLat, dLng, hw, hh, h, tone], i) => {
      const c: [number, number] = [secondaryCoord[0] + dLat, secondaryCoord[1] + dLng];
      sceneBuildings.push({
        id: `cluster-sec-${i}`,
        center: c,
        corners: makeRotatedRect(c[0], c[1], hw, hh, streetAngle),
        heightPx: h,
        tone,
        tier: 2,
      });
    });
  }

  const pois: TacticalPOI[] = [
    { coord: [redCenter[0] - 0.0006, redCenter[1] - 0.0022], kind: 'alert_amber' },
    { coord: [redCenter[0] - 0.0008, redCenter[1] + 0.0006], kind: 'house_red' },
    ...(secondaryCoord
      ? ([{ coord: [secondaryCoord[0] - 0.00055, secondaryCoord[1] + 0.00045], kind: 'alert_amber' }] as TacticalPOI[])
      : []),
    { coord: [targetCoord[0] - 0.0024, targetCoord[1] - 0.0008], kind: 'hydrant_blue' },
  ];

  return {
    targetCoord,
    targetLabelMn: shortKhorooTitle(primaryKhoroo.nameMn),
    targetLabelEn: shortKhorooTitle(primaryKhoroo.nameEn),
    targetScore: primaryKhoroo.riskScore,
    secondaryCoord,
    secondaryLabelMn: secondaryKhoroo ? shortKhorooTitle(secondaryKhoroo.nameMn) : '',
    secondaryLabelEn: secondaryKhoroo ? shortKhorooTitle(secondaryKhoroo.nameEn) : '',
    secondaryScore: secondaryKhoroo ? secondaryKhoroo.riskScore : 0,
    primaryZonePolygon: expandBlockPolygon(redCenter, 0.0011, 0.0024, streetAngle),
    secondaryZonePolygon: secondaryCoord
      ? expandBlockPolygon(secondaryCoord, 0.0010, 0.0021, streetAngle)
      : [],
    nearestStation: nearest.station,
    dispatchStartCoord,
    distanceKm: nearest.routeKm,
    etaMin: nearest.etaMin,
    dispatchSegments,
    evacuationSegments,
    evacuationOrigin,
    evacuationDistanceM,
    pois,
    buildings: sceneBuildings,
  };
}

export function mapScaleLabel(zoom: number): string {
  const z = Math.round(zoom);
  if (z >= 16) return '1:5,000';
  if (z === 15) return '1:10,000';
  if (z === 14) return '1:18,000';
  if (z === 13) return '1:35,000';
  if (z === 12) return '1:50,000';
  if (z === 11) return '1:100,000';
  return '1:250,000';
}
