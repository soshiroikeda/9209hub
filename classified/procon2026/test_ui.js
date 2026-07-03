'use strict';
// ================================================================
// test_ui.js — DOMシムで ui.js の全フローを通す統合スモークテスト
// 起動→モード選択→タイプ選択→4日分(提出/再生/日送り)→結果→リセット
// ================================================================

// ---------------- 最小DOMシム ----------------
function makeCtx() {
  const noop = () => {};
  return new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : noop),
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

const elementsById = {};
const allElements = [];

function makeElement(tag, id) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    dataset: {},
    style: {},
    value: '',
    checked: false,
    disabled: false,
    _text: '',
    _html: '',
    _classes: new Set(),
    _handlers: {},
    childNodes: [],
    parentElement: null,
    files: [],
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.childNodes = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.childNodes = []; },
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
    },
    addEventListener(type, fn) { (el._handlers[type] = el._handlers[type] || []).push(fn); },
    fire(type, ev) { (el._handlers[type] || []).forEach(fn => fn(ev || { target: el })); },
    appendChild(c) { c.parentElement = el; el.childNodes.push(c); return c; },
    prepend(c) {
      const nodes = c._isFragment ? c.childNodes : [c];
      nodes.forEach(n => { n.parentElement = el; });
      el.childNodes.unshift(...nodes);
    },
    removeChild(c) { el.childNodes = el.childNodes.filter(x => x !== c); },
    get lastChild() { return el.childNodes[el.childNodes.length - 1]; },
    click() {},
    getContext() { return makeCtx(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
  if (tag === 'canvas') { el.width = 0; el.height = 0; }
  allElements.push(el);
  if (id) elementsById[id] = el;
  return el;
}

// index.html に登場するIDを列挙して生成
const IDS = [
  'screen-start','screen-mode','screen-place','screen-type','screen-plan','screen-play','screen-result',
  'map-file-input','btn-sample','start-error',
  'btn-mode-json','btn-mode-gui','chk-custom-place',
  'place-canvas','place-list','btn-place-reset','btn-place-confirm','place-error',
  'type-canvas','type-overlay','type-list','btn-type-confirm',
  'plan-canvas','plan-day-title','plan-day-info','plan-json-panel','plan-file-input','plan-textarea',
  'plan-gui-panel','gui-agent-list','gui-wait-num','btn-gui-wait','btn-gui-fill','btn-gui-undo',
  'gui-json-view','btn-gui-download','btn-plan-submit','plan-error','plan-cell-detail',
  'st-day','st-step','st-next','st-day-fill','play-map-zone','play-canvas',
  'btn-next-phase','btn-skip-day','btn-day-end',
  'brand-title','brand-badges','agent-panel','spot-panel','play-cell-detail','log-body',
  'result-summary','result-agents','result-days','btn-reset-same','btn-reset-all',
];
IDS.forEach(id => {
  const tag = id.includes('canvas') ? 'canvas' : id.includes('textarea') || id === 'gui-json-view' ? 'textarea' : 'div';
  const el = makeElement(tag, id);
  if (id.startsWith('screen-')) el._classes.add('screen');
});
// canvasの親(map-zone)を用意
['place-canvas','type-canvas','plan-canvas','play-canvas'].forEach(id => {
  const parent = makeElement('div');
  parent.appendChild(elementsById[id]);
});

global.document = {
  getElementById: id => elementsById[id] || null,
  querySelectorAll: sel => {
    const cls = sel.replace('.', '');
    return allElements.filter(e => e._classes.has(cls));
  },
  createElement: tag => makeElement(tag),
  createDocumentFragment: () => {
    const f = makeElement('fragment');
    f._isFragment = true;
    return f;
  },
};
global.window = {
  addEventListener: () => {},
};
global.requestAnimationFrame = fn => fn();
global.URL = { createObjectURL: () => 'blob:', revokeObjectURL: () => {} };
global.Blob = class {};
global.FileReader = class { readAsText() {} };

// ---------------- 読み込み ----------------
// ブラウザでは複数<script>がグローバルスコープを共有するため、
// 3ファイルを連結して単一実行することでそれを再現する。
// テストから内部関数(app, placeableCell, guiAppendMove)へ触れるよう、
// 連結末尾でそれらを global へ書き出す。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const code = ['sim.js', 'render.js', 'ui.js']
  .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')
    .replace("typeof module !== 'undefined'", 'false'))
  .join('\n;\n')
  + '\n;globalThis.app = app; globalThis.placeableCell = placeableCell; globalThis.guiAppendMove = guiAppendMove;';
vm.runInThisContext(code, { filename: 'bundle.js' });

// ---------------- アサーション ----------------
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function activeScreen() {
  return allElements.find(e => e._classes.has('screen') && e._classes.has('active'))?.id;
}

// ---------------- フロー実行 ----------------
console.log('[UI-1] 起動〜タイプ選択');
ok('初期画面はstart', activeScreen() === 'screen-start');

elementsById['btn-sample'].fire('click');
ok('サンプル読込→mode画面', activeScreen() === 'screen-mode');
ok('マップエラーなし', elementsById['start-error']._text === '');

elementsById['btn-mode-json'].fire('click');
ok('JSONモード→type画面(配置スキップ)', activeScreen() === 'screen-type');

// タイプ: A1を補給車に(app はui.js内グローバル)
app.typeSel[1] = 1;
elementsById['btn-type-confirm'].fire('click');
ok('タイプ確定→plan画面', activeScreen() === 'screen-plan');
ok('game生成: 4体', app.game.agents.length === 4);
ok('A1=補給車 / 他=巡回車', app.game.agents.map(a => a.kind).join('') === '0100');
ok('Day1 道路は全て順調', Object.values(app.game.roadStatus).every(v => v === 0));

console.log('[UI-2] Day1: 無効回答の拒否と有効回答の受理');
elementsById['plan-textarea'].value = '[[2,2],[-16],[-16],[-16]]'; // 合計不足
elementsById['btn-plan-submit'].fire('click');
ok('合計不足はリジェクト(plan画面のまま)', activeScreen() === 'screen-plan');
ok('エラーメッセージ表示', elementsById['plan-error']._text.includes('一致しません'));

// 有効: A0はセル0(平地2step)→右→右→…と単純化して全員16step
// セル0(偶数行): 右(2)=セル1(道路順調1step) さらに右=セル2(平地2step)…
// シンプルに: A0 [2, -14] (2step移動+14待機) / 他は待機のみ
elementsById['plan-textarea'].value = '[[2,-14],[-16],[-16],[-16]]';
elementsById['btn-plan-submit'].fire('click');
ok('有効回答→play画面', activeScreen() === 'screen-play');
ok('タイムライン=2N=32フェーズ', app.timeline.length === 32);
ok('提出直後はphaseIdx=-1', app.phaseIdx === -1);

console.log('[UI-3] Day1: 再生');
elementsById['btn-next-phase'].fire('click'); // S0 AC
ok('1押下でS0 AC', app.phaseIdx === 0 && app.timeline[0].kind === 'AC');
elementsById['btn-next-phase'].fire('click'); // S1 REF
elementsById['btn-next-phase'].fire('click'); // S1 AC
elementsById['btn-next-phase'].fire('click'); // S2 REF: A0がセル1へ移動完了
const s2snap = app.timeline[app.phaseIdx].snapshot;
ok('S2でA0がセル1へ移動', s2snap.agents[0].pos === 1 && s2snap.step === 2);
ok('A0燃料 20-1=19(平地)', s2snap.agents[0].fuel === 19);
elementsById['btn-skip-day'].fire('click');
ok('スキップで日末尾へ', app.phaseIdx === app.timeline.length - 1);
ok('日終了ボタン表示', elementsById['btn-day-end'].style.display === '');
// A0はセル1(道路)にS2..S16の反映で滞在 → 交通量15
ok('セル1交通量=15', app.game.trafficDays[0][1] === 15);

console.log('[UI-4] Day2: 道路状態への反映');
elementsById['btn-day-end'].fire('click');
ok('Day2のplan画面へ', activeScreen() === 'screen-plan' && app.game.day === 2);
ok('セル1は渋滞(15≧6)', app.game.roadStatus[1] === 2);
ok('在庫が補充されている', app.game.stocks[10] === 3);
ok('A0の燃料が引き継がれている', app.game.agents[0].fuel === 19);

// Day2: A0はセル1(渋滞:4step,燃料2)から右上(1)=セル2? 奇数行…セル1はrow0(偶数)。
// 右(2)=セル2(平地)。 [2, -12] = 4+12=16 ✓
elementsById['plan-textarea'].value = '[[2,-12],[-16],[-16],[-16]]';
elementsById['btn-plan-submit'].fire('click');
ok('Day2有効回答→play画面', activeScreen() === 'screen-play');
elementsById['btn-skip-day'].fire('click');
ok('A0がセル2へ(渋滞4step消費)', app.game.agents[0].pos === 2);
ok('A0燃料 19-2=17(道路)', app.game.agents[0].fuel === 17);

console.log('[UI-5] Day3〜4: 消化して結果へ');
elementsById['btn-day-end'].fire('click'); // Day3 plan
elementsById['plan-textarea'].value = '[[-16],[-16],[-16],[-16]]';
elementsById['btn-plan-submit'].fire('click');
elementsById['btn-skip-day'].fire('click');
elementsById['btn-day-end'].fire('click'); // Day4 plan
elementsById['plan-textarea'].value = '[[-16],[-16],[-16],[-16]]';
elementsById['btn-plan-submit'].fire('click');
elementsById['btn-skip-day'].fire('click');
ok('最終日終了ボタンは結果表示', elementsById['btn-day-end']._text.includes('結果'));
elementsById['btn-day-end'].fire('click');
ok('結果画面へ', activeScreen() === 'screen-result');
ok('日別ログ4日分', elementsById['result-days']._html.split('<br>').length === 4);

console.log('[UI-6] リセット');
elementsById['btn-reset-same'].fire('click');
ok('同マップリセット→type画面', activeScreen() === 'screen-type');
ok('gameがクリアされている', app.game === null);
ok('mapDataは保持', app.mapData !== null);
ok('タイプ選択は未選択に戻る', app.typeSel.every(t => t === null));

elementsById['btn-reset-all'].fire('click');
ok('全リセット→start画面', activeScreen() === 'screen-start');
ok('mapDataもクリア', app.mapData === null);

console.log('[UI-7] GUIモード + カスタム配置');
elementsById['btn-sample'].fire('click');
elementsById['chk-custom-place'].checked = true;
elementsById['btn-mode-gui'].fire('click');
ok('カスタム配置画面へ', activeScreen() === 'screen-place');
// 配置APIを直接叩く(canvasヒットテストはシム外のため)
ok('山地は配置不可', placeableCell(5) !== null);     // pos5=山地
ok('スポットセルは配置不可', placeableCell(10) !== null); // pos10=スポット
ok('平地は配置可', placeableCell(0) === null);
app.placements = [0, 4, 56, 62];
elementsById['btn-place-confirm'].disabled = false;
elementsById['btn-place-confirm'].fire('click');
ok('配置確定→type画面', activeScreen() === 'screen-type');
elementsById['btn-type-confirm'].fire('click');
ok('GUIモードでplan画面へ', activeScreen() === 'screen-plan');
ok('GUIドラフト生成', app.guiDraft.length === 4);

// GUI操作: A0(セル0)を右へ移動(平地2step)→待機で埋める
guiAppendMove(2);
ok('GUI移動追加: 仮想位置セル1 / 累計2', app.guiDraft[0].pos === 1 && app.guiDraft[0].sum === 2);
guiAppendMove(5); // 左に戻る(道路順調1step)
ok('GUI移動追加: セル0へ戻る / 累計3', app.guiDraft[0].pos === 0 && app.guiDraft[0].sum === 3);
elementsById['btn-gui-undo'].fire('click');
ok('undoで累計2に戻る', app.guiDraft[0].pos === 1 && app.guiDraft[0].sum === 2);
elementsById['btn-gui-fill'].fire('click');
ok('残りを待機で埋めて16', app.guiDraft[0].sum === 16);
ok('JSONプレビュー更新', elementsById['gui-json-view'].value === JSON.stringify([[2,-14],[],[],[]]));
// 全員埋めて提出
app.guiSel = 1; elementsById['btn-gui-fill'].fire('click');
app.guiSel = 2; elementsById['btn-gui-fill'].fire('click');
app.guiSel = 3; elementsById['btn-gui-fill'].fire('click');
elementsById['btn-plan-submit'].fire('click');
ok('GUI計画の提出成功→play画面', activeScreen() === 'screen-play');

console.log(`\n===== 結果: PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
