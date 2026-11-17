// Compress a new field photo and stamp @SerinS before it is written.
// Files that already carry the JPEG marker are returned unchanged.
(function () {
  var spec = window.WBJpeg;

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      var slice = bytes.subarray(i, i + 0x8000);
      var part = "";
      for (var j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
      binary += part;
    }
    return btoa(binary);
  }

  function applyOrientation(ctx, orientation, width, height) {
    switch (orientation) {
      case 2:
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
        break;
      case 3:
        ctx.translate(width, height);
        ctx.rotate(Math.PI);
        break;
      case 4:
        ctx.translate(0, height);
        ctx.scale(1, -1);
        break;
      case 5:
        ctx.rotate(0.5 * Math.PI);
        ctx.scale(1, -1);
        break;
      case 6:
        ctx.rotate(0.5 * Math.PI);
        ctx.translate(0, -height);
        break;
      case 7:
        ctx.rotate(0.5 * Math.PI);
        ctx.translate(width, -height);
        ctx.scale(-1, 1);
        break;
      case 8:
        ctx.rotate(-0.5 * Math.PI);
        ctx.translate(-width, 0);
        break;
      default:
        break;
    }
  }

  function paintOriented(bitmap, orientation) {
    var srcW = bitmap.width;
    var srcH = bitmap.height;
    var swap = orientation >= 5 && orientation <= 8;
    var canvas = document.createElement("canvas");
    canvas.width = swap ? srcH : srcW;
    canvas.height = swap ? srcW : srcH;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#F7F3EB";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    applyOrientation(ctx, orientation, srcW, srcH);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
    return canvas;
  }

  async function drawWatermark(ctx, width, height) {
    var shortSide = Math.min(width, height);
    var size = Math.max(22, Math.min(40, Math.round(shortSide * 0.028)));
    var margin = Math.max(28, Math.min(72, Math.round(shortSide * 0.04)));
    var italic = "italic " + size + "px \"Source Serif 4\", Palatino, \"Palatino Linotype\", serif";
    if (document.fonts && document.fonts.load) {
      try { await document.fonts.load(italic, spec.TEXT); } catch (err) { /* draw with the fallback */ }
    }
    ctx.save();
    ctx.font = italic;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(1.25, size * 0.045);
    ctx.strokeStyle = "rgba(58, 58, 54, 0.55)";
    ctx.fillStyle = "rgba(247, 243, 235, 0.93)";
    var x = width - margin;
    var y = height - margin;
    ctx.strokeText(spec.TEXT, x, y);
    ctx.fillText(spec.TEXT, x, y);
    ctx.restore();
  }

  async function decodeBitmap(file) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("这个浏览器不能处理照片，没有写入。");
    }
    try {
      return await createImageBitmap(file, { imageOrientation: "none" });
    } catch (err) {
      try {
        return await createImageBitmap(file);
      } catch (inner) {
        throw new Error("这张照片无法解码，没有写入。请换一张 JPEG 或 PNG。");
      }
    }
  }

  // Some browsers ignore imageOrientation:"none" and bake EXIF in already.
  // Compare the bitmap to the JPEG's stored size so the tag is applied once.
  function manualOrientation(bitmap, rawSize, exifOrientation) {
    if (!rawSize || !exifOrientation || exifOrientation === 1) return 1;
    var swaps = exifOrientation >= 5 && exifOrientation <= 8;
    var rawMatch = bitmap.width === rawSize.width && bitmap.height === rawSize.height;
    var turnedMatch = swaps && bitmap.width === rawSize.height && bitmap.height === rawSize.width;
    if (turnedMatch && !rawMatch) return 1;
    return exifOrientation;
  }

  async function prepare(file) {
    var raw = new Uint8Array(await file.arrayBuffer());
    if (spec.hasMarker(raw)) {
      return {
        skipped: true,
        width: null,
        height: null,
        blob: new Blob([raw], { type: "image/jpeg" }),
        base64: bytesToBase64(raw),
      };
    }
    var exifOrientation = spec.jpegOrientation(raw);
    var bitmap = await decodeBitmap(file);
    var orientation = manualOrientation(bitmap, spec.jpegSize(raw), exifOrientation);
    var oriented = paintOriented(bitmap, orientation);
    if (bitmap.close) bitmap.close();
    var scale = Math.min(1, spec.MAX_EDGE / Math.max(oriented.width, oriented.height));
    var width = Math.max(1, Math.round(oriented.width * scale));
    var height = Math.max(1, Math.round(oriented.height * scale));
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(oriented, 0, 0, width, height);
    await drawWatermark(ctx, width, height);
    var blob = await new Promise(function (resolve, reject) {
      canvas.toBlob(function (result) {
        if (result) resolve(result);
        else reject(new Error("照片没有压成 JPEG，没有写入。"));
      }, "image/jpeg", spec.JPEG_QUALITY);
    });
    var encoded = new Uint8Array(await blob.arrayBuffer());
    var marked = spec.appendMarker(encoded);
    return {
      skipped: false,
      width: width,
      height: height,
      blob: new Blob([marked], { type: "image/jpeg" }),
      base64: bytesToBase64(marked),
    };
  }

  window.WBMedia = { prepare: prepare };
})();
