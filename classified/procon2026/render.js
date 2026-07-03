'use strict';
// ================================================================
// render.js — 六角マップのCanvas描画とヒットテスト
// sim.js のグローバル定数(TERRAIN 等)に依存する。
// ================================================================

const RENDER_COLORS = {
  terrain: {
    [TERRAIN.PLAIN]:    '#1a2e1a',
    [TERRAIN.MOUNTAIN]: '#3a2a12',
    [TERRAIN.POND]:     '#0a1428',
  },
  road: ['#3a3a48', '#6b5a1e', '#6b1e1e'], // 順調 / 混雑 / 渋滞
  stroke: '#333',
  strokeSel: '#ffffff',
  cellNum: 'rgba(255,255,255,0.22)',
  patrol: '#4fc3f7',
  supply: '#ffa726',
  arrow: '#ffffff',
  ghost: 'rgba(79,195,247,0.45)', // GUI計画時の仮想位置
};

function brandColor(b) {
  return `hsl(${(b * 137.5 + 48) % 360}, 85%, 58%)`;
}

// canvas に対する描画器を生成する。
// render(view) の view:
//   { mapData, roadStatus, stocks, agents:[{id,kind,pos,action}],
//     selectedCell, arrows:[{from,to,remain}], ghosts:[{id,pos}], highlights:[pos] }
// 戻り値(最終描画情報): { centers, ox, oy, hex } — ヒットテスト・オーバーレイ配置に使用。
function makeRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let last = null;

  function hexPath(cx, cy, hex) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 30);
      const px = cx + (hex - 1) * Math.cos(a);
      const py = cy + (hex - 1) * Math.sin(a);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function render(view) {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.max(50, rect.width);
    canvas.height = Math.max(50, rect.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!view || !view.mapData) { last = null; return null; }

    const W = view.mapData.map.width, H = view.mapData.map.height;
    // マップゾーンは固定・セルサイズ側を調整(仕様Q23)
    const hex = Math.max(8, Math.min(
      (canvas.width - 40) / ((W + 0.5) * Math.sqrt(3)),
      (canvas.height - 40) / (H * 1.5 + 0.5)
    ));
    const mapPxW = (W + 0.5) * hex * Math.sqrt(3);
    const mapPxH = H * 1.5 * hex + hex * 0.5;
    const ox = (canvas.width - mapPxW) / 2;
    const oy = (canvas.height - mapPxH) / 2;

    // 偶数行(0,2,4...)が右にずれる(公式Q1)
    const centers = [];
    for (let pos = 0; pos < W * H; pos++) {
      const r = Math.floor(pos / W), c = pos % W;
      const offX = (r % 2 === 0) ? hex * Math.sqrt(3) / 2 : 0;
      centers[pos] = {
        x: c * hex * Math.sqrt(3) + offX + hex * Math.sqrt(3) / 2,
        y: r * hex * 1.5 + hex,
      };
    }

    ctx.save();
    ctx.translate(ox, oy);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // --- セル ---
    for (let pos = 0; pos < W * H; pos++) {
      const t = terrainAt(view.mapData, pos);
      const { x, y } = centers[pos];
      hexPath(x, y, hex);
      ctx.fillStyle = (t === TERRAIN.ROAD)
        ? RENDER_COLORS.road[(view.roadStatus && view.roadStatus[pos]) || 0]
        : RENDER_COLORS.terrain[t];
      ctx.fill();
      const sel = (view.selectedCell === pos);
      const hi = view.highlights && view.highlights.includes(pos);
      ctx.strokeStyle = sel ? RENDER_COLORS.strokeSel : hi ? '#9f9' : RENDER_COLORS.stroke;
      ctx.lineWidth = (sel || hi) ? 2 : 1;
      ctx.stroke();
      // セル番号(常時・薄く)
      ctx.fillStyle = RENDER_COLORS.cellNum;
      ctx.font = `${Math.max(7, hex * 0.24)}px 'Courier New', monospace`;
      ctx.fillText(pos, x, y - hex * 0.55);
    }

    // --- スポット(系列色マーカー + 在庫数) ---
    view.mapData.spots.forEach(spot => {
      const { x, y } = centers[spot.pos];
      ctx.beginPath();
      ctx.arc(x, y, hex * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = brandColor(spot.brand);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      const stock = (view.stocks && view.stocks[spot.pos] != null) ? view.stocks[spot.pos] : spot.stocks;
      ctx.fillStyle = '#000';
      ctx.font = `bold ${Math.max(8, hex * 0.3)}px 'Courier New', monospace`;
      ctx.fillText(stock, x, y);
    });

    // --- 移動予約の矢印 ---
    (view.arrows || []).forEach(mv => {
      const f = centers[mv.from], t = centers[mv.to];
      if (!f || !t) return;
      const ang = Math.atan2(t.y - f.y, t.x - f.x);
      const ex = t.x - Math.cos(ang) * hex * 0.45;
      const ey = t.y - Math.sin(ang) * hex * 0.45;
      ctx.strokeStyle = RENDER_COLORS.arrow;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - 7 * Math.cos(ang - 0.5), ey - 7 * Math.sin(ang - 0.5));
      ctx.lineTo(ex - 7 * Math.cos(ang + 0.5), ey - 7 * Math.sin(ang + 0.5));
      ctx.closePath();
      ctx.fillStyle = RENDER_COLORS.arrow;
      ctx.fill();
      ctx.font = `bold ${Math.max(8, hex * 0.26)}px 'Courier New', monospace`;
      ctx.fillText(`残${mv.remain}`, (f.x + ex) / 2, (f.y + ey) / 2 - hex * 0.25);
    });

    // --- GUI計画中の仮想位置(半透明) ---
    (view.ghosts || []).forEach(gh => {
      const { x, y } = centers[gh.pos];
      ctx.beginPath();
      ctx.arc(x, y + hex * 0.15, hex * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = RENDER_COLORS.ghost;
      ctx.fill();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#000';
      ctx.font = `bold ${Math.max(8, hex * 0.28)}px 'Courier New', monospace`;
      ctx.fillText(gh.id, x, y + hex * 0.15);
    });

    // --- エージェント(同一セルは小さく円周配置 / 仕様E16) ---
    const byCell = {};
    (view.agents || []).forEach(a => { (byCell[a.pos] = byCell[a.pos] || []).push(a); });
    Object.values(byCell).forEach(list => {
      const { x, y } = centers[list[0].pos];
      const n = list.length;
      const r = (n === 1) ? hex * 0.26 : Math.max(6, hex * 0.18);
      list.forEach((a, k) => {
        const ang = (Math.PI * 2 * k) / n - Math.PI / 2;
        const dx = (n === 1) ? 0 : Math.cos(ang) * hex * 0.32;
        const dy = (n === 1) ? 0 : Math.sin(ang) * hex * 0.32;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy + hex * 0.15, r, 0, Math.PI * 2);
        ctx.fillStyle = a.kind === KIND_SUPPLY ? RENDER_COLORS.supply : RENDER_COLORS.patrol;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.font = `bold ${Math.max(8, r * 1.1)}px 'Courier New', monospace`;
        ctx.fillText(a.id, x + dx, y + dy + hex * 0.15);
      });
    });

    ctx.restore();
    last = { centers, ox, oy, hex };
    return last;
  }

  // クリック座標→セル番号(なければ null)
  function hitTest(clientX, clientY) {
    if (!last) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left - last.ox;
    const y = clientY - rect.top - last.oy;
    let best = null, bestD = Infinity;
    last.centers.forEach((c, pos) => {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bestD) { bestD = d; best = pos; }
    });
    return (best !== null && bestD <= (last.hex * 0.95) ** 2) ? best : null;
  }

  return { render, hitTest, getLast: () => last };
}
