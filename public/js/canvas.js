// Drawing canvas with pen/eraser/fill/shapes/text, colors, opacity,
// brush/text sizes, and undo/redo.
//
// Exposes a single constructor: ThumbCanvas(canvasEl, opts).

(function (global) {
  const DEFAULT_PALETTE = [
    '#000000', '#ffffff', '#ff0000', '#ff8a00', '#ffd400',
    '#1eb854', '#00b3ff', '#2b5bff', '#8b4cff', '#ff3ea5',
    '#6b3f1d', '#8a8a8a'
  ];

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  class ThumbCanvas {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.width = canvas.width;
      this.height = canvas.height;

      this.tool = 'pen';
      this.color = '#ff0000';
      this.size = 6;
      this.textSize = 48;
      this.opacity = 1;

      this.undoStack = [];
      this.redoStack = [];
      this.maxUndo = 20;

      // Off-screen snapshot used when dragging shapes (pre-shape image).
      this.baseSnapshot = null;

      this.isDrawing = false;
      this.startX = 0;
      this.startY = 0;
      this.lastX = 0;
      this.lastY = 0;

      this._fillBackground('#ffffff');
      this._pushUndo();

      this._bind();
    }

    _fillBackground(color) {
      this.ctx.save();
      this.ctx.fillStyle = color;
      this.ctx.globalAlpha = 1;
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.ctx.restore();
    }

    _bind() {
      const c = this.canvas;
      const handlers = {
        pointerdown: (e) => this._onDown(e),
        pointermove: (e) => this._onMove(e),
        pointerup: (e) => this._onUp(e),
        pointerleave: (e) => {
          if (this.isDrawing) this._onUp(e);
        }
      };
      for (const [ev, fn] of Object.entries(handlers)) {
        c.addEventListener(ev, fn);
      }
    }

    _coords(e) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = this.width / rect.width;
      const sy = this.height / rect.height;
      return {
        x: (e.clientX - rect.left) * sx,
        y: (e.clientY - rect.top) * sy
      };
    }

    _onDown(e) {
      e.preventDefault();
      const { x, y } = this._coords(e);
      this.startX = x;
      this.startY = y;
      this.lastX = x;
      this.lastY = y;

      if (this.tool === 'fill') {
        this._flood(Math.round(x), Math.round(y));
        this._pushUndo();
        return;
      }

      if (this.tool === 'text') {
        const text = window.prompt('Enter text:');
        if (text) {
          this._drawText(x, y, text);
          this._pushUndo();
        }
        return;
      }

      this.isDrawing = true;
      this.canvas.setPointerCapture?.(e.pointerId);

      if (['line', 'rect', 'circle', 'arrow'].includes(this.tool)) {
        // Snapshot before drawing shape, so dragging updates cleanly.
        this.baseSnapshot = this.ctx.getImageData(0, 0, this.width, this.height);
      } else if (this.tool === 'pen' || this.tool === 'eraser') {
        // Start a stroke — drop a dot immediately.
        this._stroke(x, y, x, y);
      }
    }

    _onMove(e) {
      if (!this.isDrawing) return;
      const { x, y } = this._coords(e);
      if (this.tool === 'pen' || this.tool === 'eraser') {
        this._stroke(this.lastX, this.lastY, x, y);
        this.lastX = x;
        this.lastY = y;
      } else if (this.baseSnapshot) {
        // Restore snapshot, then draw the new shape preview.
        this.ctx.putImageData(this.baseSnapshot, 0, 0);
        this._drawShape(this.startX, this.startY, x, y);
        this.lastX = x;
        this.lastY = y;
      }
    }

    _onUp(e) {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      try { this.canvas.releasePointerCapture?.(e.pointerId); } catch {}
      this.baseSnapshot = null;
      this._pushUndo();
    }

    _stroke(x1, y1, x2, y2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = this.size;
      if (this.tool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.strokeStyle = this.color;
        ctx.globalAlpha = this.opacity;
      }
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    }

    _drawShape(x1, y1, x2, y2) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = this.size;
      ctx.strokeStyle = this.color;
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;

      if (this.tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else if (this.tool === 'rect') {
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      } else if (this.tool === 'circle') {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2;
        const ry = Math.abs(y2 - y1) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (this.tool === 'arrow') {
        this._drawArrow(x1, y1, x2, y2);
      }
      ctx.restore();
    }

    _drawArrow(x1, y1, x2, y2) {
      const ctx = this.ctx;
      const headSize = Math.max(14, this.size * 3.5);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headSize * Math.cos(angle - Math.PI / 6),
        y2 - headSize * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        x2 - headSize * Math.cos(angle + Math.PI / 6),
        y2 - headSize * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    }

    _drawText(x, y, text) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;
      ctx.font = `800 ${this.textSize}px Impact, "Arial Black", sans-serif`;
      ctx.textBaseline = 'top';
      // Thumbnail-style stroke
      ctx.lineWidth = Math.max(2, this.textSize * 0.08);
      ctx.strokeStyle = '#000000';
      ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    _flood(sx, sy) {
      const ctx = this.ctx;
      const img = ctx.getImageData(0, 0, this.width, this.height);
      const data = img.data;
      const W = this.width;
      const H = this.height;

      const idx = (x, y) => (y * W + x) * 4;
      const startIdx = idx(sx, sy);
      const sr = data[startIdx],
        sg = data[startIdx + 1],
        sb = data[startIdx + 2],
        sa = data[startIdx + 3];

      const [fr, fg, fb] = this._hexToRgb(this.color);
      const fa = Math.round(this.opacity * 255);
      if (sr === fr && sg === fg && sb === fb && sa === fa) return;

      const stack = [[sx, sy]];
      const match = (x, y) => {
        const i = idx(x, y);
        return (
          data[i] === sr &&
          data[i + 1] === sg &&
          data[i + 2] === sb &&
          data[i + 3] === sa
        );
      };
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (!match(x, y)) continue;
        let xl = x;
        while (xl >= 0 && match(xl, y)) xl--;
        xl++;
        let xr = x;
        while (xr < W && match(xr, y)) xr++;
        xr--;
        for (let xi = xl; xi <= xr; xi++) {
          const i = idx(xi, y);
          data[i] = fr;
          data[i + 1] = fg;
          data[i + 2] = fb;
          data[i + 3] = fa;
          if (y > 0 && match(xi, y - 1)) stack.push([xi, y - 1]);
          if (y < H - 1 && match(xi, y + 1)) stack.push([xi, y + 1]);
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    _hexToRgb(hex) {
      const h = hex.replace('#', '');
      const v = parseInt(
        h.length === 3
          ? h.split('').map((c) => c + c).join('')
          : h,
        16
      );
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    _pushUndo() {
      try {
        const snap = this.ctx.getImageData(0, 0, this.width, this.height);
        this.undoStack.push(snap);
        if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
        this.redoStack = [];
      } catch (e) {
        /* canvas too large — skip */
      }
    }

    undo() {
      if (this.undoStack.length <= 1) return;
      const current = this.undoStack.pop();
      this.redoStack.push(current);
      const prev = this.undoStack[this.undoStack.length - 1];
      this.ctx.putImageData(prev, 0, 0);
    }

    redo() {
      if (this.redoStack.length === 0) return;
      const img = this.redoStack.pop();
      this.undoStack.push(img);
      this.ctx.putImageData(img, 0, 0);
    }

    clear() {
      this._fillBackground('#ffffff');
      this._pushUndo();
    }

    // Load a previous PNG (when switching tasks).
    loadPng(dataUrl) {
      return new Promise((resolve) => {
        if (!dataUrl) {
          this._fillBackground('#ffffff');
          this.undoStack = [];
          this.redoStack = [];
          this._pushUndo();
          return resolve();
        }
        const img = new Image();
        img.onload = () => {
          this.ctx.clearRect(0, 0, this.width, this.height);
          this._fillBackground('#ffffff');
          this.ctx.drawImage(img, 0, 0, this.width, this.height);
          this.undoStack = [];
          this.redoStack = [];
          this._pushUndo();
          resolve();
        };
        img.onerror = () => {
          this._fillBackground('#ffffff');
          this._pushUndo();
          resolve();
        };
        img.src = dataUrl;
      });
    }

    toDataURL() {
      // Downscale on export so the server cap (~1.5MB) is never breached even
      // if the canvas is busy. The canvas itself stays at full 1280x720 for
      // drawing precision.
      const sizes = [
        [960, 540, 0.75],
        [800, 450, 0.7],
        [640, 360, 0.6]
      ];
      for (const [w, h, q] of sizes) {
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(this.canvas, 0, 0, w, h);
        const data = out.toDataURL('image/jpeg', q);
        if (data.length <= 1_400_000) return data;
      }
      return this.canvas.toDataURL('image/jpeg', 0.5);
    }
  }

  global.ThumbCanvas = ThumbCanvas;
  global.THUMB_PALETTE = DEFAULT_PALETTE;
})(window);
