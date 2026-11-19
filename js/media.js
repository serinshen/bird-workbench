// Compress a new field photo and stamp @SerinS before it is written.
// Files that already carry the JPEG marker are returned unchanged.
// Uploads are decoded from file bytes, not from the file extension.
(function () {
  var spec = window.WBJpeg;

  function sniff(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) return "webp";
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "heif";
    return "";
  }

  function isJpeg(bytes) {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
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

  async function loadOriented(file) {
    var raw = new Uint8Array(await file.arrayBuffer());
    var kind = sniff(raw);
    if (!kind) {
      // Extension is ignored. Try the bytes anyway, then fail if they are not an image.
    }
    if (isJpeg(raw) && spec.hasMarker(raw)) {
      return { skipped: true, raw: raw, kind: "jpeg" };
    }
    var bitmap;
    try {
      bitmap = await decodeBitmap(file);
    } catch (err) {
      if (!kind) throw new Error("这张照片无法解码，没有写入。请换一张 JPEG 或 PNG。");
      throw err;
    }
    var exifOrientation = isJpeg(raw) ? spec.jpegOrientation(raw) : 1;
    var orientation = manualOrientation(bitmap, isJpeg(raw) ? spec.jpegSize(raw) : null, exifOrientation);
    var canvas = paintOriented(bitmap, orientation);
    if (bitmap.close) bitmap.close();
    return { skipped: false, canvas: canvas, kind: kind || "image" };
  }

  function packSkipped(raw) {
    return { skipped: true, blob: new Blob([raw], { type: "image/jpeg" }) };
  }

  async function finish(source) {
    var scale = Math.min(1, spec.MAX_EDGE / Math.max(source.width, source.height));
    var width = Math.max(1, Math.round(source.width * scale));
    var height = Math.max(1, Math.round(source.height * scale));
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
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
    };
  }

  window.WBMedia = {
    sniff: sniff,
    loadOriented: loadOriented,
    packSkipped: packSkipped,
    finish: finish,
  };
})();
