// Crop step shown before a new field photo is watermarked.
(function () {
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  var currentClose = null;

  function resized(origin, handle, dx, dy, lock) {
    var left = origin.x;
    var top = origin.y;
    var right = origin.x + origin.w;
    var bottom = origin.y + origin.h;
    if (handle.indexOf("w") !== -1) left += dx;
    if (handle.indexOf("e") !== -1) right += dx;
    if (handle.indexOf("n") !== -1) top += dy;
    if (handle.indexOf("s") !== -1) bottom += dy;
    if (!(lock && origin.w > 0 && origin.h > 0)) {
      return {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        w: Math.abs(right - left),
        h: Math.abs(bottom - top),
      };
    }
    var ratio = origin.w / origin.h;
    var ax = handle.indexOf("w") !== -1 ? origin.x + origin.w : origin.x;
    var ay = handle.indexOf("n") !== -1 ? origin.y + origin.h : origin.y;
    var mx = handle.indexOf("w") !== -1 ? left : right;
    var my = handle.indexOf("n") !== -1 ? top : bottom;
    var dw = mx - ax;
    var dh = my - ay;
    var adx = Math.abs(dw);
    var ady = Math.abs(dh);
    if (ady * ratio > adx) adx = ady * ratio;
    else ady = adx / ratio;
    var signX = dw < 0 ? -1 : 1;
    var signY = dh < 0 ? -1 : 1;
    var x2 = ax + signX * adx;
    var y2 = ay + signY * ady;
    return {
      x: Math.min(ax, x2),
      y: Math.min(ay, y2),
      w: Math.abs(x2 - ax),
      h: Math.abs(y2 - ay),
    };
  }

  function cropCanvas(source, label) {
    return new Promise(function (resolve) {
      var layer = document.getElementById("crop-layer");
      var stage = document.getElementById("crop-stage");
      var count = document.getElementById("crop-count");
      var error = document.getElementById("crop-error");
      var cancel = document.getElementById("crop-cancel");
      var reset = document.getElementById("crop-reset");
      var ok = document.getElementById("crop-ok");
      var shell = document.querySelector(".shell");
      var rect = { x: 0, y: 0, w: source.width, h: source.height };
      var frame = document.createElement("div");
      frame.className = "crop-frame";
      var box = document.createElement("div");
      box.className = "crop-box";
      box.tabIndex = 0;
      box.setAttribute("role", "application");
      box.setAttribute("aria-label", "裁切范围");
      var handles = ["nw", "ne", "sw", "se"];
      handles.forEach(function (name) {
        var handle = document.createElement("span");
        handle.className = "crop-handle crop-handle-" + name;
        handle.dataset.handle = name;
        box.append(handle);
      });
      frame.append(source, box);
      stage.replaceChildren(frame);
      count.textContent = label || "";
      error.hidden = true;
      layer.hidden = false;
      if (shell) shell.setAttribute("inert", "");
      var previous = document.activeElement;
      var closed = false;

      function paint() {
        box.style.left = (rect.x / source.width * 100) + "%";
        box.style.top = (rect.y / source.height * 100) + "%";
        box.style.width = (rect.w / source.width * 100) + "%";
        box.style.height = (rect.h / source.height * 100) + "%";
      }

      function fit(ratio) {
        var minW = Math.min(32, source.width);
        var minH = Math.min(32, source.height);
        if (ratio && ratio > 0) {
          var w = rect.w;
          var h = w / ratio;
          if (w < minW) { w = minW; h = w / ratio; }
          if (h < minH) { h = minH; w = h * ratio; }
          if (w > source.width) { w = source.width; h = w / ratio; }
          if (h > source.height) { h = source.height; w = h * ratio; }
          if (w > source.width) { w = source.width; h = w / ratio; }
          rect.w = w;
          rect.h = h;
        } else {
          rect.w = clamp(rect.w, minW, source.width);
          rect.h = clamp(rect.h, minH, source.height);
        }
        rect.x = clamp(rect.x, 0, Math.max(0, source.width - rect.w));
        rect.y = clamp(rect.y, 0, Math.max(0, source.height - rect.h));
        paint();
      }

      function close(result) {
        if (closed) return;
        closed = true;
        if (currentClose === close) currentClose = null;
        document.removeEventListener("keydown", onKey, true);
        cancel.removeEventListener("click", onCancel);
        reset.removeEventListener("click", onReset);
        ok.removeEventListener("click", onOk);
        layer.removeEventListener("click", onBackdrop);
        box.removeEventListener("pointerdown", onPointerDown);
        layer.hidden = true;
        stage.replaceChildren();
        if (shell) shell.removeAttribute("inert");
        if (previous && previous.focus && document.contains(previous)) previous.focus();
        resolve(result);
      }

      if (currentClose) currentClose(null);
      currentClose = close;

      function onCancel() { close(null); }

      function onReset() {
        rect = { x: 0, y: 0, w: source.width, h: source.height };
        paint();
        box.focus();
      }

      function onOk() {
        var out = document.createElement("canvas");
        var w = Math.max(1, Math.round(rect.w));
        var h = Math.max(1, Math.round(rect.h));
        out.width = w;
        out.height = h;
        out.getContext("2d").drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
        close(out);
      }

      function point(event) {
        var bounds = source.getBoundingClientRect();
        var x = (event.clientX - bounds.left) * (source.width / bounds.width);
        var y = (event.clientY - bounds.top) * (source.height / bounds.height);
        return { x: x, y: y };
      }

      function onPointerDown(event) {
        if (event.button != null && event.button !== 0) return;
        var handle = event.target && event.target.dataset ? event.target.dataset.handle : "";
        if (!handle && event.target !== box) return;
        event.preventDefault();
        box.focus();
        var start = point(event);
        var origin = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        box.setPointerCapture(event.pointerId);

        function move(ev) {
          var next = point(ev);
          var dx = next.x - start.x;
          var dy = next.y - start.y;
          if (!handle) {
            rect.x = origin.x + dx;
            rect.y = origin.y + dy;
            fit();
          } else {
            var ratio = ev.shiftKey ? origin.w / origin.h : 0;
            rect = resized(origin, handle, dx, dy, ev.shiftKey);
            fit(ratio);
          }
        }

        function up(ev) {
          box.removeEventListener("pointermove", move);
          box.removeEventListener("pointerup", up);
          box.removeEventListener("pointercancel", up);
          if (box.hasPointerCapture(ev.pointerId)) box.releasePointerCapture(ev.pointerId);
        }

        box.addEventListener("pointermove", move);
        box.addEventListener("pointerup", up);
        box.addEventListener("pointercancel", up);
      }

      function stepSize() {
        return Math.max(12, Math.round(Math.min(source.width, source.height) * 0.02));
      }

      function nudge(event) {
        var key = event.key;
        var step = stepSize();
        if (key === "ArrowLeft") rect.x -= step;
        if (key === "ArrowRight") rect.x += step;
        if (key === "ArrowUp") rect.y -= step;
        if (key === "ArrowDown") rect.y += step;
        fit();
      }

      function onBackdrop(event) {
        if (event.target === layer) onCancel();
      }

      function onKey(event) {
        if (closed) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          nudge(event);
          return;
        }
        if (event.key !== "Tab") return;
        var nodes = [box, cancel, reset, ok];
        var first = nodes[0];
        var last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      paint();
      cancel.addEventListener("click", onCancel);
      reset.addEventListener("click", onReset);
      ok.addEventListener("click", onOk);
      layer.addEventListener("click", onBackdrop);
      box.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKey, true);
      box.focus();
      requestAnimationFrame(function () {
        if (!closed) box.focus();
      });
    });
  }

  window.WBCrop = { cropCanvas: cropCanvas };
})();
