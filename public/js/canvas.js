// Drawing canvas with pen/eraser/fill/shapes/text, colors, opacity,
// brush/text sizes, and undo/redo.
//
// Exposes a single constructor: ThumbCanvas(canvasEl, opts).

(function (global) {
  const DEFAULT_PALETTE = [
    // core
    '#000000', '#ffffff', '#9b9b9b', '#ff2d55', '#ff0000',
    '#ff8a00', '#ffd400', '#1eb854', '#00b3ff', '#2b5bff',
    '#8b4cff', '#ff3ea5',
    // skin tones
    '#ffe0bd', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3317',
    // extras
    '#7a4b2a', '#00e5ff', '#a3e635', '#f97316', '#e11d48', '#1e293b'
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
      this.color = '#000000';
      this.size = 6;
      this.textSize = 48;
      this.textFont = 'Impact';
      this.textBold = true;
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
      document.addEventListener('keydown', (e) => {
        if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
          e.preventDefault();
          this.undo();
        } else if (
          (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
          (e.key === 'y' && (e.ctrlKey || e.metaKey))
        ) {
          e.preventDefault();
          this.redo();
        }
      });
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
      if (this._textDragActive) return;
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
        const opener = window.openTextModal;
        if (opener) {
          opener({
            color: this.color,
            size: this.textSize,
            opacity: this.opacity,
            onConfirm: ({ text, size, color, font, bold }) => {
              if (!text) return;
              this._startTextDrag({ text, size, color, font, bold, x, y });
            }
          });
        } else {
          const text = window.prompt('Enter text:');
          if (text) {
            this._drawText(x, y, text);
            this._pushUndo();
          }
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
      const headLen = Math.max(18, this.size * 4);
      const headWidth = Math.max(10, this.size * 2.4);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      // End the shaft slightly inside the arrowhead base so a thick line
      // with a round cap doesn't poke past the tip.
      const baseX = x2 - headLen * 0.85 * Math.cos(angle);
      const baseY = y2 - headLen * 0.85 * Math.sin(angle);
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();
      ctx.restore();
      // Filled triangular head, perpendicular width controlled separately
      const perp = angle + Math.PI / 2;
      const wingX = headLen * Math.cos(angle);
      const wingY = headLen * Math.sin(angle);
      const sideX = headWidth * Math.cos(perp);
      const sideY = headWidth * Math.sin(perp);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - wingX + sideX, y2 - wingY + sideY);
      ctx.lineTo(x2 - wingX - sideX, y2 - wingY - sideY);
      ctx.closePath();
      ctx.fill();
    }

    // Start drag-to-place mode for newly added text. The text follows
    // the pointer until the user clicks/taps to commit it.
    // Stamp a sticker emoji onto the canvas in draggable move mode.
    beginSticker(emoji) {
      const size = 160;
      const draw = (x, y) => {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, x, y);
        ctx.restore();
      };
      this._beginPlacement(draw, this.width / 2, this.height / 2);
    }

    // Place text in a draggable "move mode": the text follows your finger
    // while dragging and only commits when you hit Place (or Enter). You can
    // reposition as many times as you like before committing.
    _startTextDrag(opts) {
      const renderAt = (x, y) => {
        const prev = { color: this.color, size: this.textSize, font: this.textFont, bold: this.textBold };
        this.color = opts.color;
        this.textSize = opts.size;
        this.textFont = opts.font || 'Impact';
        this.textBold = opts.bold !== false;
        this._drawText(x, y, opts.text);
        this.color = prev.color;
        this.textSize = prev.size;
        this.textFont = prev.font;
        this.textBold = prev.bold;
      };
      this._beginPlacement(renderAt, opts.x, opts.y);
    }

    // Shared draggable-placement scaffold used by text and stickers.
    _beginPlacement(renderAt, x0, y0) {
      const snapshot = this.ctx.getImageData(0, 0, this.width, this.height);
      let cx = x0;
      let cy = y0;
      let dragging = false;
      let grabDX = 0;
      let grabDY = 0;

      const draw = (x, y) => {
        this.ctx.putImageData(snapshot, 0, 0);
        renderAt(x, y);
      };

      draw(cx, cy);

      const onDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { x, y } = this._coords(e);
        dragging = true;
        grabDX = x - cx;
        grabDY = y - cy;
        try { this.canvas.setPointerCapture?.(e.pointerId); } catch {}
      };
      const onMove = (e) => {
        if (!dragging) return;
        const { x, y } = this._coords(e);
        cx = x - grabDX;
        cy = y - grabDY;
        draw(cx, cy);
      };
      const onUp = (e) => {
        dragging = false;
        try { this.canvas.releasePointerCapture?.(e.pointerId); } catch {}
      };
      const onKey = (e) => {
        if (e.key === 'Escape') cancel();
        else if (e.key === 'Enter') commit();
      };

      const commit = () => { cleanup(); this._pushUndo(); };
      const cancel = () => { this.ctx.putImageData(snapshot, 0, 0); cleanup(); };

      const cleanup = () => {
        this.canvas.removeEventListener('pointerdown', onDown);
        this.canvas.removeEventListener('pointermove', onMove);
        this.canvas.removeEventListener('pointerup', onUp);
        document.removeEventListener('keydown', onKey);
        this._textDragActive = false;
        if (window.onTextPlaced) window.onTextPlaced();
      };

      this._textDragActive = true;
      this.canvas.addEventListener('pointerdown', onDown);
      this.canvas.addEventListener('pointermove', onMove);
      this.canvas.addEventListener('pointerup', onUp);
      document.addEventListener('keydown', onKey);
      if (window.onTextPlacing) window.onTextPlacing(commit, cancel);
    }

    _drawText(x, y, text) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;
      const weight = this.textBold ? '900' : '400';
      const font = this.textFont || 'Impact';
      ctx.font = `${weight} ${this.textSize}px "${font}", "Arial Black", sans-serif`;
      ctx.textBaseline = 'top';
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
