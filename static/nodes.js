/**
 * nodes.js - 节点类型定义 & 节点弹窗渲染
 */

// 节点类型配置表
const NODE_TYPES = {
  Input_Character: {
    label: '🧑 角色输入',
    color: '#1a3a5c',
    ports: { in: [], out: ['characters'] },
    desc: '载入本场角色图片（以角色名命名）'
  },
  Input_Env: {
    label: '🌄 环境输入',
    color: '#1a3a2a',
    ports: { in: [], out: ['env_image'] },
    desc: '载入本场环境图片（可选）'
  },
  Input_Script: {
    label: '📄 剧本输入',
    color: '#3a2a1a',
    ports: { in: [], out: ['script'] },
    desc: '载入总剧本文件（docx/txt）'
  },
  Output_Storyboard: {
    label: '🎬 分镜生成',
    color: '#2a1a3a',
    ports: { in: ['script'], out: ['storyboard'] },
    desc: '根据剧本生成分镜脚本'
  },
  Shot_Text: {
    label: '📝 分镜文本',
    color: '#1a2a4a',
    ports: { in: [], out: ['shot_text'] },
    desc: '单镜头分镜描述（可编辑）'
  },
  Output_Pic_ShotPrompt: {
    label: '🖼 图片描述生成',
    color: '#1a2a3a',
    ports: { in: ['shot_text'], out: ['pic_prompts'] },
    desc: '生成每个镜头的图片Prompt'
  },
  Output_Video_ShotPrompt: {
    label: '🎥 视频描述生成',
    color: '#2a1a2a',
    ports: { in: ['shot_text', 'pic_prompts'], out: ['video_prompts'] },
    desc: '生成每个镜头的图生视频Prompt'
  },
  Output_KeyPic: {
    label: '🖼 关键帧生成',
    color: '#1a3a1a',
    ports: { in: ['characters', 'pic_prompts'], out: ['keyframes'] },
    desc: '生成镜头首帧/首尾帧图片'
  },
  Output_Video: {
    label: '🎞 镜头视频生成',
    color: '#3a1a1a',
    ports: { in: ['keyframes', 'video_prompts'], out: ['video'] },
    desc: '图片转视频，输出镜头视频'
  }
};

// 状态文字映射
const STATUS_LABEL = {
  idle: '未执行', running: '生成中', done: '待审核', approved: '已通过', error: '执行失败'
};
const STATUS_BADGE = {
  idle: 'badge-idle', running: 'badge-running', done: 'badge-done',
  approved: 'badge-approved', error: 'badge-error'
};

// ── 渲染节点弹窗内容 ──────────────────────────────────────
function renderModalBody(node) {
  const type = node.type;
  const data = node.data || {};
  const settings = window._settings || {};
  let html = '';

  // 输入节点：文件上传区
  if (type === 'Input_Character') {
    html += fileUploadSection(node, 'characters', '角色图片', 'image/*', true);
  } else if (type === 'Input_Env') {
    html += fileUploadSection(node, 'env_images', '环境图片', 'image/*', true);
  } else if (type === 'Input_Script') {
    html += fileUploadSection(node, 'script_files', '剧本文件', '.txt,.docx', false);
  }

  // 分镜生成节点
  if (type === 'Output_Storyboard') {
    html += fileUploadSection(node, 'ref_docs', '分镜参考文档（可选）', '.txt,.docx', false);
    html += textareaSection(node, 'custom_prompt', '自定义要求（场次/风格/备注）',
      '例如：生成第一场，风格写实，镜头语言参考《教父》');
    html += apiConfigSection(node, settings);
    html += systemPromptSection(node, DEFAULT_PROMPTS.storyboard);
    html += outputSection(node);
    html += runButton(node, 'runStoryboard');
  }

  // 分镜纯文本节点（可编辑单镜头）
  if (type === 'Shot_Text') {
    const shotText = data.shot_text || '';
    html += `<div class="modal-section">
      <label>镜头编号</label>
      <input type="text" value="${data.shot_label || ''}" placeholder="例如：1_1"
        onchange="updateNodeData('${node.id}','shot_label',this.value)">
    </div>
    <div class="modal-section">
      <label>分镜描述（可直接编辑）</label>
      <textarea style="min-height:160px" onchange="updateNodeData('${node.id}','shot_text',this.value)">${shotText}</textarea>
    </div>`;
    html += `<button class="run-btn" onclick="approveShotText('${node.id}')">✔ 确认此分镜</button>`;
  }

  if (type === 'Output_Pic_ShotPrompt') {
    html += fileUploadSection(node, 'ref_docs', '图片描述参考文档（可选）', '.txt,.docx', false);
    html += textareaSection(node, 'custom_prompt', '自定义要求（风格/备注）', '');
    html += `<div class="modal-section">
      <label>图片尺寸（16:9）</label>
      <select onchange="updateNodeData('${node.id}','img_size',this.value)" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
        <option value="1920x1080" ${(data.img_size||'1920x1080')==='1920x1080'?'selected':''}>1920×1080（FHD）</option>
        <option value="1280x720"  ${data.img_size==='1280x720'?'selected':''}>1280×720（HD）</option>
        <option value="3840x2160" ${data.img_size==='3840x2160'?'selected':''}>3840×2160（4K）</option>
      </select>
    </div>`;
    html += apiConfigSection(node, settings);
    html += systemPromptSection(node, DEFAULT_PROMPTS.pic_prompt);
    html += outputSection(node);
    html += runButton(node, 'runPicPrompt');
  }

  if (type === 'Output_Video_ShotPrompt') {
    html += fileUploadSection(node, 'ref_docs', '视频描述参考文档（可选）', '.txt,.docx', false);
    html += textareaSection(node, 'custom_prompt', '画幅比/帧率/备注', '例如：16:9，24fps');
    html += apiConfigSection(node, settings);
    html += systemPromptSection(node, DEFAULT_PROMPTS.video_prompt);
    html += outputSection(node);
    html += runButton(node, 'runVideoPrompt');
  }

  if (type === 'Output_KeyPic') {
    const genMode = data.keypic_gen_mode || 'comfyui';
    html += `<div class="modal-section">
      <label>生成模式</label>
      <select onchange="updateNodeData('${node.id}','keypic_mode',this.value)" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
        <option value="first" ${(data.keypic_mode||'first')==='first'?'selected':''}>仅首帧</option>
        <option value="both" ${data.keypic_mode==='both'?'selected':''}>首尾帧</option>
      </select>
    </div>
    <div class="modal-section">
      <label>图片比例</label>
      <select onchange="updateNodeData('${node.id}','keypic_ratio',this.value)" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
        <option value="16:9" ${(data.keypic_ratio||'16:9')==='16:9'?'selected':''}>16:9（横屏）</option>
        <option value="9:16" ${data.keypic_ratio==='9:16'?'selected':''}>9:16（竖屏）</option>
      </select>
    </div>
    <div class="modal-section">
      <label>图片生成方式</label>
      <select onchange="updateNodeData('${node.id}','keypic_gen_mode',this.value);openModal('${node.id}')" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
        <option value="comfyui" ${genMode==='comfyui'?'selected':''}>ComfyUI（本地）</option>
        <option value="api" ${genMode==='api'?'selected':''}>图片生成 API（DALL-E 等）</option>
      </select>
    </div>`;
    html += textareaSection(node, 'shot_label', '镜头编号（m_n）', '例如：1_1');
    if (genMode === 'api') {
      html += imageApiConfigSection(node, settings);
    } else {
      html += comfyConfigSection(node, settings);
      html += workflowSection(node, DEFAULT_WORKFLOWS.txt2img);
    }
    html += imageOutputSection(node);
    html += runButton(node, 'runKeyPic');
  }

  if (type === 'Output_Video') {
    const vidMode = data.vid_gen_mode || 'comfyui';
    html += textareaSection(node, 'shot_label', '镜头编号（m_n）', '例如：1_1');
    html += `<div class="modal-section">
      <label>视频生成方式</label>
      <select onchange="updateNodeData('${node.id}','vid_gen_mode',this.value);openModal('${node.id}')" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
        <option value="comfyui"  ${vidMode==='comfyui'?'selected':''}>ComfyUI（图生视频）</option>
        <option value="api_img"  ${vidMode==='api_img'?'selected':''}>外部API（图生视频）</option>
        <option value="api_text" ${vidMode==='api_text'?'selected':''}>外部API（纯文本生视频）</option>
      </select>
    </div>`;
    if (vidMode === 'comfyui') {
      html += comfyConfigSection(node, settings);
      html += workflowSection(node, DEFAULT_WORKFLOWS.img2vid);
    } else {
      html += `<div class="modal-section">
        <label>视频生成 API 地址</label>
        <input type="text" value="${data.vid_api_url||''}" placeholder="https://api.example.com/v1/video"
          onchange="updateNodeData('${node.id}','vid_api_url',this.value)">
        <label style="margin-top:6px">API Key</label>
        <input type="password" value="${data.vid_api_key||''}" placeholder="留空使用全局设置"
          onchange="updateNodeData('${node.id}','vid_api_key',this.value)">
        <label style="margin-top:6px">模型名</label>
        <input type="text" value="${data.vid_model||''}" placeholder="例如：wan-2.1"
          onchange="updateNodeData('${node.id}','vid_model',this.value)">
      </div>`;
    }
    html += videoOutputSection(node);
    html += runButton(node, 'runVideo');
  }

  return html;
}

// ── 通用 UI 片段 ──────────────────────────────────────────
function fileUploadSection(node, key, label, accept, multi) {
  const files = (node.data || {})[key] || [];
  const listHtml = files.map((f, i) => `
    <div class="file-item">
      <span title="${f.name}">${f.name}</span>
      <button onclick="removeFile('${node.id}','${key}',${i})">✕</button>
    </div>`).join('');
  return `<div class="modal-section">
    <label>${label}</label>
    <div class="file-upload-area" onclick="triggerUpload('${node.id}','${key}','${accept}',${multi})">
      点击上传${multi ? '（可多选）' : ''}
      <input type="file" id="fu-${node.id}-${key}" accept="${accept}" ${multi ? 'multiple' : ''}
        style="display:none" onchange="handleUpload(this,'${node.id}','${key}')">
    </div>
    <div class="file-list">${listHtml}</div>
  </div>`;
}

function textareaSection(node, key, label, placeholder) {
  const val = (node.data || {})[key] || '';
  return `<div class="modal-section">
    <label>${label}</label>
    <textarea placeholder="${placeholder}"
      onchange="updateNodeData('${node.id}','${key}',this.value)">${val}</textarea>
  </div>`;
}

function apiConfigSection(node, settings) {
  const d = node.data || {};
  return `<div class="modal-section">
    <label>API 地址（留空使用全局设置）</label>
    <input type="text" value="${d.api_url || ''}" placeholder="${settings.llm_url || 'https://api.openai.com/v1'}"
      onchange="updateNodeData('${node.id}','api_url',this.value)">
    <label style="margin-top:6px">API Key（留空使用全局设置）</label>
    <input type="password" value="${d.api_key || ''}" placeholder="留空使用全局设置"
      onchange="updateNodeData('${node.id}','api_key',this.value)">
    <label style="margin-top:6px">模型名</label>
    <input type="text" value="${d.model || ''}" placeholder="${settings.llm_model || 'gpt-4o'}"
      onchange="updateNodeData('${node.id}','model',this.value)">
  </div>`;
}

function imageApiConfigSection(node, settings) {
  const d = node.data || {};
  return `<div class="modal-section">
    <label>API 地址（留空使用全局设置）</label>
    <input type="text" value="${d.img_api_url || ''}" placeholder="${settings.llm_url || 'https://api.openai.com/v1'}"
      onchange="updateNodeData('${node.id}','img_api_url',this.value)">
    <label style="margin-top:6px">API Key（留空使用全局设置）</label>
    <input type="password" value="${d.img_api_key || ''}" placeholder="留空使用全局设置"
      onchange="updateNodeData('${node.id}','img_api_key',this.value)">
    <label style="margin-top:6px">模型名</label>
    <input type="text" value="${d.img_model || ''}" placeholder="dall-e-3"
      onchange="updateNodeData('${node.id}','img_model',this.value)">
    <label style="margin-top:6px">图片尺寸</label>
    <select onchange="updateNodeData('${node.id}','img_size',this.value)" style="width:100%;padding:6px;background:#0f3460;border:1px solid #1a4a8a;border-radius:4px;color:#fff">
      <option value="1024x1024" ${(d.img_size||'1024x1024')==='1024x1024'?'selected':''}>1024×1024</option>
      <option value="1792x1024" ${d.img_size==='1792x1024'?'selected':''}>1792×1024（横）</option>
      <option value="1024x1792" ${d.img_size==='1024x1792'?'selected':''}>1024×1792（竖）</option>
    </select>
  </div>`;
}

function comfyConfigSection(node, settings) {
  const d = node.data || {};
  return `<div class="modal-section">
    <label>ComfyUI 地址（留空使用全局设置）</label>
    <input type="text" value="${d.comfyui_url || ''}" placeholder="${settings.comfyui_url || 'http://127.0.0.1:8188'}"
      onchange="updateNodeData('${node.id}','comfyui_url',this.value)">
  </div>`;
}

function systemPromptSection(node, defaultPrompt) {
  const val = (node.data || {}).system_prompt || defaultPrompt;
  return `<div class="modal-section">
    <label>系统提示词（System Prompt）</label>
    <textarea style="min-height:100px" onchange="updateNodeData('${node.id}','system_prompt',this.value)">${val}</textarea>
  </div>`;
}

function workflowSection(node, defaultWf) {
  const val = (node.data || {}).workflow || JSON.stringify(defaultWf, null, 2);
  return `<div class="modal-section">
    <label>ComfyUI Workflow JSON</label>
    <textarea style="min-height:120px;font-family:monospace;font-size:11px"
      onchange="updateNodeData('${node.id}','workflow',this.value)">${val}</textarea>
  </div>`;
}

function outputSection(node) {
  const out = node.output || '';
  if (!out) return '';
  return `<div class="modal-section">
    <label>输出内容 <button class="download-btn" onclick="downloadText('${node.id}')">⬇ 下载</button></label>
    <textarea id="out-${node.id}" style="min-height:120px" onchange="updateNodeOutput('${node.id}',this.value)">${out}</textarea>
  </div>`;
}

function imageOutputSection(node) {
  const imgs = node.output_images || [];
  if (!imgs.length) return '';
  const imgHtml = imgs.map((url, i) =>
    `<div style="position:relative;display:inline-block">
      <img src="${url}" onclick="selectImage('${node.id}',${i})" class="${node.selected_image===i?'selected-img':''}">
      <a href="${url}" download style="position:absolute;bottom:2px;right:2px;background:#0009;color:#fff;font-size:10px;padding:2px 4px;border-radius:3px;text-decoration:none">⬇</a>
    </div>`
  ).join('');
  return `<div class="modal-section">
    <label>生成图片（最多3张，点击选择使用的帧）</label>
    <div class="modal-img-list">${imgHtml}</div>
  </div>`;
}

function videoOutputSection(node) {
  const vids = node.output_videos || [];
  if (!vids.length) return '';
  return `<div class="modal-section">
    <label>生成视频 <a href="${vids[0]}" download class="download-btn">⬇ 下载</a></label>
    <div class="modal-video-list"><video src="${vids[0]}" controls></video></div>
  </div>`;
}

function runButton(node, fnName) {
  const running = node.status === 'running';
  return `<button class="run-btn" ${running ? 'disabled' : ''} onclick="${fnName}('${node.id}')">
    ${running ? '⏳ 生成中...' : '▶ 执行生成'}
  </button>`;
}

// ── 默认系统提示词 ────────────────────────────────────────
const DEFAULT_PROMPTS = {
  storyboard: `你是专业的影视分镜师。根据提供的剧本，生成详细的分镜脚本。
必须以JSON格式输出，结构如下：
{"shots":[{"shot_id":"1_1","scene":"场景描述","action":"动作描述","camera":"镜头运动","dialogue":"台词","duration":"时长(秒)"}]}
只输出JSON，不要其他内容。`,

  pic_prompt: `你是专业的AI图片提示词工程师。根据分镜脚本，为每个镜头生成图片生成提示词。
必须以JSON格式输出：
{"shots":[{"shot_id":"1_1","positive_prompt":"英文正向提示词","negative_prompt":"英文负向提示词","style":"风格描述"}]}
只输出JSON，不要其他内容。`,

  video_prompt: `你是专业的AI视频提示词工程师。根据分镜和图片描述，生成图生视频提示词。
必须以JSON格式输出：
{"shots":[{"shot_id":"1_1","motion_prompt":"英文动作提示词","camera_motion":"镜头运动","aspect_ratio":"16:9","fps":24}]}
只输出JSON，不要其他内容。`
};

// ── 默认 ComfyUI Workflow 模板（占位，用户需替换为自己的）──
const DEFAULT_WORKFLOWS = {
  txt2img: {
    "3": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "v1-5-pruned-emaonly.ckpt"}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{positive_prompt}}", "clip": ["4", 1]}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative_prompt}}", "clip": ["4", 1]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "film_studio", "images": ["8", 0]}}
  },
  img2vid: {
    "_comment": "请替换为你的 ComfyUI 图生视频 Workflow JSON"
  }
};
