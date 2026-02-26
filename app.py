"""
AI Film Studio - 后端主程序
运行方式: python app.py
"""
import os, json, uuid, time, traceback
from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS

app = Flask(__name__, static_folder='static')
CORS(app)

# ── 目录初始化 ──────────────────────────────────────────────
CACHE_DIR = 'cache'
UPLOAD_DIR = os.path.join(CACHE_DIR, 'uploads')
for d in [CACHE_DIR, UPLOAD_DIR]:
    os.makedirs(d, exist_ok=True)

# ── 项目状态（内存存储，重启后从文件恢复）──────────────────
STATE_FILE = os.path.join(CACHE_DIR, 'project_state.json')

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {'nodes': {}, 'edges': [], 'settings': {}}

def save_state(state):
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

project_state = load_state()

# ── 静态页面 ────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

# ── 项目状态 API ────────────────────────────────────────────
@app.route('/api/state', methods=['GET'])
def get_state():
    return jsonify(project_state)

@app.route('/api/state', methods=['POST'])
def set_state():
    global project_state
    project_state = request.json
    save_state(project_state)
    return jsonify({'ok': True})

# ── 节点操作 API ────────────────────────────────────────────
@app.route('/api/node/<node_id>', methods=['PATCH'])
def patch_node(node_id):
    """更新节点部分字段（状态、输出内容等）"""
    node = project_state['nodes'].get(node_id)
    if not node:
        return jsonify({'error': 'node not found'}), 404
    node.update(request.json)
    # 若节点被刷新，使下游节点失效
    if request.json.get('status') == 'idle':
        _invalidate_downstream(node_id)
    save_state(project_state)
    return jsonify(node)

def _invalidate_downstream(node_id):
    """递归将下游节点置为 idle（失效）"""
    for edge in project_state.get('edges', []):
        if edge['source'] == node_id:
            target = project_state['nodes'].get(edge['target'])
            if target and target.get('status') not in ('idle',):
                target['status'] = 'idle'
                target['output'] = None
                _invalidate_downstream(edge['target'])

# ── 文件上传 API ────────────────────────────────────────────
@app.route('/api/upload', methods=['POST'])
def upload_file():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'no file'}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    name = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(UPLOAD_DIR, name)
    f.save(path)
    return jsonify({'filename': name, 'url': f'/api/file/{name}'})

@app.route('/api/file/<filename>')
def get_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)

# ── 文档读取 API ────────────────────────────────────────────
@app.route('/api/read_doc', methods=['POST'])
def read_doc():
    """读取上传的 docx/txt 文件内容"""
    filename = request.json.get('filename')
    path = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(path):
        return jsonify({'error': 'file not found'}), 404
    ext = os.path.splitext(filename)[1].lower()
    if ext == '.txt':
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
    elif ext == '.docx':
        from docx import Document
        doc = Document(path)
        text = '\n'.join(p.text for p in doc.paragraphs)
    else:
        return jsonify({'error': 'unsupported format'}), 400
    return jsonify({'text': text})

# ── LLM 调用 API ────────────────────────────────────────────
@app.route('/api/llm', methods=['POST'])
def call_llm():
    """
    通用 LLM 调用接口
    body: { api_url, api_key, model, system_prompt, user_prompt, node_id }
    """
    import requests as req
    data = request.json
    node_id = data.get('node_id')

    # 更新节点状态为运行中
    if node_id and node_id in project_state['nodes']:
        project_state['nodes'][node_id]['status'] = 'running'
        save_state(project_state)

    try:
        headers = {
            'Authorization': f"Bearer {data['api_key']}",
            'Content-Type': 'application/json'
        }
        payload = {
            'model': data.get('model', 'gpt-4o'),
            'messages': [
                {'role': 'system', 'content': data.get('system_prompt', '')},
                {'role': 'user',   'content': data.get('user_prompt', '')}
            ],
            'temperature': data.get('temperature', 0.7)
        }
        resp = req.post(
            data['api_url'].rstrip('/') + '/chat/completions',
            headers=headers, json=payload, timeout=120
        )
        resp.raise_for_status()
        result_text = resp.json()['choices'][0]['message']['content']

        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'done'
            project_state['nodes'][node_id]['output'] = result_text
            save_state(project_state)

        return jsonify({'ok': True, 'text': result_text})

    except Exception as e:
        err = traceback.format_exc()
        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'error'
            project_state['nodes'][node_id]['error_log'] = err
            save_state(project_state)
        return jsonify({'ok': False, 'error': str(e), 'log': err}), 500

# ── ComfyUI 图片生成 API ────────────────────────────────────
@app.route('/api/comfyui/txt2img', methods=['POST'])
def comfyui_txt2img():
    """
    调用 ComfyUI 文生图
    body: { comfyui_url, workflow, node_id }
    workflow 为 ComfyUI API 格式的 JSON
    """
    import requests as req
    data = request.json
    node_id = data.get('node_id')
    comfyui_url = data.get('comfyui_url', 'http://127.0.0.1:8188')

    if node_id and node_id in project_state['nodes']:
        project_state['nodes'][node_id]['status'] = 'running'
        save_state(project_state)

    try:
        # 提交工作流
        prompt_id = str(uuid.uuid4())
        resp = req.post(f'{comfyui_url}/prompt', json={
            'prompt': data['workflow'],
            'client_id': prompt_id
        }, timeout=30)
        resp.raise_for_status()
        pid = resp.json().get('prompt_id')

        # 轮询等待完成（最多等 5 分钟）
        for _ in range(300):
            time.sleep(1)
            hist = req.get(f'{comfyui_url}/history/{pid}', timeout=10).json()
            if pid in hist:
                outputs = hist[pid].get('outputs', {})
                images = []
                for node_out in outputs.values():
                    for img in node_out.get('images', []):
                        # 下载图片并缓存
                        img_resp = req.get(
                            f"{comfyui_url}/view?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}",
                            timeout=30
                        )
                        fname = f"{uuid.uuid4().hex}.png"
                        fpath = os.path.join(UPLOAD_DIR, fname)
                        with open(fpath, 'wb') as f:
                            f.write(img_resp.content)
                        images.append(f'/api/file/{fname}')

                if node_id and node_id in project_state['nodes']:
                    n = project_state['nodes'][node_id]
                    # 最多保留3张图片防止爆显存
                    existing = n.get('output_images', [])
                    n['output_images'] = (existing + images)[-3:]
                    n['status'] = 'done'
                    save_state(project_state)
                return jsonify({'ok': True, 'images': images})

        raise TimeoutError('ComfyUI 生成超时')

    except Exception as e:
        err = traceback.format_exc()
        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'error'
            project_state['nodes'][node_id]['error_log'] = err
            save_state(project_state)
        return jsonify({'ok': False, 'error': str(e), 'log': err}), 500

# ── ComfyUI 图生视频 API ────────────────────────────────────
@app.route('/api/comfyui/img2vid', methods=['POST'])
def comfyui_img2vid():
    """
    调用 ComfyUI 图生视频
    body: { comfyui_url, workflow, node_id }
    """
    import requests as req
    data = request.json
    node_id = data.get('node_id')
    comfyui_url = data.get('comfyui_url', 'http://127.0.0.1:8188')

    if node_id and node_id in project_state['nodes']:
        project_state['nodes'][node_id]['status'] = 'running'
        save_state(project_state)

    try:
        prompt_id = str(uuid.uuid4())
        resp = req.post(f'{comfyui_url}/prompt', json={
            'prompt': data['workflow'],
            'client_id': prompt_id
        }, timeout=30)
        resp.raise_for_status()
        pid = resp.json().get('prompt_id')

        for _ in range(600):  # 视频生成等待更长
            time.sleep(1)
            hist = req.get(f'{comfyui_url}/history/{pid}', timeout=10).json()
            if pid in hist:
                outputs = hist[pid].get('outputs', {})
                videos = []
                for node_out in outputs.values():
                    for vid in node_out.get('gifs', []) + node_out.get('videos', []):
                        vid_resp = req.get(
                            f"{comfyui_url}/view?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}",
                            timeout=60
                        )
                        ext = os.path.splitext(vid['filename'])[1] or '.mp4'
                        fname = f"{uuid.uuid4().hex}{ext}"
                        fpath = os.path.join(UPLOAD_DIR, fname)
                        with open(fpath, 'wb') as f:
                            f.write(vid_resp.content)
                        videos.append(f'/api/file/{fname}')

                if node_id and node_id in project_state['nodes']:
                    project_state['nodes'][node_id]['output_videos'] = videos
                    project_state['nodes'][node_id]['status'] = 'done'
                    save_state(project_state)
                return jsonify({'ok': True, 'videos': videos})

        raise TimeoutError('ComfyUI 视频生成超时')

    except Exception as e:
        err = traceback.format_exc()
        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'error'
            project_state['nodes'][node_id]['error_log'] = err
            save_state(project_state)
        return jsonify({'ok': False, 'error': str(e), 'log': err}), 500

# ── 图片生成 API（兼容 OpenAI images/generations）──────────
@app.route('/api/image_gen', methods=['POST'])
def image_gen():
    """
    调用图片生成模型（OpenAI DALL-E 或兼容接口）
    body: { api_url, api_key, model, prompt, size, n, node_id }
    """
    import requests as req
    data = request.json
    node_id = data.get('node_id')

    if node_id and node_id in project_state['nodes']:
        project_state['nodes'][node_id]['status'] = 'running'
        save_state(project_state)

    try:
        headers = {
            'Authorization': f"Bearer {data['api_key']}",
            'Content-Type': 'application/json'
        }
        payload = {
            'model':  data.get('model', 'dall-e-3'),
            'prompt': data.get('prompt', ''),
            'n':      data.get('n', 1),
            'size':   data.get('size', '1024x1024'),
            'response_format': 'url'
        }
        resp = req.post(
            data['api_url'].rstrip('/') + '/images/generations',
            headers=headers, json=payload, timeout=120
        )
        resp.raise_for_status()
        result_data = resp.json().get('data', [])

        # 下载图片并缓存到本地
        images = []
        for item in result_data:
            img_url = item.get('url') or item.get('b64_json')
            if item.get('b64_json'):
                import base64
                img_bytes = base64.b64decode(item['b64_json'])
            else:
                img_bytes = req.get(img_url, timeout=60).content
            fname = f"{uuid.uuid4().hex}.png"
            fpath = os.path.join(UPLOAD_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(img_bytes)
            images.append(f'/api/file/{fname}')

        if node_id and node_id in project_state['nodes']:
            n = project_state['nodes'][node_id]
            existing = n.get('output_images', [])
            n['output_images'] = (existing + images)[-3:]
            n['status'] = 'done'
            save_state(project_state)

        return jsonify({'ok': True, 'images': images})

    except Exception as e:
        err = traceback.format_exc()
        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'error'
            project_state['nodes'][node_id]['error_log'] = err
            save_state(project_state)
        return jsonify({'ok': False, 'error': str(e), 'log': err}), 500

# ── 外部视频生成 API ────────────────────────────────────────
@app.route('/api/video_gen', methods=['POST'])
def video_gen():
    """
    调用外部视频生成 API（图生视频 或 纯文本生视频）
    body: { api_url, api_key, model, prompt, image_url(可选), mode, node_id }
    接口约定（OpenAI 兼容风格）：
      POST {api_url}/videos/generations
      返回 { data: [{ url: "..." }] } 或 { url: "..." }
    """
    import requests as req
    data = request.json
    node_id = data.get('node_id')

    if node_id and node_id in project_state['nodes']:
        project_state['nodes'][node_id]['status'] = 'running'
        save_state(project_state)

    try:
        headers = {
            'Authorization': f"Bearer {data.get('api_key', '')}",
            'Content-Type': 'application/json'
        }
        payload = {
            'model':  data.get('model', ''),
            'prompt': data.get('prompt', ''),
        }
        if data.get('mode') == 'img2vid' and data.get('image_url'):
            payload['image_url'] = data['image_url']

        resp = req.post(
            data['api_url'].rstrip('/') + '/videos/generations',
            headers=headers, json=payload, timeout=300
        )
        resp.raise_for_status()
        resp_json = resp.json()

        # 兼容多种返回格式
        video_url = None
        if 'data' in resp_json and resp_json['data']:
            video_url = resp_json['data'][0].get('url')
        elif 'url' in resp_json:
            video_url = resp_json['url']

        videos = []
        if video_url:
            vid_bytes = req.get(video_url, timeout=120).content
            fname = f"{uuid.uuid4().hex}.mp4"
            fpath = os.path.join(UPLOAD_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(vid_bytes)
            videos.append(f'/api/file/{fname}')

        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['output_videos'] = videos
            project_state['nodes'][node_id]['status'] = 'done'
            save_state(project_state)

        return jsonify({'ok': True, 'videos': videos})

    except Exception as e:
        err = traceback.format_exc()
        if node_id and node_id in project_state['nodes']:
            project_state['nodes'][node_id]['status'] = 'error'
            project_state['nodes'][node_id]['error_log'] = err
            save_state(project_state)
        return jsonify({'ok': False, 'error': str(e), 'log': err}), 500

# ── 设置 API ────────────────────────────────────────────────
@app.route('/api/settings', methods=['GET', 'POST'])
def settings():
    if request.method == 'GET':
        return jsonify(project_state.get('settings', {}))
    project_state['settings'] = request.json
    save_state(project_state)
    return jsonify({'ok': True})

if __name__ == '__main__':
    print("=" * 50)
    print("AI Film Studio 启动成功！")
    print("请在浏览器打开: http://127.0.0.1:5000")
    print("=" * 50)
    app.run(debug=True, port=5000)
