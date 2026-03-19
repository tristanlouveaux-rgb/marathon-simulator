/**
 * strava-detail.ts
 * ================
 * Handles expand/collapse of Strava activity detail panels and
 * canvas-based route map rendering with OSM tile background + pace colouring.
 */

// ---------------------------------------------------------------------------
// Expand / collapse toggle
// ---------------------------------------------------------------------------

export function toggleStravaDetail(expandId: string): void {
  const panel = document.getElementById(expandId);
  const chevron = document.getElementById(`${expandId}-chevron`);
  if (!panel) return;

  const isNowVisible = panel.classList.toggle('hidden') === false;
  chevron?.classList.toggle('rotate-180', isNowVisible);

  if (isNowVisible) {
    panel.querySelectorAll<HTMLCanvasElement>('canvas[data-polyline]').forEach(canvas => {
      const encoded = canvas.dataset.polyline;
      const kmSplitsRaw = canvas.dataset.kmSplits;
      const kmSplits = kmSplitsRaw ? JSON.parse(kmSplitsRaw) as number[] : undefined;
      if (encoded) void drawPolylineOnCanvas(canvas, encoded, kmSplits);
    });
  }
}

// ---------------------------------------------------------------------------
// Google encoded polyline decoder (no external dependency)
// ---------------------------------------------------------------------------

function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;

    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

// ---------------------------------------------------------------------------
// Web Mercator projection helpers
// ---------------------------------------------------------------------------

function mercatorX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom) * 256;
}

function mercatorY(lat: number, zoom: number): number {
  const latRad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom) * 256;
}

// ---------------------------------------------------------------------------
// Haversine distance (metres) between two lat/lng points
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Pace → colour (green = fast, red = slow, relative to the run's own range)
// ---------------------------------------------------------------------------

const PACE_GRADIENT = ['#22c55e', '#86efac', '#fbbf24', '#f97316', '#ef4444'] as const;

function paceColor(secPerKm: number, minPace: number, maxPace: number): string {
  const spread = Math.max(maxPace - minPace, 30); // at least 30s spread for visible variation
  const t = Math.min(1, Math.max(0, (secPerKm - minPace) / spread));
  return PACE_GRADIENT[Math.min(4, Math.floor(t * 5))];
}

// ---------------------------------------------------------------------------
// OSM tile loader
// ---------------------------------------------------------------------------

function loadTile(tx: number, ty: number, zoom: number): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const n = Math.pow(2, zoom);
    if (ty < 0 || ty >= n) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
  });
}

// ---------------------------------------------------------------------------
// Route renderer (shared between immediate + tile-backed draws)
// ---------------------------------------------------------------------------

function renderRoute(
  ctx: CanvasRenderingContext2D,
  coords: [number, number][],
  kmSplits: number[] | undefined,
  toX: (lng: number) => number,
  toY: (lat: number) => number,
): void {
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kmSplits && kmSplits.length > 0) {
    // Build cumulative polyline distances for km boundary mapping
    const cumDist: number[] = [0];
    for (let i = 1; i < coords.length; i++) {
      cumDist.push(cumDist[i - 1] + haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    const minPace = Math.min(...kmSplits);
    const maxPace = Math.max(...kmSplits);

    // Batch consecutive points with the same colour into a single path
    let prevColor = '';
    for (let i = 1; i < coords.length; i++) {
      const kmIdx = Math.min(Math.floor(cumDist[i] / 1000), kmSplits.length - 1);
      const color = paceColor(kmSplits[kmIdx], minPace, maxPace);
      if (color !== prevColor) {
        if (prevColor) ctx.stroke();
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(toX(coords[i - 1][1]), toY(coords[i - 1][0]));
        prevColor = color;
      }
      ctx.lineTo(toX(coords[i][1]), toY(coords[i][0]));
    }
    if (prevColor) ctx.stroke();
  } else {
    // Single purple line when no pace data
    ctx.strokeStyle = '#a855f7';
    ctx.beginPath();
    ctx.moveTo(toX(coords[0][1]), toY(coords[0][0]));
    for (let i = 1; i < coords.length; i++) {
      ctx.lineTo(toX(coords[i][1]), toY(coords[i][0]));
    }
    ctx.stroke();
  }

  // Start dot (green)
  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(toX(coords[0][1]), toY(coords[0][0]), 5, 0, Math.PI * 2);
  ctx.fill();

  // End dot (red)
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(toX(coords[coords.length - 1][1]), toY(coords[coords.length - 1][0]), 5, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Main canvas renderer
// ---------------------------------------------------------------------------

export async function drawPolylineOnCanvas(
  canvas: HTMLCanvasElement,
  encoded: string,
  kmSplits?: number[],
): Promise<void> {
  // Filter [0,0] GPS artifacts before computing bounds
  const coords = decodePolyline(encoded).filter(c => Math.abs(c[0]) > 1 || Math.abs(c[1]) > 1);
  if (coords.length < 2) { canvas.style.display = 'none'; return; }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.offsetWidth || 300;
  const H = 200;
  canvas.width = W;
  canvas.height = H;

  const lats = coords.map(c => c[0]);
  const lngs = coords.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 28;

  // Pick highest zoom level where the route fits in the canvas
  let zoom = 10;
  for (let z = 16; z >= 10; z--) {
    const routeW = Math.abs(mercatorX(maxLng, z) - mercatorX(minLng, z));
    const routeH = Math.abs(mercatorY(minLat, z) - mercatorY(maxLat, z));
    if (routeW <= W - pad * 2 && routeH <= H - pad * 2) {
      zoom = z;
      break;
    }
  }

  // Centre of route's bounding box in Mercator world pixels
  const cx = (mercatorX(minLng, zoom) + mercatorX(maxLng, zoom)) / 2;
  const cy = (mercatorY(minLat, zoom) + mercatorY(maxLat, zoom)) / 2;

  const toX = (lng: number) => mercatorX(lng, zoom) - cx + W / 2;
  const toY = (lat: number) => mercatorY(lat, zoom) - cy + H / 2;

  // --- Immediate draw: dark background + route so there's no blank canvas ---
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, H);
  renderRoute(ctx, coords, kmSplits, toX, toY);

  // --- Load OSM tiles that cover the canvas ---
  const tileX0 = Math.floor((cx - W / 2) / 256);
  const tileX1 = Math.floor((cx + W / 2) / 256);
  const tileY0 = Math.floor((cy - H / 2) / 256);
  const tileY1 = Math.floor((cy + H / 2) / 256);

  const tileJobs: { tx: number; ty: number; px: number; py: number }[] = [];
  for (let tx = tileX0; tx <= tileX1 + 1; tx++) {
    for (let ty = tileY0; ty <= tileY1 + 1; ty++) {
      tileJobs.push({ tx, ty, px: tx * 256 - cx + W / 2, py: ty * 256 - cy + H / 2 });
    }
  }

  const tiles = await Promise.all(tileJobs.map(j => loadTile(j.tx, j.ty, zoom)));
  if (!tiles.some(t => t !== null)) return; // all tiles failed — keep dark background

  // --- Redraw: tiles + overlay + route ---
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, W, H);

  tiles.forEach((img, i) => {
    if (img) ctx.drawImage(img, tileJobs[i].px, tileJobs[i].py, 256, 256);
  });

  // Subtle dark overlay so coloured route pops against light map tiles
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, W, H);

  renderRoute(ctx, coords, kmSplits, toX, toY);

  // Pace legend (when pace data available)
  if (kmSplits && kmSplits.length > 0) {
    const minPace = Math.min(...kmSplits);
    const maxPace = Math.max(...kmSplits);
    // Import getState lazily to avoid circular dependency
    let unitPref: 'km' | 'mi' = 'km';
    try { const { getState } = await import('@/state'); unitPref = getState().unitPref ?? 'km'; } catch { /* ignore */ }
    const KM_TO_MI_PACE = 1.60934;
    const fmtLegend = (secPerKm: number) => {
      const sec = unitPref === 'mi' ? secPerKm * KM_TO_MI_PACE : secPerKm;
      const unit = unitPref === 'mi' ? '/mi' : '/km';
      return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}${unit}`;
    };
    ctx.font = 'bold 9px sans-serif';
    // Fast label (green end)
    ctx.fillStyle = '#22c55e';
    ctx.fillText(`▶ ${fmtLegend(minPace)}`, 4, 14);
    // Slow label (red end)
    ctx.fillStyle = '#ef4444';
    const slowLabel = `${fmtLegend(maxPace)} ▶`;
    ctx.fillText(slowLabel, W - ctx.measureText(slowLabel).width - 4, 14);
  }

  // OSM attribution (required)
  const attr = '© OpenStreetMap contributors';
  ctx.font = '8px sans-serif';
  const attrW = ctx.measureText(attr).width + 6;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(W - attrW, H - 14, attrW, 14);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillText(attr, W - attrW + 3, H - 4);
}

// ---------------------------------------------------------------------------
// Register on window for inline onclick handlers
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    toggleStravaDetail: (expandId: string) => void;
  }
}

window.toggleStravaDetail = toggleStravaDetail;
