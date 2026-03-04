/**
 * editor.js - 节点编辑器核心：画布、拖拽、连线、状态管理、API执行
 */

// ── 全局状态 ──────────────────────────────────────────────
let nodes = {};   // { id: nodeObj }
let edges = [];   // [{ id, source, target, srcPort, dstPort }]
let _settings = {};
let _currentModal = null;  // 当前打开的节点id

// 连线绘制临时状态
let _drawingEdge = null;  // { sourceId, srcPort, startX, startY }

const canvas = document.getElementById('canvas');
const svgLayer = document.getElementById('svg-layer');
const canvasWrap = document.getElementById('canvas-wrap');

// ── 辅助函数：获取屏幕中心 ─────────────────────────────────
function getScreenCenter() {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const centerX = wrapRect.left + wrapRect.width / 2;
  const centerY = wrapRect.top + wrapRect.height / 2;
  return { x: centerX, y: centerY };
}

function getCanvasCenter() {
  const screenCenter = getScreenCenter();
  const wrapRect = canvasWrap.getBoundingClientRect();
  return {
    x: screenCenter.x - wrapRect.left - _pan.x,
    y: screenCenter.y - wrapRect.top - _pan.y
  };
}

// ── 初始化：加载项目状态 ──────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/state');
  const state = await res.json();
  nodes = state.nodes || {};
  edges = state.edges || [];
  _settings = state.settings || {};
  window._settings = _settings;
  Object.values(nodes).forEach(n => renderNode(n));
  renderAllEdges();
});

// ── 画布平移 ──────────────────────────────────────────────
let _pan = { x: 0, y: 0, dragging: false, sx: 0, sy: 0 };
canvasWrap.addEventListener('mousedown', e => {
  if (e.target === canvasWrap || e.target === canvas || e.target === svgLayer) {
    _pan.dragging = true;
    _pan.sx = e.clientX - _pan.x;
    _pan.sy = e.clientY - _pan.y;
  }
});
window.addEventListener('mousemove', e => {
  if (_pan.dragging) {
    _pan.x = e.clientX - _pan.sx;
    _pan.y = e.clientY - _pan.sy;
    canvas.style.transform = `translate(${_pan.x}px,${_pan.y}px)`;
    svgLayer.style.transform = `translate(${_pan.x}px,${_pan.y}px)`;
  }
  if (_drawingEdge) updateTempEdge(e);
});
window.addEventListener('mouseup', e => {
  _pan.dragging = false;
  if (_drawingEdge) {
    finishEdge(e);
    _drawingEdge = null;
    removeTempEdge();
  }
});

// ── 添加节点 ──────────────────────────────────────────────
function addNode(type) {
  const id = `${type}_${Date.now()}`;
  const cfg = NODE_TYPES[type];
  const center = getCanvasCenter();
  const node = {
    id, type,
    x: center.x + (Math.random() - 0.5) * 100,
    y: center.y + (Math.random() - 0.5) * 100,
    status: 'idle',
    data: {},
    output: null,
    output_images: [],
    output_videos: [],
    error_log: ''
  };
  nodes[id] = node;
  renderNode(node);
  persistState();
}

// ── 渲染节点DOM ───────────────────────────────────────────
function renderNode(node) {
  let el = document.getElementById(node.id);
  if (!el) {
    el = document.createElement('div');
    el.id = node.id;
    el.className = 'node';
    canvas.appendChild(el);
    makeDraggable(el, node);
  }
  const cfg = NODE_TYPES[node.type];
  const badge = `<span class="status-badge ${STATUS_BADGE[node.status]}">${STATUS_LABEL[node.status]}</span>`;
  el.className = `node status-${node.status}`;
  el.style.left = node.x + 'px';
  el.style.top  = node.y + 'px';

  // 镜头编号标签
  const shotLabel = node.data?.shot_label || node.data?.shot_index || '';
  const shotTag = shotLabel ? `<span class="shot-tag">🎞 ${shotLabel}</span>` : '';

  // 端口HTML
  const inPorts  = (cfg.ports.in  || []).map((p,i) =>
    `<div class="port port-in"  style="top:${30+i*20}px" data-node="${node.id}" data-port="${p}" data-dir="in"></div>`
  ).join('');
  const outPorts = (cfg.ports.out || []).map((p,i) =>
    `<div class="port port-out" style="top:${30+i*20}px" data-node="${node.id}" data-port="${p}" data-dir="out"></div>`
  ).join('');

  // 底部按钮
  let footerBtns = '';
  const previewBtn = hasOutput(node) ? `<button class="btn-preview" onclick="previewOutput('${node.id}')">👁 查看</button>` : '';
  if (node.status === 'done') {
    const passBtn = node.type === 'Shot_Text'
      ? `<button class="btn-pass" onclick="approveShotText('${node.id}')">✔ 确认</button>`
      : `<button class="btn-pass" onclick="approveNode('${node.id}')">✔ 通过</button>`;
    footerBtns = `
      ${passBtn}
      <button class="btn-refresh" onclick="refreshNode('${node.id}')">↺ 刷新</button>
      <button class="btn-edit"    onclick="openModal('${node.id}')">✎ 编辑</button>${previewBtn}`;
  } else if (node.status === 'error') {
    footerBtns = `
      <button class="btn-log"     onclick="showLog('${node.id}')">⚠ 查看错误</button>
      <button class="btn-refresh" onclick="refreshNode('${node.id}')">↺ 重试</button>`;
  } else if (node.status === 'approved') {
    footerBtns = `<button class="btn-edit" onclick="openModal('${node.id}')">🔒 查看</button>${previewBtn}`;
  } else {
    footerBtns = `<button class="btn-edit" onclick="openModal('${node.id}')">✎ 打开</button>`;
  }

  el.innerHTML = `
    ${inPorts}
    <div class="node-header" style="background:${cfg.color}">
      ${cfg.label} ${badge}
      <button class="btn-delete" onclick="deleteNode('${node.id}')">✕</button>
    </div>
    <div class="node-body">${cfg.desc}${shotTag}</div>
    <div class="node-footer">${footerBtns}</div>
    ${outPorts}`;

  // 绑定端口连线事件
  el.querySelectorAll('.port[data-dir="out"]').forEach(p => {
    p.addEventListener('mousedown', startEdge);
  });
  el.querySelectorAll('.port[data-dir="in"]').forEach(p => {
    p.addEventListener('mouseup', e => {
      e.stopPropagation();
      if (_drawingEdge) {
        const srcId   = _drawingEdge.sourceId;
        const srcPort = _drawingEdge.srcPort;
        const dstId   = p.dataset.node;
        const dstPort = p.dataset.port;
        if (srcId !== dstId && !edgeExists(srcId, dstId)) {
          const edge = { id: `e_${Date.now()}`, source: srcId, target: dstId, srcPort, dstPort };
          edges.push(edge);
          renderAllEdges();
          persistState();
        }
        _drawingEdge = null;
        removeTempEdge();
      }
    });
  });
}

// ── 节点拖拽 ──────────────────────────────────────────────
function makeDraggable(el, node) {
  let ox, oy, dragging = false;
  el.querySelector && el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('port') || e.target.tagName === 'BUTTON') return;
    dragging = true;
    ox = e.clientX - node.x;
    oy = e.clientY - node.y;
    e.stopPropagation();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    node.x = e.clientX - ox;
    node.y = e.clientY - oy;
    el.style.left = node.x + 'px';
    el.style.top  = node.y + 'px';
    renderAllEdges();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; persistState(); } });
}

// ── 连线绘制 ──────────────────────────────────────────────
function startEdge(e) {
  e.stopPropagation();
  const p = e.currentTarget;
  const rect = p.getBoundingClientRect();
  const wrapRect = canvasWrap.getBoundingClientRect();
  _drawingEdge = {
    sourceId: p.dataset.node,
    srcPort:  p.dataset.port,
    startX: rect.left - wrapRect.left - _pan.x + 6,
    startY: rect.top  - wrapRect.top  - _pan.y + 6
  };
}

function updateTempEdge(e) {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const mx = e.clientX - wrapRect.left - _pan.x;
  const my = e.clientY - wrapRect.top  - _pan.y;
  let tmp = document.getElementById('tmp-edge');
  if (!tmp) { tmp = document.createElementNS('http://www.w3.org/2000/svg','path'); tmp.id='tmp-edge'; tmp.style.stroke='#ffcc00'; tmp.style.strokeWidth='2'; tmp.style.fill='none'; tmp.style.strokeDasharray='6,3'; svgLayer.appendChild(tmp); }
  tmp.setAttribute('d', bezier(_drawingEdge.startX, _drawingEdge.startY, mx, my));
}

function removeTempEdge() {
  const t = document.getElementById('tmp-edge');
  if (t) t.remove();
}

function finishEdge(e) {
  // 若鼠标松开在端口上，由端口的mouseup处理；否则取消
}

function edgeExists(src, dst) {
  return edges.some(e => e.source === src && e.target === dst);
}

// ── SVG 连线渲染 ──────────────────────────────────────────
function renderAllEdges() {
  // 清除旧连线（保留临时线）
  Array.from(svgLayer.querySelectorAll('path:not(#tmp-edge)')).forEach(p => p.remove());
  edges.forEach(edge => {
    const srcEl = document.querySelector(`#${edge.source} .port-out[data-port="${edge.srcPort}"]`);
    const dstEl = document.querySelector(`#${edge.target} .port-in[data-port="${edge.dstPort}"]`);
    if (!srcEl || !dstEl) return;
    const wrapRect = canvasWrap.getBoundingClientRect();
    const sr = srcEl.getBoundingClientRect();
    const dr = dstEl.getBoundingClientRect();
    const x1 = sr.left - wrapRect.left - _pan.x + 6;
    const y1 = sr.top  - wrapRect.top  - _pan.y + 6;
    const x2 = dr.left - wrapRect.left - _pan.x + 6;
    const y2 = dr.top  - wrapRect.top  - _pan.y + 6;
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', bezier(x1,y1,x2,y2));
    path.dataset.edgeId = edge.id;
    path.style.cursor = 'pointer';
    path.addEventListener('click', () => deleteEdge(edge.id));
    svgLayer.appendChild(path);
  });
}

function bezier(x1,y1,x2,y2) {
  const cx = (x1+x2)/2;
  return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
}

// ── 删除节点/连线 ─────────────────────────────────────────
function deleteNode(id) {
  if (!confirm('删除该节点？')) return;
  delete nodes[id];
  edges = edges.filter(e => e.source !== id && e.target !== id);
  document.getElementById(id)?.remove();
  renderAllEdges();
  persistState();
}

function deleteEdge(id) {
  edges = edges.filter(e => e.id !== id);
  renderAllEdges();
  persistState();
}

// ── 判断节点是否有可预览输出 ─────────────────────────────
function hasOutput(node) {
  return !!(node.output || (node.output_images && node.output_images.length) || (node.output_videos && node.output_videos.length));
}

// ── 快速预览输出弹窗 ──────────────────────────────────────
function previewOutput(id) {
  const node = nodes[id];
  let html = '';
  if (node.output_videos && node.output_videos.length) {
    html += node.output_videos.map(v => `<video src="${v}" controls style="max-width:100%;margin-bottom:8px"></video>`).join('');
  }
  if (node.output_images && node.output_images.length) {
    html += `<div style="display:flex;flex-wrap:wrap;gap:6px">` +
      node.output_images.map(u => `<img src="${u}" style="max-width:48%;border-radius:4px">`).join('') + `</div>`;
  }
  if (node.output) {
    html += `<pre style="white-space:pre-wrap;word-break:break-all;max-height:400px;overflow:auto;background:#0a1628;padding:10px;border-radius:4px;font-size:12px">${escHtml(node.output)}</pre>`;
  }
  document.getElementById('preview-body').innerHTML = html;
  document.getElementById('preview-overlay').classList.remove('hidden');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function closePreview(e) {
  if (e && e.target !== document.getElementById('preview-overlay')) return;
  document.getElementById('preview-overlay').classList.add('hidden');
}

// ── 节点状态操作 ──────────────────────────────────────────
function approveNode(id) {
  nodes[id].status = 'approved';
  renderNode(nodes[id]);
  persistState();
  // 分镜生成通过 → 自动为每个shot创建分镜纯文本节点
  if (nodes[id].type === 'Output_Storyboard') {
    autoCreateShotTextNodes(id);
  }
  // 图片描述通过 → 自动创建视频描述模块
  if (nodes[id].type === 'Output_Pic_ShotPrompt') {
    autoCreateVideoPromptNode(id);
  }
}

// 分镜纯文本节点"确认"按钮（在弹窗内触发）
function approveShotText(id) {
  nodes[id].status = 'approved';
  renderNode(nodes[id]);
  persistState();
  closeModal();
  autoCreatePicNode(id);
}

// 从可能含 markdown 代码块的字符串中提取 JSON
function extractJSON(str) {
  if (!str) return null;
  const m = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : str;
  try { return JSON.parse(raw.trim()); } catch(e) { return null; }
}

// 分镜生成通过 → 为每个shot创建 Shot_Text 节点
function autoCreateShotTextNodes(storyboardId) {
  const node = nodes[storyboardId];
  const parsed = extractJSON(node.output);
  const shots = parsed?.shots;
  if (!shots || !shots.length) {
    alert('未能解析分镜JSON，请确认输出格式正确（需含 shots 数组）');
    return;
  }
  shots.forEach((shot, i) => {
    const newId = `Shot_Text_${Date.now()}_${i}`;
    const shotText = JSON.stringify(shot, null, 2);
    const newNode = {
      id: newId, type: 'Shot_Text',
      x: node.x + 280, y: node.y + i * 180,
      status: 'done',
      data: { shot_label: shot.shot_id, shot_text: shotText },
      output: shotText,
      output_images: [], output_videos: [], error_log: ''
    };
    nodes[newId] = newNode;
    renderNode(newNode);
  });
  renderAllEdges();
  persistState();
}

// Shot_Text 确认 → 自动创建图片描述节点
function autoCreatePicNode(shotTextId) {
  const stNode = nodes[shotTextId];
  const label = stNode.data?.shot_label || '';
  const newId = `Output_Pic_ShotPrompt_${Date.now()}`;
  const newNode = {
    id: newId, type: 'Output_Pic_ShotPrompt',
    x: stNode.x + 280, y: stNode.y,
    status: 'idle', data: { shot_label: label }, output: null,
    output_images: [], output_videos: [], error_log: ''
  };
  nodes[newId] = newNode;
  renderNode(newNode);
  edges.push({ id: `e_${Date.now()}_st`, source: shotTextId, target: newId, srcPort: 'shot_text', dstPort: 'shot_text' });
  renderAllEdges();
  persistState();
}

// 图片描述通过 → 自动创建视频描述节点
function autoCreateVideoPromptNode(picNodeId) {
  const picNode = nodes[picNodeId];
  const label = picNode.data?.shot_label || '';
  // 找到上游 Shot_Text 节点
  const stEdge = edges.find(e => e.target === picNodeId && e.dstPort === 'shot_text');
  const newId = `Output_Video_ShotPrompt_${Date.now()}`;
  const newNode = {
    id: newId, type: 'Output_Video_ShotPrompt',
    x: picNode.x + 280, y: picNode.y,
    status: 'idle', data: { shot_label: label }, output: null,
    output_images: [], output_videos: [], error_log: ''
  };
  nodes[newId] = newNode;
  renderNode(newNode);
  // 连接上游 Shot_Text
  if (stEdge) {
    edges.push({ id: `e_${Date.now()}_st`, source: stEdge.source, target: newId, srcPort: 'shot_text', dstPort: 'shot_text' });
  }
  // 连接图片描述
  edges.push({ id: `e_${Date.now()}_pic`, source: picNodeId, target: newId, srcPort: 'pic_prompts', dstPort: 'pic_prompts' });
  renderAllEdges();
  persistState();
}

function refreshNode(id) {
  nodes[id].status = 'idle';
  nodes[id].output = null;
  invalidateDownstream(id);
  renderNode(nodes[id]);
  persistState();
  openModal(id);
}

function invalidateDownstream(id) {
  edges.filter(e => e.source === id).forEach(e => {
    const n = nodes[e.target];
    if (n && n.status !== 'idle') {
      n.status = 'idle';
      n.output = null;
      invalidateDownstream(e.target);
      renderNode(n);
    }
  });
}

// ── 获取上游节点输出 ──────────────────────────────────────
function getUpstreamOutput(nodeId, portName) {
  const edge = edges.find(e => e.target === nodeId && e.dstPort === portName);
  if (!edge) return null;
  const src = nodes[edge.source];
  if (!src) return null;
  if (portName === 'characters') return src.data?.characters || [];
  if (portName === 'env_image')  return src.data?.env_images || [];
  if (portName === 'script')     return src.data?.script_files || [];
  if (portName === 'shot_text')  return src.data?.shot_text || src.output || null;
  return src.output || null;
}

// 按源节点类型查找上游输出（忽略端口名，防止接线接反）
function getUpstreamByType(nodeId, srcType) {
  const edge = edges.find(e => e.target === nodeId && nodes[e.source]?.type === srcType);
  if (!edge) return null;
  const src = nodes[edge.source];
  if (srcType === 'Input_Character') return src.data?.characters || [];
  return src.output || null;
}

// ── 读取文档内容 ──────────────────────────────────────────
async function readDocFiles(files) {
  if (!files || !files.length) return '';
  const texts = await Promise.all(files.map(async f => {
    const r = await fetch('/api/read_doc', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({filename: f.serverName}) });
    const d = await r.json();
    return d.text || '';
  }));
  return texts.join('\n\n');
}

// ── 持久化状态 ────────────────────────────────────────────
async function persistState() {
  await fetch('/api/state', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ nodes, edges, settings: _settings })
  });
}

// ── 弹窗 ──────────────────────────────────────────────────
function openModal(id) {
  _currentModal = id;
  const node = nodes[id];
  document.getElementById('modal-title').textContent = NODE_TYPES[node.type].label + ' — ' + id;
  document.getElementById('modal-body').innerHTML = renderModalBody(node);
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.add('hidden');
  _currentModal = null;
}

function showLog(id) {
  document.getElementById('log-body').textContent = nodes[id].error_log || '无日志';
  document.getElementById('log-overlay').classList.remove('hidden');
}

function closeLog(e) {
  if (e && e.target !== document.getElementById('log-overlay')) return;
  document.getElementById('log-overlay').classList.add('hidden');
}

// ── 设置弹窗 ──────────────────────────────────────────────
async function openSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  _settings = s; window._settings = s;
  document.getElementById('s-llm-url').value   = s.llm_url   || '';
  document.getElementById('s-llm-key').value   = s.llm_key   || '';
  document.getElementById('s-llm-model').value = s.llm_model || '';
  document.getElementById('s-comfy-url').value = s.comfyui_url || '';
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings(e) {
  if (e && e.target !== document.getElementById('settings-overlay')) return;
  document.getElementById('settings-overlay').classList.add('hidden');
}

async function saveSettings() {
  _settings = {
    ..._settings,
    llm_url:     document.getElementById('s-llm-url').value.trim(),
    llm_key:     document.getElementById('s-llm-key').value.trim(),
    llm_model:   document.getElementById('s-llm-model').value.trim(),
    comfyui_url: document.getElementById('s-comfy-url').value.trim()
  };
  window._settings = _settings;
  await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(_settings) });
  closeSettings();
  alert('设置已保存');
}

// ── 预设弹窗 ──────────────────────────────────────────────
function openPresets() {
  const s = _settings;
  const iv = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  iv('p-img-vol-key',    s.preset_img_volcano?.api_key);
  iv('p-img-vol-model',  s.preset_img_volcano?.model);
  iv('p-img-goog-key',   s.preset_img_google?.api_key);
  iv('p-img-goog-model', s.preset_img_google?.model);
  iv('p-img-goog-ratio', s.preset_img_google?.aspect_ratio);
  iv('p-img-goog-neg',   s.preset_img_google?.negative_prompt);
  iv('p-vid-vol-key',    s.preset_vid_volcano?.api_key);
  iv('p-vid-vol-model',  s.preset_vid_volcano?.model);
  iv('p-vid-goog-key',   s.preset_vid_google?.api_key);
  iv('p-vid-goog-model', s.preset_vid_google?.model);
  iv('p-vid-goog-ratio', s.preset_vid_google?.aspect_ratio);
  iv('p-vid-goog-dur',   s.preset_vid_google?.duration_seconds);
  document.getElementById('presets-overlay').classList.remove('hidden');
}

function closePresets(e) {
  if (e && e.target !== document.getElementById('presets-overlay')) return;
  document.getElementById('presets-overlay').classList.add('hidden');
}

async function savePresets() {
  const gv = id => document.getElementById(id)?.value.trim() || '';
  _settings = {
    ..._settings,
    preset_img_volcano: { api_key: gv('p-img-vol-key'), model: gv('p-img-vol-model') },
    preset_img_google:  { api_key: gv('p-img-goog-key'), model: gv('p-img-goog-model'), aspect_ratio: gv('p-img-goog-ratio'), negative_prompt: gv('p-img-goog-neg') },
    preset_vid_volcano: { api_key: gv('p-vid-vol-key'), model: gv('p-vid-vol-model') },
    preset_vid_google:  { api_key: gv('p-vid-goog-key'), model: gv('p-vid-goog-model'), aspect_ratio: gv('p-vid-goog-ratio'), duration_seconds: gv('p-vid-goog-dur') }
  };
  window._settings = _settings;
  await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(_settings) });
  closePresets();
  alert('预设已保存');
}

// ── 节点数据更新 ──────────────────────────────────────────
function updateNodeData(id, key, val) {
  if (!nodes[id].data) nodes[id].data = {};
  nodes[id].data[key] = val;
  persistState();
}

function updateNodeOutput(id, val) {
  nodes[id].output = val;
  persistState();
}

function selectImage(id, idx) {
  nodes[id].selected_image = idx;
  persistState();
  openModal(id);  // 刷新弹窗显示选中状态
}

// ── 文件上传 ──────────────────────────────────────────────
function triggerUpload(nodeId, key, accept, multi) {
  document.getElementById(`fu-${nodeId}-${key}`).click();
}

async function handleUpload(input, nodeId, key) {
  const files = Array.from(input.files);
  if (!nodes[nodeId].data) nodes[nodeId].data = {};
  const existing = nodes[nodeId].data[key] || [];
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method:'POST', body: fd });
    const d = await res.json();
    existing.push({ name: file.name, serverName: d.filename, url: d.url });
  }
  nodes[nodeId].data[key] = existing;
  persistState();
  openModal(nodeId);
}

function removeFile(nodeId, key, idx) {
  nodes[nodeId].data[key].splice(idx, 1);
  persistState();
  openModal(nodeId);
}

// ── 下载文本输出 ──────────────────────────────────────────
function downloadText(id) {
  const text = nodes[id].output || '';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type:'text/plain'}));
  a.download = `${id}_output.txt`;
  a.click();
}

// ── 清空画布 ──────────────────────────────────────────────
function clearCanvas() {
  if (!confirm('清空所有节点？')) return;
  nodes = {}; edges = [];
  canvas.innerHTML = '';
  Array.from(svgLayer.querySelectorAll('path')).forEach(p=>p.remove());
  persistState();
}

// ── 保存项目 ──────────────────────────────────────────────
async function saveProject() {
  await persistState();
  alert('项目已保存');
}

// ── LLM 调用通用函数 ──────────────────────────────────────
async function callLLM(nodeId, systemPrompt, userPrompt) {
  const node = nodes[nodeId];
  const d = node.data || {};
  const s = _settings;
  const res = await fetch('/api/llm', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      node_id:       nodeId,
      api_url:       d.api_url  || s.llm_url   || 'https://api.openai.com/v1',
      api_key:       d.api_key  || s.llm_key   || '',
      model:         d.model    || s.llm_model  || 'gpt-4o',
      system_prompt: d.system_prompt || systemPrompt,
      user_prompt:   userPrompt
    })
  });
  return await res.json();
}

// ── 分镜生成 ──────────────────────────────────────────────
async function runStoryboard(id) {
  const node = nodes[id];
  const d = node.data || {};
  // 读取上游剧本
  const scriptFiles = getUpstreamOutput(id, 'script') || d.script_files || [];
  const scriptText  = await readDocFiles(scriptFiles);
  const refText     = await readDocFiles(d.ref_docs || []);
  const userPrompt  = `【剧本内容】\n${scriptText}\n\n【分镜参考】\n${refText}\n\n【自定义要求】\n${d.custom_prompt || ''}`;
  node.status = 'running';
  renderNode(node);
  const result = await callLLM(id, DEFAULT_PROMPTS.storyboard, userPrompt);
  nodes[id] = (await fetch('/api/state').then(r=>r.json())).nodes[id] || node;
  renderNode(nodes[id]);
  if (_currentModal === id) openModal(id);
}

// ── 图片描述生成 ──────────────────────────────────────────
async function runPicPrompt(id) {
  const node = nodes[id];
  const d = node.data || {};
  // 优先从上游 Shot_Text 节点获取分镜文本
  const shotText = getUpstreamOutput(id, 'shot_text') || d.shot_text || '';
  const refText  = await readDocFiles(d.ref_docs || []);
  const userPrompt = `【分镜描述】\n${shotText}\n\n【参考文档】\n${refText}\n\n【自定义要求】\n${d.custom_prompt || ''}`;
  node.status = 'running';
  renderNode(node);
  await callLLM(id, DEFAULT_PROMPTS.pic_prompt, userPrompt);
  nodes[id] = (await fetch('/api/state').then(r=>r.json())).nodes[id] || node;
  renderNode(nodes[id]);
  if (_currentModal === id) openModal(id);
}

// ── 视频描述生成 ──────────────────────────────────────────
async function runVideoPrompt(id) {
  const node = nodes[id];
  const d = node.data || {};
  const shotText  = getUpstreamOutput(id, 'shot_text') || '';
  const picPrompts = getUpstreamOutput(id, 'pic_prompts') || '';
  const refText    = await readDocFiles(d.ref_docs || []);
  const userPrompt = `【分镜描述】\n${shotText}\n\n【图片描述】\n${picPrompts}\n\n【参考文档】\n${refText}\n\n【画幅/帧率/备注】\n${d.custom_prompt || '16:9，24fps'}`;
  node.status = 'running';
  renderNode(node);
  await callLLM(id, DEFAULT_PROMPTS.video_prompt, userPrompt);
  nodes[id] = (await fetch('/api/state').then(r=>r.json())).nodes[id] || node;
  renderNode(nodes[id]);
  if (_currentModal === id) openModal(id);
}

// ── 关键帧图片生成 ────────────────────────────────────────
async function runKeyPic(id) {
  const node = nodes[id];
  const d = node.data || {};
  const s = _settings;
  const picPrompts = getUpstreamByType(id, 'Output_Pic_ShotPrompt') || getUpstreamOutput(id, 'pic_prompts') || '';
  const parsed = extractJSON(picPrompts);
  const shots = parsed?.shots || [];
  const label = d.shot_label || '';
  const shot  = (label ? shots.find(x => x.shot_id === label) : null) || shots[0] || {};
  const prompt = shot.positive_prompt || d.custom_prompt || 'cinematic shot';
  const genMode = d.keypic_gen_mode || 'comfyui';

  node.status = 'running';
  renderNode(node);

  if (genMode === 'volcano') {
    const ps = s.preset_img_volcano || {};
    const apiKey = d.img_api_key || ps.api_key || '';
    const model  = d.img_model   || ps.model   || '';
    // 解析尺寸：custom 时用 vol_size_custom，否则用 vol_size
    const rawSize = d.vol_size === 'custom' ? (d.vol_size_custom || '') : (d.vol_size || '');
    const body = { model, prompt, response_format: d.vol_response_format || 'url', stream: false };
    if (rawSize) body.size = rawSize;
    if (d.vol_watermark) body.watermark = d.vol_watermark === 'true';
    await fetch('/api/image_gen_volcano', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_key: apiKey, body })
    });

  } else if (genMode === 'google') {
    const ps = s.preset_img_google || {};
    const apiKey = d.img_api_key || ps.api_key || '';
    const model  = d.img_model   || ps.model   || 'imagen-3.0-generate-002';
    const imgCfg = {};
    const numImg = parseInt(d.goog_num_images || ps.num_images || 1);
    if (numImg) imgCfg.number_of_images = numImg;
    if (d.goog_aspect_ratio || ps.aspect_ratio) imgCfg.aspect_ratio = d.goog_aspect_ratio || ps.aspect_ratio;
    if (d.goog_neg_prompt   || ps.negative_prompt) imgCfg.negative_prompt = d.goog_neg_prompt || ps.negative_prompt;
    if (d.goog_safety       || ps.safety_filter_level) imgCfg.safety_filter_level = d.goog_safety || ps.safety_filter_level;
    await fetch('/api/image_gen_google', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_key: apiKey, model, prompt, image_config: imgCfg })
    });

  } else if (genMode === 'api') {
    const body = {
      node_id: id,
      api_url: d.img_api_url || s.llm_url || 'https://api.openai.com/v1',
      api_key: d.img_api_key || s.llm_key || '',
      model:   d.img_model   || 'dall-e-3',
      prompt, n: 1
    };
    // img_size 留空则不发送 size
    const sz = d.img_size === 'custom' ? (d.img_size_custom || '') : (d.img_size || '');
    if (sz) body.size = sz;
    await fetch('/api/image_gen', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });

  } else {
    // ComfyUI
    let wfStr = d.workflow || JSON.stringify(DEFAULT_WORKFLOWS.txt2img);
    wfStr = wfStr
      .replace('{{positive_prompt}}', prompt)
      .replace('{{negative_prompt}}', shot.negative_prompt || 'blurry, low quality')
      .replace('{{width}}', '1920').replace('{{height}}', '1080');
    let wf;
    try { wf = JSON.parse(wfStr); } catch(e) { alert('Workflow JSON 格式错误'); return; }
    await fetch('/api/comfyui/txt2img', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, comfyui_url: d.comfyui_url || s.comfyui_url || 'http://127.0.0.1:8188', workflow: wf })
    });
  }

  nodes[id] = (await fetch('/api/state').then(r=>r.json())).nodes[id] || node;
  renderNode(nodes[id]);
  if (_currentModal === id) openModal(id);
}

// ── 镜头视频生成 ──────────────────────────────────────────
async function runVideo(id) {
  const node = nodes[id];
  const d = node.data || {};
  const s = _settings;
  const vidMode = d.vid_gen_mode || 'comfyui';

  // 按源节点类型获取，防止端口接反
  const videoPrompts = getUpstreamByType(id, 'Output_Video_ShotPrompt') || getUpstreamOutput(id, 'video_prompts') || '';
  let motionPrompt = videoPrompts;
  const parsed = extractJSON(videoPrompts);
  if (parsed?.shots) {
    const label = d.shot_label || '';
    const shot = label ? parsed.shots.find(x => x.shot_id === label) : null;
    motionPrompt = shot?.motion_prompt || '';
  }

  // 获取上游关键帧图片（按节点类型查找，防止端口接反）
  function getKeyframeUrl() {
    const edge = edges.find(e => e.target === id && nodes[e.source]?.type === 'Output_KeyPic')
               || edges.find(e => e.target === id && e.dstPort === 'keyframes');
    const kp = edge ? nodes[edge.source] : null;
    return kp?.output_images?.[kp?.selected_image ?? 0] || '';
  }
  // 判断是否有图片参考输入（角色/环境节点接入）
  function hasImageRef() {
    return edges.some(e => e.target === id && (e.dstPort === 'characters' || e.dstPort === 'env_image'));
  }

  if (!motionPrompt || !motionPrompt.trim()) {
    alert('视频提示词为空，请确认上游"视频描述生成"节点已执行并通过，且镜头编号匹配。');
    return;
  }

  node.status = 'running';
  renderNode(node);

  if (vidMode === 'volcano') {
    const ps = s.preset_vid_volcano || {};
    const apiKey = d.vid_api_key || ps.api_key || '';
    const model  = d.vid_model   || ps.model   || '';
    const imgUrl = getKeyframeUrl();
    const content = [{ type: 'text', text: motionPrompt }];
    if (imgUrl && hasImageRef()) content.push({ type: 'image_url', image_url: { url: imgUrl } });
    await fetch('/api/video_gen_volcano', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_key: apiKey, model, content })
    });

  } else if (vidMode === 'google') {
    const ps = s.preset_vid_google || {};
    const apiKey = d.vid_api_key || ps.api_key || '';
    const model  = d.vid_model   || ps.model   || 'veo-3.1-generate-preview';
    const genCfg = {};
    if (ps.aspect_ratio || d.vid_aspect_ratio) genCfg.aspectRatio = d.vid_aspect_ratio || ps.aspect_ratio;
    if (ps.duration_seconds || d.vid_duration) genCfg.durationSeconds = parseInt(d.vid_duration || ps.duration_seconds || 8);
    const imgUrl = getKeyframeUrl();
    if (imgUrl && hasImageRef()) {
      // 需要后端将 URL 转为 base64
      genCfg.referenceImageUrl = imgUrl;
    }
    await fetch('/api/video_gen_google', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_key: apiKey, model, prompt: motionPrompt, generation_config: genCfg })
    });

  } else if (vidMode === 'comfyui') {
    const imgUrl = getKeyframeUrl();
    let wfStr = d.workflow || JSON.stringify(DEFAULT_WORKFLOWS.img2vid);
    wfStr = wfStr.replace('{{motion_prompt}}', motionPrompt).replace('{{image_url}}', imgUrl);
    let wf;
    try { wf = JSON.parse(wfStr); } catch(e) { alert('Workflow JSON 格式错误'); return; }
    await fetch('/api/comfyui/img2vid', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, comfyui_url: d.comfyui_url || s.comfyui_url || 'http://127.0.0.1:8188', workflow: wf })
    });

  } else if (vidMode === 'api_img') {
    await fetch('/api/video_gen', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_url: d.vid_api_url || '', api_key: d.vid_api_key || s.llm_key || '', model: d.vid_model || '', prompt: motionPrompt, image_url: getKeyframeUrl(), mode: 'img2vid' })
    });

  } else {
    await fetch('/api/video_gen', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ node_id: id, api_url: d.vid_api_url || '', api_key: d.vid_api_key || s.llm_key || '', model: d.vid_model || '', prompt: motionPrompt, mode: 'txt2vid' })
    });
  }

  nodes[id] = (await fetch('/api/state').then(r=>r.json())).nodes[id] || node;
  renderNode(nodes[id]);
  if (_currentModal === id) openModal(id);
}
