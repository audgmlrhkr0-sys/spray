(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const DRIP_SPEED = 1.4;
  const DRIP_WOBBLE = 1.5;
  const STORAGE_KEY = 'spray-canvas-data';

  let width = 0;
  let height = 0;
  let isDrawing = false;
  let currentPath = [];
  let activePointerId = null;

  // 스프레이 한 줄 = 물감 얼룩 하나 + 그 안에 글자
  const strokes = [];
  // 벽에 맺혀서 주르륵 흐르는 줄 (시작점 고정, 아래로만 길어짐)
  const wallDrips = [];

  let cameraPath = [];
  let cameraFingerVisible = false;
  let cameraVideo = null;
  let cameraPreviewEl = null;
  let handsInstance = null;
  let cameraStream = null;
  let cameraDetectionRunning = false;
  let cameraDetectionInterval = null;
  let cameraFingerTargetX = 0;
  let cameraFingerTargetY = 0;
  let cameraFingerSmoothedX = 0;
  let cameraFingerSmoothedY = 0;
  let cameraFingerSmoothFactor = 0.28;
  const CAMERA_DETECT_INTERVAL_MS = 150;

  function saveToStorage() {
    if (width < 10 || height < 10) return;
    const savedWidth = width;
    const savedHeight = height;
    const strokesData = strokes.map(s => {
      const pathNorm = s.pathNorm || (s.path && s.path.map(p => ({ x: p.x / savedWidth, y: p.y / savedHeight })));
      if (!pathNorm || !pathNorm.length) return null;
      return {
        pathNorm: pathNorm.slice(),
        sprayColor: s.sprayColor,
        thickness: s.thickness,
        text: s.text,
        textSize: s.textSize,
        textColor: s.textColor,
        numChars: s.numChars,
        totalLen: s.totalLen
      };
    }).filter(Boolean);
    const dripsData = wallDrips.map(d => ({
      startXNorm: d.startXNorm,
      startYNorm: d.startYNorm,
      color: d.color,
      points: d.points.slice(),
      thick: d.thick,
      alpha: d.alpha,
      maxLengthNorm: d.maxLengthNorm
    }));
    let payload;
    try {
      payload = JSON.stringify({ savedWidth, savedHeight, strokes: strokesData, wallDrips: dripsData });
    } catch (e) { return; }
    try {
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {
      try { sessionStorage.setItem(STORAGE_KEY, payload); } catch (e2) {}
    }
  }

  function loadFromStorage() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
    } catch (e) { return; }
    if (!data || typeof data !== 'object') return;
    if (data.strokes && Array.isArray(data.strokes)) {
      data.strokes.forEach(function (s) {
        var pathNorm = s.pathNorm || s.path;
        if (!pathNorm || !pathNorm.length) return;
        strokes.push({
          pathNorm: pathNorm,
          sprayColor: s.sprayColor || '#e74c3c',
          thickness: s.thickness || 32,
          text: s.text || 'oh',
          textSize: s.textSize || 28,
          textColor: s.textColor || '#3498db',
          numChars: Math.max(1, s.numChars || 1),
          totalLen: s.totalLen || 0
        });
      });
    }
    if (data.wallDrips && Array.isArray(data.wallDrips)) {
      data.wallDrips.forEach(function (o) {
        var d = new WallDrip(0, 0, o.color || '#e74c3c', 1, 1);
        d.startXNorm = Number(o.startXNorm);
        d.startYNorm = Number(o.startYNorm);
        d.points = Array.isArray(o.points) ? o.points.slice() : [];
        d.thick = o.thick != null ? Number(o.thick) : 4;
        d.alpha = o.alpha != null ? Number(o.alpha) : 0.88;
        d.maxLengthNorm = o.maxLengthNorm != null ? Number(o.maxLengthNorm) : 0.5;
        if (d.points.length > 0) {
          var last = d.points[d.points.length - 1];
          d.curYNorm = last.y;
          d.curXNorm = last.x;
        } else {
          d.curYNorm = d.startYNorm;
          d.curXNorm = d.startXNorm;
        }
        wallDrips.push(d);
      });
    }
  }

  function resize() {
    width = canvas.width = Math.max(1, canvas.offsetWidth || 800);
    height = canvas.height = Math.max(1, canvas.offsetHeight || 600);
  }

  function getCanvasPoint(e) {
    return getCanvasPointFromClient(e.clientX, e.clientY);
  }

  function getCanvasPointFromClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  // 경로의 총 길이
  function pathLength(path) {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    }
    return len;
  }

  // 경로 위에서 거리 d인 지점의 좌표
  function pointAtDistance(path, d) {
    if (path.length === 0) return null;
    if (path.length === 1 || d <= 0) return { x: path[0].x, y: path[0].y };
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      if (acc + seg >= d) {
        const t = (d - acc) / seg;
        return {
          x: path[i - 1].x + t * (path[i].x - path[i - 1].x),
          y: path[i - 1].y + t * (path[i].y - path[i - 1].y)
        };
      }
      acc += seg;
    }
    return { x: path[path.length - 1].x, y: path[path.length - 1].y };
  }

  // ——— 벽에 맺혀서 주르륵 흐르는 줄 (좌표는 비율 0~1로 저장해서 리사이즈 후에도 안 사라짐) ———
  class WallDrip {
    constructor(startX, startY, color, w, h) {
      this.startXNorm = startX / w;
      this.startYNorm = startY / h;
      this.color = color;
      this.points = [];
      this.curYNorm = startY / h;
      this.curXNorm = startX / w;
      this.wobble = (Math.random() - 0.5) * 2;
      this.thick = 3 + Math.random() * 5;
      this.alpha = 0.88;
      this.maxLengthNorm = (50 + Math.random() * 350) / h;
    }

    update() {
      if (width < 1 || height < 1) return;
      const currentLenNorm = this.curYNorm - this.startYNorm;
      if (currentLenNorm >= this.maxLengthNorm) return;
      this.curYNorm += DRIP_SPEED / height;
      this.wobble += (Math.random() - 0.5) * DRIP_WOBBLE;
      this.wobble *= 0.95;
      this.curXNorm = this.startXNorm + this.wobble / width;
      if (Number.isFinite(this.curXNorm) && Number.isFinite(this.curYNorm)) {
        this.points.push({ x: this.curXNorm, y: this.curYNorm });
      }
    }

    draw() {
      if (this.points.length < 1) return;
      const sx = this.startXNorm * width;
      const sy = this.startYNorm * height;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      this.points.forEach(p => {
        const px = p.x * width;
        const py = p.y * height;
        if (Number.isFinite(px) && Number.isFinite(py)) ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  function createDripsFromPath(path, color, count) {
    const len = pathLength(path);
    if (len < 10) return;
    const maxDripLen = height - 80;
    for (let i = 0; i < count; i++) {
      const d = len * (0.15 + Math.random() * 0.7);
      const p = pointAtDistance(path, d);
      if (p) {
        const drip = new WallDrip(p.x, p.y, color, width, height);
        drip.maxLengthNorm = (60 + Math.random() * maxDripLen) / height;
        wallDrips.push(drip);
      }
    }
  }

  function finishStroke() {
    if (currentPath.length < 1) {
      currentPath = [];
      return;
    }

    const sprayColor = document.getElementById('sprayColor').value;
    const radiusVal = parseInt(document.getElementById('sprayRadius').value, 10) || 4;
    const thickness = 24 + radiusVal * 2;
    const text = (document.getElementById('textInput').value || 'oh').trim();
    const textSize = Math.max(12, parseInt(document.getElementById('textSize').value, 10) || 28);
    const textColor = document.getElementById('textColor').value;

    const totalLen = pathLength(currentPath);
    const charSpacing = Math.max(8, textSize * 0.6);
    const numChars = Math.max(1, Math.floor(totalLen / charSpacing));

    const pathNorm = currentPath.map(p => ({ x: p.x / width, y: p.y / height }));
    strokes.push({
      path: currentPath.slice(),
      pathNorm,
      sprayColor,
      thickness,
      text,
      textSize,
      textColor,
      numChars,
      totalLen
    });

    const dripCount = 3 + Math.floor(totalLen / 50);
    createDripsFromPath(currentPath, sprayColor, Math.min(dripCount, 12));

    currentPath = [];
    saveToStorage();
  }

  function finishStrokeWithPath(path) {
    if (!path || path.length < 1) return;
    var sprayColor = document.getElementById('sprayColor').value;
    var radiusVal = parseInt(document.getElementById('sprayRadius').value, 10) || 4;
    var thickness = 24 + radiusVal * 2;
    var text = (document.getElementById('textInput').value || 'oh').trim();
    var textSize = Math.max(12, parseInt(document.getElementById('textSize').value, 10) || 28);
    var textColor = document.getElementById('textColor').value;
    var totalLen = pathLength(path);
    var charSpacing = Math.max(8, textSize * 0.6);
    var numChars = Math.max(1, Math.floor(totalLen / charSpacing));
    var pathNorm = path.map(function (p) { return { x: p.x / width, y: p.y / height }; });
    strokes.push({
      path: path.slice(),
      pathNorm: pathNorm,
      sprayColor: sprayColor,
      thickness: thickness,
      text: text,
      textSize: textSize,
      textColor: textColor,
      numChars: numChars,
      totalLen: totalLen
    });
    var dripCount = 3 + Math.floor(totalLen / 50);
    createDripsFromPath(path, sprayColor, Math.min(dripCount, 12));
    saveToStorage();
  }

  function drawStroke(s) {
    const path = s.pathNorm
      ? s.pathNorm.map(p => ({ x: p.x * width, y: p.y * height }))
      : (s.path || []);
    if (path.length < 1) return;

    ctx.save();
    ctx.strokeStyle = s.sprayColor;
    ctx.lineWidth = s.thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.92;

    if (path.length === 1) {
      ctx.beginPath();
      ctx.arc(path[0].x, path[0].y, s.thickness / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.sprayColor;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }

    if (s.text && s.numChars > 0) {
      ctx.fillStyle = s.textColor;
      ctx.font = `bold ${s.textSize}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
      for (let i = 0; i < s.numChars; i++) {
        const d = (i / (s.numChars - 1 || 1)) * s.totalLen;
        const p = pointAtDistance(path, d);
        if (p) ctx.fillText(s.text[i % s.text.length], p.x, p.y);
      }
    }
    ctx.restore();
  }

  function update() {
    wallDrips.forEach(d => d.update());
    if (cameraDetectionRunning && cameraFingerVisible && document.getElementById('sprayToggle').checked) {
      cameraFingerSmoothedX += (cameraFingerTargetX - cameraFingerSmoothedX) * cameraFingerSmoothFactor;
      cameraFingerSmoothedY += (cameraFingerTargetY - cameraFingerSmoothedY) * cameraFingerSmoothFactor;
      var last = cameraPath[cameraPath.length - 1];
      if (!last || Math.hypot(cameraFingerSmoothedX - last.x, cameraFingerSmoothedY - last.y) > 1.5) {
        cameraPath.push({ x: cameraFingerSmoothedX, y: cameraFingerSmoothedY });
      }
    }
  }

  function draw() {
    const blur = document.getElementById('blurEffect').checked;

    ctx.save();
    if (blur) ctx.filter = 'blur(1px)';
    ctx.clearRect(0, 0, width, height);

    strokes.forEach(drawStroke);

    ctx.restore();

    ctx.save();
    if (blur) ctx.filter = 'blur(1px)';
    wallDrips.forEach(d => d.draw());
    ctx.restore();

    if (currentPath.length >= 1) {
      ctx.save();
      const col = document.getElementById('sprayColor').value;
      const thick = 24 + (parseInt(document.getElementById('sprayRadius').value, 10) || 4) * 2;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.9;
      if (currentPath.length === 1) {
        ctx.beginPath();
        ctx.arc(currentPath[0].x, currentPath[0].y, thick / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(currentPath[0].x, currentPath[0].y);
        for (let i = 1; i < currentPath.length; i++) {
          ctx.lineTo(currentPath[i].x, currentPath[i].y);
        }
        ctx.stroke();
      }
      const text = (document.getElementById('textInput').value || 'oh').trim();
      if (text) {
        const textSize = Math.max(12, parseInt(document.getElementById('textSize').value, 10) || 28);
        const textColor = document.getElementById('textColor').value;
        const totalLen = pathLength(currentPath);
        const numChars = Math.max(1, Math.floor(totalLen / Math.max(8, textSize * 0.6)));
        ctx.fillStyle = textColor;
        ctx.font = `bold ${textSize}px "Segoe UI", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1;
        for (let i = 0; i < numChars; i++) {
          const d = (numChars > 1 ? (i / (numChars - 1)) : 0) * totalLen;
          const p = pointAtDistance(currentPath, d);
          if (p) ctx.fillText(text[i % text.length], p.x, p.y);
        }
      }
      ctx.restore();
    }
    if (cameraPath.length >= 1) {
      ctx.save();
      var col = document.getElementById('sprayColor').value;
      var thick = 24 + (parseInt(document.getElementById('sprayRadius').value, 10) || 4) * 2;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.9;
      if (cameraPath.length === 1) {
        ctx.beginPath();
        ctx.arc(cameraPath[0].x, cameraPath[0].y, thick / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(cameraPath[0].x, cameraPath[0].y);
        for (var i = 1; i < cameraPath.length; i++) {
          ctx.lineTo(cameraPath[i].x, cameraPath[i].y);
        }
        ctx.stroke();
      }
      var text = (document.getElementById('textInput').value || 'oh').trim();
      if (text) {
        var textSize = Math.max(12, parseInt(document.getElementById('textSize').value, 10) || 28);
        var textColor = document.getElementById('textColor').value;
        var totalLen = pathLength(cameraPath);
        var numChars = Math.max(1, Math.floor(totalLen / Math.max(8, textSize * 0.6)));
        ctx.fillStyle = textColor;
        ctx.font = 'bold ' + textSize + 'px "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1;
        for (var j = 0; j < numChars; j++) {
          var d = (numChars > 1 ? (j / (numChars - 1)) : 0) * totalLen;
          var p = pointAtDistance(cameraPath, d);
          if (p) ctx.fillText(text[j % text.length], p.x, p.y);
        }
      }
      ctx.restore();
    }
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  function getClientXY(e) {
    if (e.clientX != null) return { x: e.clientX, y: e.clientY };
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return null;
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!document.getElementById('sprayToggle').checked) return;
    if (e.target !== canvas) return;
    e.preventDefault();
    isDrawing = true;
    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = getCanvasPointFromClient(e.clientX, e.clientY);
    currentPath = [{ x, y }];
  }

  function onPointerMove(e) {
    if (!isDrawing || e.pointerId !== activePointerId || currentPath.length === 0) return;
    e.preventDefault();
    const { x, y } = getCanvasPointFromClient(e.clientX, e.clientY);
    const last = currentPath[currentPath.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 1) {
      currentPath.push({ x, y });
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    e.preventDefault();
    if (isDrawing && currentPath.length > 0) {
      finishStroke();
    }
    isDrawing = false;
    activePointerId = null;
  }

  function reset() {
    strokes.length = 0;
    wallDrips.length = 0;
    currentPath = [];
    try {
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    ctx.clearRect(0, 0, width, height);
  }

  document.getElementById('sprayDensity').addEventListener('input', function () {
    document.getElementById('densityVal').textContent = this.value;
  });
  document.getElementById('sprayRadius').addEventListener('input', function () {
    document.getElementById('radiusVal').textContent = this.value;
  });
  document.getElementById('textSize').addEventListener('input', function () {
    document.getElementById('textSizeVal').textContent = this.value;
  });
  document.getElementById('resetBtn').addEventListener('click', reset);

  var panelEl = document.getElementById('panel');
  var panelToggle = document.getElementById('panelToggle');
  var panelToggleText = panelToggle && panelToggle.querySelector('.panel-toggle-text');
  function updatePanelToggleLabel() {
    var collapsed = panelEl.classList.contains('collapsed');
    panelToggle.setAttribute('aria-label', collapsed ? '설정 펼치기' : '설정 접기');
    if (panelToggleText) panelToggleText.textContent = collapsed ? '설정' : '접기';
  }
  function togglePanel() {
    panelEl.classList.toggle('collapsed');
    updatePanelToggleLabel();
    setTimeout(resize, 260);
  }
  panelToggle.addEventListener('click', togglePanel);

  if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
    panelEl.classList.add('collapsed');
  }
  updatePanelToggleLabel();

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointermove', onPointerMove, { capture: true });
  canvas.addEventListener('pointerup', onPointerUp, { capture: true });
  canvas.addEventListener('pointercancel', onPointerUp, { capture: true });
  canvas.addEventListener('pointerleave', onPointerUp, { capture: true });

  canvas.style.touchAction = 'none';
  canvas.style.msTouchAction = 'none';

  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', saveToStorage);
  window.addEventListener('pagehide', saveToStorage);
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveToStorage();
  });
  setInterval(saveToStorage, 1500);

  cameraVideo = document.getElementById('cameraVideo');
  cameraPreviewEl = document.getElementById('cameraPreview');

  function onHandResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      if (cameraFingerVisible && cameraPath.length > 0) {
        finishStrokeWithPath(cameraPath);
        cameraPath = [];
      }
      cameraFingerVisible = false;
      return;
    }
    var landmarks = results.multiHandLandmarks[0];
    var tip = landmarks[8];
    if (!tip) return;
    var normX = tip.x;
    var normY = tip.y;
    cameraFingerTargetX = (1 - normX) * width;
    cameraFingerTargetY = normY * height;
    cameraFingerVisible = true;
    if (cameraPath.length === 0) {
      cameraFingerSmoothedX = cameraFingerTargetX;
      cameraFingerSmoothedY = cameraFingerTargetY;
    }
  }

  function startCameraSpray() {
    if (!cameraVideo) return;
    cameraPath = [];
    cameraFingerVisible = false;
    var startDetection = function () {
      if (!window.mediaPipeHandLandmarker) {
        if (window.mediaPipeHandError) {
          alert('손 인식 로딩에 실패했습니다. 네트워크를 확인해 주세요.');
          return;
        }
        setTimeout(startDetection, 100);
        return;
      }
      handsInstance = window.mediaPipeHandLandmarker;
      cameraDetectionRunning = true;
      if (cameraDetectionInterval) clearInterval(cameraDetectionInterval);
      cameraDetectionInterval = setInterval(runCameraDetectionLoop, CAMERA_DETECT_INTERVAL_MS);
    };
    if (cameraStream) {
      cameraPreviewEl.classList.add('active');
      startDetection();
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then(function (stream) {
        cameraStream = stream;
        cameraVideo.srcObject = stream;
        cameraVideo.onloadedmetadata = function () {
          cameraVideo.play();
          cameraPreviewEl.classList.add('active');
          startDetection();
        };
      })
      .catch(function (err) {
        console.warn('Camera error:', err);
        alert('카메라를 사용할 수 없습니다. 권한을 확인해 주세요.');
      });
  }

  function runCameraDetectionLoop() {
    if (!cameraDetectionRunning || !handsInstance || !cameraVideo) return;
    if (cameraVideo.readyState < 2) return;
    if (document.visibilityState === 'hidden') return;
    try {
      var timestamp = performance.now();
      var results = handsInstance.detectForVideo(cameraVideo, timestamp);
      if (results && results.landmarks && results.landmarks.length > 0) {
        onHandResults({ multiHandLandmarks: results.landmarks });
      } else {
        onHandResults({ multiHandLandmarks: [] });
      }
    } catch (e) {
      onHandResults({ multiHandLandmarks: [] });
    }
  }

  function stopCameraSpray() {
    cameraDetectionRunning = false;
    if (cameraDetectionInterval) {
      clearInterval(cameraDetectionInterval);
      cameraDetectionInterval = null;
    }
    if (cameraFingerVisible && cameraPath.length > 0) {
      finishStrokeWithPath(cameraPath);
    }
    cameraPath = [];
    cameraFingerVisible = false;
    if (cameraPreviewEl) cameraPreviewEl.classList.remove('active');
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (t) { t.stop(); });
      cameraStream = null;
    }
    if (cameraVideo) cameraVideo.srcObject = null;
  }

  var cameraCheck = document.getElementById('cameraSprayTogglePanel');
  if (cameraCheck) {
    cameraCheck.addEventListener('change', function () {
      if (this.checked) {
        startCameraSpray();
      } else {
        stopCameraSpray();
      }
    });
  }

  resize();
  loadFromStorage();
  requestAnimationFrame(loop);
})();
