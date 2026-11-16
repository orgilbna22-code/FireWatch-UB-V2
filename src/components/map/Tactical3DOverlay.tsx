import React, { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { DistrictData, FireStation, KhorooData } from '../../types';
import {
  BuildingFootprint,
  buildTactical3DScene,
  generateCityBlueFootprints,
  Tactical3DScene,
  TacticalPOI,
} from '../../utils/tactical3dData';

interface Tactical3DOverlayProps {
  map: L.Map | null;
  active: boolean;
  activeDistrict: DistrictData | null;
  selectedKhoroo: KhorooData | null;
  khoroos: KhorooData[];
  stations: FireStation[];
  isMn: boolean;
}

interface Palette3D {
  litWallTop: string;
  litWallBottom: string;
  darkWallTop: string;
  darkWallBottom: string;
  wallStroke: string;
  roofFill: string;
  roofStroke: string;
  glow?: string;
}

const PALETTES: Record<Exclude<BuildingFootprint['tone'], 'blue_footprint'>, Palette3D> = {
  slate_tower: {
    litWallTop: 'rgba(130, 152, 184, 0.64)',
    litWallBottom: 'rgba(38, 52, 76, 0.86)',
    darkWallTop: 'rgba(72, 92, 124, 0.58)',
    darkWallBottom: 'rgba(20, 30, 48, 0.90)',
    wallStroke: 'rgba(186, 204, 230, 0.24)',
    roofFill: 'rgba(148, 170, 202, 0.62)',
    roofStroke: 'rgba(226, 232, 240, 0.52)',
  },
  risk_red: {
    litWallTop: 'rgba(248, 113, 113, 0.82)',
    litWallBottom: 'rgba(153, 27, 27, 0.90)',
    darkWallTop: 'rgba(220, 38, 38, 0.74)',
    darkWallBottom: 'rgba(112, 20, 28, 0.92)',
    wallStroke: 'rgba(254, 202, 202, 0.58)',
    roofFill: 'rgba(252, 134, 134, 0.85)',
    roofStroke: 'rgba(254, 242, 242, 0.92)',
    glow: 'rgba(239, 68, 68, 0.55)',
  },
  risk_amber: {
    litWallTop: 'rgba(251, 191, 36, 0.82)',
    litWallBottom: 'rgba(180, 83, 9, 0.90)',
    darkWallTop: 'rgba(217, 119, 6, 0.74)',
    darkWallBottom: 'rgba(120, 53, 15, 0.92)',
    wallStroke: 'rgba(253, 230, 138, 0.58)',
    roofFill: 'rgba(252, 211, 77, 0.84)',
    roofStroke: 'rgba(254, 249, 195, 0.92)',
    glow: 'rgba(245, 158, 11, 0.48)',
  },
};

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

interface RectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: RectBox, b: RectBox, pad = 6): boolean {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function resolveCardPosition(
  desiredX: number,
  desiredY: number,
  w: number,
  h: number,
  placed: RectBox[],
  candidates: Array<[number, number]>
): { x: number; y: number } {
  for (const [dx, dy] of candidates) {
    const rect: RectBox = { x: desiredX + dx, y: desiredY + dy, w, h };
    if (!placed.some((p) => rectsOverlap(rect, p))) {
      placed.push(rect);
      return { x: rect.x, y: rect.y };
    }
  }
  const fallback: RectBox = { x: desiredX, y: desiredY - 40, w, h };
  placed.push(fallback);
  return { x: fallback.x, y: fallback.y };
}

function drawLeaderBadge(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  stemHeight: number,
  title: string,
  scoreBadge: string,
  badgeBg: string,
  dotColor: string,
  placed: RectBox[]
) {
  ctx.save();

  ctx.font = '700 11px Inter, system-ui, sans-serif';
  const titleW = ctx.measureText(title).width;
  ctx.font = '800 11px ui-monospace, SFMono-Regular, monospace';
  const scoreW = ctx.measureText(scoreBadge).width;

  const padX = 8;
  const gap = 6;
  const scoreBoxW = scoreW + 10;
  const totalW = padX * 2 + titleW + gap + scoreBoxW;
  const cardH = 24;

  const baseCardX = anchorX - totalW / 2;
  const baseCardY = anchorY - stemHeight - cardH - 4;
  const { x: cardX, y: cardY } = resolveCardPosition(
    baseCardX,
    baseCardY,
    totalW,
    cardH,
    placed,
    [
      [0, 0],
      [0, -34],
      [70, -28],
      [-70, -28],
      [96, 16],
      [-96, 16],
      [0, -70],
    ]
  );

  // Clean vertical stem to badge bottom center
  const stemEndX = cardX + totalW / 2;
  const stemEndY = cardY + cardH;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(stemEndX, stemEndY);
  ctx.stroke();

  // Glowing anchor dot
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(anchorX, anchorY, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Badge card
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(10, 17, 34, 0.96)';
  drawRoundedRectPath(ctx, cardX, cardY, totalW, cardH, 7);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#F8FAFC';
  ctx.font = '700 11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, cardX + padX, cardY + cardH / 2 + 0.5);

  const scoreX = cardX + padX + titleW + gap;
  ctx.fillStyle = badgeBg;
  drawRoundedRectPath(ctx, scoreX, cardY + 3, scoreBoxW, cardH - 6, 4);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '800 10.5px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(scoreBadge, scoreX + 5, cardY + cardH / 2 + 0.5);

  ctx.restore();
}

function drawRoutePill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  iconBg: string,
  iconText: string,
  label: string,
  placed: RectBox[]
) {
  ctx.save();
  ctx.font = '700 10.5px Inter, system-ui, sans-serif';
  const textW = ctx.measureText(label).width;
  const pillH = 22;
  const totalW = 24 + textW + 10;
  const desiredX = x - totalW / 2;
  const desiredY = y - pillH - 14;

  const { x: px, y: py } = resolveCardPosition(desiredX, desiredY, totalW, pillH, placed, [
    [0, 0],
    [54, 22],
    [-54, 22],
    [0, -30],
    [0, 40],
  ]);

  ctx.shadowColor = 'rgba(0, 0, 0, 0.52)';
  ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
  drawRoundedRectPath(ctx, px, py, totalW, pillH, 11);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = iconBg;
  ctx.beginPath();
  ctx.arc(px + 12, py + pillH / 2, 7.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '800 9px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(iconText, px + 12, py + pillH / 2 + 0.5);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#0B124D';
  ctx.font = '700 10.5px Inter, system-ui, sans-serif';
  ctx.fillText(label, px + 24, py + pillH / 2 + 0.5);
  ctx.restore();
}

function drawTacticalPin(ctx: CanvasRenderingContext2D, x: number, y: number, kind: TacticalPOI['kind']) {
  const colorMap: Record<TacticalPOI['kind'], { bg: string; glyph: string }> = {
    alert_amber: { bg: '#F59E0B', glyph: '!' },
    house_red: { bg: '#EF4444', glyph: 'H' },
    hydrant_blue: { bg: '#2563EB', glyph: 'W' },
    flame_red: { bg: '#E93B2F', glyph: '!' },
  };
  const cfg = colorMap[kind];

  ctx.save();
  // Pin stem
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 10);
  ctx.stroke();

  // Circle badge
  ctx.shadowColor = cfg.bg;
  ctx.shadowBlur = 8;
  ctx.fillStyle = cfg.bg;
  ctx.beginPath();
  ctx.arc(x, y - 18, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '800 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.glyph, x, y - 17.5);
  ctx.restore();
}

function drawFireTruck3D(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);

  // Soft ground shadow
  ctx.fillStyle = 'rgba(2, 6, 23, 0.72)';
  ctx.beginPath();
  ctx.ellipse(0, 5, 19, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // Truck body (red rear + brighter cab)
  ctx.fillStyle = '#DC2626';
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1.3;
  drawRoundedRectPath(ctx, -16, -9, 24, 13, 2.5);
  ctx.fill();
  ctx.stroke();

  // Front cab (left-facing toward route)
  ctx.fillStyle = '#EF4444';
  drawRoundedRectPath(ctx, -20, -6, 9, 10, 2);
  ctx.fill();
  ctx.stroke();

  // Windshield glass
  ctx.fillStyle = '#BAE6FD';
  ctx.fillRect(-19, -4.5, 4.5, 4);

  // White tactical stripe + roof ladder rack
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(-10, -2.5, 16, 2.4);
  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(-12, -11, 18, 2.5);

  // Wheels
  ctx.fillStyle = '#0F172A';
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.1;
  [-13, 2].forEach((wx) => {
    ctx.beginPath();
    ctx.arc(wx, 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  ctx.restore();
}

export const Tactical3DOverlay: React.FC<Tactical3DOverlayProps> = ({
  map,
  active,
  activeDistrict,
  selectedKhoroo,
  khoroos,
  stations,
  isMn,
}) => {
  const baseFootprints = useMemo(() => generateCityBlueFootprints(khoroos), [khoroos]);

  const scene = useMemo<Tactical3DScene | null>(() => {
    if (!active || khoroos.length === 0 || stations.length === 0) return null;
    return buildTactical3DScene({
      activeDistrict,
      selectedKhoroo,
      khoroos,
      stations,
      baseFootprints,
    });
  }, [active, activeDistrict, selectedKhoroo, khoroos, stations, baseFootprints]);

  const drawRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const latest = useRef({ map, active, scene, isMn });

  useEffect(() => {
    latest.current = { map, active, scene, isMn };
  }, [map, active, scene, isMn]);

  // 1. Lightweight GPU-animated CSS pulsing fire-core marker at targetCoord
  useEffect(() => {
    if (!map || !active || !scene) return;

    const pulseIcon = L.divIcon({
      className: 'fw-tactical-fire-core',
      html: `
        <div style="position:relative;width:36px;height:36px;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <span style="position:absolute;inset:0;border-radius:9999px;background:rgba(239,68,68,0.42);animation:ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></span>
          <span style="position:relative;width:16px;height:16px;border-radius:9999px;background:#EF4444;border:2.5px solid #FFFFFF;box-shadow:0 0 16px rgba(239,68,68,0.95);"></span>
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const marker = L.marker(scene.targetCoord, {
      icon: pulseIcon,
      interactive: false,
      zIndexOffset: 650,
    }).addTo(map);

    return () => {
      marker.remove();
    };
  }, [map, active, scene]);

  // 2. Overscanned GPU-synced 2.5D Tactical Canvas Layer
  useEffect(() => {
    if (!map) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'fw-tactical-canvas leaflet-layer leaflet-zoom-animated';
    canvas.style.transformOrigin = '0 0';
    canvas.style.pointerEvents = 'none';

    const overlayPane = map.getPanes().overlayPane;
    overlayPane.insertBefore(canvas, overlayPane.firstChild);
    const ctx = canvas.getContext('2d');

    let live = true;
    const OVERSCAN = 0.26;
    let renderedZoom: number | null = null;
    let renderedTopLeftLatLng: L.LatLng | null = null;
    let renderedBounds: L.LatLngBounds | null = null;

    const applyTransform = (targetTopLeft: L.Point, scale: number) => {
      L.DomUtil.setTransform(canvas, targetTopLeft, scale);
    };

    const draw = () => {
      if (!live || !ctx) return;
      const current = latest.current;
      const m = current.map;
      if (!m) return;

      const size = m.getSize();
      if (!size || size.x < 8 || size.y < 8) return;

      if (!current.active || !current.scene) {
        canvas.width = 0;
        canvas.height = 0;
        renderedZoom = null;
        renderedTopLeftLatLng = null;
        renderedBounds = null;
        return;
      }

      const padX = Math.round(size.x * OVERSCAN);
      const padY = Math.round(size.y * OVERSCAN);
      const canvasW = size.x + padX * 2;
      const canvasH = size.y + padY * 2;

      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }

      const topLeftLayerPt = m.containerPointToLayerPoint([-padX, -padY]);
      const zoom = m.getZoom();
      renderedZoom = zoom;
      renderedTopLeftLatLng = m.containerPointToLatLng([-padX, -padY]);
      renderedBounds = L.latLngBounds(
        m.containerPointToLatLng([size.x + padX, -padY]),
        m.containerPointToLatLng([-padX, size.y + padY])
      );
      applyTransform(topLeftLayerPt, 1);

      ctx.clearRect(0, 0, canvasW, canvasH);

      const toPt = (coord: [number, number]): [number, number] => {
        const p = m.latLngToContainerPoint(coord);
        return [p.x + padX, p.y + padY];
      };

      const sc = current.scene;
      // Scale building extrusions proportionally relative to reference Z15
      const zoomScale =
        zoom >= 16 ? 1.25 : zoom >= 15 ? 1.0 : zoom >= 14 ? 0.68 : zoom >= 13 ? 0.38 : 0.22;
      const showNeighborhoodTowers = zoom >= 13.5;

      // A. City-wide glowing cobalt-blue building footprints (Image 1 aesthetic, subtle underneath at Z15)
      ctx.save();
      ctx.fillStyle = zoom >= 14 ? 'rgba(30, 64, 175, 0.14)' : 'rgba(29, 78, 216, 0.22)';
      ctx.strokeStyle = zoom >= 14 ? 'rgba(59, 130, 246, 0.42)' : 'rgba(59, 130, 246, 0.78)';
      ctx.lineWidth = zoom >= 14 ? 1.1 : 1.0;
      for (const b of sc.buildings) {
        if (b.tone !== 'blue_footprint') continue;
        const pts = b.corners.map(toPt);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();

      // B. Ground tactical risk zone polygons (Image 3 red dashed + amber warning block pads)
      const drawGroundZone = (
        poly: [number, number][],
        fill: string,
        stroke: string,
        dashed = false
      ) => {
        if (poly.length < 3) return;
        const pts = poly.map(toPt);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (dashed) ctx.setLineDash([6, 4]);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.restore();
      };

      drawGroundZone(
        sc.primaryZonePolygon,
        'rgba(239, 68, 68, 0.20)',
        'rgba(248, 113, 113, 0.88)',
        true
      );
      drawGroundZone(
        sc.secondaryZonePolygon,
        'rgba(245, 158, 11, 0.14)',
        'rgba(251, 191, 36, 0.82)',
        false
      );

      // Radiant fire glow on pavement around targetCoord
      const targetScreen = toPt(sc.targetCoord);
      ctx.save();
      const fireRadius = 82 * Math.max(0.75, zoomScale);
      const grad = ctx.createRadialGradient(
        targetScreen[0],
        targetScreen[1],
        4,
        targetScreen[0],
        targetScreen[1],
        fireRadius
      );
      grad.addColorStop(0, 'rgba(239, 68, 68, 0.62)');
      grad.addColorStop(0.45, 'rgba(239, 68, 68, 0.22)');
      grad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(targetScreen[0], targetScreen[1], fireRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // C. Multi-segment arterial routes (Image 3 green->amber->red dispatch + blue responder path)
      const drawSegments = (segments: Tactical3DScene['dispatchSegments'], width: number) => {
        if (segments.length === 0) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(6, 11, 22, 0.92)';
        ctx.lineWidth = width + 4.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        segments.forEach((seg, idx) => {
          const p0 = toPt(seg.from);
          const p1 = toPt(seg.to);
          if (idx === 0) ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
        });
        ctx.stroke();
        ctx.restore();

        for (const seg of segments) {
          const p0 = toPt(seg.from);
          const p1 = toPt(seg.to);
          ctx.save();
          ctx.strokeStyle = seg.color;
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.shadowColor = seg.color;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
          ctx.stroke();
          ctx.restore();
        }
      };

      drawSegments(sc.evacuationSegments, 3.8);
      drawSegments(sc.dispatchSegments, 4.4);

      // D. Painter-sorted 1-point perspective architectural 3D blocks with directional lighting
      const camCenterX = canvasW * 0.5;
      const towers = sc.buildings
        .filter(
          (b) =>
            b.tone !== 'blue_footprint' &&
            b.heightPx > 0 &&
            (showNeighborhoodTowers || b.tier >= 2)
        )
        .map((b) => {
          const centerPt = toPt(b.center);
          return { b, centerY: centerPt[1] };
        })
        .sort((a, b) => a.centerY - b.centerY);

      for (const { b, centerY } of towers) {
        // Atmospheric distance fade toward top horizon
        const normY = Math.max(0, Math.min(1, (centerY - padY * 0.4) / (canvasH * 0.85)));
        const distanceAlpha = b.tier >= 2 ? 1 : 0.42 + normY * 0.58;

        const palette = PALETTES[b.tone as Exclude<BuildingFootprint['tone'], 'blue_footprint'>];
        const h = b.heightPx * zoomScale;
        const basePts = b.corners.map(toPt);
        const roofPts: [number, number][] = basePts.map(([px, py]) => [
          px + (px - camCenterX) * Math.min(0.11, h * 0.00058),
          py - h,
        ]);

        ctx.save();
        ctx.globalAlpha = distanceAlpha;

        // Ambient ground occlusion shadow
        ctx.beginPath();
        ctx.moveTo(basePts[0][0] + 4, basePts[0][1] + 4);
        for (let i = 1; i < basePts.length; i++) {
          ctx.lineTo(basePts[i][0] + 4, basePts[i][1] + 4);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
        ctx.fill();

        if (palette.glow) {
          ctx.shadowColor = palette.glow;
          ctx.shadowBlur = 14;
        }

        // Sort wall faces back-to-front by vertical midpoint
        const edges = basePts.map((pt, i) => {
          const next = (i + 1) % basePts.length;
          const midX = (pt[0] + basePts[next][0]) * 0.5;
          const midY = (pt[1] + basePts[next][1]) * 0.5;
          const dx = basePts[next][0] - pt[0];
          const dy = basePts[next][1] - pt[1];
          // Light comes from upper-left (-0.7, -0.7): compute edge facing alignment
          const isLitSide = dx + dy > 0 || midX < toPt(b.center)[0];
          return { i, next, midY, isLitSide };
        });
        edges.sort((e1, e2) => e1.midY - e2.midY);

        for (const edge of edges) {
          const b0 = basePts[edge.i];
          const b1 = basePts[edge.next];
          const r1 = roofPts[edge.next];
          const r0 = roofPts[edge.i];

          const wallGrad = ctx.createLinearGradient(0, r0[1], 0, b0[1]);
          wallGrad.addColorStop(0, edge.isLitSide ? palette.litWallTop : palette.darkWallTop);
          wallGrad.addColorStop(1, edge.isLitSide ? palette.litWallBottom : palette.darkWallBottom);

          ctx.beginPath();
          ctx.moveTo(b0[0], b0[1]);
          ctx.lineTo(b1[0], b1[1]);
          ctx.lineTo(r1[0], r1[1]);
          ctx.lineTo(r0[0], r0[1]);
          ctx.closePath();
          ctx.fillStyle = wallGrad;
          ctx.fill();
          ctx.strokeStyle = palette.wallStroke;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }

        // Architectural roof cap
        ctx.beginPath();
        ctx.moveTo(roofPts[0][0], roofPts[0][1]);
        for (let i = 1; i < roofPts.length; i++) ctx.lineTo(roofPts[i][0], roofPts[i][1]);
        ctx.closePath();
        ctx.fillStyle = palette.roofFill;
        ctx.fill();
        ctx.strokeStyle = palette.roofStroke;
        ctx.lineWidth = 1.05;
        ctx.stroke();

        ctx.restore();
      }

      // E. Ground POI Pins (clean circular tactical icons matching Image 3)
      for (const poi of sc.pois) {
        const pt = toPt(poi.coord);
        drawTacticalPin(ctx, pt[0], pt[1], poi.kind);
      }

      // F. Vertical Leader Callouts + Incident & Dispatch Badges (collision-free)
      const placedRects: RectBox[] = [];

      drawRoutePill(
        ctx,
        targetScreen[0] + 38,
        targetScreen[1] - 4,
        '#EF4444',
        '!',
        current.isMn ? 'Гал илэрсэн' : 'Incident active',
        placedRects
      );

      const primaryPts = sc.primaryZonePolygon;
      const primaryBadgeBase = primaryPts[0] ?? sc.targetCoord;
      const primaryPt = toPt(primaryBadgeBase);
      drawLeaderBadge(
        ctx,
        primaryPt[0] - 24,
        primaryPt[1] - 6,
        62 * Math.max(0.75, zoomScale),
        current.isMn ? sc.targetLabelMn : sc.targetLabelEn,
        `${sc.targetScore}`,
        '#E93B2F',
        '#EF4444',
        placedRects
      );

      if (sc.secondaryCoord) {
        const secPt = toPt(sc.secondaryCoord);
        drawLeaderBadge(
          ctx,
          secPt[0] + 18,
          secPt[1] - 8,
          56 * Math.max(0.75, zoomScale),
          current.isMn ? sc.secondaryLabelMn : sc.secondaryLabelEn,
          `${sc.secondaryScore}`,
          '#D97706',
          '#F59E0B',
          placedRects
        );
      }

      // Fire Truck + Dispatch ETA Pill at boulevard entry
      const dispatchPt = toPt(sc.dispatchStartCoord);
      drawFireTruck3D(ctx, dispatchPt[0], dispatchPt[1]);
      drawRoutePill(
        ctx,
        dispatchPt[0] + 6,
        dispatchPt[1] - 10,
        '#E93B2F',
        'F',
        current.isMn
          ? `~${sc.etaMin} мин · ${sc.distanceKm} км`
          : `~${sc.etaMin} min · ${sc.distanceKm} km`,
        placedRects
      );

      // Responder evacuation route origin node + distance pill
      const evacPt = toPt(sc.evacuationOrigin);
      ctx.save();
      ctx.fillStyle = '#2563EB';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(evacPt[0], evacPt[1], 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '800 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('R', evacPt[0], evacPt[1] + 0.5);
      ctx.restore();

      drawRoutePill(
        ctx,
        evacPt[0],
        evacPt[1] - 8,
        '#2563EB',
        'R',
        current.isMn ? `~${sc.evacuationDistanceM} м` : `~${sc.evacuationDistanceM} m`,
        placedRects
      );
    };

    drawRef.current = draw;

    const scheduleRedraw = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        draw();
      });
    };

    const handleZoomAnim = (ev: L.ZoomAnimEvent) => {
      if (renderedZoom === null || !renderedTopLeftLatLng || !latest.current.active) return;
      const scale = map.getZoomScale(ev.zoom, renderedZoom);
      const leafletMap = map as unknown as {
        _latLngToNewLayerPoint: (latlng: L.LatLng, zoom: number, center: L.LatLng) => L.Point;
      };
      const offset = leafletMap._latLngToNewLayerPoint(renderedTopLeftLatLng, ev.zoom, ev.center);
      applyTransform(offset, scale);
    };

    const handleZoom = () => {
      if (renderedZoom === null || !renderedTopLeftLatLng || !latest.current.active) return;
      const curZoom = map.getZoom();
      const scale = map.getZoomScale(curZoom, renderedZoom);
      const offset = map.latLngToLayerPoint(renderedTopLeftLatLng);
      applyTransform(offset, scale);
      const animatingCss = (map as unknown as { _animatingZoom?: boolean })._animatingZoom;
      if (!animatingCss && (scale < 0.55 || scale > 1.85)) {
        scheduleRedraw();
      }
    };

    const handleMove = () => {
      if (!latest.current.active) return;
      const animatingCss = (map as unknown as { _animatingZoom?: boolean })._animatingZoom;
      if (animatingCss) return;
      if (!renderedBounds || !renderedBounds.contains(map.getBounds())) {
        scheduleRedraw();
      }
    };

    draw();
    map.on('zoomanim', handleZoomAnim);
    map.on('zoom', handleZoom);
    map.on('move', handleMove);
    map.on('zoomend', scheduleRedraw);
    map.on('moveend', scheduleRedraw);
    map.on('viewreset', scheduleRedraw);
    map.on('resize', scheduleRedraw);

    return () => {
      live = false;
      map.off('zoomanim', handleZoomAnim);
      map.off('zoom', handleZoom);
      map.off('move', handleMove);
      map.off('zoomend', scheduleRedraw);
      map.off('moveend', scheduleRedraw);
      map.off('viewreset', scheduleRedraw);
      map.off('resize', scheduleRedraw);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (drawRef.current === draw) drawRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    drawRef.current?.();
  }, [active, scene, isMn]);

  return null;
};
