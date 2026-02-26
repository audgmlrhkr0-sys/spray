(function () {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const DRIP_SPEED = 1.4;
  const DRIP_WOBBLE = 1.5;

  let width = 0;
  let height = 0;
  let isDrawing = false;
  let currentPath = [];

  // 스프레이 한 줄 = 물감 얼룩 하나 + 그 안에 글자
  const strokes = [];
  // 벽에 맺혀서 주르륵 흐르는 줄 (시작점 고정, 아래로만 길어짐)
  const wallDrips = [];

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

  // ——— 벽에 맺혀서 주르륵 흐르는 줄 (시작점 고정, 아래로만 길어짐) ———
  class WallDrip {
    constructor(startX, startY, color) {
      this.startX = startX;
      this.startY = startY;
      this.color = color;
      this.points = [];
      this.curY = startY;
      this.curX = startX;
      this.wobble = (Math.random() - 0.5) * 2;
      this.thick = 3 + Math.random() * 5;
      this.alpha = 0.88;
      this.maxLength = 50 + Math.random() * 350;
    }

    update() {
      const currentLen = this.curY - this.startY;
      if (currentLen >= this.maxLength) return;
      this.curY += DRIP_SPEED;
      this.wobble += (Math.random() - 0.5) * DRIP_WOBBLE;
      this.wobble *= 0.95;
      this.curX = this.startX + this.wobble;
      this.points.push({ x: this.curX, y: this.curY });
    }

    draw() {
      if (this.points.length < 2) return;
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this.startX, this.startY);
      this.points.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      ctx.restore();
    }

    isDone() {
      return this.curY > height + 20;
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
        const drip = new WallDrip(p.x, p.y, color);
        drip.maxLength = 60 + Math.random() * maxDripLen;
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

    strokes.push({
      path: currentPath.slice(),
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
  }

  function drawStroke(s) {
    const path = s.path;
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
    for (let i = wallDrips.length - 1; i >= 0; i--) {
      if (wallDrips[i].isDone()) wallDrips.splice(i, 1);
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
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (!document.getElementById('sprayToggle').checked) return;
    isDrawing = true;
    const { x, y } = getCanvasPoint(e);
    currentPath = [{ x, y }];
  }

  function onMouseMove(e) {
    if (!isDrawing || currentPath.length === 0) return;
    const { x, y } = getCanvasPoint(e);
    const last = currentPath[currentPath.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 1) {
      currentPath.push({ x, y });
    }
  }

  function onMouseUp(e) {
    if (e.button !== 0) return;
    if (isDrawing && currentPath.length > 0) {
      finishStroke();
    }
    isDrawing = false;
  }

  function onMouseLeave() {
    if (isDrawing && currentPath.length > 0) {
      finishStroke();
    }
    isDrawing = false;
  }

  function onTouchStart(e) {
    if (!document.getElementById('sprayToggle').checked) return;
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    isDrawing = true;
    const { x, y } = getCanvasPointFromClient(t.clientX, t.clientY);
    currentPath = [{ x, y }];
  }

  function onTouchMove(e) {
    if (!isDrawing || currentPath.length === 0) return;
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    const { x, y } = getCanvasPointFromClient(t.clientX, t.clientY);
    const last = currentPath[currentPath.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 1) {
      currentPath.push({ x, y });
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length > 0) return;
    e.preventDefault();
    if (isDrawing && currentPath.length > 0) {
      finishStroke();
    }
    isDrawing = false;
  }

  function onTouchCancel(e) {
    if (isDrawing && currentPath.length > 0) {
      finishStroke();
    }
    isDrawing = false;
  }

  function reset() {
    strokes.length = 0;
    wallDrips.length = 0;
    currentPath = [];
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

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(loop);
})();
