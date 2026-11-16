import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTactical3DScene,
  findNearestStation,
  generateCityBlueFootprints,
  mapScaleLabel,
} from './tactical3dData';
import { UB_DISTRICTS, UB_FIRE_STATIONS, UB_KHOROOS } from '../data/ubGeoData';

test('findNearestStation returns closest station with valid route distance and ETA', () => {
  const target = UB_KHOROOS[0].center;
  const res = findNearestStation(target, UB_FIRE_STATIONS);
  assert.ok(res.station);
  assert.ok(res.routeKm >= 0.6);
  assert.ok(res.etaMin >= 3);
});

test('generateCityBlueFootprints produces deterministic flat cobalt footprints', () => {
  const fp1 = generateCityBlueFootprints(UB_KHOROOS);
  const fp2 = generateCityBlueFootprints(UB_KHOROOS);
  assert.ok(fp1.length > 100);
  assert.deepEqual(fp1[0], fp2[0]);
  assert.equal(fp1[0].tone, 'blue_footprint');
  assert.equal(fp1[0].heightPx, 0);
});

test('buildTactical3DScene builds dispatch segments, evacuation path, and extruded 3D risk blocks', () => {
  const baseFootprints = generateCityBlueFootprints(UB_KHOROOS);
  const scene = buildTactical3DScene({
    activeDistrict: UB_DISTRICTS[0],
    selectedKhoroo: null,
    khoroos: UB_KHOROOS,
    stations: UB_FIRE_STATIONS,
    baseFootprints,
  });

  assert.equal(scene.dispatchSegments.length, 5);
  assert.equal(scene.dispatchSegments[0].color, '#10B981');
  assert.equal(scene.dispatchSegments[3].color, '#F59E0B');
  assert.equal(scene.dispatchSegments[4].color, '#EF4444');
  assert.equal(scene.evacuationSegments.length, 5);
  assert.ok(scene.evacuationSegments.every((s) => s.color === '#3B82F6'));
  assert.ok(scene.primaryZonePolygon.length >= 4);
  assert.ok(scene.buildings.some((b) => b.tone === 'risk_red' && b.heightPx > 0));
  assert.ok(scene.buildings.some((b) => b.tone === 'slate_tower' && b.heightPx > 0));
});

test('mapScaleLabel returns cartographic ratio per zoom level', () => {
  assert.equal(mapScaleLabel(12), '1:50,000');
  assert.equal(mapScaleLabel(15), '1:10,000');
  assert.equal(mapScaleLabel(9), '1:250,000');
});
