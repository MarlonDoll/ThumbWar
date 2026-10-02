// Drawing canvas with pen/eraser/fill/shapes, editable text and stickers,
// colors, opacity, brush sizes, and undo/redo.
//
// Pixels (pen, eraser, shapes, fill) live on an off-screen "base" layer.
// Text and stickers are objects drawn on top of it, so they can be tapped,
// moved, resized, edited or deleted at any time — not just when placed.
//
// Exposes a single constructor: ThumbCanvas(canvasEl).

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
  const STICKER_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  const SHAPES = ['line', 'rect', 'circle', 'arrow'];
  const SIZE_LIMITS = { text: [12, 400], sticker: [40, 640] };

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  const cloneObjects = (objs) => objs.map((o) => ({ ...o }));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  class ThumbCanvas {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.width = canvas.width;
      this.height = canvas.height;
      this.base = createCanvas(this.width, this.height);
      this.bctx = this.base.getContext('2d', { willReadFrequently: true });

      this.tool = 'pen';
      this.color = '#000000';
      this.size = 6;
      this.textSize = 48;
      this.opacity = 1;

      this.objects = [];
      this.selected = null;
      this.onSelectionChange = null;
      this._nextId = 1;

      this.undoStack = [];
      this.redoStack = [];
      this.maxUndo = 20;
      // While a just-added object is still selected, moving/resizing it
      // updates the same undo step, so one undo removes it entirely.
      this._amendId = null;

      this.pointers = new Map();
      this.gesture = null;
      this.isDrawing = false;

      this._fillBackground('#ffffff');
      this._pushUndo();
      this._bind();
      this.render();
    }

    // ----- rendering -----

    _fillBackground(color) {
      const b = this.bctx;
      b.save();
      b.globalAlpha = 1;
      b.globalCompositeOperation = 'source-over';
      b.fillStyle = color;
      b.fillRect(0, 0, this.width, this.height);
      b.restore();
    }

    render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(this.base, 0, 0);
      for (const o of this.objects) this._drawObject(ctx, o);
      if (this.selected) this._drawSelection(ctx, this.selected);
    }

    // Base + objects, without selection handles (what gets submitted).
    _composite() {
      const c = createCanvas(this.width, this.height);
      const x = c.getContext('2d');
      x.drawImage(this.base, 0, 0);
      for (const o of this.objects) this._drawObject(x, o);
      return c;
    }

    _textFont(o) {
      return `${o.bold === false ? '400' : '900'} ${o.size}px "${o.font || 'Impact'}", "Arial Black", sans-serif`;
    }

    _drawObject(ctx, o) {
      ctx.save();
      if (o.type === 'text') {
        ctx.globalAlpha = o.opacity ?? 1;
        ctx.font = this._textFont(o);
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, o.size * 0.08);
        ctx.strokeStyle = '#000000';
        ctx.fillStyle = o.color;
        ctx.strokeText(o.text, o.x, o.y);
        ctx.fillText(o.text, o.x, o.y);
      } else if (o.type === 'sticker') {
        ctx.font = `${o.size}px ${STICKER_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.emoji, o.x, o.y);
      }
      ctx.restore();
    }

    _bounds(o) {
      if (o.type === 'text') {
        this.ctx.save();
        this.ctx.font = this._textFont(o);
        const w = this.ctx.measureText(o.text).width;
        this.ctx.restore();
        return { x: o.x, y: o.y, w, h: o.size * 1.05 };
      }
      return { x: o.x - o.size / 2, y: o.y - o.size / 2, w: o.size, h: o.size };
    }

    // Canvas pixels per screen pixel, so handles stay finger-sized on phones.
    _k() {
      const r = this.canvas.getBoundingClientRect();
      return r.width ? this.width / r.width : 1;
    }

    _handles(o) {
      const b = this._bounds(o);
      const k = this._k();
      const pad = 8 * k;
      return {
        box: { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 },
        resize: { x: b.x + b.w + pad, y: b.y + b.h + pad, r: 16 * k },
        del: { x: b.x + b.w + pad, y: b.y - pad, r: 14 * k }
      };
    }

    _drawSelection(ctx, o) {
      const { box, resize, del } = this._handles(o);
      const k = this._k();
      ctx.save();
      ctx.lineWidth = 2 * k;
      ctx.setLineDash([8 * k, 6 * k]);
      ctx.strokeStyle = '#00b3ff';
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);
      // Resize handle (bottom-right)
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#00b3ff';
      ctx.lineWidth = 3 * k;
      ctx.beginPath(); ctx.arc(resize.x, resize.y, resize.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#0a5ea8';
      ctx.lineWidth = 2.5 * k;
      const a = resize.r * 0.45;
      ctx.beginPath();
      ctx.moveTo(resize.x - a, resize.y - a); ctx.lineTo(resize.x + a, resize.y + a);
      ctx.moveTo(resize.x + a, resize.y + a); ctx.lineTo(resize.x + a, resize.y);
      ctx.moveTo(resize.x + a, resize.y + a); ctx.lineTo(resize.x, resize.y + a);
      ctx.stroke();
      // Delete handle (top-right)
      ctx.fillStyle = '#ff2d55';
      ctx.beginPath(); ctx.arc(del.x, del.y, del.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5 * k;
      const d = del.r * 0.4;
      ctx.beginPath();
      ctx.moveTo(del.x - d, del.y - d); ctx.lineTo(del.x + d, del.y + d);
      ctx.moveTo(del.x + d, del.y - d); ctx.lineTo(del.x - d, del.y + d);
      ctx.stroke();
      ctx.restore();
    }

    // ----- hit testing -----

    _inBox(b, x, y) {
      return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    }

    _onHandle(h, x, y, slack = 1.4) {
      return Math.hypot(x - h.x, y - h.y) <= h.r * slack;
    }

    _hitObject(x, y) {
      for (let i = this.objects.length - 1; i >= 0; i--) {
        if (this._inBox(this._handles(this.objects[i]).box, x, y)) return this.objects[i];
      }
      return null;
    }

    // ----- input -----

    _bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this._onDown(e));
      c.addEventListener('pointermove', (e) => this._onMove(e));
      c.addEventListener('pointerup', (e) => this._onUp(e));
      c.addEventListener('pointercancel', (e) => this._onUp(e));
      // Tapping outside the canvas finishes editing — except on the toolbar
      // (so a color swatch can recolor the selected text) and the edit bar.
      document.addEventListener('pointerdown', (e) => {
        if (!this.selected || !this.canvas.isConnected) return;
        if (c.contains(e.target)) return;
        if (e.target.closest && e.target.closest('#place-banner, #toolbar, #text-modal')) return;
        this.deselect();
      }, true);
      document.addEventListener('keydown', (e) => {
        if (!this.canvas.isConnected) return;
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'z' && mod && !e.shiftKey) {
          e.preventDefault();
          this.undo();
          return;
        }
        if ((e.key === 'z' && mod && e.shiftKey) || (e.key === 'y' && mod)) {
          e.preventDefault();
          this.redo();
          return;
        }
        if (!this.selected) return;
        const t = e.target;
        const tag = (t.tagName || '').toLowerCase();
        const typing = tag === 'textarea' || t.isContentEditable ||
          (tag === 'input' && !['range', 'color', 'checkbox', 'button'].includes(t.type));
        const modal = document.getElementById('text-modal');
        if (typing || (modal && !modal.hidden)) return;
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); }
        else if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); this.deselect(); }
      });
    }

    _coords(e) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (this.width / rect.width),
        y: (e.clientY - rect.top) * (this.height / rect.height)
      };
    }

    _onDown(e) {
      e.preventDefault();
      // preventDefault keeps focus wherever it was (often a text box or
      // slider), which silently swallows keyboard shortcuts. Drop it.
      const active = document.activeElement;
      if (active && active !== document.body && active.blur) active.blur();
      const { x, y } = this._coords(e);
      this.pointers.set(e.pointerId, { x, y });
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}

      // Second finger on a selected object: pinch to resize.
      if (this.pointers.size === 2 && this.selected) {
        if (this.isDrawing) this._abortStroke();
        const [p1, p2] = [...this.pointers.values()];
        this.gesture = {
          type: 'pinch', obj: this.selected,
          startDist: Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y)),
          startSize: this.selected.size
        };
        return;
      }
      if (this.pointers.size > 1) return;

      const sel = this.selected;
      if (sel) {
        const h = this._handles(sel);
        if (this._onHandle(h.del, x, y)) { this.deleteSelected(); return; }
        if (this._onHandle(h.resize, x, y)) {
          const b = this._bounds(sel);
          const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
          this.gesture = { type: 'resize', obj: sel, cx, cy, startDist: Math.max(1, Math.hypot(x - cx, y - cy)), startSize: sel.size };
          return;
        }
        if (this._inBox(h.box, x, y)) {
          this.gesture = { type: 'move', obj: sel, dx: x - sel.x, dy: y - sel.y, changed: false };
          return;
        }
      }

      const hit = this._hitObject(x, y);
      // Text and fill taps on an object select it straight away. Pen and
      // shape tools only select on a tap (see _onUp), so you can still draw
      // across text.
      if (hit && (this.tool === 'text' || this.tool === 'fill')) {
        this._select(hit);
        this.gesture = { type: 'move', obj: hit, dx: x - hit.x, dy: y - hit.y, changed: false };
        return;
      }

      if (sel) {
        this.deselect();
        // Tapping away with the text tool just finishes editing.
        if (this.tool === 'text') return;
      }

      if (this.tool === 'fill') {
        this._flood(Math.round(x), Math.round(y));
        this.render();
        this._pushUndo();
        return;
      }

      if (this.tool === 'text') {
        const open = global.openTextModal;
        if (open) {
          open({
            color: this.color,
            size: this.textSize,
            onConfirm: ({ text, size, color, font, bold }) => {
              if (text) this.addText({ text, size, color, font, bold, x, y });
            }
          });
        }
        return;
      }

      // Pen / eraser / shapes draw on the base layer.
      this.isDrawing = true;
      this.stroke = { startX: x, startY: y, lastX: x, lastY: y, moved: 0, hit, snapshot: this.bctx.getImageData(0, 0, this.width, this.height) };
      if (this.tool === 'pen' || this.tool === 'eraser') {
        this._strokeLine(x, y, x, y);
        this.render();
      }
    }

    _onMove(e) {
      if (!this.pointers.has(e.pointerId)) return;
      const { x, y } = this._coords(e);
      this.pointers.set(e.pointerId, { x, y });
      const g = this.gesture;

      if (g && g.type === 'pinch' && this.pointers.size >= 2) {
        const [p1, p2] = [...this.pointers.values()];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        this._setSize(g.obj, g.startSize * (dist / g.startDist));
        g.changed = true;
        this.render();
        return;
      }
      if (g && g.type === 'resize') {
        const dist = Math.hypot(x - g.cx, y - g.cy);
        this._setSize(g.obj, g.startSize * (dist / g.startDist));
        g.changed = true;
        this.render();
        return;
      }
      if (g && g.type === 'move') {
        g.obj.x = x - g.dx;
        g.obj.y = y - g.dy;
        this._keepOnCanvas(g.obj);
        g.changed = true;
        this.render();
        return;
      }

      if (!this.isDrawing) return;
      const s = this.stroke;
      s.moved = Math.max(s.moved, Math.hypot(x - s.startX, y - s.startY));
      if (this.tool === 'pen' || this.tool === 'eraser') {
        this._strokeLine(s.lastX, s.lastY, x, y);
      } else if (SHAPES.includes(this.tool)) {
        this.bctx.putImageData(s.snapshot, 0, 0);
        this._drawShape(s.startX, s.startY, x, y);
      }
      s.lastX = x;
      s.lastY = y;
      this.render();
    }

    _onUp(e) {
      this.pointers.delete(e.pointerId);
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      const g = this.gesture;
      if (g) {
        // A pinch ends when either finger lifts.
        this.gesture = null;
        if (g.changed) this._commitChange();
        return;
      }
      if (!this.isDrawing) return;
      this.isDrawing = false;
      const s = this.stroke;
      this.stroke = null;
      // A tap (not a drag) on a text/sticker selects it instead of drawing.
      if (s.hit && s.moved < 8 * this._k()) {
        this.bctx.putImageData(s.snapshot, 0, 0);
        this._select(s.hit);
        return;
      }
      this._pushUndo();
    }

    _abortStroke() {
      if (this.stroke) this.bctx.putImageData(this.stroke.snapshot, 0, 0);
      this.isDrawing = false;
      this.stroke = null;
      this.render();
    }

    // ----- objects -----

    _setSize(o, size) {
      const [lo, hi] = SIZE_LIMITS[o.type];
      const before = this._bounds(o);
      const cx = before.x + before.w / 2, cy = before.y + before.h / 2;
      o.size = Math.round(clamp(size, lo, hi));
      if (o.type === 'text') {
        // Keep the text centered where it was while it grows or shrinks.
        const after = this._bounds(o);
        o.x = cx - after.w / 2;
        o.y = cy - after.h / 2;
      }
      this._keepOnCanvas(o);
    }

    // Don't let an object get dragged entirely off the canvas.
    _keepOnCanvas(o) {
      const b = this._bounds(o);
      const margin = 24;
      const dx = Math.min(0, this.width - margin - b.x) + Math.max(0, margin - (b.x + b.w));
      const dy = Math.min(0, this.height - margin - b.y) + Math.max(0, margin - (b.y + b.h));
      o.x += dx;
      o.y += dy;
    }

    _add(obj) {
      obj.id = this._nextId++;
      this.objects.push(obj);
      this._keepOnCanvas(obj);
      this._select(obj);
      this._pushUndo();
      this._amendId = obj.id;
    }

    addText({ text, size, color, font, bold, x, y }) {
      this._add({ type: 'text', text, size: size || this.textSize, color: color || this.color, font: font || 'Impact', bold: bold !== false, opacity: this.opacity, x, y });
    }

    // Stamp a sticker in the middle; it stays selected so it can be dragged.
    beginSticker(emoji) {
      this._add({ type: 'sticker', emoji, size: 160, x: this.width / 2, y: this.height / 2 });
    }

    _select(o) {
      if (this.selected === o) return;
      // Only the object just added keeps amending its own undo step.
      if (o.id !== this._amendId) this._amendId = null;
      this.selected = o;
      this.render();
      if (this.onSelectionChange) this.onSelectionChange(o);
    }

    deselect() {
      if (!this.selected) return;
      this.selected = null;
      this._amendId = null;
      this.render();
      if (this.onSelectionChange) this.onSelectionChange(null);
    }

    deleteSelected() {
      const o = this.selected;
      if (!o) return;
      this.objects = this.objects.filter((x) => x !== o);
      this.selected = null;
      const fresh = this._amendId === o.id;
      this._amendId = null;
      if (fresh) {
        // Deleting something you just added = it never happened.
        this.undoStack.pop();
        this.redoStack = [];
      } else {
        this._pushUndo();
      }
      this.render();
      if (this.onSelectionChange) this.onSelectionChange(null);
    }

    resizeSelectedBy(factor) {
      if (!this.selected) return;
      this._setSize(this.selected, this.selected.size * factor);
      this._commitChange();
      this.render();
    }

    // Recolor the selected text (used by the palette).
    recolorSelected(color) {
      const o = this.selected;
      if (!o || o.type !== 'text') return false;
      o.color = color;
      this._commitChange();
      this.render();
      return true;
    }

    editSelected() {
      const o = this.selected;
      if (!o || o.type !== 'text' || !global.openTextModal) return;
      global.openTextModal({
        text: o.text,
        color: o.color,
        size: o.size,
        font: o.font,
        bold: o.bold,
        editing: true,
        onConfirm: ({ text, size, color, font, bold }) => {
          if (!text) return;
          Object.assign(o, { text, color, font, bold });
          this._setSize(o, size);
          this._commitChange();
          this.render();
        }
      });
    }

    commitPlacement() { this.deselect(); }
    cancelPlacement() { this.deselect(); }

    _commitChange() {
      if (this.selected && this.selected.id === this._amendId && this.undoStack.length > 1) {
        this.undoStack[this.undoStack.length - 1] = this._snapshot();
        this.redoStack = [];
      } else {
        this._pushUndo();
      }
    }

    // ----- base-layer drawing -----

    _strokeLine(x1, y1, x2, y2) {
      const ctx = this.bctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = this.size;
      if (this.tool === 'eraser') {
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 1;
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
      const ctx = this.bctx;
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
        ctx.beginPath();
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (this.tool === 'arrow') {
        this._drawArrow(ctx, x1, y1, x2, y2);
      }
      ctx.restore();
    }

    _drawArrow(ctx, x1, y1, x2, y2) {
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

    _flood(sx, sy) {
      const ctx = this.bctx;
      const img = ctx.getImageData(0, 0, this.width, this.height);
      const data = img.data;
      const W = this.width;
      const H = this.height;
      const idx = (x, y) => (y * W + x) * 4;
      const startIdx = idx(sx, sy);
      const sr = data[startIdx], sg = data[startIdx + 1], sb = data[startIdx + 2], sa = data[startIdx + 3];
      const [fr, fg, fb] = this._hexToRgb(this.color);
      const fa = Math.round(this.opacity * 255);
      if (sr === fr && sg === fg && sb === fb && sa === fa) return;
      const stack = [[sx, sy]];
      const match = (x, y) => {
        const i = idx(x, y);
        return data[i] === sr && data[i + 1] === sg && data[i + 2] === sb && data[i + 3] === sa;
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
          data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = fa;
          if (y > 0 && match(xi, y - 1)) stack.push([xi, y - 1]);
          if (y < H - 1 && match(xi, y + 1)) stack.push([xi, y + 1]);
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    _hexToRgb(hex) {
      const h = hex.replace('#', '');
      const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    // ----- undo / redo -----

    _snapshot() {
      return { img: this.bctx.getImageData(0, 0, this.width, this.height), objects: cloneObjects(this.objects) };
    }

    _pushUndo() {
      try {
        this.undoStack.push(this._snapshot());
        if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
        this.redoStack = [];
      } catch (e) {
        /* canvas too large — skip */
      }
    }

    _restore(snap) {
      this.bctx.putImageData(snap.img, 0, 0);
      this.objects = cloneObjects(snap.objects);
    }

    undo() {
      const hadSelection = !!this.selected;
      this.selected = null;
      this._amendId = null;
      if (this.undoStack.length > 1) {
        this.redoStack.push(this.undoStack.pop());
        this._restore(this.undoStack[this.undoStack.length - 1]);
      }
      this.render();
      if (hadSelection && this.onSelectionChange) this.onSelectionChange(null);
    }

    redo() {
      if (this.redoStack.length === 0) return;
      this.deselect();
      const snap = this.redoStack.pop();
      this.undoStack.push(snap);
      this._restore(snap);
      this.render();
    }

    clear() {
      this.deselect();
      this._fillBackground('#ffffff');
      this.objects = [];
      this._pushUndo();
      this.render();
    }

    // ----- save / load (switching between assigned thumbnails) -----

    // Everything needed to restore this drawing with text still editable.
    getState() {
      return { base: this.base.toDataURL('image/png'), objects: cloneObjects(this.objects) };
    }

    _reset(objects = []) {
      this.selected = null;
      this._amendId = null;
      this.objects = cloneObjects(objects);
      this.undoStack = [];
      this.redoStack = [];
      this._pushUndo();
      this.render();
      if (this.onSelectionChange) this.onSelectionChange(null);
    }

    _loadBase(dataUrl) {
      return new Promise((resolve) => {
        this._fillBackground('#ffffff');
        if (!dataUrl) return resolve();
        const img = new Image();
        img.onload = () => { this.bctx.drawImage(img, 0, 0, this.width, this.height); resolve(); };
        img.onerror = () => resolve();
        img.src = dataUrl;
      });
    }

    loadState(state) {
      return this._loadBase(state && state.base).then(() => this._reset(state ? state.objects : []));
    }

    // Load a flat image (no editable objects), or a blank canvas for null.
    loadPng(dataUrl) {
      return this._loadBase(dataUrl).then(() => this._reset([]));
    }

    toDataURL() {
      // Downscale on export so the server cap (~1.5MB) is never breached even
      // if the canvas is busy. The canvas itself stays at full 1280x720 for
      // drawing precision.
      const src = this._composite();
      const sizes = [
        [960, 540, 0.75],
        [800, 450, 0.7],
        [640, 360, 0.6]
      ];
      for (const [w, h, q] of sizes) {
        const out = createCanvas(w, h);
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(src, 0, 0, w, h);
        const data = out.toDataURL('image/jpeg', q);
        if (data.length <= 1_400_000) return data;
      }
      return src.toDataURL('image/jpeg', 0.5);
    }
  }

  global.ThumbCanvas = ThumbCanvas;
  global.THUMB_PALETTE = DEFAULT_PALETTE;
})(window);
