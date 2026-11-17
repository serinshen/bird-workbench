// JPEG comment that marks a field photo as already watermarked.
// A later upload or batch sees WBWM:@SerinS and does not stamp @SerinS again.
(function (root) {
  var TEXT = "@SerinS";
  var MARKER = "WBWM:@SerinS";
  var MAX_EDGE = 2000;
  var JPEG_QUALITY = 0.82;

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    throw new Error("不是二进制");
  }

  function hasMarker(input) {
    var bytes = asBytes(input);
    var n = MARKER.length;
    if (bytes.length < n) return false;
    outer: for (var i = 0; i <= bytes.length - n; i++) {
      for (var j = 0; j < n; j++) {
        if (bytes[i + j] !== MARKER.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }

  function appendMarker(input) {
    var bytes = asBytes(input);
    if (hasMarker(bytes)) return bytes;
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error("水印标记只能写进 JPEG");
    }
    var len = MARKER.length + 2;
    var seg = new Uint8Array(4 + MARKER.length);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg[2] = (len >> 8) & 255;
    seg[3] = len & 255;
    for (var i = 0; i < MARKER.length; i++) seg[4 + i] = MARKER.charCodeAt(i);
    var out = new Uint8Array(bytes.length + seg.length);
    out[0] = bytes[0];
    out[1] = bytes[1];
    out.set(seg, 2);
    out.set(bytes.subarray(2), 2 + seg.length);
    return out;
  }

  function u16at(u8, tiff, offset, le) {
    var a = u8[tiff + offset];
    var b = u8[tiff + offset + 1];
    return le ? (a | (b << 8)) : ((a << 8) | b);
  }

  function u32at(u8, tiff, offset, le) {
    var a = u8[tiff + offset];
    var b = u8[tiff + offset + 1];
    var c = u8[tiff + offset + 2];
    var d = u8[tiff + offset + 3];
    return le ? ((a | (b << 8) | (c << 16) | (d << 24)) >>> 0) : (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  }

  function readOrientation(u8, tiff) {
    if (tiff + 8 > u8.length) return 1;
    var le = u8[tiff] === 0x49 && u8[tiff + 1] === 0x49;
    var be = u8[tiff] === 0x4d && u8[tiff + 1] === 0x4d;
    if (!le && !be) return 1;
    if (u16at(u8, tiff, 2, le) !== 42) return 1;
    var ifd = u32at(u8, tiff, 4, le);
    if (tiff + ifd + 2 > u8.length) return 1;
    var count = u16at(u8, tiff, ifd, le);
    for (var entry = 0; entry < count; entry++) {
      var off = ifd + 2 + entry * 12;
      if (tiff + off + 10 > u8.length) break;
      if (u16at(u8, tiff, off, le) === 0x0112) {
        var value = u16at(u8, tiff, off + 8, le);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    return 1;
  }

  // Stored raster size, before the orientation tag is applied.
  function jpegSize(input) {
    var u8 = asBytes(input);
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    var i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) {
        i += 1;
        continue;
      }
      var marker = u8[i + 1];
      if (marker === 0x00) {
        i += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      var len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (u8[i + 5] << 8) | u8[i + 6],
          width: (u8[i + 7] << 8) | u8[i + 8],
        };
      }
      i += 2 + len;
    }
    return null;
  }

  // 1–8, or 1 when the file has no EXIF orientation.
  function jpegOrientation(input) {
    var u8 = asBytes(input);
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return 1;
    var i = 2;
    while (i + 4 < u8.length) {
      if (u8[i] !== 0xff) {
        i += 1;
        continue;
      }
      var marker = u8[i + 1];
      if (marker === 0x00) {
        i += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      var len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) break;
      if (marker === 0xe1 && len > 16) {
        var start = i + 4;
        if (
          u8[start] === 0x45 &&
          u8[start + 1] === 0x78 &&
          u8[start + 2] === 0x69 &&
          u8[start + 3] === 0x66 &&
          u8[start + 4] === 0x00 &&
          u8[start + 5] === 0x00
        ) {
          return readOrientation(u8, start + 6) || 1;
        }
      }
      i += 2 + len;
    }
    return 1;
  }

  var api = {
    TEXT: TEXT,
    MARKER: MARKER,
    MAX_EDGE: MAX_EDGE,
    JPEG_QUALITY: JPEG_QUALITY,
    hasMarker: hasMarker,
    appendMarker: appendMarker,
    jpegOrientation: jpegOrientation,
    jpegSize: jpegSize,
  };
  root.WBJpeg = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
