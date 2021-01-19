// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.

// The following code is based off of text-encoding at:
// https://github.com/inexorabletash/text-encoding
//
// Anyone is free to copy, modify, publish, use, compile, sell, or
// distribute this software, either in source code form or as a compiled
// binary, for any purpose, commercial or non-commercial, and by any
// means.
//
// In jurisdictions that recognize copyright laws, the author or authors
// of this software dedicate any and all copyright interest in the
// software to the public domain. We make this dedication for the benefit
// of the public at large and to the detriment of our heirs and
// successors. We intend this dedication to be an overt act of
// relinquishment in perpetuity of all present and future rights to this
// software under copyright law.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.

((window) => {
  const core = Deno.core;

  const CONTINUE = null;
  const END_OF_STREAM = -1;
  const FINISHED = -1;

  function decoderError(fatal) {
    if (fatal) {
      throw new TypeError("Decoder error.");
    }
    return 0xfffd; // default code point
  }

  function inRange(a, min, max) {
    return min <= a && a <= max;
  }

  function isASCIIByte(a) {
    return inRange(a, 0x00, 0x7f);
  }

  function stringToCodePoints(input) {
    const u = [];
    for (const c of input) {
      u.push(c.codePointAt(0));
    }
    return u;
  }

  class UTF8Encoder {
    handler(codePoint) {
      if (codePoint === END_OF_STREAM) {
        return "finished";
      }

      if (inRange(codePoint, 0x00, 0x7f)) {
        return [codePoint];
      }

      let count;
      let offset;
      if (inRange(codePoint, 0x0080, 0x07ff)) {
        count = 1;
        offset = 0xc0;
      } else if (inRange(codePoint, 0x0800, 0xffff)) {
        count = 2;
        offset = 0xe0;
      } else if (inRange(codePoint, 0x10000, 0x10ffff)) {
        count = 3;
        offset = 0xf0;
      } else {
        throw TypeError(
          `Code point out of range: \\x${codePoint.toString(16)}`,
        );
      }

      const bytes = [(codePoint >> (6 * count)) + offset];

      while (count > 0) {
        const temp = codePoint >> (6 * (count - 1));
        bytes.push(0x80 | (temp & 0x3f));
        count--;
      }

      return bytes;
    }
  }

  function atob(s) {
    s = String(s);
    s = s.replace(/[\t\n\f\r ]/g, "");

    if (s.length % 4 === 0) {
      s = s.replace(/==?$/, "");
    }

    const rem = s.length % 4;
    if (rem === 1 || /[^+/0-9A-Za-z]/.test(s)) {
      throw new DOMException(
        "The string to be decoded is not correctly encoded",
        "InvalidCharacterError",
      );
    }

    // base64-js requires length exactly times of 4
    if (rem > 0) {
      s = s.padEnd(s.length + (4 - rem), "=");
    }

    const byteArray = base64.toByteArray(s);
    let result = "";
    for (let i = 0; i < byteArray.length; i++) {
      result += String.fromCharCode(byteArray[i]);
    }
    return result;
  }

  function btoa(s) {
    const byteArray = [];
    for (let i = 0; i < s.length; i++) {
      const charCode = s[i].charCodeAt(0);
      if (charCode > 0xff) {
        throw new TypeError(
          "The string to be encoded contains characters " +
            "outside of the Latin1 range.",
        );
      }
      byteArray.push(charCode);
    }
    const result = base64.fromByteArray(Uint8Array.from(byteArray));
    return result;
  }

  function Big5Decoder(big5, bytes, fatal = false, ignoreBOM = false) {
    if (ignoreBOM) {
      throw new TypeError("Ignoring the BOM is available only with utf-8.");
    }
    const res = [];
    let lead = 0x00;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (lead !== 0x00) {
        let pointer = null;
        const offset = byte < 0x7f ? 0x40 : 0x62;
        const leadCopy = lead;
        lead = 0x00;
        if (inRange(byte, 0x40, 0x7e) || inRange(byte, 0xa1, 0xfe)) {
          pointer = (leadCopy - 0x81) * 157 + (byte - offset);
        }
        if (pointer === 1133) {
          res.push(202);
          continue;
        }
        if (pointer === 1135) {
          res.push(202);
          continue;
        }
        if (pointer === 1164) {
          res.push(234);
          continue;
        }
        if (pointer === 1166) {
          res.push(234);
          continue;
        }
        const code = pointer === null ? null : big5[pointer];
        if (code === null && isASCIIByte(byte)) {
          i--;
        }
        if (code === null) {
          res.push(decoderError(fatal));
          continue;
        }
        res.push(code);
        continue;
      }
      if (isASCIIByte(byte)) {
        res.push(byte);
        continue;
      }
      if (inRange(byte, 0x81, 0xFE)) {
        lead = byte;
        continue;
      }
      res.push(decoderError(fatal));
      continue;
    }
    if (lead !== 0x00) {
      lead = 0x00;
      res.push(decoderError(fatal));
    }
    return res;
  }

  function Utf16ByteDecoder(
    bytes,
    be = false,
    fatal = false,
    ignoreBOM = false,
  ) {
    let leadByte = null;
    let leadSurrogate = null;
    const result = [];

    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (leadByte === null) {
        leadByte = byte;
        continue;
      }
      const codeUnit = be ? (leadByte << 8) + byte : (byte << 8) + leadByte;
      leadByte = null;
      if (codeUnit === 65279 && !ignoreBOM) {
        continue;
      }
      if (leadSurrogate !== null) {
        if (inRange(codeUnit, 0xDC00, 0xDFFF)) {
          result.push(leadSurrogate, codeUnit);
          leadSurrogate = null;
          continue;
        }
        leadSurrogate = null;
        const byte1 = codeUnit >> 8;
        const byte2 = codeUnit & 0xFF;
        result.push(decoderError(fatal));
        result.push(byte1 & byte2);
        continue;
      }
      if (inRange(codeUnit, 0xD800, 0xDBFF)) {
        leadSurrogate = codeUnit;
        continue;
      }
      if (inRange(codeUnit, 0xDC00, 0xDFFF)) {
        result.push(decoderError(fatal));
        continue;
      }
      result.push(codeUnit);
    }
    if (!(leadByte === null && leadSurrogate === null)) {
      result.push(decoderError(fatal));
    }
    return result;
  }

  class SingleByteDecoder {
    #index = [];
    #fatal = false;

    constructor(index, { ignoreBOM = false, fatal = false } = {}) {
      if (ignoreBOM) {
        throw new TypeError("Ignoring the BOM is available only with utf-8.");
      }
      this.#fatal = fatal;
      this.#index = index;
    }
    handler(_stream, byte) {
      if (byte === END_OF_STREAM) {
        return FINISHED;
      }
      if (isASCIIByte(byte)) {
        return byte;
      }
      const codePoint = this.#index[byte - 0x80];

      if (codePoint == null) {
        return decoderError(this.#fatal);
      }

      return codePoint;
    }
  }

  // The encodingMap is a hash of labels that are indexed by the conical
  // encoding.
  const encodingMap = {
    "utf-8": [
      "unicode-1-1-utf-8",
      "unicode11utf8",
      "unicode20utf8",
      "utf-8",
      "utf8",
      "x-unicode20utf8",
    ],
    ibm866: ["866", "cp866", "csibm866", "ibm866"],
    "iso-8859-2": [
      "csisolatin2",
      "iso-8859-2",
      "iso-ir-101",
      "iso8859-2",
      "iso88592",
      "iso_8859-2",
      "iso_8859-2:1987",
      "l2",
      "latin2",
    ],
    "iso-8859-3": [
      "csisolatin3",
      "iso-8859-3",
      "iso-ir-109",
      "iso8859-3",
      "iso88593",
      "iso_8859-3",
      "iso_8859-3:1988",
      "l3",
      "latin3",
    ],
    "iso-8859-4": [
      "csisolatin4",
      "iso-8859-4",
      "iso-ir-110",
      "iso8859-4",
      "iso88594",
      "iso_8859-4",
      "iso_8859-4:1988",
      "l4",
      "latin4",
    ],
    "iso-8859-5": [
      "csisolatincyrillic",
      "cyrillic",
      "iso-8859-5",
      "iso-ir-144",
      "iso8859-5",
      "iso88595",
      "iso_8859-5",
      "iso_8859-5:1988",
    ],
    "iso-8859-6": [
      "arabic",
      "asmo-708",
      "csiso88596e",
      "csiso88596i",
      "csisolatinarabic",
      "ecma-114",
      "iso-8859-6",
      "iso-8859-6-e",
      "iso-8859-6-i",
      "iso-ir-127",
      "iso8859-6",
      "iso88596",
      "iso_8859-6",
      "iso_8859-6:1987",
    ],
    "iso-8859-7": [
      "csisolatingreek",
      "ecma-118",
      "elot_928",
      "greek",
      "greek8",
      "iso-8859-7",
      "iso-ir-126",
      "iso8859-7",
      "iso88597",
      "iso_8859-7",
      "iso_8859-7:1987",
      "sun_eu_greek",
    ],
    "iso-8859-8": [
      "csiso88598e",
      "csisolatinhebrew",
      "hebrew",
      "iso-8859-8",
      "iso-8859-8-e",
      "iso-ir-138",
      "iso8859-8",
      "iso88598",
      "iso_8859-8",
      "iso_8859-8:1988",
      "visual",
    ],
    "iso-8859-8-i": [
      "csiso88598i",
      "iso-8859-8-i",
      "logical",
    ],
    "iso-8859-10": [
      "csisolatin6",
      "iso-8859-10",
      "iso-ir-157",
      "iso8859-10",
      "iso885910",
      "l6",
      "latin6",
    ],
    "iso-8859-13": ["iso-8859-13", "iso8859-13", "iso885913"],
    "iso-8859-14": ["iso-8859-14", "iso8859-14", "iso885914"],
    "iso-8859-15": [
      "csisolatin9",
      "iso-8859-15",
      "iso8859-15",
      "iso885915",
      "iso_8859-15",
      "l9",
    ],
    "iso-8859-16": ["iso-8859-16"],
    "koi8-r": ["cskoi8r", "koi", "koi8", "koi8-r", "koi8_r"],
    "koi8-u": ["koi8-ru", "koi8-u"],
    macintosh: ["csmacintosh", "mac", "macintosh", "x-mac-roman"],
    "windows-874": [
      "dos-874",
      "iso-8859-11",
      "iso8859-11",
      "iso885911",
      "tis-620",
      "windows-874",
    ],
    "windows-1250": ["cp1250", "windows-1250", "x-cp1250"],
    "windows-1251": ["cp1251", "windows-1251", "x-cp1251"],
    "windows-1252": [
      "ansi_x3.4-1968",
      "ascii",
      "cp1252",
      "cp819",
      "csisolatin1",
      "ibm819",
      "iso-8859-1",
      "iso-ir-100",
      "iso8859-1",
      "iso88591",
      "iso_8859-1",
      "iso_8859-1:1987",
      "l1",
      "latin1",
      "us-ascii",
      "windows-1252",
      "x-cp1252",
    ],
    "windows-1253": ["cp1253", "windows-1253", "x-cp1253"],
    "windows-1254": [
      "cp1254",
      "csisolatin5",
      "iso-8859-9",
      "iso-ir-148",
      "iso8859-9",
      "iso88599",
      "iso_8859-9",
      "iso_8859-9:1989",
      "l5",
      "latin5",
      "windows-1254",
      "x-cp1254",
    ],
    "windows-1255": ["cp1255", "windows-1255", "x-cp1255"],
    "windows-1256": ["cp1256", "windows-1256", "x-cp1256"],
    "windows-1257": ["cp1257", "windows-1257", "x-cp1257"],
    "windows-1258": ["cp1258", "windows-1258", "x-cp1258"],
    "x-mac-cyrillic": ["x-mac-cyrillic", "x-mac-ukrainian"],
    gbk: [
      "chinese",
      "csgb2312",
      "csiso58gb231280",
      "gb2312",
      "gb_2312",
      "gb_2312-80",
      "gbk",
      "iso-ir-58",
      "x-gbk",
    ],
    gb18030: ["gb18030"],
    big5: ["big5", "big5-hkscs", "cn-big5", "csbig5", "x-x-big5"],
    "utf-16be": ["unicodefffe", "utf-16be"],
    "utf-16le": [
      "csunicode",
      "iso-10646-ucs-2",
      "ucs-2",
      "unicode",
      "unicodefeff",
      "utf-16",
      "utf-16le",
    ],
  };
  // We convert these into a Map where every label resolves to its canonical
  // encoding type.
  const encodings = new Map();
  for (const key of Object.keys(encodingMap)) {
    const labels = encodingMap[key];
    for (const label of labels) {
      encodings.set(label, key);
    }
  }

  // A map of functions that return new instances of a decoder indexed by the
  // encoding type.
  const decoders = new Map();

  // Single byte decoders are an array of code point lookups
  const encodingIndexes = new Map();
  // deno-fmt-ignore
  encodingIndexes.set("windows-1252", [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710,
    8240, 352, 8249, 338, 141, 381, 143, 144,
    8216, 8217, 8220, 8221, 8226, 8211, 8212, 732,
    8482, 353, 8250, 339, 157, 382, 376, 160,
    161, 162, 163, 164, 165, 166, 167, 168,
    169, 170, 171, 172, 173, 174, 175, 176,
    177, 178, 179, 180, 181, 182, 183, 184,
    185, 186, 187, 188, 189, 190, 191, 192,
    193, 194, 195, 196, 197, 198, 199, 200,
    201, 202, 203, 204, 205, 206, 207, 208,
    209, 210, 211, 212, 213, 214, 215, 216,
    217, 218, 219, 220, 221, 222, 223, 224,
    225, 226, 227, 228, 229, 230, 231, 232,
    233, 234, 235, 236, 237, 238, 239, 240,
    241, 242, 243, 244, 245, 246, 247, 248,
    249, 250, 251, 252, 253, 254, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("ibm866", [
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047,
    1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
    1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063,
    1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
    1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
    1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
    9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558,
    9557, 9571, 9553, 9559, 9565, 9564, 9563, 9488,
    9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567,
    9562, 9556, 9577, 9574, 9568, 9552, 9580, 9575,
    9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579,
    9578, 9496, 9484, 9608, 9604, 9612, 9616, 9600,
    1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095,
    1096, 1097, 1098, 1099, 1100, 1101, 1102, 1103,
    1025, 1105, 1028, 1108, 1031, 1111, 1038, 1118,
    176, 8729, 183, 8730, 8470, 164, 9632, 160,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-2", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 260, 728, 321, 164, 317, 346, 167,
    168, 352, 350, 356, 377, 173, 381, 379,
    176, 261, 731, 322, 180, 318, 347, 711,
    184, 353, 351, 357, 378, 733, 382, 380,
    340, 193, 194, 258, 196, 313, 262, 199,
    268, 201, 280, 203, 282, 205, 206, 270,
    272, 323, 327, 211, 212, 336, 214, 215,
    344, 366, 218, 368, 220, 221, 354, 223,
    341, 225, 226, 259, 228, 314, 263, 231,
    269, 233, 281, 235, 283, 237, 238, 271,
    273, 324, 328, 243, 244, 337, 246, 247,
    345, 367, 250, 369, 252, 253, 355, 729,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-3", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 294, 728, 163, 164, null, 292, 167,
    168, 304, 350, 286, 308, 173, null, 379,
    176, 295, 178, 179, 180, 181, 293, 183,
    184, 305, 351, 287, 309, 189, null, 380,
    192, 193, 194, null, 196, 266, 264, 199,
    200, 201, 202, 203, 204, 205, 206, 207,
    null, 209, 210, 211, 212, 288, 214, 215,
    284, 217, 218, 219, 220, 364, 348, 223,
    224, 225, 226, null, 228, 267, 265, 231,
    232, 233, 234, 235, 236, 237, 238, 239,
    null, 241, 242, 243, 244, 289, 246, 247,
    285, 249, 250, 251, 252, 365, 349, 729,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-4", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 260, 312, 342, 164, 296, 315, 167,
    168, 352, 274, 290, 358, 173, 381, 175,
    176, 261, 731, 343, 180, 297, 316, 711,
    184, 353, 275, 291, 359, 330, 382, 331,
    256, 193, 194, 195, 196, 197, 198, 302,
    268, 201, 280, 203, 278, 205, 206, 298,
    272, 325, 332, 310, 212, 213, 214, 215,
    216, 370, 218, 219, 220, 360, 362, 223,
    257, 225, 226, 227, 228, 229, 230, 303,
    269, 233, 281, 235, 279, 237, 238, 299,
    273, 326, 333, 311, 244, 245, 246, 247,
    248, 371, 250, 251, 252, 361, 363, 729,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-5", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 1025, 1026, 1027, 1028, 1029, 1030, 1031,
    1032, 1033, 1034, 1035, 1036, 173, 1038, 1039,
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047,
    1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
    1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063,
    1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
    1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
    1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
    1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095,
    1096, 1097, 1098, 1099, 1100, 1101, 1102, 1103,
    8470, 1105, 1106, 1107, 1108, 1109, 1110, 1111,
    1112, 1113, 1114, 1115, 1116, 167, 1118, 1119,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-6", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, null, null, null, 164, null, null, null,
    null, null, null, null, 1548, 173, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null, 1563, null, null, null, 1567,
    null, 1569, 1570, 1571, 1572, 1573, 1574, 1575,
    1576, 1577, 1578, 1579, 1580, 1581, 1582, 1583,
    1584, 1585, 1586, 1587, 1588, 1589, 1590, 1591,
    1592, 1593, 1594, null, null, null, null, null,
    1600, 1601, 1602, 1603, 1604, 1605, 1606, 1607,
    1608, 1609, 1610, 1611, 1612, 1613, 1614, 1615,
    1616, 1617, 1618, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-7", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 8216, 8217, 163, 8364, 8367, 166, 167,
    168, 169, 890, 171, 172, 173, null, 8213,
    176, 177, 178, 179, 900, 901, 902, 183,
    904, 905, 906, 187, 908, 189, 910, 911,
    912, 913, 914, 915, 916, 917, 918, 919,
    920, 921, 922, 923, 924, 925, 926, 927,
    928, 929, null, 931, 932, 933, 934, 935,
    936, 937, 938, 939, 940, 941, 942, 943,
    944, 945, 946, 947, 948, 949, 950, 951,
    952, 953, 954, 955, 956, 957, 958, 959,
    960, 961, 962, 963, 964, 965, 966, 967,
    968, 969, 970, 971, 972, 973, 974, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-8", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, null, 162, 163, 164, 165, 166, 167,
    168, 169, 215, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 247, 187, 188, 189, 190, null,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, 8215,
    1488, 1489, 1490, 1491, 1492, 1493, 1494, 1495,
    1496, 1497, 1498, 1499, 1500, 1501, 1502, 1503,
    1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511,
    1512, 1513, 1514, null, null, 8206, 8207, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-8-i", [
      128, 129, 130, 131, 132, 133, 134, 135,
      136, 137, 138, 139, 140, 141, 142, 143,
      144, 145, 146, 147, 148, 149, 150, 151,
      152, 153, 154, 155, 156, 157, 158, 159,
      160, null, 162, 163, 164, 165, 166, 167,
      168, 169, 215, 171, 172, 173, 174, 175,
      176, 177, 178, 179, 180, 181, 182, 183,
      184, 185, 247, 187, 188, 189, 190, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, 8215,
      1488, 1489, 1490, 1491, 1492, 1493, 1494, 1495,
      1496, 1497, 1498, 1499, 1500, 1501, 1502, 1503,
      1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511,
      1512, 1513, 1514, null, null, 8206, 8207, null,
    ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-10", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 260, 274, 290, 298, 296, 310, 167,
    315, 272, 352, 358, 381, 173, 362, 330,
    176, 261, 275, 291, 299, 297, 311, 183,
    316, 273, 353, 359, 382, 8213, 363, 331,
    256, 193, 194, 195, 196, 197, 198, 302,
    268, 201, 280, 203, 278, 205, 206, 207,
    208, 325, 332, 211, 212, 213, 214, 360,
    216, 370, 218, 219, 220, 221, 222, 223,
    257, 225, 226, 227, 228, 229, 230, 303,
    269, 233, 281, 235, 279, 237, 238, 239,
    240, 326, 333, 243, 244, 245, 246, 361,
    248, 371, 250, 251, 252, 253, 254, 312,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-13", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 8221, 162, 163, 164, 8222, 166, 167,
    216, 169, 342, 171, 172, 173, 174, 198,
    176, 177, 178, 179, 8220, 181, 182, 183,
    248, 185, 343, 187, 188, 189, 190, 230,
    260, 302, 256, 262, 196, 197, 280, 274,
    268, 201, 377, 278, 290, 310, 298, 315,
    352, 323, 325, 211, 332, 213, 214, 215,
    370, 321, 346, 362, 220, 379, 381, 223,
    261, 303, 257, 263, 228, 229, 281, 275,
    269, 233, 378, 279, 291, 311, 299, 316,
    353, 324, 326, 243, 333, 245, 246, 247,
    371, 322, 347, 363, 252, 380, 382, 8217,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-14", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 7682, 7683, 163, 266, 267, 7690, 167,
    7808, 169, 7810, 7691, 7922, 173, 174, 376,
    7710, 7711, 288, 289, 7744, 7745, 182, 7766,
    7809, 7767, 7811, 7776, 7923, 7812, 7813, 7777,
    192, 193, 194, 195, 196, 197, 198, 199,
    200, 201, 202, 203, 204, 205, 206, 207,
    372, 209, 210, 211, 212, 213, 214, 7786,
    216, 217, 218, 219, 220, 221, 374, 223,
    224, 225, 226, 227, 228, 229, 230, 231,
    232, 233, 234, 235, 236, 237, 238, 239,
    373, 241, 242, 243, 244, 245, 246, 7787,
    248, 249, 250, 251, 252, 253, 375, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-15", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 161, 162, 163, 8364, 165, 352, 167,
    353, 169, 170, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 381, 181, 182, 183,
    382, 185, 186, 187, 338, 339, 376, 191,
    192, 193, 194, 195, 196, 197, 198, 199,
    200, 201, 202, 203, 204, 205, 206, 207,
    208, 209, 210, 211, 212, 213, 214, 215,
    216, 217, 218, 219, 220, 221, 222, 223,
    224, 225, 226, 227, 228, 229, 230, 231,
    232, 233, 234, 235, 236, 237, 238, 239,
    240, 241, 242, 243, 244, 245, 246, 247,
    248, 249, 250, 251, 252, 253, 254, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("iso-8859-16", [
    128, 129, 130, 131, 132, 133, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 145, 146, 147, 148, 149, 150, 151,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 260, 261, 321, 8364, 8222, 352, 167,
    353, 169, 536, 171, 377, 173, 378, 379,
    176, 177, 268, 322, 381, 8221, 182, 183,
    382, 269, 537, 187, 338, 339, 376, 380,
    192, 193, 194, 258, 196, 262, 198, 199,
    200, 201, 202, 203, 204, 205, 206, 207,
    272, 323, 210, 211, 212, 336, 214, 346,
    368, 217, 218, 219, 220, 280, 538, 223,
    224, 225, 226, 259, 228, 263, 230, 231,
    232, 233, 234, 235, 236, 237, 238, 239,
    273, 324, 242, 243, 244, 337, 246, 347,
    369, 249, 250, 251, 252, 281, 539, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("koi8-r", [
    9472, 9474, 9484, 9488, 9492, 9496, 9500, 9508,
    9516, 9524, 9532, 9600, 9604, 9608, 9612, 9616,
    9617, 9618, 9619, 8992, 9632, 8729, 8730, 8776,
    8804, 8805, 160, 8993, 176, 178, 183, 247,
    9552, 9553, 9554, 1105, 9555, 9556, 9557, 9558,
    9559, 9560, 9561, 9562, 9563, 9564, 9565, 9566,
    9567, 9568, 9569, 1025, 9570, 9571, 9572, 9573,
    9574, 9575, 9576, 9577, 9578, 9579, 9580, 169,
    1102, 1072, 1073, 1094, 1076, 1077, 1092, 1075,
    1093, 1080, 1081, 1082, 1083, 1084, 1085, 1086,
    1087, 1103, 1088, 1089, 1090, 1091, 1078, 1074,
    1100, 1099, 1079, 1096, 1101, 1097, 1095, 1098,
    1070, 1040, 1041, 1062, 1044, 1045, 1060, 1043,
    1061, 1048, 1049, 1050, 1051, 1052, 1053, 1054,
    1055, 1071, 1056, 1057, 1058, 1059, 1046, 1042,
    1068, 1067, 1047, 1064, 1069, 1065, 1063, 1066,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("koi8-u", [
    9472, 9474, 9484, 9488, 9492, 9496, 9500, 9508,
    9516, 9524, 9532, 9600, 9604, 9608, 9612, 9616,
    9617, 9618, 9619, 8992, 9632, 8729, 8730, 8776,
    8804, 8805, 160, 8993, 176, 178, 183, 247,
    9552, 9553, 9554, 1105, 1108, 9556, 1110, 1111,
    9559, 9560, 9561, 9562, 9563, 1169, 1118, 9566,
    9567, 9568, 9569, 1025, 1028, 9571, 1030, 1031,
    9574, 9575, 9576, 9577, 9578, 1168, 1038, 169,
    1102, 1072, 1073, 1094, 1076, 1077, 1092, 1075,
    1093, 1080, 1081, 1082, 1083, 1084, 1085, 1086,
    1087, 1103, 1088, 1089, 1090, 1091, 1078, 1074,
    1100, 1099, 1079, 1096, 1101, 1097, 1095, 1098,
    1070, 1040, 1041, 1062, 1044, 1045, 1060, 1043,
    1061, 1048, 1049, 1050, 1051, 1052, 1053, 1054,
    1055, 1071, 1056, 1057, 1058, 1059, 1046, 1042,
    1068, 1067, 1047, 1064, 1069, 1065, 1063, 1066,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("macintosh", [
    196, 197, 199, 201, 209, 214, 220, 225,
    224, 226, 228, 227, 229, 231, 233, 232,
    234, 235, 237, 236, 238, 239, 241, 243,
    242, 244, 246, 245, 250, 249, 251, 252,
    8224, 176, 162, 163, 167, 8226, 182, 223,
    174, 169, 8482, 180, 168, 8800, 198, 216,
    8734, 177, 8804, 8805, 165, 181, 8706, 8721,
    8719, 960, 8747, 170, 186, 937, 230, 248,
    191, 161, 172, 8730, 402, 8776, 8710, 171,
    187, 8230, 160, 192, 195, 213, 338, 339,
    8211, 8212, 8220, 8221, 8216, 8217, 247, 9674,
    255, 376, 8260, 8364, 8249, 8250, 64257, 64258,
    8225, 183, 8218, 8222, 8240, 194, 202, 193,
    203, 200, 205, 206, 207, 204, 211, 212,
    63743, 210, 218, 219, 217, 305, 710, 732,
    175, 728, 729, 730, 184, 733, 731, 711,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-874", [
    8364, 129, 130, 131, 132, 8230, 134, 135,
    136, 137, 138, 139, 140, 141, 142, 143,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    152, 153, 154, 155, 156, 157, 158, 159,
    160, 3585, 3586, 3587, 3588, 3589, 3590, 3591,
    3592, 3593, 3594, 3595, 3596, 3597, 3598, 3599,
    3600, 3601, 3602, 3603, 3604, 3605, 3606, 3607,
    3608, 3609, 3610, 3611, 3612, 3613, 3614, 3615,
    3616, 3617, 3618, 3619, 3620, 3621, 3622, 3623,
    3624, 3625, 3626, 3627, 3628, 3629, 3630, 3631,
    3632, 3633, 3634, 3635, 3636, 3637, 3638, 3639,
    3640, 3641, 3642, null, null, null, null, 3647,
    3648, 3649, 3650, 3651, 3652, 3653, 3654, 3655,
    3656, 3657, 3658, 3659, 3660, 3661, 3662, 3663,
    3664, 3665, 3666, 3667, 3668, 3669, 3670, 3671,
    3672, 3673, 3674, 3675, null, null, null, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1250", [
    8364, 129, 8218, 131, 8222, 8230, 8224, 8225,
    136, 8240, 352, 8249, 346, 356, 381, 377,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    152, 8482, 353, 8250, 347, 357, 382, 378,
    160, 711, 728, 321, 164, 260, 166, 167,
    168, 169, 350, 171, 172, 173, 174, 379,
    176, 177, 731, 322, 180, 181, 182, 183,
    184, 261, 351, 187, 317, 733, 318, 380,
    340, 193, 194, 258, 196, 313, 262, 199,
    268, 201, 280, 203, 282, 205, 206, 270,
    272, 323, 327, 211, 212, 336, 214, 215,
    344, 366, 218, 368, 220, 221, 354, 223,
    341, 225, 226, 259, 228, 314, 263, 231,
    269, 233, 281, 235, 283, 237, 238, 271,
    273, 324, 328, 243, 244, 337, 246, 247,
    345, 367, 250, 369, 252, 253, 355, 729,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1251", [
    1026, 1027, 8218, 1107, 8222, 8230, 8224, 8225,
    8364, 8240, 1033, 8249, 1034, 1036, 1035, 1039,
    1106, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    152, 8482, 1113, 8250, 1114, 1116, 1115, 1119,
    160, 1038, 1118, 1032, 164, 1168, 166, 167,
    1025, 169, 1028, 171, 172, 173, 174, 1031,
    176, 177, 1030, 1110, 1169, 181, 182, 183,
    1105, 8470, 1108, 187, 1112, 1029, 1109, 1111,
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047,
    1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
    1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063,
    1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
    1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
    1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
    1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095,
    1096, 1097, 1098, 1099, 1100, 1101, 1102, 1103,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1253", [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225,
    136, 8240, 138, 8249, 140, 141, 142, 143,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    152, 8482, 154, 8250, 156, 157, 158, 159,
    160, 901, 902, 163, 164, 165, 166, 167,
    168, 169, null, 171, 172, 173, 174, 8213,
    176, 177, 178, 179, 900, 181, 182, 183,
    904, 905, 906, 187, 908, 189, 910, 911,
    912, 913, 914, 915, 916, 917, 918, 919,
    920, 921, 922, 923, 924, 925, 926, 927,
    928, 929, null, 931, 932, 933, 934, 935,
    936, 937, 938, 939, 940, 941, 942, 943,
    944, 945, 946, 947, 948, 949, 950, 951,
    952, 953, 954, 955, 956, 957, 958, 959,
    960, 961, 962, 963, 964, 965, 966, 967,
    968, 969, 970, 971, 972, 973, 974, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1254", [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225,
    710, 8240, 352, 8249, 338, 141, 142, 143,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    732, 8482, 353, 8250, 339, 157, 158, 376,
    160, 161, 162, 163, 164, 165, 166, 167,
    168, 169, 170, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 186, 187, 188, 189, 190, 191,
    192, 193, 194, 195, 196, 197, 198, 199,
    200, 201, 202, 203, 204, 205, 206, 207,
    286, 209, 210, 211, 212, 213, 214, 215,
    216, 217, 218, 219, 220, 304, 350, 223,
    224, 225, 226, 227, 228, 229, 230, 231,
    232, 233, 234, 235, 236, 237, 238, 239,
    287, 241, 242, 243, 244, 245, 246, 247,
    248, 249, 250, 251, 252, 305, 351, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1255", [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225,
    710, 8240, 138, 8249, 140, 141, 142, 143,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    732, 8482, 154, 8250, 156, 157, 158, 159,
    160, 161, 162, 163, 8362, 165, 166, 167,
    168, 169, 215, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 247, 187, 188, 189, 190, 191,
    1456, 1457, 1458, 1459, 1460, 1461, 1462, 1463,
    1464, 1465, 1466, 1467, 1468, 1469, 1470, 1471,
    1472, 1473, 1474, 1475, 1520, 1521, 1522, 1523,
    1524, null, null, null, null, null, null, null,
    1488, 1489, 1490, 1491, 1492, 1493, 1494, 1495,
    1496, 1497, 1498, 1499, 1500, 1501, 1502, 1503,
    1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511,
    1512, 1513, 1514, null, null, 8206, 8207, null,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1256", [
    8364, 1662, 8218, 402, 8222, 8230, 8224, 8225,
    710, 8240, 1657, 8249, 338, 1670, 1688, 1672,
    1711, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    1705, 8482, 1681, 8250, 339, 8204, 8205, 1722,
    160, 1548, 162, 163, 164, 165, 166, 167,
    168, 169, 1726, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 1563, 187, 188, 189, 190, 1567,
    1729, 1569, 1570, 1571, 1572, 1573, 1574, 1575,
    1576, 1577, 1578, 1579, 1580, 1581, 1582, 1583,
    1584, 1585, 1586, 1587, 1588, 1589, 1590, 215,
    1591, 1592, 1593, 1594, 1600, 1601, 1602, 1603,
    224, 1604, 226, 1605, 1606, 1607, 1608, 231,
    232, 233, 234, 235, 1609, 1610, 238, 239,
    1611, 1612, 1613, 1614, 244, 1615, 1616, 247,
    1617, 249, 1618, 251, 252, 8206, 8207, 1746,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1257", [
    8364, 129, 8218, 131, 8222, 8230, 8224, 8225,
    136, 8240, 138, 8249, 140, 168, 711, 184,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    152, 8482, 154, 8250, 156, 175, 731, 159,
    160, null, 162, 163, 164, null, 166, 167,
    216, 169, 342, 171, 172, 173, 174, 198,
    176, 177, 178, 179, 180, 181, 182, 183,
    248, 185, 343, 187, 188, 189, 190, 230,
    260, 302, 256, 262, 196, 197, 280, 274,
    268, 201, 377, 278, 290, 310, 298, 315,
    352, 323, 325, 211, 332, 213, 214, 215,
    370, 321, 346, 362, 220, 379, 381, 223,
    261, 303, 257, 263, 228, 229, 281, 275,
    269, 233, 378, 279, 291, 311, 299, 316,
    353, 324, 326, 243, 333, 245, 246, 247,
    371, 322, 347, 363, 252, 380, 382, 729,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("windows-1258", [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225,
    710, 8240, 138, 8249, 338, 141, 142, 143,
    144, 8216, 8217, 8220, 8221, 8226, 8211, 8212,
    732, 8482, 154, 8250, 339, 157, 158, 376,
    160, 161, 162, 163, 164, 165, 166, 167,
    168, 169, 170, 171, 172, 173, 174, 175,
    176, 177, 178, 179, 180, 181, 182, 183,
    184, 185, 186, 187, 188, 189, 190, 191,
    192, 193, 194, 258, 196, 197, 198, 199,
    200, 201, 202, 203, 768, 205, 206, 207,
    272, 209, 777, 211, 212, 416, 214, 215,
    216, 217, 218, 219, 220, 431, 771, 223,
    224, 225, 226, 259, 228, 229, 230, 231,
    232, 233, 234, 235, 769, 237, 238, 239,
    273, 241, 803, 243, 244, 417, 246, 247,
    248, 249, 250, 251, 252, 432, 8363, 255,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("x-mac-cyrillic", [
    1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047,
    1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055,
    1056, 1057, 1058, 1059, 1060, 1061, 1062, 1063,
    1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071,
    8224, 176, 1168, 163, 167, 8226, 182, 1030,
    174, 169, 8482, 1026, 1106, 8800, 1027, 1107,
    8734, 177, 8804, 8805, 1110, 181, 1169, 1032,
    1028, 1108, 1031, 1111, 1033, 1113, 1034, 1114,
    1112, 1029, 172, 8730, 402, 8776, 8710, 171,
    187, 8230, 160, 1035, 1115, 1036, 1116, 1109,
    8211, 8212, 8220, 8221, 8216, 8217, 247, 8222,
    1038, 1118, 1039, 1119, 8470, 1025, 1105, 1103,
    1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
    1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087,
    1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095,
    1096, 1097, 1098, 1099, 1100, 1101, 1102, 8364,
  ]);

  // deno-fmt-ignore
  encodingIndexes.set("big5", [
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   17392,  19506,  17923,  17830,  17784,  160359, 19831,  17843,  162993, 19682,  163013, 15253,  18230,  18244,  19527,  19520,  148159, 144919, 
    160594, 159371, 159954, 19543,  172881, 18255,  17882,  19589,  162924, 19719,  19108,  18081,  158499, 29221,  154196, 137827, 146950, 147297, 26189,  22267,  
    null,   32149,  22813,  166841, 15860,  38708,  162799, 23515,  138590, 23204,  13861,  171696, 23249,  23479,  23804,  26478,  34195,  170309, 29793,  29853,  
    14453,  138579, 145054, 155681, 16108,  153822, 15093,  31484,  40855,  147809, 166157, 143850, 133770, 143966, 17162,  33924,  40854,  37935,  18736,  34323,  
    22678,  38730,  37400,  31184,  31282,  26208,  27177,  34973,  29772,  31685,  26498,  31276,  21071,  36934,  13542,  29636,  155065, 29894,  40903,  22451,  
    18735,  21580,  16689,  145038, 22552,  31346,  162661, 35727,  18094,  159368, 16769,  155033, 31662,  140476, 40904,  140481, 140489, 140492, 40905,  34052,  
    144827, 16564,  40906,  17633,  175615, 25281,  28782,  40907,  null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   12736,  
    12737,  12738,  12739,  12740,  131340, 12741,  131281, 131277, 12742,  12743,  131275, 139240, 12744,  131274, 12745,  12746,  12747,  12748,  131342, 12749,  
    12750,  256,    193,    461,    192,    274,    201,    282,    200,    332,    211,    465,    210,    null,   7870,   null,   7872,   202,    257,    225,    
    462,    224,    593,    275,    233,    283,    232,    299,    237,    464,    236,    333,    243,    466,    242,    363,    250,    468,    249,    470,    
    472,    474,    476,    252,    null,   7871,   null,   7873,   234,    609,    9178,   9179,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   172969, 135493, null,   25866,  
    null,   null,   20029,  28381,  40270,  37343,  null,   null,   161589, 25745,  20250,  20264,  20392,  20822,  20852,  20892,  20964,  21153,  21160,  21307,  
    21326,  21457,  21464,  22242,  22768,  22788,  22791,  22834,  22836,  23398,  23454,  23455,  23706,  24198,  24635,  25993,  26622,  26628,  26725,  27982,  
    28860,  30005,  32420,  32428,  32442,  32455,  32463,  32479,  32518,  32567,  33402,  33487,  33647,  35270,  35774,  35810,  36710,  36711,  36718,  29713,  
    31996,  32205,  26950,  31433,  21031,  null,   null,   null,   null,   37260,  30904,  37214,  32956,  null,   36107,  33014,  133607, null,   null,   32927,  
    40647,  19661,  40393,  40460,  19518,  171510, 159758, 40458,  172339, 13761,  null,   28314,  33342,  29977,  null,   18705,  39532,  39567,  40857,  31111,  
    164972, 138698, 132560, 142054, 20004,  20097,  20096,  20103,  20159,  20203,  20279,  13388,  20413,  15944,  20483,  20616,  13437,  13459,  13477,  20870,  
    22789,  20955,  20988,  20997,  20105,  21113,  21136,  21287,  13767,  21417,  13649,  21424,  13651,  21442,  21539,  13677,  13682,  13953,  21651,  21667,  
    21684,  21689,  21712,  21743,  21784,  21795,  21800,  13720,  21823,  13733,  13759,  21975,  13765,  163204, 21797,  null,   134210, 134421, 151851, 21904,  
    142534, 14828,  131905, 36422,  150968, 169189, 16467,  164030, 30586,  142392, 14900,  18389,  164189, 158194, 151018, 25821,  134524, 135092, 134357, 135412, 
    25741,  36478,  134806, 134155, 135012, 142505, 164438, 148691, null,   134470, 170573, 164073, 18420,  151207, 142530, 39602,  14951,  169460, 16365,  13574,  
    152263, 169940, 161992, 142660, 40302,  38933,  null,   17369,  155813, 25780,  21731,  142668, 142282, 135287, 14843,  135279, 157402, 157462, 162208, 25834,  
    151634, 134211, 36456,  139681, 166732, 132913, null,   18443,  131497, 16378,  22643,  142733, null,   148936, 132348, 155799, 134988, 134550, 21881,  16571,  
    17338,  null,   19124,  141926, 135325, 33194,  39157,  134556, 25465,  14846,  141173, 36288,  22177,  25724,  15939,  null,   173569, 134665, 142031, 142537, 
    null,   135368, 145858, 14738,  14854,  164507, 13688,  155209, 139463, 22098,  134961, 142514, 169760, 13500,  27709,  151099, null,   null,   161140, 142987, 
    139784, 173659, 167117, 134778, 134196, 157724, 32659,  135375, 141315, 141625, 13819,  152035, 134796, 135053, 134826, 16275,  134960, 134471, 135503, 134732, 
    null,   134827, 134057, 134472, 135360, 135485, 16377,  140950, 25650,  135085, 144372, 161337, 142286, 134526, 134527, 142417, 142421, 14872,  134808, 135367, 
    134958, 173618, 158544, 167122, 167321, 167114, 38314,  21708,  33476,  21945,  null,   171715, 39974,  39606,  161630, 142830, 28992,  33133,  33004,  23580,  
    157042, 33076,  14231,  21343,  164029, 37302,  134906, 134671, 134775, 134907, 13789,  151019, 13833,  134358, 22191,  141237, 135369, 134672, 134776, 135288, 
    135496, 164359, 136277, 134777, 151120, 142756, 23124,  135197, 135198, 135413, 135414, 22428,  134673, 161428, 164557, 135093, 134779, 151934, 14083,  135094, 
    135552, 152280, 172733, 149978, 137274, 147831, 164476, 22681,  21096,  13850,  153405, 31666,  23400,  18432,  19244,  40743,  18919,  39967,  39821,  154484, 
    143677, 22011,  13810,  22153,  20008,  22786,  138177, 194680, 38737,  131206, 20059,  20155,  13630,  23587,  24401,  24516,  14586,  25164,  25909,  27514,  
    27701,  27706,  28780,  29227,  20012,  29357,  149737, 32594,  31035,  31993,  32595,  156266, 13505,  null,   156491, 32770,  32896,  157202, 158033, 21341,  
    34916,  35265,  161970, 35744,  36125,  38021,  38264,  38271,  38376,  167439, 38886,  39029,  39118,  39134,  39267,  170000, 40060,  40479,  40644,  27503,  
    63751,  20023,  131207, 38429,  25143,  38050,  null,   20539,  28158,  171123, 40870,  15817,  34959,  147790, 28791,  23797,  19232,  152013, 13657,  154928, 
    24866,  166450, 36775,  37366,  29073,  26393,  29626,  144001, 172295, 15499,  137600, 19216,  30948,  29698,  20910,  165647, 16393,  27235,  172730, 16931,  
    34319,  133743, 31274,  170311, 166634, 38741,  28749,  21284,  139390, 37876,  30425,  166371, 40871,  30685,  20131,  20464,  20668,  20015,  20247,  40872,  
    21556,  32139,  22674,  22736,  138678, 24210,  24217,  24514,  141074, 25995,  144377, 26905,  27203,  146531, 27903,  null,   29184,  148741, 29580,  16091,  
    150035, 23317,  29881,  35715,  154788, 153237, 31379,  31724,  31939,  32364,  33528,  34199,  40873,  34960,  40874,  36537,  40875,  36815,  34143,  39392,  
    37409,  40876,  167353, 136255, 16497,  17058,  23066,  null,   null,   null,   39016,  26475,  17014,  22333,  null,   34262,  149883, 33471,  160013, 19585,  
    159092, 23931,  158485, 159678, 40877,  40878,  23446,  40879,  26343,  32347,  28247,  31178,  15752,  17603,  143958, 141206, 17306,  17718,  null,   23765,  
    146202, 35577,  23672,  15634,  144721, 23928,  40882,  29015,  17752,  147692, 138787, 19575,  14712,  13386,  131492, 158785, 35532,  20404,  131641, 22975,  
    33132,  38998,  170234, 24379,  134047, null,   139713, 166253, 16642,  18107,  168057, 16135,  40883,  172469, 16632,  14294,  18167,  158790, 16764,  165554, 
    160767, 17773,  14548,  152730, 17761,  17691,  19849,  19579,  19830,  17898,  16328,  150287, 13921,  17630,  17597,  16877,  23870,  23880,  23894,  15868,  
    14351,  23972,  23993,  14368,  14392,  24130,  24253,  24357,  24451,  14600,  14612,  14655,  14669,  24791,  24893,  23781,  14729,  25015,  25017,  25039,  
    14776,  25132,  25232,  25317,  25368,  14840,  22193,  14851,  25570,  25595,  25607,  25690,  14923,  25792,  23829,  22049,  40863,  14999,  25990,  15037,  
    26111,  26195,  15090,  26258,  15138,  26390,  15170,  26532,  26624,  15192,  26698,  26756,  15218,  15217,  15227,  26889,  26947,  29276,  26980,  27039,  
    27013,  15292,  27094,  15325,  27237,  27252,  27249,  27266,  15340,  27289,  15346,  27307,  27317,  27348,  27382,  27521,  27585,  27626,  27765,  27818,  
    15563,  27906,  27910,  27942,  28033,  15599,  28068,  28081,  28181,  28184,  28201,  28294,  166336, 28347,  28386,  28378,  40831,  28392,  28393,  28452,  
    28468,  15686,  147265, 28545,  28606,  15722,  15733,  29111,  23705,  15754,  28716,  15761,  28752,  28756,  28783,  28799,  28809,  131877, 17345,  13809,  
    134872, 147159, 22462,  159443, 28990,  153568, 13902,  27042,  166889, 23412,  31305,  153825, 169177, 31333,  31357,  154028, 31419,  31408,  31426,  31427,  
    29137,  156813, 16842,  31450,  31453,  31466,  16879,  21682,  154625, 31499,  31573,  31529,  152334, 154878, 31650,  31599,  33692,  154548, 158847, 31696,  
    33825,  31634,  31672,  154912, 15789,  154725, 33938,  31738,  31750,  31797,  154817, 31812,  31875,  149634, 31910,  26237,  148856, 31945,  31943,  31974,  
    31860,  31987,  31989,  31950,  32359,  17693,  159300, 32093,  159446, 29837,  32137,  32171,  28981,  32179,  32210,  147543, 155689, 32228,  15635,  32245,  
    137209, 32229,  164717, 32285,  155937, 155994, 32366,  32402,  17195,  37996,  32295,  32576,  32577,  32583,  31030,  156368, 39393,  32663,  156497, 32675,  
    136801, 131176, 17756,  145254, 17667,  164666, 32762,  156809, 32773,  32776,  32797,  32808,  32815,  172167, 158915, 32827,  32828,  32865,  141076, 18825,  
    157222, 146915, 157416, 26405,  32935,  166472, 33031,  33050,  22704,  141046, 27775,  156824, 151480, 25831,  136330, 33304,  137310, 27219,  150117, 150165, 
    17530,  33321,  133901, 158290, 146814, 20473,  136445, 34018,  33634,  158474, 149927, 144688, 137075, 146936, 33450,  26907,  194964, 16859,  34123,  33488,  
    33562,  134678, 137140, 14017,  143741, 144730, 33403,  33506,  33560,  147083, 159139, 158469, 158615, 144846, 15807,  33565,  21996,  33669,  17675,  159141, 
    33708,  33729,  33747,  13438,  159444, 27223,  34138,  13462,  159298, 143087, 33880,  154596, 33905,  15827,  17636,  27303,  33866,  146613, 31064,  33960,  
    158614, 159351, 159299, 34014,  33807,  33681,  17568,  33939,  34020,  154769, 16960,  154816, 17731,  34100,  23282,  159385, 17703,  34163,  17686,  26559,  
    34326,  165413, 165435, 34241,  159880, 34306,  136578, 159949, 194994, 17770,  34344,  13896,  137378, 21495,  160666, 34430,  34673,  172280, 34798,  142375, 
    34737,  34778,  34831,  22113,  34412,  26710,  17935,  34885,  34886,  161248, 146873, 161252, 34910,  34972,  18011,  34996,  34997,  25537,  35013,  30583,  
    161551, 35207,  35210,  35238,  35241,  35239,  35260,  166437, 35303,  162084, 162493, 35484,  30611,  37374,  35472,  162393, 31465,  162618, 147343, 18195,  
    162616, 29052,  35596,  35615,  152624, 152933, 35647,  35660,  35661,  35497,  150138, 35728,  35739,  35503,  136927, 17941,  34895,  35995,  163156, 163215, 
    195028, 14117,  163155, 36054,  163224, 163261, 36114,  36099,  137488, 36059,  28764,  36113,  150729, 16080,  36215,  36265,  163842, 135188, 149898, 15228,  
    164284, 160012, 31463,  36525,  36534,  36547,  37588,  36633,  36653,  164709, 164882, 36773,  37635,  172703, 133712, 36787,  18730,  166366, 165181, 146875, 
    24312,  143970, 36857,  172052, 165564, 165121, 140069, 14720,  159447, 36919,  165180, 162494, 36961,  165228, 165387, 37032,  165651, 37060,  165606, 37038,  
    37117,  37223,  15088,  37289,  37316,  31916,  166195, 138889, 37390,  27807,  37441,  37474,  153017, 37561,  166598, 146587, 166668, 153051, 134449, 37676,  
    37739,  166625, 166891, 28815,  23235,  166626, 166629, 18789,  37444,  166892, 166969, 166911, 37747,  37979,  36540,  38277,  38310,  37926,  38304,  28662,  
    17081,  140922, 165592, 135804, 146990, 18911,  27676,  38523,  38550,  16748,  38563,  159445, 25050,  38582,  30965,  166624, 38589,  21452,  18849,  158904, 
    131700, 156688, 168111, 168165, 150225, 137493, 144138, 38705,  34370,  38710,  18959,  17725,  17797,  150249, 28789,  23361,  38683,  38748,  168405, 38743,  
    23370,  168427, 38751,  37925,  20688,  143543, 143548, 38793,  38815,  38833,  38846,  38848,  38866,  38880,  152684, 38894,  29724,  169011, 38911,  38901,  
    168989, 162170, 19153,  38964,  38963,  38987,  39014,  15118,  160117, 15697,  132656, 147804, 153350, 39114,  39095,  39112,  39111,  19199,  159015, 136915, 
    21936,  39137,  39142,  39148,  37752,  39225,  150057, 19314,  170071, 170245, 39413,  39436,  39483,  39440,  39512,  153381, 14020,  168113, 170965, 39648,  
    39650,  170757, 39668,  19470,  39700,  39725,  165376, 20532,  39732,  158120, 14531,  143485, 39760,  39744,  171326, 23109,  137315, 39822,  148043, 39938,  
    39935,  39948,  171624, 40404,  171959, 172434, 172459, 172257, 172323, 172511, 40318,  40323,  172340, 40462,  26760,  40388,  139611, 172435, 172576, 137531, 
    172595, 40249,  172217, 172724, 40592,  40597,  40606,  40610,  19764,  40618,  40623,  148324, 40641,  15200,  14821,  15645,  20274,  14270,  166955, 40706,  
    40712,  19350,  37924,  159138, 40727,  40726,  40761,  22175,  22154,  40773,  39352,  168075, 38898,  33919,  40802,  40809,  31452,  40846,  29206,  19390,  
    149877, 149947, 29047,  150008, 148296, 150097, 29598,  166874, 137466, 31135,  166270, 167478, 37737,  37875,  166468, 37612,  37761,  37835,  166252, 148665, 
    29207,  16107,  30578,  31299,  28880,  148595, 148472, 29054,  137199, 28835,  137406, 144793, 16071,  137349, 152623, 137208, 14114,  136955, 137273, 14049,  
    137076, 137425, 155467, 14115,  136896, 22363,  150053, 136190, 135848, 136134, 136374, 34051,  145062, 34051,  33877,  149908, 160101, 146993, 152924, 147195, 
    159826, 17652,  145134, 170397, 159526, 26617,  14131,  15381,  15847,  22636,  137506, 26640,  16471,  145215, 147681, 147595, 147727, 158753, 21707,  22174,  
    157361, 22162,  135135, 134056, 134669, 37830,  166675, 37788,  20216,  20779,  14361,  148534, 20156,  132197, 131967, 20299,  20362,  153169, 23144,  131499, 
    132043, 14745,  131850, 132116, 13365,  20265,  131776, 167603, 131701, 35546,  131596, 20120,  20685,  20749,  20386,  20227,  150030, 147082, 20290,  20526,  
    20588,  20609,  20428,  20453,  20568,  20732,  20825,  20827,  20829,  20830,  28278,  144789, 147001, 147135, 28018,  137348, 147081, 20904,  20931,  132576, 
    17629,  132259, 132242, 132241, 36218,  166556, 132878, 21081,  21156,  133235, 21217,  37742,  18042,  29068,  148364, 134176, 149932, 135396, 27089,  134685, 
    29817,  16094,  29849,  29716,  29782,  29592,  19342,  150204, 147597, 21456,  13700,  29199,  147657, 21940,  131909, 21709,  134086, 22301,  37469,  38644,  
    37734,  22493,  22413,  22399,  13886,  22731,  23193,  166470, 136954, 137071, 136976, 23084,  22968,  37519,  23166,  23247,  23058,  153926, 137715, 137313, 
    148117, 14069,  27909,  29763,  23073,  155267, 23169,  166871, 132115, 37856,  29836,  135939, 28933,  18802,  37896,  166395, 37821,  14240,  23582,  23710,  
    24158,  24136,  137622, 137596, 146158, 24269,  23375,  137475, 137476, 14081,  137376, 14045,  136958, 14035,  33066,  166471, 138682, 144498, 166312, 24332,  
    24334,  137511, 137131, 23147,  137019, 23364,  34324,  161277, 34912,  24702,  141408, 140843, 24539,  16056,  140719, 140734, 168072, 159603, 25024,  131134, 
    131142, 140827, 24985,  24984,  24693,  142491, 142599, 149204, 168269, 25713,  149093, 142186, 14889,  142114, 144464, 170218, 142968, 25399,  173147, 25782,  
    25393,  25553,  149987, 142695, 25252,  142497, 25659,  25963,  26994,  15348,  143502, 144045, 149897, 144043, 21773,  144096, 137433, 169023, 26318,  144009, 
    143795, 15072,  16784,  152964, 166690, 152975, 136956, 152923, 152613, 30958,  143619, 137258, 143924, 13412,  143887, 143746, 148169, 26254,  159012, 26219,  
    19347,  26160,  161904, 138731, 26211,  144082, 144097, 26142,  153714, 14545,  145466, 145340, 15257,  145314, 144382, 29904,  15254,  26511,  149034, 26806,  
    26654,  15300,  27326,  14435,  145365, 148615, 27187,  27218,  27337,  27397,  137490, 25873,  26776,  27212,  15319,  27258,  27479,  147392, 146586, 37792,  
    37618,  166890, 166603, 37513,  163870, 166364, 37991,  28069,  28427,  149996, 28007,  147327, 15759,  28164,  147516, 23101,  28170,  22599,  27940,  30786,  
    28987,  148250, 148086, 28913,  29264,  29319,  29332,  149391, 149285, 20857,  150180, 132587, 29818,  147192, 144991, 150090, 149783, 155617, 16134,  16049,  
    150239, 166947, 147253, 24743,  16115,  29900,  29756,  37767,  29751,  17567,  159210, 17745,  30083,  16227,  150745, 150790, 16216,  30037,  30323,  173510, 
    15129,  29800,  166604, 149931, 149902, 15099,  15821,  150094, 16127,  149957, 149747, 37370,  22322,  37698,  166627, 137316, 20703,  152097, 152039, 30584,  
    143922, 30478,  30479,  30587,  149143, 145281, 14942,  149744, 29752,  29851,  16063,  150202, 150215, 16584,  150166, 156078, 37639,  152961, 30750,  30861,  
    30856,  30930,  29648,  31065,  161601, 153315, 16654,  31131,  33942,  31141,  27181,  147194, 31290,  31220,  16750,  136934, 16690,  37429,  31217,  134476, 
    149900, 131737, 146874, 137070, 13719,  21867,  13680,  13994,  131540, 134157, 31458,  23129,  141045, 154287, 154268, 23053,  131675, 30960,  23082,  154566, 
    31486,  16889,  31837,  31853,  16913,  154547, 155324, 155302, 31949,  150009, 137136, 31886,  31868,  31918,  27314,  32220,  32263,  32211,  32590,  156257, 
    155996, 162632, 32151,  155266, 17002,  158581, 133398, 26582,  131150, 144847, 22468,  156690, 156664, 149858, 32733,  31527,  133164, 154345, 154947, 31500,  
    155150, 39398,  34373,  39523,  27164,  144447, 14818,  150007, 157101, 39455,  157088, 33920,  160039, 158929, 17642,  33079,  17410,  32966,  33033,  33090,  
    157620, 39107,  158274, 33378,  33381,  158289, 33875,  159143, 34320,  160283, 23174,  16767,  137280, 23339,  137377, 23268,  137432, 34464,  195004, 146831, 
    34861,  160802, 23042,  34926,  20293,  34951,  35007,  35046,  35173,  35149,  153219, 35156,  161669, 161668, 166901, 166873, 166812, 166393, 16045,  33955,  
    18165,  18127,  14322,  35389,  35356,  169032, 24397,  37419,  148100, 26068,  28969,  28868,  137285, 40301,  35999,  36073,  163292, 22938,  30659,  23024,  
    17262,  14036,  36394,  36519,  150537, 36656,  36682,  17140,  27736,  28603,  140065, 18587,  28537,  28299,  137178, 39913,  14005,  149807, 37051,  37015,  
    21873,  18694,  37307,  37892,  166475, 16482,  166652, 37927,  166941, 166971, 34021,  35371,  38297,  38311,  38295,  38294,  167220, 29765,  16066,  149759, 
    150082, 148458, 16103,  143909, 38543,  167655, 167526, 167525, 16076,  149997, 150136, 147438, 29714,  29803,  16124,  38721,  168112, 26695,  18973,  168083, 
    153567, 38749,  37736,  166281, 166950, 166703, 156606, 37562,  23313,  35689,  18748,  29689,  147995, 38811,  38769,  39224,  134950, 24001,  166853, 150194, 
    38943,  169178, 37622,  169431, 37349,  17600,  166736, 150119, 166756, 39132,  166469, 16128,  37418,  18725,  33812,  39227,  39245,  162566, 15869,  39323,  
    19311,  39338,  39516,  166757, 153800, 27279,  39457,  23294,  39471,  170225, 19344,  170312, 39356,  19389,  19351,  37757,  22642,  135938, 22562,  149944, 
    136424, 30788,  141087, 146872, 26821,  15741,  37976,  14631,  24912,  141185, 141675, 24839,  40015,  40019,  40059,  39989,  39952,  39807,  39887,  171565, 
    39839,  172533, 172286, 40225,  19630,  147716, 40472,  19632,  40204,  172468, 172269, 172275, 170287, 40357,  33981,  159250, 159711, 158594, 34300,  17715,  
    159140, 159364, 159216, 33824,  34286,  159232, 145367, 155748, 31202,  144796, 144960, 18733,  149982, 15714,  37851,  37566,  37704,  131775, 30905,  37495,  
    37965,  20452,  13376,  36964,  152925, 30781,  30804,  30902,  30795,  137047, 143817, 149825, 13978,  20338,  28634,  28633,  28702,  28702,  21524,  147893, 
    22459,  22771,  22410,  40214,  22487,  28980,  13487,  147884, 29163,  158784, 151447, 23336,  137141, 166473, 24844,  23246,  23051,  17084,  148616, 14124,  
    19323,  166396, 37819,  37816,  137430, 134941, 33906,  158912, 136211, 148218, 142374, 148417, 22932,  146871, 157505, 32168,  155995, 155812, 149945, 149899, 
    166394, 37605,  29666,  16105,  29876,  166755, 137375, 16097,  150195, 27352,  29683,  29691,  16086,  150078, 150164, 137177, 150118, 132007, 136228, 149989, 
    29768,  149782, 28837,  149878, 37508,  29670,  37727,  132350, 37681,  166606, 166422, 37766,  166887, 153045, 18741,  166530, 29035,  149827, 134399, 22180,  
    132634, 134123, 134328, 21762,  31172,  137210, 32254,  136898, 150096, 137298, 17710,  37889,  14090,  166592, 149933, 22960,  137407, 137347, 160900, 23201,  
    14050,  146779, 14000,  37471,  23161,  166529, 137314, 37748,  15565,  133812, 19094,  14730,  20724,  15721,  15692,  136092, 29045,  17147,  164376, 28175,  
    168164, 17643,  27991,  163407, 28775,  27823,  15574,  147437, 146989, 28162,  28428,  15727,  132085, 30033,  14012,  13512,  18048,  16090,  18545,  22980,  
    37486,  18750,  36673,  166940, 158656, 22546,  22472,  14038,  136274, 28926,  148322, 150129, 143331, 135856, 140221, 26809,  26983,  136088, 144613, 162804, 
    145119, 166531, 145366, 144378, 150687, 27162,  145069, 158903, 33854,  17631,  17614,  159014, 159057, 158850, 159710, 28439,  160009, 33597,  137018, 33773,  
    158848, 159827, 137179, 22921,  23170,  137139, 23137,  23153,  137477, 147964, 14125,  23023,  137020, 14023,  29070,  37776,  26266,  148133, 23150,  23083,  
    148115, 27179,  147193, 161590, 148571, 148170, 28957,  148057, 166369, 20400,  159016, 23746,  148686, 163405, 148413, 27148,  148054, 135940, 28838,  28979,  
    148457, 15781,  27871,  194597, 150095, 32357,  23019,  23855,  15859,  24412,  150109, 137183, 32164,  33830,  21637,  146170, 144128, 131604, 22398,  133333, 
    132633, 16357,  139166, 172726, 28675,  168283, 23920,  29583,  31955,  166489, 168992, 20424,  32743,  29389,  29456,  162548, 29496,  29497,  153334, 29505,  
    29512,  16041,  162584, 36972,  29173,  149746, 29665,  33270,  16074,  30476,  16081,  27810,  22269,  29721,  29726,  29727,  16098,  16112,  16116,  16122,  
    29907,  16142,  16211,  30018,  30061,  30066,  30093,  16252,  30152,  30172,  16320,  30285,  16343,  30324,  16348,  30330,  151388, 29064,  22051,  35200,  
    22633,  16413,  30531,  16441,  26465,  16453,  13787,  30616,  16490,  16495,  23646,  30654,  30667,  22770,  30744,  28857,  30748,  16552,  30777,  30791,  
    30801,  30822,  33864,  152885, 31027,  26627,  31026,  16643,  16649,  31121,  31129,  36795,  31238,  36796,  16743,  31377,  16818,  31420,  33401,  16836,  
    31439,  31451,  16847,  20001,  31586,  31596,  31611,  31762,  31771,  16992,  17018,  31867,  31900,  17036,  31928,  17044,  31981,  36755,  28864,  134351, 
    32207,  32212,  32208,  32253,  32686,  32692,  29343,  17303,  32800,  32805,  31545,  32814,  32817,  32852,  15820,  22452,  28832,  32951,  33001,  17389,  
    33036,  29482,  33038,  33042,  30048,  33044,  17409,  15161,  33110,  33113,  33114,  17427,  22586,  33148,  33156,  17445,  33171,  17453,  33189,  22511,  
    33217,  33252,  33364,  17551,  33446,  33398,  33482,  33496,  33535,  17584,  33623,  38505,  27018,  33797,  28917,  33892,  24803,  33928,  17668,  33982,  
    34017,  34040,  34064,  34104,  34130,  17723,  34159,  34160,  34272,  17783,  34418,  34450,  34482,  34543,  38469,  34699,  17926,  17943,  34990,  35071,  
    35108,  35143,  35217,  162151, 35369,  35384,  35476,  35508,  35921,  36052,  36082,  36124,  18328,  22623,  36291,  18413,  20206,  36410,  21976,  22356,  
    36465,  22005,  36528,  18487,  36558,  36578,  36580,  36589,  36594,  36791,  36801,  36810,  36812,  36915,  39364,  18605,  39136,  37395,  18718,  37416,  
    37464,  37483,  37553,  37550,  37567,  37603,  37611,  37619,  37620,  37629,  37699,  37764,  37805,  18757,  18769,  40639,  37911,  21249,  37917,  37933,  
    37950,  18794,  37972,  38009,  38189,  38306,  18855,  38388,  38451,  18917,  26528,  18980,  38720,  18997,  38834,  38850,  22100,  19172,  24808,  39097,  
    19225,  39153,  22596,  39182,  39193,  20916,  39196,  39223,  39234,  39261,  39266,  19312,  39365,  19357,  39484,  39695,  31363,  39785,  39809,  39901,  
    39921,  39924,  19565,  39968,  14191,  138178, 40265,  39994,  40702,  22096,  40339,  40381,  40384,  40444,  38134,  36790,  40571,  40620,  40625,  40637,  
    40646,  38108,  40674,  40689,  40696,  31432,  40772,  131220, 131767, 132000, 26906,  38083,  22956,  132311, 22592,  38081,  14265,  132565, 132629, 132726, 
    136890, 22359,  29043,  133826, 133837, 134079, 21610,  194619, 134091, 21662,  134139, 134203, 134227, 134245, 134268, 24807,  134285, 22138,  134325, 134365, 
    134381, 134511, 134578, 134600, 26965,  39983,  34725,  134660, 134670, 134871, 135056, 134957, 134771, 23584,  135100, 24075,  135260, 135247, 135286, 26398,  
    135291, 135304, 135318, 13895,  135359, 135379, 135471, 135483, 21348,  33965,  135907, 136053, 135990, 35713,  136567, 136729, 137155, 137159, 20088,  28859,  
    137261, 137578, 137773, 137797, 138282, 138352, 138412, 138952, 25283,  138965, 139029, 29080,  26709,  139333, 27113,  14024,  139900, 140247, 140282, 141098, 
    141425, 141647, 33533,  141671, 141715, 142037, 35237,  142056, 36768,  142094, 38840,  142143, 38983,  39613,  142412, null,   142472, 142519, 154600, 142600, 
    142610, 142775, 142741, 142914, 143220, 143308, 143411, 143462, 144159, 144350, 24497,  26184,  26303,  162425, 144743, 144883, 29185,  149946, 30679,  144922, 
    145174, 32391,  131910, 22709,  26382,  26904,  146087, 161367, 155618, 146961, 147129, 161278, 139418, 18640,  19128,  147737, 166554, 148206, 148237, 147515, 
    148276, 148374, 150085, 132554, 20946,  132625, 22943,  138920, 15294,  146687, 148484, 148694, 22408,  149108, 14747,  149295, 165352, 170441, 14178,  139715, 
    35678,  166734, 39382,  149522, 149755, 150037, 29193,  150208, 134264, 22885,  151205, 151430, 132985, 36570,  151596, 21135,  22335,  29041,  152217, 152601, 
    147274, 150183, 21948,  152646, 152686, 158546, 37332,  13427,  152895, 161330, 152926, 18200,  152930, 152934, 153543, 149823, 153693, 20582,  13563,  144332, 
    24798,  153859, 18300,  166216, 154286, 154505, 154630, 138640, 22433,  29009,  28598,  155906, 162834, 36950,  156082, 151450, 35682,  156674, 156746, 23899,  
    158711, 36662,  156804, 137500, 35562,  150006, 156808, 147439, 156946, 19392,  157119, 157365, 141083, 37989,  153569, 24981,  23079,  194765, 20411,  22201,  
    148769, 157436, 20074,  149812, 38486,  28047,  158909, 13848,  35191,  157593, 157806, 156689, 157790, 29151,  157895, 31554,  168128, 133649, 157990, 37124,  
    158009, 31301,  40432,  158202, 39462,  158253, 13919,  156777, 131105, 31107,  158260, 158555, 23852,  144665, 33743,  158621, 18128,  158884, 30011,  34917,  
    159150, 22710,  14108,  140685, 159819, 160205, 15444,  160384, 160389, 37505,  139642, 160395, 37680,  160486, 149968, 27705,  38047,  160848, 134904, 34855,  
    35061,  141606, 164979, 137137, 28344,  150058, 137248, 14756,  14009,  23568,  31203,  17727,  26294,  171181, 170148, 35139,  161740, 161880, 22230,  16607,  
    136714, 14753,  145199, 164072, 136133, 29101,  33638,  162269, 168360, 23143,  19639,  159919, 166315, 162301, 162314, 162571, 163174, 147834, 31555,  31102,  
    163849, 28597,  172767, 27139,  164632, 21410,  159239, 37823,  26678,  38749,  164207, 163875, 158133, 136173, 143919, 163912, 23941,  166960, 163971, 22293,  
    38947,  166217, 23979,  149896, 26046,  27093,  21458,  150181, 147329, 15377,  26422,  163984, 164084, 164142, 139169, 164175, 164233, 164271, 164378, 164614, 
    164655, 164746, 13770,  164968, 165546, 18682,  25574,  166230, 30728,  37461,  166328, 17394,  166375, 17375,  166376, 166726, 166868, 23032,  166921, 36619,  
    167877, 168172, 31569,  168208, 168252, 15863,  168286, 150218, 36816,  29327,  22155,  169191, 169449, 169392, 169400, 169778, 170193, 170313, 170346, 170435, 
    170536, 170766, 171354, 171419, 32415,  171768, 171811, 19620,  38215,  172691, 29090,  172799, 19857,  36882,  173515, 19868,  134300, 36798,  21953,  36794,  
    140464, 36793,  150163, 17673,  32383,  28502,  27313,  20202,  13540,  166700, 161949, 14138,  36480,  137205, 163876, 166764, 166809, 162366, 157359, 15851,  
    161365, 146615, 153141, 153942, 20122,  155265, 156248, 22207,  134765, 36366,  23405,  147080, 150686, 25566,  25296,  137206, 137339, 25904,  22061,  154698, 
    21530,  152337, 15814,  171416, 19581,  22050,  22046,  32585,  155352, 22901,  146752, 34672,  19996,  135146, 134473, 145082, 33047,  40286,  36120,  30267,  
    40005,  30286,  30649,  37701,  21554,  33096,  33527,  22053,  33074,  33816,  32957,  21994,  31074,  22083,  21526,  134813, 13774,  22021,  22001,  26353,  
    164578, 13869,  30004,  22000,  21946,  21655,  21874,  134209, 134294, 24272,  151880, 134774, 142434, 134818, 40619,  32090,  21982,  135285, 25245,  38765,  
    21652,  36045,  29174,  37238,  25596,  25529,  25598,  21865,  142147, 40050,  143027, 20890,  13535,  134567, 20903,  21581,  21790,  21779,  30310,  36397,  
    157834, 30129,  32950,  34820,  34694,  35015,  33206,  33820,  135361, 17644,  29444,  149254, 23440,  33547,  157843, 22139,  141044, 163119, 147875, 163187, 
    159440, 160438, 37232,  135641, 37384,  146684, 173737, 134828, 134905, 29286,  138402, 18254,  151490, 163833, 135147, 16634,  40029,  25887,  142752, 18675,  
    149472, 171388, 135148, 134666, 24674,  161187, 135149, null,   155720, 135559, 29091,  32398,  40272,  19994,  19972,  13687,  23309,  27826,  21351,  13996,  
    14812,  21373,  13989,  149016, 22682,  150382, 33325,  21579,  22442,  154261, 133497, null,   14930,  140389, 29556,  171692, 19721,  39917,  146686, 171824, 
    19547,  151465, 169374, 171998, 33884,  146870, 160434, 157619, 145184, 25390,  32037,  147191, 146988, 14890,  36872,  21196,  15988,  13946,  17897,  132238, 
    30272,  23280,  134838, 30842,  163630, 22695,  16575,  22140,  39819,  23924,  30292,  173108, 40581,  19681,  30201,  14331,  24857,  143578, 148466, null,   
    22109,  135849, 22439,  149859, 171526, 21044,  159918, 13741,  27722,  40316,  31830,  39737,  22494,  137068, 23635,  25811,  169168, 156469, 160100, 34477,  
    134440, 159010, 150242, 134513, null,   20990,  139023, 23950,  38659,  138705, 40577,  36940,  31519,  39682,  23761,  31651,  25192,  25397,  39679,  31695,  
    39722,  31870,  39726,  31810,  31878,  39957,  31740,  39689,  40727,  39963,  149822, 40794,  21875,  23491,  20477,  40600,  20466,  21088,  15878,  21201,  
    22375,  20566,  22967,  24082,  38856,  40363,  36700,  21609,  38836,  39232,  38842,  21292,  24880,  26924,  21466,  39946,  40194,  19515,  38465,  27008,  
    20646,  30022,  137069, 39386,  21107,  null,   37209,  38529,  37212,  null,   37201,  167575, 25471,  159011, 27338,  22033,  37262,  30074,  25221,  132092, 
    29519,  31856,  154657, 146685, null,   149785, 30422,  39837,  20010,  134356, 33726,  34882,  null,   23626,  27072,  20717,  22394,  21023,  24053,  20174,  
    27697,  131570, 20281,  21660,  21722,  21146,  36226,  13822,  24332,  13811,  null,   27474,  37244,  40869,  39831,  38958,  39092,  39610,  40616,  40580,  
    29050,  31508,  null,   27642,  34840,  32632,  null,   22048,  173642, 36471,  40787,  null,   36308,  36431,  40476,  36353,  25218,  164733, 36392,  36469,  
    31443,  150135, 31294,  30936,  27882,  35431,  30215,  166490, 40742,  27854,  34774,  30147,  172722, 30803,  194624, 36108,  29410,  29553,  35629,  29442,  
    29937,  36075,  150203, 34351,  24506,  34976,  17591,  null,   137275, 159237, null,   35454,  140571, null,   24829,  30311,  39639,  40260,  37742,  39823,  
    34805,  null,   34831,  36087,  29484,  38689,  39856,  13782,  29362,  19463,  31825,  39242,  155993, 24921,  19460,  40598,  24957,  null,   22367,  24943,  
    25254,  25145,  25294,  14940,  25058,  21418,  144373, 25444,  26626,  13778,  23895,  166850, 36826,  167481, null,   20697,  138566, 30982,  21298,  38456,  
    134971, 16485,  null,   30718,  null,   31938,  155418, 31962,  31277,  32870,  32867,  32077,  29957,  29938,  35220,  33306,  26380,  32866,  160902, 32859,  
    29936,  33027,  30500,  35209,  157644, 30035,  159441, 34729,  34766,  33224,  34700,  35401,  36013,  35651,  30507,  29944,  34010,  13877,  27058,  36262,  
    null,   35241,  29800,  28089,  34753,  147473, 29927,  15835,  29046,  24740,  24988,  15569,  29026,  24695,  null,   32625,  166701, 29264,  24809,  19326,  
    21024,  15384,  146631, 155351, 161366, 152881, 137540, 135934, 170243, 159196, 159917, 23745,  156077, 166415, 145015, 131310, 157766, 151310, 17762,  23327,  
    156492, 40784,  40614,  156267, 12288,  65292,  12289,  12290,  65294,  8231,   65307,  65306,  65311,  65281,  65072,  8230,   8229,   65104,  65105,  65106,  
    183,    65108,  65109,  65110,  65111,  65372,  8211,   65073,  8212,   65075,  9588,   65076,  65103,  65288,  65289,  65077,  65078,  65371,  65373,  65079,  
    65080,  12308,  12309,  65081,  65082,  12304,  12305,  65083,  65084,  12298,  12299,  65085,  65086,  12296,  12297,  65087,  65088,  12300,  12301,  65089,  
    65090,  12302,  12303,  65091,  65092,  65113,  65114,  65115,  65116,  65117,  65118,  8216,   8217,   8220,   8221,   12317,  12318,  8245,   8242,   65283,  
    65286,  65290,  8251,   167,    12291,  9675,   9679,   9651,   9650,   9678,   9734,   9733,   9671,   9670,   9633,   9632,   9661,   9660,   12963,  8453,   
    175,    65507,  65343,  717,    65097,  65098,  65101,  65102,  65099,  65100,  65119,  65120,  65121,  65291,  65293,  215,    247,    177,    8730,   65308,  
    65310,  65309,  8806,   8807,   8800,   8734,   8786,   8801,   65122,  65123,  65124,  65125,  65126,  65374,  8745,   8746,   8869,   8736,   8735,   8895,   
    13266,  13265,  8747,   8750,   8757,   8756,   9792,   9794,   8853,   8857,   8593,   8595,   8592,   8594,   8598,   8599,   8601,   8600,   8741,   8739,   
    65295,  65340,  8725,   65128,  65284,  65509,  12306,  65504,  65505,  65285,  65312,  8451,   8457,   65129,  65130,  65131,  13269,  13212,  13213,  13214,  
    13262,  13217,  13198,  13199,  13252,  176,    20825,  20827,  20830,  20829,  20833,  20835,  21991,  29929,  31950,  9601,   9602,   9603,   9604,   9605,   
    9606,   9607,   9608,   9615,   9614,   9613,   9612,   9611,   9610,   9609,   9532,   9524,   9516,   9508,   9500,   9620,   9472,   9474,   9621,   9484,   
    9488,   9492,   9496,   9581,   9582,   9584,   9583,   9552,   9566,   9578,   9569,   9698,   9699,   9701,   9700,   9585,   9586,   9587,   65296,  65297,  
    65298,  65299,  65300,  65301,  65302,  65303,  65304,  65305,  8544,   8545,   8546,   8547,   8548,   8549,   8550,   8551,   8552,   8553,   12321,  12322,  
    12323,  12324,  12325,  12326,  12327,  12328,  12329,  21313,  21316,  21317,  65313,  65314,  65315,  65316,  65317,  65318,  65319,  65320,  65321,  65322,  
    65323,  65324,  65325,  65326,  65327,  65328,  65329,  65330,  65331,  65332,  65333,  65334,  65335,  65336,  65337,  65338,  65345,  65346,  65347,  65348,  
    65349,  65350,  65351,  65352,  65353,  65354,  65355,  65356,  65357,  65358,  65359,  65360,  65361,  65362,  65363,  65364,  65365,  65366,  65367,  65368,  
    65369,  65370,  913,    914,    915,    916,    917,    918,    919,    920,    921,    922,    923,    924,    925,    926,    927,    928,    929,    931,    
    932,    933,    934,    935,    936,    937,    945,    946,    947,    948,    949,    950,    951,    952,    953,    954,    955,    956,    957,    958,    
    959,    960,    961,    963,    964,    965,    966,    967,    968,    969,    12549,  12550,  12551,  12552,  12553,  12554,  12555,  12556,  12557,  12558,  
    12559,  12560,  12561,  12562,  12563,  12564,  12565,  12566,  12567,  12568,  12569,  12570,  12571,  12572,  12573,  12574,  12575,  12576,  12577,  12578,  
    12579,  12580,  12581,  12582,  12583,  12584,  12585,  729,    713,    714,    711,    715,    9216,   9217,   9218,   9219,   9220,   9221,   9222,   9223,   
    9224,   9225,   9226,   9227,   9228,   9229,   9230,   9231,   9232,   9233,   9234,   9235,   9236,   9237,   9238,   9239,   9240,   9241,   9242,   9243,   
    9244,   9245,   9246,   9247,   9249,   8364,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   19968,  20057,  19969,  19971,  20035,  
    20061,  20102,  20108,  20154,  20799,  20837,  20843,  20960,  20992,  20993,  21147,  21269,  21313,  21340,  21448,  19977,  19979,  19976,  19978,  20011,  
    20024,  20961,  20037,  20040,  20063,  20062,  20110,  20129,  20800,  20995,  21242,  21315,  21449,  21475,  22303,  22763,  22805,  22823,  22899,  23376,  
    23377,  23379,  23544,  23567,  23586,  23608,  23665,  24029,  24037,  24049,  24050,  24051,  24062,  24178,  24318,  24331,  24339,  25165,  19985,  19984,  
    19981,  20013,  20016,  20025,  20043,  23609,  20104,  20113,  20117,  20114,  20116,  20130,  20161,  20160,  20163,  20166,  20167,  20173,  20170,  20171,  
    20164,  20803,  20801,  20839,  20845,  20846,  20844,  20887,  20982,  20998,  20999,  21000,  21243,  21246,  21247,  21270,  21305,  21320,  21319,  21317,  
    21342,  21380,  21451,  21450,  21453,  22764,  22825,  22827,  22826,  22829,  23380,  23569,  23588,  23610,  23663,  24052,  24187,  24319,  24340,  24341,  
    24515,  25096,  25142,  25163,  25166,  25903,  25991,  26007,  26020,  26041,  26085,  26352,  26376,  26408,  27424,  27490,  27513,  27595,  27604,  27611,  
    27663,  27700,  28779,  29226,  29238,  29243,  29255,  29273,  29275,  29356,  29579,  19993,  19990,  19989,  19988,  19992,  20027,  20045,  20047,  20046,  
    20197,  20184,  20180,  20181,  20182,  20183,  20195,  20196,  20185,  20190,  20805,  20804,  20873,  20874,  20908,  20985,  20986,  20984,  21002,  21152,  
    21151,  21253,  21254,  21271,  21277,  20191,  21322,  21321,  21345,  21344,  21359,  21358,  21435,  21487,  21476,  21491,  21484,  21486,  21481,  21480,  
    21500,  21496,  21493,  21483,  21478,  21482,  21490,  21489,  21488,  21477,  21485,  21499,  22235,  22234,  22806,  22830,  22833,  22900,  22902,  23381,  
    23427,  23612,  24040,  24039,  24038,  24066,  24067,  24179,  24188,  24321,  24344,  24343,  24517,  25098,  25171,  25172,  25170,  25169,  26021,  26086,  
    26414,  26412,  26410,  26411,  26413,  27491,  27597,  27665,  27664,  27704,  27713,  27712,  27710,  29359,  29572,  29577,  29916,  29926,  29976,  29983,  
    29992,  29993,  30000,  30001,  30002,  30003,  30091,  30333,  30382,  30399,  30446,  30683,  30690,  30707,  31034,  31166,  31348,  31435,  19998,  19999,  
    20050,  20051,  20073,  20121,  20132,  20134,  20133,  20223,  20233,  20249,  20234,  20245,  20237,  20240,  20241,  20239,  20210,  20214,  20219,  20208,  
    20211,  20221,  20225,  20235,  20809,  20807,  20806,  20808,  20840,  20849,  20877,  20912,  21015,  21009,  21010,  21006,  21014,  21155,  21256,  21281,  
    21280,  21360,  21361,  21513,  21519,  21516,  21514,  21520,  21505,  21515,  21508,  21521,  21517,  21512,  21507,  21518,  21510,  21522,  22240,  22238,  
    22237,  22323,  22320,  22312,  22317,  22316,  22319,  22313,  22809,  22810,  22839,  22840,  22916,  22904,  22915,  22909,  22905,  22914,  22913,  23383,  
    23384,  23431,  23432,  23429,  23433,  23546,  23574,  23673,  24030,  24070,  24182,  24180,  24335,  24347,  24537,  24534,  25102,  25100,  25101,  25104,  
    25187,  25179,  25176,  25910,  26089,  26088,  26092,  26093,  26354,  26355,  26377,  26429,  26420,  26417,  26421,  27425,  27492,  27515,  27670,  27741,  
    27735,  27737,  27743,  27744,  27728,  27733,  27745,  27739,  27725,  27726,  28784,  29279,  29277,  30334,  31481,  31859,  31992,  32566,  32650,  32701,  
    32769,  32771,  32780,  32786,  32819,  32895,  32905,  32907,  32908,  33251,  33258,  33267,  33276,  33292,  33307,  33311,  33390,  33394,  33406,  34411,  
    34880,  34892,  34915,  35199,  38433,  20018,  20136,  20301,  20303,  20295,  20311,  20318,  20276,  20315,  20309,  20272,  20304,  20305,  20285,  20282,  
    20280,  20291,  20308,  20284,  20294,  20323,  20316,  20320,  20271,  20302,  20278,  20313,  20317,  20296,  20314,  20812,  20811,  20813,  20853,  20918,  
    20919,  21029,  21028,  21033,  21034,  21032,  21163,  21161,  21162,  21164,  21283,  21363,  21365,  21533,  21549,  21534,  21566,  21542,  21582,  21543,  
    21574,  21571,  21555,  21576,  21570,  21531,  21545,  21578,  21561,  21563,  21560,  21550,  21557,  21558,  21536,  21564,  21568,  21553,  21547,  21535,  
    21548,  22250,  22256,  22244,  22251,  22346,  22353,  22336,  22349,  22343,  22350,  22334,  22352,  22351,  22331,  22767,  22846,  22941,  22930,  22952,  
    22942,  22947,  22937,  22934,  22925,  22948,  22931,  22922,  22949,  23389,  23388,  23386,  23387,  23436,  23435,  23439,  23596,  23616,  23617,  23615,  
    23614,  23696,  23697,  23700,  23692,  24043,  24076,  24207,  24199,  24202,  24311,  24324,  24351,  24420,  24418,  24439,  24441,  24536,  24524,  24535,  
    24525,  24561,  24555,  24568,  24554,  25106,  25105,  25220,  25239,  25238,  25216,  25206,  25225,  25197,  25226,  25212,  25214,  25209,  25203,  25234,  
    25199,  25240,  25198,  25237,  25235,  25233,  25222,  25913,  25915,  25912,  26097,  26356,  26463,  26446,  26447,  26448,  26449,  26460,  26454,  26462,  
    26441,  26438,  26464,  26451,  26455,  27493,  27599,  27714,  27742,  27801,  27777,  27784,  27785,  27781,  27803,  27754,  27770,  27792,  27760,  27788,  
    27752,  27798,  27794,  27773,  27779,  27762,  27774,  27764,  27782,  27766,  27789,  27796,  27800,  27778,  28790,  28796,  28797,  28792,  29282,  29281,  
    29280,  29380,  29378,  29590,  29996,  29995,  30007,  30008,  30338,  30447,  30691,  31169,  31168,  31167,  31350,  31995,  32597,  32918,  32915,  32925,  
    32920,  32923,  32922,  32946,  33391,  33426,  33419,  33421,  35211,  35282,  35328,  35895,  35910,  35925,  35997,  36196,  36208,  36275,  36523,  36554,  
    36763,  36784,  36802,  36806,  36805,  36804,  24033,  37009,  37026,  37034,  37030,  37027,  37193,  37318,  37324,  38450,  38446,  38449,  38442,  38444,  
    20006,  20054,  20083,  20107,  20123,  20126,  20139,  20140,  20335,  20381,  20365,  20339,  20351,  20332,  20379,  20363,  20358,  20355,  20336,  20341,  
    20360,  20329,  20347,  20374,  20350,  20367,  20369,  20346,  20820,  20818,  20821,  20841,  20855,  20854,  20856,  20925,  20989,  21051,  21048,  21047,  
    21050,  21040,  21038,  21046,  21057,  21182,  21179,  21330,  21332,  21331,  21329,  21350,  21367,  21368,  21369,  21462,  21460,  21463,  21619,  21621,  
    21654,  21624,  21653,  21632,  21627,  21623,  21636,  21650,  21638,  21628,  21648,  21617,  21622,  21644,  21658,  21602,  21608,  21643,  21629,  21646,  
    22266,  22403,  22391,  22378,  22377,  22369,  22374,  22372,  22396,  22812,  22857,  22855,  22856,  22852,  22868,  22974,  22971,  22996,  22969,  22958,  
    22993,  22982,  22992,  22989,  22987,  22995,  22986,  22959,  22963,  22994,  22981,  23391,  23396,  23395,  23447,  23450,  23448,  23452,  23449,  23451,  
    23578,  23624,  23621,  23622,  23735,  23713,  23736,  23721,  23723,  23729,  23731,  24088,  24090,  24086,  24085,  24091,  24081,  24184,  24218,  24215,  
    24220,  24213,  24214,  24310,  24358,  24359,  24361,  24448,  24449,  24447,  24444,  24541,  24544,  24573,  24565,  24575,  24591,  24596,  24623,  24629,  
    24598,  24618,  24597,  24609,  24615,  24617,  24619,  24603,  25110,  25109,  25151,  25150,  25152,  25215,  25289,  25292,  25284,  25279,  25282,  25273,  
    25298,  25307,  25259,  25299,  25300,  25291,  25288,  25256,  25277,  25276,  25296,  25305,  25287,  25293,  25269,  25306,  25265,  25304,  25302,  25303,  
    25286,  25260,  25294,  25918,  26023,  26044,  26106,  26132,  26131,  26124,  26118,  26114,  26126,  26112,  26127,  26133,  26122,  26119,  26381,  26379,  
    26477,  26507,  26517,  26481,  26524,  26483,  26487,  26503,  26525,  26519,  26479,  26480,  26495,  26505,  26494,  26512,  26485,  26522,  26515,  26492,  
    26474,  26482,  27427,  27494,  27495,  27519,  27667,  27675,  27875,  27880,  27891,  27825,  27852,  27877,  27827,  27837,  27838,  27836,  27874,  27819,  
    27861,  27859,  27832,  27844,  27833,  27841,  27822,  27863,  27845,  27889,  27839,  27835,  27873,  27867,  27850,  27820,  27887,  27868,  27862,  27872,  
    28821,  28814,  28818,  28810,  28825,  29228,  29229,  29240,  29256,  29287,  29289,  29376,  29390,  29401,  29399,  29392,  29609,  29608,  29599,  29611,  
    29605,  30013,  30109,  30105,  30106,  30340,  30402,  30450,  30452,  30693,  30717,  31038,  31040,  31041,  31177,  31176,  31354,  31353,  31482,  31998,  
    32596,  32652,  32651,  32773,  32954,  32933,  32930,  32945,  32929,  32939,  32937,  32948,  32938,  32943,  33253,  33278,  33293,  33459,  33437,  33433,  
    33453,  33469,  33439,  33465,  33457,  33452,  33445,  33455,  33464,  33443,  33456,  33470,  33463,  34382,  34417,  21021,  34920,  36555,  36814,  36820,  
    36817,  37045,  37048,  37041,  37046,  37319,  37329,  38263,  38272,  38428,  38464,  38463,  38459,  38468,  38466,  38585,  38632,  38738,  38750,  20127,  
    20141,  20142,  20449,  20405,  20399,  20415,  20448,  20433,  20431,  20445,  20419,  20406,  20440,  20447,  20426,  20439,  20398,  20432,  20420,  20418,  
    20442,  20430,  20446,  20407,  20823,  20882,  20881,  20896,  21070,  21059,  21066,  21069,  21068,  21067,  21063,  21191,  21193,  21187,  21185,  21261,  
    21335,  21371,  21402,  21467,  21676,  21696,  21672,  21710,  21705,  21688,  21670,  21683,  21703,  21698,  21693,  21674,  21697,  21700,  21704,  21679,  
    21675,  21681,  21691,  21673,  21671,  21695,  22271,  22402,  22411,  22432,  22435,  22434,  22478,  22446,  22419,  22869,  22865,  22863,  22862,  22864,  
    23004,  23000,  23039,  23011,  23016,  23043,  23013,  23018,  23002,  23014,  23041,  23035,  23401,  23459,  23462,  23460,  23458,  23461,  23553,  23630,  
    23631,  23629,  23627,  23769,  23762,  24055,  24093,  24101,  24095,  24189,  24224,  24230,  24314,  24328,  24365,  24421,  24456,  24453,  24458,  24459,  
    24455,  24460,  24457,  24594,  24605,  24608,  24613,  24590,  24616,  24653,  24688,  24680,  24674,  24646,  24643,  24684,  24683,  24682,  24676,  25153,  
    25308,  25366,  25353,  25340,  25325,  25345,  25326,  25341,  25351,  25329,  25335,  25327,  25324,  25342,  25332,  25361,  25346,  25919,  25925,  26027,  
    26045,  26082,  26149,  26157,  26144,  26151,  26159,  26143,  26152,  26161,  26148,  26359,  26623,  26579,  26609,  26580,  26576,  26604,  26550,  26543,  
    26613,  26601,  26607,  26564,  26577,  26548,  26586,  26597,  26552,  26575,  26590,  26611,  26544,  26585,  26594,  26589,  26578,  27498,  27523,  27526,  
    27573,  27602,  27607,  27679,  27849,  27915,  27954,  27946,  27969,  27941,  27916,  27953,  27934,  27927,  27963,  27965,  27966,  27958,  27931,  27893,  
    27961,  27943,  27960,  27945,  27950,  27957,  27918,  27947,  28843,  28858,  28851,  28844,  28847,  28845,  28856,  28846,  28836,  29232,  29298,  29295,  
    29300,  29417,  29408,  29409,  29623,  29642,  29627,  29618,  29645,  29632,  29619,  29978,  29997,  30031,  30028,  30030,  30027,  30123,  30116,  30117,  
    30114,  30115,  30328,  30342,  30343,  30344,  30408,  30406,  30403,  30405,  30465,  30457,  30456,  30473,  30475,  30462,  30460,  30471,  30684,  30722,  
    30740,  30732,  30733,  31046,  31049,  31048,  31047,  31161,  31162,  31185,  31186,  31179,  31359,  31361,  31487,  31485,  31869,  32002,  32005,  32000,  
    32009,  32007,  32004,  32006,  32568,  32654,  32703,  32772,  32784,  32781,  32785,  32822,  32982,  32997,  32986,  32963,  32964,  32972,  32993,  32987,  
    32974,  32990,  32996,  32989,  33268,  33314,  33511,  33539,  33541,  33507,  33499,  33510,  33540,  33509,  33538,  33545,  33490,  33495,  33521,  33537,  
    33500,  33492,  33489,  33502,  33491,  33503,  33519,  33542,  34384,  34425,  34427,  34426,  34893,  34923,  35201,  35284,  35336,  35330,  35331,  35998,  
    36000,  36212,  36211,  36276,  36557,  36556,  36848,  36838,  36834,  36842,  36837,  36845,  36843,  36836,  36840,  37066,  37070,  37057,  37059,  37195,  
    37194,  37325,  38274,  38480,  38475,  38476,  38477,  38754,  38761,  38859,  38893,  38899,  38913,  39080,  39131,  39135,  39318,  39321,  20056,  20147,  
    20492,  20493,  20515,  20463,  20518,  20517,  20472,  20521,  20502,  20486,  20540,  20511,  20506,  20498,  20497,  20474,  20480,  20500,  20520,  20465,  
    20513,  20491,  20505,  20504,  20467,  20462,  20525,  20522,  20478,  20523,  20489,  20860,  20900,  20901,  20898,  20941,  20940,  20934,  20939,  21078,  
    21084,  21076,  21083,  21085,  21290,  21375,  21407,  21405,  21471,  21736,  21776,  21761,  21815,  21756,  21733,  21746,  21766,  21754,  21780,  21737,  
    21741,  21729,  21769,  21742,  21738,  21734,  21799,  21767,  21757,  21775,  22275,  22276,  22466,  22484,  22475,  22467,  22537,  22799,  22871,  22872,  
    22874,  23057,  23064,  23068,  23071,  23067,  23059,  23020,  23072,  23075,  23081,  23077,  23052,  23049,  23403,  23640,  23472,  23475,  23478,  23476,  
    23470,  23477,  23481,  23480,  23556,  23633,  23637,  23632,  23789,  23805,  23803,  23786,  23784,  23792,  23798,  23809,  23796,  24046,  24109,  24107,  
    24235,  24237,  24231,  24369,  24466,  24465,  24464,  24665,  24675,  24677,  24656,  24661,  24685,  24681,  24687,  24708,  24735,  24730,  24717,  24724,  
    24716,  24709,  24726,  25159,  25331,  25352,  25343,  25422,  25406,  25391,  25429,  25410,  25414,  25423,  25417,  25402,  25424,  25405,  25386,  25387,  
    25384,  25421,  25420,  25928,  25929,  26009,  26049,  26053,  26178,  26185,  26191,  26179,  26194,  26188,  26181,  26177,  26360,  26388,  26389,  26391,  
    26657,  26680,  26696,  26694,  26707,  26681,  26690,  26708,  26665,  26803,  26647,  26700,  26705,  26685,  26612,  26704,  26688,  26684,  26691,  26666,  
    26693,  26643,  26648,  26689,  27530,  27529,  27575,  27683,  27687,  27688,  27686,  27684,  27888,  28010,  28053,  28040,  28039,  28006,  28024,  28023,  
    27993,  28051,  28012,  28041,  28014,  27994,  28020,  28009,  28044,  28042,  28025,  28037,  28005,  28052,  28874,  28888,  28900,  28889,  28872,  28879,  
    29241,  29305,  29436,  29433,  29437,  29432,  29431,  29574,  29677,  29705,  29678,  29664,  29674,  29662,  30036,  30045,  30044,  30042,  30041,  30142,  
    30149,  30151,  30130,  30131,  30141,  30140,  30137,  30146,  30136,  30347,  30384,  30410,  30413,  30414,  30505,  30495,  30496,  30504,  30697,  30768,  
    30759,  30776,  30749,  30772,  30775,  30757,  30765,  30752,  30751,  30770,  31061,  31056,  31072,  31071,  31062,  31070,  31069,  31063,  31066,  31204,  
    31203,  31207,  31199,  31206,  31209,  31192,  31364,  31368,  31449,  31494,  31505,  31881,  32033,  32023,  32011,  32010,  32032,  32034,  32020,  32016,  
    32021,  32026,  32028,  32013,  32025,  32027,  32570,  32607,  32660,  32709,  32705,  32774,  32792,  32789,  32793,  32791,  32829,  32831,  33009,  33026,  
    33008,  33029,  33005,  33012,  33030,  33016,  33011,  33032,  33021,  33034,  33020,  33007,  33261,  33260,  33280,  33296,  33322,  33323,  33320,  33324,  
    33467,  33579,  33618,  33620,  33610,  33592,  33616,  33609,  33589,  33588,  33615,  33586,  33593,  33590,  33559,  33600,  33585,  33576,  33603,  34388,  
    34442,  34474,  34451,  34468,  34473,  34444,  34467,  34460,  34928,  34935,  34945,  34946,  34941,  34937,  35352,  35344,  35342,  35340,  35349,  35338,  
    35351,  35347,  35350,  35343,  35345,  35912,  35962,  35961,  36001,  36002,  36215,  36524,  36562,  36564,  36559,  36785,  36865,  36870,  36855,  36864,  
    36858,  36852,  36867,  36861,  36869,  36856,  37013,  37089,  37085,  37090,  37202,  37197,  37196,  37336,  37341,  37335,  37340,  37337,  38275,  38498,  
    38499,  38497,  38491,  38493,  38500,  38488,  38494,  38587,  39138,  39340,  39592,  39640,  39717,  39730,  39740,  20094,  20602,  20605,  20572,  20551,  
    20547,  20556,  20570,  20553,  20581,  20598,  20558,  20565,  20597,  20596,  20599,  20559,  20495,  20591,  20589,  20828,  20885,  20976,  21098,  21103,  
    21202,  21209,  21208,  21205,  21264,  21263,  21273,  21311,  21312,  21310,  21443,  26364,  21830,  21866,  21862,  21828,  21854,  21857,  21827,  21834,  
    21809,  21846,  21839,  21845,  21807,  21860,  21816,  21806,  21852,  21804,  21859,  21811,  21825,  21847,  22280,  22283,  22281,  22495,  22533,  22538,  
    22534,  22496,  22500,  22522,  22530,  22581,  22519,  22521,  22816,  22882,  23094,  23105,  23113,  23142,  23146,  23104,  23100,  23138,  23130,  23110,  
    23114,  23408,  23495,  23493,  23492,  23490,  23487,  23494,  23561,  23560,  23559,  23648,  23644,  23645,  23815,  23814,  23822,  23835,  23830,  23842,  
    23825,  23849,  23828,  23833,  23844,  23847,  23831,  24034,  24120,  24118,  24115,  24119,  24247,  24248,  24246,  24245,  24254,  24373,  24375,  24407,  
    24428,  24425,  24427,  24471,  24473,  24478,  24472,  24481,  24480,  24476,  24703,  24739,  24713,  24736,  24744,  24779,  24756,  24806,  24765,  24773,  
    24763,  24757,  24796,  24764,  24792,  24789,  24774,  24799,  24760,  24794,  24775,  25114,  25115,  25160,  25504,  25511,  25458,  25494,  25506,  25509,  
    25463,  25447,  25496,  25514,  25457,  25513,  25481,  25475,  25499,  25451,  25512,  25476,  25480,  25497,  25505,  25516,  25490,  25487,  25472,  25467,  
    25449,  25448,  25466,  25949,  25942,  25937,  25945,  25943,  21855,  25935,  25944,  25941,  25940,  26012,  26011,  26028,  26063,  26059,  26060,  26062,  
    26205,  26202,  26212,  26216,  26214,  26206,  26361,  21207,  26395,  26753,  26799,  26786,  26771,  26805,  26751,  26742,  26801,  26791,  26775,  26800,  
    26755,  26820,  26797,  26758,  26757,  26772,  26781,  26792,  26783,  26785,  26754,  27442,  27578,  27627,  27628,  27691,  28046,  28092,  28147,  28121,  
    28082,  28129,  28108,  28132,  28155,  28154,  28165,  28103,  28107,  28079,  28113,  28078,  28126,  28153,  28088,  28151,  28149,  28101,  28114,  28186,  
    28085,  28122,  28139,  28120,  28138,  28145,  28142,  28136,  28102,  28100,  28074,  28140,  28095,  28134,  28921,  28937,  28938,  28925,  28911,  29245,  
    29309,  29313,  29468,  29467,  29462,  29459,  29465,  29575,  29701,  29706,  29699,  29702,  29694,  29709,  29920,  29942,  29943,  29980,  29986,  30053,  
    30054,  30050,  30064,  30095,  30164,  30165,  30133,  30154,  30157,  30350,  30420,  30418,  30427,  30519,  30526,  30524,  30518,  30520,  30522,  30827,  
    30787,  30798,  31077,  31080,  31085,  31227,  31378,  31381,  31520,  31528,  31515,  31532,  31526,  31513,  31518,  31534,  31890,  31895,  31893,  32070,  
    32067,  32113,  32046,  32057,  32060,  32064,  32048,  32051,  32068,  32047,  32066,  32050,  32049,  32573,  32670,  32666,  32716,  32718,  32722,  32796,  
    32842,  32838,  33071,  33046,  33059,  33067,  33065,  33072,  33060,  33282,  33333,  33335,  33334,  33337,  33678,  33694,  33688,  33656,  33698,  33686,  
    33725,  33707,  33682,  33674,  33683,  33673,  33696,  33655,  33659,  33660,  33670,  33703,  34389,  24426,  34503,  34496,  34486,  34500,  34485,  34502,  
    34507,  34481,  34479,  34505,  34899,  34974,  34952,  34987,  34962,  34966,  34957,  34955,  35219,  35215,  35370,  35357,  35363,  35365,  35377,  35373,  
    35359,  35355,  35362,  35913,  35930,  36009,  36012,  36011,  36008,  36010,  36007,  36199,  36198,  36286,  36282,  36571,  36575,  36889,  36877,  36890,  
    36887,  36899,  36895,  36893,  36880,  36885,  36894,  36896,  36879,  36898,  36886,  36891,  36884,  37096,  37101,  37117,  37207,  37326,  37365,  37350,  
    37347,  37351,  37357,  37353,  38281,  38506,  38517,  38515,  38520,  38512,  38516,  38518,  38519,  38508,  38592,  38634,  38633,  31456,  31455,  38914,  
    38915,  39770,  40165,  40565,  40575,  40613,  40635,  20642,  20621,  20613,  20633,  20625,  20608,  20630,  20632,  20634,  26368,  20977,  21106,  21108,  
    21109,  21097,  21214,  21213,  21211,  21338,  21413,  21883,  21888,  21927,  21884,  21898,  21917,  21912,  21890,  21916,  21930,  21908,  21895,  21899,  
    21891,  21939,  21934,  21919,  21822,  21938,  21914,  21947,  21932,  21937,  21886,  21897,  21931,  21913,  22285,  22575,  22570,  22580,  22564,  22576,  
    22577,  22561,  22557,  22560,  22777,  22778,  22880,  23159,  23194,  23167,  23186,  23195,  23207,  23411,  23409,  23506,  23500,  23507,  23504,  23562,  
    23563,  23601,  23884,  23888,  23860,  23879,  24061,  24133,  24125,  24128,  24131,  24190,  24266,  24257,  24258,  24260,  24380,  24429,  24489,  24490,  
    24488,  24785,  24801,  24754,  24758,  24800,  24860,  24867,  24826,  24853,  24816,  24827,  24820,  24936,  24817,  24846,  24822,  24841,  24832,  24850,  
    25119,  25161,  25507,  25484,  25551,  25536,  25577,  25545,  25542,  25549,  25554,  25571,  25552,  25569,  25558,  25581,  25582,  25462,  25588,  25578,  
    25563,  25682,  25562,  25593,  25950,  25958,  25954,  25955,  26001,  26000,  26031,  26222,  26224,  26228,  26230,  26223,  26257,  26234,  26238,  26231,  
    26366,  26367,  26399,  26397,  26874,  26837,  26848,  26840,  26839,  26885,  26847,  26869,  26862,  26855,  26873,  26834,  26866,  26851,  26827,  26829,  
    26893,  26898,  26894,  26825,  26842,  26990,  26875,  27454,  27450,  27453,  27544,  27542,  27580,  27631,  27694,  27695,  27692,  28207,  28216,  28244,  
    28193,  28210,  28263,  28234,  28192,  28197,  28195,  28187,  28251,  28248,  28196,  28246,  28270,  28205,  28198,  28271,  28212,  28237,  28218,  28204,  
    28227,  28189,  28222,  28363,  28297,  28185,  28238,  28259,  28228,  28274,  28265,  28255,  28953,  28954,  28966,  28976,  28961,  28982,  29038,  28956,  
    29260,  29316,  29312,  29494,  29477,  29492,  29481,  29754,  29738,  29747,  29730,  29733,  29749,  29750,  29748,  29743,  29723,  29734,  29736,  29989,  
    29990,  30059,  30058,  30178,  30171,  30179,  30169,  30168,  30174,  30176,  30331,  30332,  30358,  30355,  30388,  30428,  30543,  30701,  30813,  30828,  
    30831,  31245,  31240,  31243,  31237,  31232,  31384,  31383,  31382,  31461,  31459,  31561,  31574,  31558,  31568,  31570,  31572,  31565,  31563,  31567,  
    31569,  31903,  31909,  32094,  32080,  32104,  32085,  32043,  32110,  32114,  32097,  32102,  32098,  32112,  32115,  21892,  32724,  32725,  32779,  32850,  
    32901,  33109,  33108,  33099,  33105,  33102,  33081,  33094,  33086,  33100,  33107,  33140,  33298,  33308,  33769,  33795,  33784,  33805,  33760,  33733,  
    33803,  33729,  33775,  33777,  33780,  33879,  33802,  33776,  33804,  33740,  33789,  33778,  33738,  33848,  33806,  33796,  33756,  33799,  33748,  33759,  
    34395,  34527,  34521,  34541,  34516,  34523,  34532,  34512,  34526,  34903,  35009,  35010,  34993,  35203,  35222,  35387,  35424,  35413,  35422,  35388,  
    35393,  35412,  35419,  35408,  35398,  35380,  35386,  35382,  35414,  35937,  35970,  36015,  36028,  36019,  36029,  36033,  36027,  36032,  36020,  36023,  
    36022,  36031,  36024,  36234,  36229,  36225,  36302,  36317,  36299,  36314,  36305,  36300,  36315,  36294,  36603,  36600,  36604,  36764,  36910,  36917,  
    36913,  36920,  36914,  36918,  37122,  37109,  37129,  37118,  37219,  37221,  37327,  37396,  37397,  37411,  37385,  37406,  37389,  37392,  37383,  37393,  
    38292,  38287,  38283,  38289,  38291,  38290,  38286,  38538,  38542,  38539,  38525,  38533,  38534,  38541,  38514,  38532,  38593,  38597,  38596,  38598,  
    38599,  38639,  38642,  38860,  38917,  38918,  38920,  39143,  39146,  39151,  39145,  39154,  39149,  39342,  39341,  40643,  40653,  40657,  20098,  20653,  
    20661,  20658,  20659,  20677,  20670,  20652,  20663,  20667,  20655,  20679,  21119,  21111,  21117,  21215,  21222,  21220,  21218,  21219,  21295,  21983,  
    21992,  21971,  21990,  21966,  21980,  21959,  21969,  21987,  21988,  21999,  21978,  21985,  21957,  21958,  21989,  21961,  22290,  22291,  22622,  22609,  
    22616,  22615,  22618,  22612,  22635,  22604,  22637,  22602,  22626,  22610,  22603,  22887,  23233,  23241,  23244,  23230,  23229,  23228,  23219,  23234,  
    23218,  23913,  23919,  24140,  24185,  24265,  24264,  24338,  24409,  24492,  24494,  24858,  24847,  24904,  24863,  24819,  24859,  24825,  24833,  24840,  
    24910,  24908,  24900,  24909,  24894,  24884,  24871,  24845,  24838,  24887,  25121,  25122,  25619,  25662,  25630,  25642,  25645,  25661,  25644,  25615,  
    25628,  25620,  25613,  25654,  25622,  25623,  25606,  25964,  26015,  26032,  26263,  26249,  26247,  26248,  26262,  26244,  26264,  26253,  26371,  27028,  
    26989,  26970,  26999,  26976,  26964,  26997,  26928,  27010,  26954,  26984,  26987,  26974,  26963,  27001,  27014,  26973,  26979,  26971,  27463,  27506,  
    27584,  27583,  27603,  27645,  28322,  28335,  28371,  28342,  28354,  28304,  28317,  28359,  28357,  28325,  28312,  28348,  28346,  28331,  28369,  28310,  
    28316,  28356,  28372,  28330,  28327,  28340,  29006,  29017,  29033,  29028,  29001,  29031,  29020,  29036,  29030,  29004,  29029,  29022,  28998,  29032,  
    29014,  29242,  29266,  29495,  29509,  29503,  29502,  29807,  29786,  29781,  29791,  29790,  29761,  29759,  29785,  29787,  29788,  30070,  30072,  30208,  
    30192,  30209,  30194,  30193,  30202,  30207,  30196,  30195,  30430,  30431,  30555,  30571,  30566,  30558,  30563,  30585,  30570,  30572,  30556,  30565,  
    30568,  30562,  30702,  30862,  30896,  30871,  30872,  30860,  30857,  30844,  30865,  30867,  30847,  31098,  31103,  31105,  33836,  31165,  31260,  31258,  
    31264,  31252,  31263,  31262,  31391,  31392,  31607,  31680,  31584,  31598,  31591,  31921,  31923,  31925,  32147,  32121,  32145,  32129,  32143,  32091,  
    32622,  32617,  32618,  32626,  32681,  32680,  32676,  32854,  32856,  32902,  32900,  33137,  33136,  33144,  33125,  33134,  33139,  33131,  33145,  33146,  
    33126,  33285,  33351,  33922,  33911,  33853,  33841,  33909,  33894,  33899,  33865,  33900,  33883,  33852,  33845,  33889,  33891,  33897,  33901,  33862,  
    34398,  34396,  34399,  34553,  34579,  34568,  34567,  34560,  34558,  34555,  34562,  34563,  34566,  34570,  34905,  35039,  35028,  35033,  35036,  35032,  
    35037,  35041,  35018,  35029,  35026,  35228,  35299,  35435,  35442,  35443,  35430,  35433,  35440,  35463,  35452,  35427,  35488,  35441,  35461,  35437,  
    35426,  35438,  35436,  35449,  35451,  35390,  35432,  35938,  35978,  35977,  36042,  36039,  36040,  36036,  36018,  36035,  36034,  36037,  36321,  36319,  
    36328,  36335,  36339,  36346,  36330,  36324,  36326,  36530,  36611,  36617,  36606,  36618,  36767,  36786,  36939,  36938,  36947,  36930,  36948,  36924,  
    36949,  36944,  36935,  36943,  36942,  36941,  36945,  36926,  36929,  37138,  37143,  37228,  37226,  37225,  37321,  37431,  37463,  37432,  37437,  37440,  
    37438,  37467,  37451,  37476,  37457,  37428,  37449,  37453,  37445,  37433,  37439,  37466,  38296,  38552,  38548,  38549,  38605,  38603,  38601,  38602,  
    38647,  38651,  38649,  38646,  38742,  38772,  38774,  38928,  38929,  38931,  38922,  38930,  38924,  39164,  39156,  39165,  39166,  39347,  39345,  39348,  
    39649,  40169,  40578,  40718,  40723,  40736,  20711,  20718,  20709,  20694,  20717,  20698,  20693,  20687,  20689,  20721,  20686,  20713,  20834,  20979,  
    21123,  21122,  21297,  21421,  22014,  22016,  22043,  22039,  22013,  22036,  22022,  22025,  22029,  22030,  22007,  22038,  22047,  22024,  22032,  22006,  
    22296,  22294,  22645,  22654,  22659,  22675,  22666,  22649,  22661,  22653,  22781,  22821,  22818,  22820,  22890,  22889,  23265,  23270,  23273,  23255,  
    23254,  23256,  23267,  23413,  23518,  23527,  23521,  23525,  23526,  23528,  23522,  23524,  23519,  23565,  23650,  23940,  23943,  24155,  24163,  24149,  
    24151,  24148,  24275,  24278,  24330,  24390,  24432,  24505,  24903,  24895,  24907,  24951,  24930,  24931,  24927,  24922,  24920,  24949,  25130,  25735,  
    25688,  25684,  25764,  25720,  25695,  25722,  25681,  25703,  25652,  25709,  25723,  25970,  26017,  26071,  26070,  26274,  26280,  26269,  27036,  27048,  
    27029,  27073,  27054,  27091,  27083,  27035,  27063,  27067,  27051,  27060,  27088,  27085,  27053,  27084,  27046,  27075,  27043,  27465,  27468,  27699,  
    28467,  28436,  28414,  28435,  28404,  28457,  28478,  28448,  28460,  28431,  28418,  28450,  28415,  28399,  28422,  28465,  28472,  28466,  28451,  28437,  
    28459,  28463,  28552,  28458,  28396,  28417,  28402,  28364,  28407,  29076,  29081,  29053,  29066,  29060,  29074,  29246,  29330,  29334,  29508,  29520,  
    29796,  29795,  29802,  29808,  29805,  29956,  30097,  30247,  30221,  30219,  30217,  30227,  30433,  30435,  30596,  30589,  30591,  30561,  30913,  30879,  
    30887,  30899,  30889,  30883,  31118,  31119,  31117,  31278,  31281,  31402,  31401,  31469,  31471,  31649,  31637,  31627,  31605,  31639,  31645,  31636,  
    31631,  31672,  31623,  31620,  31929,  31933,  31934,  32187,  32176,  32156,  32189,  32190,  32160,  32202,  32180,  32178,  32177,  32186,  32162,  32191,  
    32181,  32184,  32173,  32210,  32199,  32172,  32624,  32736,  32737,  32735,  32862,  32858,  32903,  33104,  33152,  33167,  33160,  33162,  33151,  33154,  
    33255,  33274,  33287,  33300,  33310,  33355,  33993,  33983,  33990,  33988,  33945,  33950,  33970,  33948,  33995,  33976,  33984,  34003,  33936,  33980,  
    34001,  33994,  34623,  34588,  34619,  34594,  34597,  34612,  34584,  34645,  34615,  34601,  35059,  35074,  35060,  35065,  35064,  35069,  35048,  35098,  
    35055,  35494,  35468,  35486,  35491,  35469,  35489,  35475,  35492,  35498,  35493,  35496,  35480,  35473,  35482,  35495,  35946,  35981,  35980,  36051,  
    36049,  36050,  36203,  36249,  36245,  36348,  36628,  36626,  36629,  36627,  36771,  36960,  36952,  36956,  36963,  36953,  36958,  36962,  36957,  36955,  
    37145,  37144,  37150,  37237,  37240,  37239,  37236,  37496,  37504,  37509,  37528,  37526,  37499,  37523,  37532,  37544,  37500,  37521,  38305,  38312,  
    38313,  38307,  38309,  38308,  38553,  38556,  38555,  38604,  38610,  38656,  38780,  38789,  38902,  38935,  38936,  39087,  39089,  39171,  39173,  39180,  
    39177,  39361,  39599,  39600,  39654,  39745,  39746,  40180,  40182,  40179,  40636,  40763,  40778,  20740,  20736,  20731,  20725,  20729,  20738,  20744,  
    20745,  20741,  20956,  21127,  21128,  21129,  21133,  21130,  21232,  21426,  22062,  22075,  22073,  22066,  22079,  22068,  22057,  22099,  22094,  22103,  
    22132,  22070,  22063,  22064,  22656,  22687,  22686,  22707,  22684,  22702,  22697,  22694,  22893,  23305,  23291,  23307,  23285,  23308,  23304,  23534,  
    23532,  23529,  23531,  23652,  23653,  23965,  23956,  24162,  24159,  24161,  24290,  24282,  24287,  24285,  24291,  24288,  24392,  24433,  24503,  24501,  
    24950,  24935,  24942,  24925,  24917,  24962,  24956,  24944,  24939,  24958,  24999,  24976,  25003,  24974,  25004,  24986,  24996,  24980,  25006,  25134,  
    25705,  25711,  25721,  25758,  25778,  25736,  25744,  25776,  25765,  25747,  25749,  25769,  25746,  25774,  25773,  25771,  25754,  25772,  25753,  25762,  
    25779,  25973,  25975,  25976,  26286,  26283,  26292,  26289,  27171,  27167,  27112,  27137,  27166,  27161,  27133,  27169,  27155,  27146,  27123,  27138,  
    27141,  27117,  27153,  27472,  27470,  27556,  27589,  27590,  28479,  28540,  28548,  28497,  28518,  28500,  28550,  28525,  28507,  28536,  28526,  28558,  
    28538,  28528,  28516,  28567,  28504,  28373,  28527,  28512,  28511,  29087,  29100,  29105,  29096,  29270,  29339,  29518,  29527,  29801,  29835,  29827,  
    29822,  29824,  30079,  30240,  30249,  30239,  30244,  30246,  30241,  30242,  30362,  30394,  30436,  30606,  30599,  30604,  30609,  30603,  30923,  30917,  
    30906,  30922,  30910,  30933,  30908,  30928,  31295,  31292,  31296,  31293,  31287,  31291,  31407,  31406,  31661,  31665,  31684,  31668,  31686,  31687,  
    31681,  31648,  31692,  31946,  32224,  32244,  32239,  32251,  32216,  32236,  32221,  32232,  32227,  32218,  32222,  32233,  32158,  32217,  32242,  32249,  
    32629,  32631,  32687,  32745,  32806,  33179,  33180,  33181,  33184,  33178,  33176,  34071,  34109,  34074,  34030,  34092,  34093,  34067,  34065,  34083,  
    34081,  34068,  34028,  34085,  34047,  34054,  34690,  34676,  34678,  34656,  34662,  34680,  34664,  34649,  34647,  34636,  34643,  34907,  34909,  35088,  
    35079,  35090,  35091,  35093,  35082,  35516,  35538,  35527,  35524,  35477,  35531,  35576,  35506,  35529,  35522,  35519,  35504,  35542,  35533,  35510,  
    35513,  35547,  35916,  35918,  35948,  36064,  36062,  36070,  36068,  36076,  36077,  36066,  36067,  36060,  36074,  36065,  36205,  36255,  36259,  36395,  
    36368,  36381,  36386,  36367,  36393,  36383,  36385,  36382,  36538,  36637,  36635,  36639,  36649,  36646,  36650,  36636,  36638,  36645,  36969,  36974,  
    36968,  36973,  36983,  37168,  37165,  37159,  37169,  37255,  37257,  37259,  37251,  37573,  37563,  37559,  37610,  37548,  37604,  37569,  37555,  37564,  
    37586,  37575,  37616,  37554,  38317,  38321,  38660,  38662,  38663,  38665,  38752,  38797,  38795,  38799,  38945,  38955,  38940,  39091,  39178,  39187,  
    39186,  39192,  39389,  39376,  39391,  39387,  39377,  39381,  39378,  39385,  39607,  39662,  39663,  39719,  39749,  39748,  39799,  39791,  40198,  40201,  
    40195,  40617,  40638,  40654,  22696,  40786,  20754,  20760,  20756,  20752,  20757,  20864,  20906,  20957,  21137,  21139,  21235,  22105,  22123,  22137,  
    22121,  22116,  22136,  22122,  22120,  22117,  22129,  22127,  22124,  22114,  22134,  22721,  22718,  22727,  22725,  22894,  23325,  23348,  23416,  23536,  
    23566,  24394,  25010,  24977,  25001,  24970,  25037,  25014,  25022,  25034,  25032,  25136,  25797,  25793,  25803,  25787,  25788,  25818,  25796,  25799,  
    25794,  25805,  25791,  25810,  25812,  25790,  25972,  26310,  26313,  26297,  26308,  26311,  26296,  27197,  27192,  27194,  27225,  27243,  27224,  27193,  
    27204,  27234,  27233,  27211,  27207,  27189,  27231,  27208,  27481,  27511,  27653,  28610,  28593,  28577,  28611,  28580,  28609,  28583,  28595,  28608,  
    28601,  28598,  28582,  28576,  28596,  29118,  29129,  29136,  29138,  29128,  29141,  29113,  29134,  29145,  29148,  29123,  29124,  29544,  29852,  29859,  
    29848,  29855,  29854,  29922,  29964,  29965,  30260,  30264,  30266,  30439,  30437,  30624,  30622,  30623,  30629,  30952,  30938,  30956,  30951,  31142,  
    31309,  31310,  31302,  31308,  31307,  31418,  31705,  31761,  31689,  31716,  31707,  31713,  31721,  31718,  31957,  31958,  32266,  32273,  32264,  32283,  
    32291,  32286,  32285,  32265,  32272,  32633,  32690,  32752,  32753,  32750,  32808,  33203,  33193,  33192,  33275,  33288,  33368,  33369,  34122,  34137,  
    34120,  34152,  34153,  34115,  34121,  34157,  34154,  34142,  34691,  34719,  34718,  34722,  34701,  34913,  35114,  35122,  35109,  35115,  35105,  35242,  
    35238,  35558,  35578,  35563,  35569,  35584,  35548,  35559,  35566,  35582,  35585,  35586,  35575,  35565,  35571,  35574,  35580,  35947,  35949,  35987,  
    36084,  36420,  36401,  36404,  36418,  36409,  36405,  36667,  36655,  36664,  36659,  36776,  36774,  36981,  36980,  36984,  36978,  36988,  36986,  37172,  
    37266,  37664,  37686,  37624,  37683,  37679,  37666,  37628,  37675,  37636,  37658,  37648,  37670,  37665,  37653,  37678,  37657,  38331,  38567,  38568,  
    38570,  38613,  38670,  38673,  38678,  38669,  38675,  38671,  38747,  38748,  38758,  38808,  38960,  38968,  38971,  38967,  38957,  38969,  38948,  39184,  
    39208,  39198,  39195,  39201,  39194,  39405,  39394,  39409,  39608,  39612,  39675,  39661,  39720,  39825,  40213,  40227,  40230,  40232,  40210,  40219,  
    40664,  40660,  40845,  40860,  20778,  20767,  20769,  20786,  21237,  22158,  22144,  22160,  22149,  22151,  22159,  22741,  22739,  22737,  22734,  23344,  
    23338,  23332,  23418,  23607,  23656,  23996,  23994,  23997,  23992,  24171,  24396,  24509,  25033,  25026,  25031,  25062,  25035,  25138,  25140,  25806,  
    25802,  25816,  25824,  25840,  25830,  25836,  25841,  25826,  25837,  25986,  25987,  26329,  26326,  27264,  27284,  27268,  27298,  27292,  27355,  27299,  
    27262,  27287,  27280,  27296,  27484,  27566,  27610,  27656,  28632,  28657,  28639,  28640,  28635,  28644,  28651,  28655,  28544,  28652,  28641,  28649,  
    28629,  28654,  28656,  29159,  29151,  29166,  29158,  29157,  29165,  29164,  29172,  29152,  29237,  29254,  29552,  29554,  29865,  29872,  29862,  29864,  
    30278,  30274,  30284,  30442,  30643,  30634,  30640,  30636,  30631,  30637,  30703,  30967,  30970,  30964,  30959,  30977,  31143,  31146,  31319,  31423,  
    31751,  31757,  31742,  31735,  31756,  31712,  31968,  31964,  31966,  31970,  31967,  31961,  31965,  32302,  32318,  32326,  32311,  32306,  32323,  32299,  
    32317,  32305,  32325,  32321,  32308,  32313,  32328,  32309,  32319,  32303,  32580,  32755,  32764,  32881,  32882,  32880,  32879,  32883,  33222,  33219,  
    33210,  33218,  33216,  33215,  33213,  33225,  33214,  33256,  33289,  33393,  34218,  34180,  34174,  34204,  34193,  34196,  34223,  34203,  34183,  34216,  
    34186,  34407,  34752,  34769,  34739,  34770,  34758,  34731,  34747,  34746,  34760,  34763,  35131,  35126,  35140,  35128,  35133,  35244,  35598,  35607,  
    35609,  35611,  35594,  35616,  35613,  35588,  35600,  35905,  35903,  35955,  36090,  36093,  36092,  36088,  36091,  36264,  36425,  36427,  36424,  36426,  
    36676,  36670,  36674,  36677,  36671,  36991,  36989,  36996,  36993,  36994,  36992,  37177,  37283,  37278,  37276,  37709,  37762,  37672,  37749,  37706,  
    37733,  37707,  37656,  37758,  37740,  37723,  37744,  37722,  37716,  38346,  38347,  38348,  38344,  38342,  38577,  38584,  38614,  38684,  38686,  38816,  
    38867,  38982,  39094,  39221,  39425,  39423,  39854,  39851,  39850,  39853,  40251,  40255,  40587,  40655,  40670,  40668,  40669,  40667,  40766,  40779,  
    21474,  22165,  22190,  22745,  22744,  23352,  24413,  25059,  25139,  25844,  25842,  25854,  25862,  25850,  25851,  25847,  26039,  26332,  26406,  27315,  
    27308,  27331,  27323,  27320,  27330,  27310,  27311,  27487,  27512,  27567,  28681,  28683,  28670,  28678,  28666,  28689,  28687,  29179,  29180,  29182,  
    29176,  29559,  29557,  29863,  29887,  29973,  30294,  30296,  30290,  30653,  30655,  30651,  30652,  30990,  31150,  31329,  31330,  31328,  31428,  31429,  
    31787,  31783,  31786,  31774,  31779,  31777,  31975,  32340,  32341,  32350,  32346,  32353,  32338,  32345,  32584,  32761,  32763,  32887,  32886,  33229,  
    33231,  33290,  34255,  34217,  34253,  34256,  34249,  34224,  34234,  34233,  34214,  34799,  34796,  34802,  34784,  35206,  35250,  35316,  35624,  35641,  
    35628,  35627,  35920,  36101,  36441,  36451,  36454,  36452,  36447,  36437,  36544,  36681,  36685,  36999,  36995,  37000,  37291,  37292,  37328,  37780,  
    37770,  37782,  37794,  37811,  37806,  37804,  37808,  37784,  37786,  37783,  38356,  38358,  38352,  38357,  38626,  38620,  38617,  38619,  38622,  38692,  
    38819,  38822,  38829,  38905,  38989,  38991,  38988,  38990,  38995,  39098,  39230,  39231,  39229,  39214,  39333,  39438,  39617,  39683,  39686,  39759,  
    39758,  39757,  39882,  39881,  39933,  39880,  39872,  40273,  40285,  40288,  40672,  40725,  40748,  20787,  22181,  22750,  22751,  22754,  23541,  40848,  
    24300,  25074,  25079,  25078,  25077,  25856,  25871,  26336,  26333,  27365,  27357,  27354,  27347,  28699,  28703,  28712,  28698,  28701,  28693,  28696,  
    29190,  29197,  29272,  29346,  29560,  29562,  29885,  29898,  29923,  30087,  30086,  30303,  30305,  30663,  31001,  31153,  31339,  31337,  31806,  31807,  
    31800,  31805,  31799,  31808,  32363,  32365,  32377,  32361,  32362,  32645,  32371,  32694,  32697,  32696,  33240,  34281,  34269,  34282,  34261,  34276,  
    34277,  34295,  34811,  34821,  34829,  34809,  34814,  35168,  35167,  35158,  35166,  35649,  35676,  35672,  35657,  35674,  35662,  35663,  35654,  35673,  
    36104,  36106,  36476,  36466,  36487,  36470,  36460,  36474,  36468,  36692,  36686,  36781,  37002,  37003,  37297,  37294,  37857,  37841,  37855,  37827,  
    37832,  37852,  37853,  37846,  37858,  37837,  37848,  37860,  37847,  37864,  38364,  38580,  38627,  38698,  38695,  38753,  38876,  38907,  39006,  39000,  
    39003,  39100,  39237,  39241,  39446,  39449,  39693,  39912,  39911,  39894,  39899,  40329,  40289,  40306,  40298,  40300,  40594,  40599,  40595,  40628,  
    21240,  22184,  22199,  22198,  22196,  22204,  22756,  23360,  23363,  23421,  23542,  24009,  25080,  25082,  25880,  25876,  25881,  26342,  26407,  27372,  
    28734,  28720,  28722,  29200,  29563,  29903,  30306,  30309,  31014,  31018,  31020,  31019,  31431,  31478,  31820,  31811,  31821,  31983,  31984,  36782,  
    32381,  32380,  32386,  32588,  32768,  33242,  33382,  34299,  34297,  34321,  34298,  34310,  34315,  34311,  34314,  34836,  34837,  35172,  35258,  35320,  
    35696,  35692,  35686,  35695,  35679,  35691,  36111,  36109,  36489,  36481,  36485,  36482,  37300,  37323,  37912,  37891,  37885,  38369,  38704,  39108,  
    39250,  39249,  39336,  39467,  39472,  39479,  39477,  39955,  39949,  40569,  40629,  40680,  40751,  40799,  40803,  40801,  20791,  20792,  22209,  22208,  
    22210,  22804,  23660,  24013,  25084,  25086,  25885,  25884,  26005,  26345,  27387,  27396,  27386,  27570,  28748,  29211,  29351,  29910,  29908,  30313,  
    30675,  31824,  32399,  32396,  32700,  34327,  34349,  34330,  34851,  34850,  34849,  34847,  35178,  35180,  35261,  35700,  35703,  35709,  36115,  36490,  
    36493,  36491,  36703,  36783,  37306,  37934,  37939,  37941,  37946,  37944,  37938,  37931,  38370,  38712,  38713,  38706,  38911,  39015,  39013,  39255,  
    39493,  39491,  39488,  39486,  39631,  39764,  39761,  39981,  39973,  40367,  40372,  40386,  40376,  40605,  40687,  40729,  40796,  40806,  40807,  20796,  
    20795,  22216,  22218,  22217,  23423,  24020,  24018,  24398,  25087,  25892,  27402,  27489,  28753,  28760,  29568,  29924,  30090,  30318,  30316,  31155,  
    31840,  31839,  32894,  32893,  33247,  35186,  35183,  35324,  35712,  36118,  36119,  36497,  36499,  36705,  37192,  37956,  37969,  37970,  38717,  38718,  
    38851,  38849,  39019,  39253,  39509,  39501,  39634,  39706,  40009,  39985,  39998,  39995,  40403,  40407,  40756,  40812,  40810,  40852,  22220,  24022,  
    25088,  25891,  25899,  25898,  26348,  27408,  29914,  31434,  31844,  31843,  31845,  32403,  32406,  32404,  33250,  34360,  34367,  34865,  35722,  37008,  
    37007,  37987,  37984,  37988,  38760,  39023,  39260,  39514,  39515,  39511,  39635,  39636,  39633,  40020,  40023,  40022,  40421,  40607,  40692,  22225,  
    22761,  25900,  28766,  30321,  30322,  30679,  32592,  32648,  34870,  34873,  34914,  35731,  35730,  35734,  33399,  36123,  37312,  37994,  38722,  38728,  
    38724,  38854,  39024,  39519,  39714,  39768,  40031,  40441,  40442,  40572,  40573,  40711,  40823,  40818,  24307,  27414,  28771,  31852,  31854,  34875,  
    35264,  36513,  37313,  38002,  38000,  39025,  39262,  39638,  39715,  40652,  28772,  30682,  35738,  38007,  38857,  39522,  39525,  32412,  35740,  36522,  
    37317,  38013,  38014,  38012,  40055,  40056,  40695,  35924,  38015,  40474,  29224,  39530,  39729,  40475,  40478,  31858,  9312,   9313,   9314,   9315,   
    9316,   9317,   9318,   9319,   9320,   9321,   9332,   9333,   9334,   9335,   9336,   9337,   9338,   9339,   9340,   9341,   8560,   8561,   8562,   8563,   
    8564,   8565,   8566,   8567,   8568,   8569,   20022,  20031,  20101,  20128,  20866,  20886,  20907,  21241,  21304,  21353,  21430,  22794,  23424,  24027,  
    12083,  24191,  24308,  24400,  24417,  25908,  26080,  30098,  30326,  36789,  38582,  168,    710,    12541,  12542,  12445,  12446,  12291,  20189,  12293,  
    12294,  12295,  12540,  65339,  65341,  10045,  12353,  12354,  12355,  12356,  12357,  12358,  12359,  12360,  12361,  12362,  12363,  12364,  12365,  12366,  
    12367,  12368,  12369,  12370,  12371,  12372,  12373,  12374,  12375,  12376,  12377,  12378,  12379,  12380,  12381,  12382,  12383,  12384,  12385,  12386,  
    12387,  12388,  12389,  12390,  12391,  12392,  12393,  12394,  12395,  12396,  12397,  12398,  12399,  12400,  12401,  12402,  12403,  12404,  12405,  12406,  
    12407,  12408,  12409,  12410,  12411,  12412,  12413,  12414,  12415,  12416,  12417,  12418,  12419,  12420,  12421,  12422,  12423,  12424,  12425,  12426,  
    12427,  12428,  12429,  12430,  12431,  12432,  12433,  12434,  12435,  12449,  12450,  12451,  12452,  12453,  12454,  12455,  12456,  12457,  12458,  12459,  
    12460,  12461,  12462,  12463,  12464,  12465,  12466,  12467,  12468,  12469,  12470,  12471,  12472,  12473,  12474,  12475,  12476,  12477,  12478,  12479,  
    12480,  12481,  12482,  12483,  12484,  12485,  12486,  12487,  12488,  12489,  12490,  12491,  12492,  12493,  12494,  12495,  12496,  12497,  12498,  12499,  
    12500,  12501,  12502,  12503,  12504,  12505,  12506,  12507,  12508,  12509,  12510,  12511,  12512,  12513,  12514,  12515,  12516,  12517,  12518,  12519,  
    12520,  12521,  12522,  12523,  12524,  12525,  12526,  12527,  12528,  12529,  12530,  12531,  12532,  12533,  12534,  1040,   1041,   1042,   1043,   1044,   
    1045,   1025,   1046,   1047,   1048,   1049,   1050,   1051,   1052,   1053,   1054,   1055,   1056,   1057,   1058,   1059,   1060,   1061,   1062,   1063,   
    1064,   1065,   1066,   1067,   1068,   1069,   1070,   1071,   1072,   1073,   1074,   1075,   1076,   1077,   1105,   1078,   1079,   1080,   1081,   1082,   
    1083,   1084,   1085,   1086,   1087,   1088,   1089,   1090,   1091,   1092,   1093,   1094,   1095,   1096,   1097,   1098,   1099,   1100,   1101,   1102,   
    1103,   8679,   8632,   8633,   12751,  131276, 20058,  131210, 20994,  17553,  40880,  20872,  40881,  161287, null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   
    null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   null,   65506,  65508,  65287,  65282,  12849,  8470,   
    8481,   12443,  12444,  11904,  11908,  11910,  11911,  11912,  11914,  11916,  11917,  11925,  11932,  11933,  11941,  11943,  11946,  11948,  11950,  11958,  
    11964,  11966,  11974,  11978,  11980,  11981,  11983,  11990,  11991,  11998,  12003,  null,   null,   null,   643,    592,    603,    596,    629,    339,    
    248,    331,    650,    618,    20034,  20060,  20981,  21274,  21378,  19975,  19980,  20039,  20109,  22231,  64012,  23662,  24435,  19983,  20871,  19982,  
    20014,  20115,  20162,  20169,  20168,  20888,  21244,  21356,  21433,  22304,  22787,  22828,  23568,  24063,  26081,  27571,  27596,  27668,  29247,  20017,  
    20028,  20200,  20188,  20201,  20193,  20189,  20186,  21004,  21276,  21324,  22306,  22307,  22807,  22831,  23425,  23428,  23570,  23611,  23668,  23667,  
    24068,  24192,  24194,  24521,  25097,  25168,  27669,  27702,  27715,  27711,  27707,  29358,  29360,  29578,  31160,  32906,  38430,  20238,  20248,  20268,  
    20213,  20244,  20209,  20224,  20215,  20232,  20253,  20226,  20229,  20258,  20243,  20228,  20212,  20242,  20913,  21011,  21001,  21008,  21158,  21282,  
    21279,  21325,  21386,  21511,  22241,  22239,  22318,  22314,  22324,  22844,  22912,  22908,  22917,  22907,  22910,  22903,  22911,  23382,  23573,  23589,  
    23676,  23674,  23675,  23678,  24031,  24181,  24196,  24322,  24346,  24436,  24533,  24532,  24527,  25180,  25182,  25188,  25185,  25190,  25186,  25177,  
    25184,  25178,  25189,  26095,  26094,  26430,  26425,  26424,  26427,  26426,  26431,  26428,  26419,  27672,  27718,  27730,  27740,  27727,  27722,  27732,  
    27723,  27724,  28785,  29278,  29364,  29365,  29582,  29994,  30335,  31349,  32593,  33400,  33404,  33408,  33405,  33407,  34381,  35198,  37017,  37015,  
    37016,  37019,  37012,  38434,  38436,  38432,  38435,  20310,  20283,  20322,  20297,  20307,  20324,  20286,  20327,  20306,  20319,  20289,  20312,  20269,  
    20275,  20287,  20321,  20879,  20921,  21020,  21022,  21025,  21165,  21166,  21257,  21347,  21362,  21390,  21391,  21552,  21559,  21546,  21588,  21573,  
    21529,  21532,  21541,  21528,  21565,  21583,  21569,  21544,  21540,  21575,  22254,  22247,  22245,  22337,  22341,  22348,  22345,  22347,  22354,  22790,  
    22848,  22950,  22936,  22944,  22935,  22926,  22946,  22928,  22927,  22951,  22945,  23438,  23442,  23592,  23594,  23693,  23695,  23688,  23691,  23689,  
    23698,  23690,  23686,  23699,  23701,  24032,  24074,  24078,  24203,  24201,  24204,  24200,  24205,  24325,  24349,  24440,  24438,  24530,  24529,  24528,  
    24557,  24552,  24558,  24563,  24545,  24548,  24547,  24570,  24559,  24567,  24571,  24576,  24564,  25146,  25219,  25228,  25230,  25231,  25236,  25223,  
    25201,  25211,  25210,  25200,  25217,  25224,  25207,  25213,  25202,  25204,  25911,  26096,  26100,  26099,  26098,  26101,  26437,  26439,  26457,  26453,  
    26444,  26440,  26461,  26445,  26458,  26443,  27600,  27673,  27674,  27768,  27751,  27755,  27780,  27787,  27791,  27761,  27759,  27753,  27802,  27757,  
    27783,  27797,  27804,  27750,  27763,  27749,  27771,  27790,  28788,  28794,  29283,  29375,  29373,  29379,  29382,  29377,  29370,  29381,  29589,  29591,  
    29587,  29588,  29586,  30010,  30009,  30100,  30101,  30337,  31037,  32820,  32917,  32921,  32912,  32914,  32924,  33424,  33423,  33413,  33422,  33425,  
    33427,  33418,  33411,  33412,  35960,  36809,  36799,  37023,  37025,  37029,  37022,  37031,  37024,  38448,  38440,  38447,  38445,  20019,  20376,  20348,  
    20357,  20349,  20352,  20359,  20342,  20340,  20361,  20356,  20343,  20300,  20375,  20330,  20378,  20345,  20353,  20344,  20368,  20380,  20372,  20382,  
    20370,  20354,  20373,  20331,  20334,  20894,  20924,  20926,  21045,  21042,  21043,  21062,  21041,  21180,  21258,  21259,  21308,  21394,  21396,  21639,  
    21631,  21633,  21649,  21634,  21640,  21611,  21626,  21630,  21605,  21612,  21620,  21606,  21645,  21615,  21601,  21600,  21656,  21603,  21607,  21604,  
    22263,  22265,  22383,  22386,  22381,  22379,  22385,  22384,  22390,  22400,  22389,  22395,  22387,  22388,  22370,  22376,  22397,  22796,  22853,  22965,  
    22970,  22991,  22990,  22962,  22988,  22977,  22966,  22972,  22979,  22998,  22961,  22973,  22976,  22984,  22964,  22983,  23394,  23397,  23443,  23445,  
    23620,  23623,  23726,  23716,  23712,  23733,  23727,  23720,  23724,  23711,  23715,  23725,  23714,  23722,  23719,  23709,  23717,  23734,  23728,  23718,  
    24087,  24084,  24089,  24360,  24354,  24355,  24356,  24404,  24450,  24446,  24445,  24542,  24549,  24621,  24614,  24601,  24626,  24587,  24628,  24586,  
    24599,  24627,  24602,  24606,  24620,  24610,  24589,  24592,  24622,  24595,  24593,  24588,  24585,  24604,  25108,  25149,  25261,  25268,  25297,  25278,  
    25258,  25270,  25290,  25262,  25267,  25263,  25275,  25257,  25264,  25272,  25917,  26024,  26043,  26121,  26108,  26116,  26130,  26120,  26107,  26115,  
    26123,  26125,  26117,  26109,  26129,  26128,  26358,  26378,  26501,  26476,  26510,  26514,  26486,  26491,  26520,  26502,  26500,  26484,  26509,  26508,  
    26490,  26527,  26513,  26521,  26499,  26493,  26497,  26488,  26489,  26516,  27429,  27520,  27518,  27614,  27677,  27795,  27884,  27883,  27886,  27865,  
    27830,  27860,  27821,  27879,  27831,  27856,  27842,  27834,  27843,  27846,  27885,  27890,  27858,  27869,  27828,  27786,  27805,  27776,  27870,  27840,  
    27952,  27853,  27847,  27824,  27897,  27855,  27881,  27857,  28820,  28824,  28805,  28819,  28806,  28804,  28817,  28822,  28802,  28826,  28803,  29290,  
    29398,  29387,  29400,  29385,  29404,  29394,  29396,  29402,  29388,  29393,  29604,  29601,  29613,  29606,  29602,  29600,  29612,  29597,  29917,  29928,  
    30015,  30016,  30014,  30092,  30104,  30383,  30451,  30449,  30448,  30453,  30712,  30716,  30713,  30715,  30714,  30711,  31042,  31039,  31173,  31352,  
    31355,  31483,  31861,  31997,  32821,  32911,  32942,  32931,  32952,  32949,  32941,  33312,  33440,  33472,  33451,  33434,  33432,  33435,  33461,  33447,  
    33454,  33468,  33438,  33466,  33460,  33448,  33441,  33449,  33474,  33444,  33475,  33462,  33442,  34416,  34415,  34413,  34414,  35926,  36818,  36811,  
    36819,  36813,  36822,  36821,  36823,  37042,  37044,  37039,  37043,  37040,  38457,  38461,  38460,  38458,  38467,  20429,  20421,  20435,  20402,  20425,  
    20427,  20417,  20436,  20444,  20441,  20411,  20403,  20443,  20423,  20438,  20410,  20416,  20409,  20460,  21060,  21065,  21184,  21186,  21309,  21372,  
    21399,  21398,  21401,  21400,  21690,  21665,  21677,  21669,  21711,  21699,  33549,  21687,  21678,  21718,  21686,  21701,  21702,  21664,  21616,  21692,  
    21666,  21694,  21618,  21726,  21680,  22453,  22430,  22431,  22436,  22412,  22423,  22429,  22427,  22420,  22424,  22415,  22425,  22437,  22426,  22421,  
    22772,  22797,  22867,  23009,  23006,  23022,  23040,  23025,  23005,  23034,  23037,  23036,  23030,  23012,  23026,  23031,  23003,  23017,  23027,  23029,  
    23008,  23038,  23028,  23021,  23464,  23628,  23760,  23768,  23756,  23767,  23755,  23771,  23774,  23770,  23753,  23751,  23754,  23766,  23763,  23764,  
    23759,  23752,  23750,  23758,  23775,  23800,  24057,  24097,  24098,  24099,  24096,  24100,  24240,  24228,  24226,  24219,  24227,  24229,  24327,  24366,  
    24406,  24454,  24631,  24633,  24660,  24690,  24670,  24645,  24659,  24647,  24649,  24667,  24652,  24640,  24642,  24671,  24612,  24644,  24664,  24678,  
    24686,  25154,  25155,  25295,  25357,  25355,  25333,  25358,  25347,  25323,  25337,  25359,  25356,  25336,  25334,  25344,  25363,  25364,  25338,  25365,  
    25339,  25328,  25921,  25923,  26026,  26047,  26166,  26145,  26162,  26165,  26140,  26150,  26146,  26163,  26155,  26170,  26141,  26164,  26169,  26158,  
    26383,  26384,  26561,  26610,  26568,  26554,  26588,  26555,  26616,  26584,  26560,  26551,  26565,  26603,  26596,  26591,  26549,  26573,  26547,  26615,  
    26614,  26606,  26595,  26562,  26553,  26574,  26599,  26608,  26546,  26620,  26566,  26605,  26572,  26542,  26598,  26587,  26618,  26569,  26570,  26563,  
    26602,  26571,  27432,  27522,  27524,  27574,  27606,  27608,  27616,  27680,  27681,  27944,  27956,  27949,  27935,  27964,  27967,  27922,  27914,  27866,  
    27955,  27908,  27929,  27962,  27930,  27921,  27904,  27933,  27970,  27905,  27928,  27959,  27907,  27919,  27968,  27911,  27936,  27948,  27912,  27938,  
    27913,  27920,  28855,  28831,  28862,  28849,  28848,  28833,  28852,  28853,  28841,  29249,  29257,  29258,  29292,  29296,  29299,  29294,  29386,  29412,  
    29416,  29419,  29407,  29418,  29414,  29411,  29573,  29644,  29634,  29640,  29637,  29625,  29622,  29621,  29620,  29675,  29631,  29639,  29630,  29635,  
    29638,  29624,  29643,  29932,  29934,  29998,  30023,  30024,  30119,  30122,  30329,  30404,  30472,  30467,  30468,  30469,  30474,  30455,  30459,  30458,  
    30695,  30696,  30726,  30737,  30738,  30725,  30736,  30735,  30734,  30729,  30723,  30739,  31050,  31052,  31051,  31045,  31044,  31189,  31181,  31183,  
    31190,  31182,  31360,  31358,  31441,  31488,  31489,  31866,  31864,  31865,  31871,  31872,  31873,  32003,  32008,  32001,  32600,  32657,  32653,  32702,  
    32775,  32782,  32783,  32788,  32823,  32984,  32967,  32992,  32977,  32968,  32962,  32976,  32965,  32995,  32985,  32988,  32970,  32981,  32969,  32975,  
    32983,  32998,  32973,  33279,  33313,  33428,  33497,  33534,  33529,  33543,  33512,  33536,  33493,  33594,  33515,  33494,  33524,  33516,  33505,  33522,  
    33525,  33548,  33531,  33526,  33520,  33514,  33508,  33504,  33530,  33523,  33517,  34423,  34420,  34428,  34419,  34881,  34894,  34919,  34922,  34921,  
    35283,  35332,  35335,  36210,  36835,  36833,  36846,  36832,  37105,  37053,  37055,  37077,  37061,  37054,  37063,  37067,  37064,  37332,  37331,  38484,  
    38479,  38481,  38483,  38474,  38478,  20510,  20485,  20487,  20499,  20514,  20528,  20507,  20469,  20468,  20531,  20535,  20524,  20470,  20471,  20503,  
    20508,  20512,  20519,  20533,  20527,  20529,  20494,  20826,  20884,  20883,  20938,  20932,  20933,  20936,  20942,  21089,  21082,  21074,  21086,  21087,  
    21077,  21090,  21197,  21262,  21406,  21798,  21730,  21783,  21778,  21735,  21747,  21732,  21786,  21759,  21764,  21768,  21739,  21777,  21765,  21745,  
    21770,  21755,  21751,  21752,  21728,  21774,  21763,  21771,  22273,  22274,  22476,  22578,  22485,  22482,  22458,  22470,  22461,  22460,  22456,  22454,  
    22463,  22471,  22480,  22457,  22465,  22798,  22858,  23065,  23062,  23085,  23086,  23061,  23055,  23063,  23050,  23070,  23091,  23404,  23463,  23469,  
    23468,  23555,  23638,  23636,  23788,  23807,  23790,  23793,  23799,  23808,  23801,  24105,  24104,  24232,  24238,  24234,  24236,  24371,  24368,  24423,  
    24669,  24666,  24679,  24641,  24738,  24712,  24704,  24722,  24705,  24733,  24707,  24725,  24731,  24727,  24711,  24732,  24718,  25113,  25158,  25330,  
    25360,  25430,  25388,  25412,  25413,  25398,  25411,  25572,  25401,  25419,  25418,  25404,  25385,  25409,  25396,  25432,  25428,  25433,  25389,  25415,  
    25395,  25434,  25425,  25400,  25431,  25408,  25416,  25930,  25926,  26054,  26051,  26052,  26050,  26186,  26207,  26183,  26193,  26386,  26387,  26655,  
    26650,  26697,  26674,  26675,  26683,  26699,  26703,  26646,  26673,  26652,  26677,  26667,  26669,  26671,  26702,  26692,  26676,  26653,  26642,  26644,  
    26662,  26664,  26670,  26701,  26682,  26661,  26656,  27436,  27439,  27437,  27441,  27444,  27501,  32898,  27528,  27622,  27620,  27624,  27619,  27618,  
    27623,  27685,  28026,  28003,  28004,  28022,  27917,  28001,  28050,  27992,  28002,  28013,  28015,  28049,  28045,  28143,  28031,  28038,  27998,  28007,  
    28000,  28055,  28016,  28028,  27999,  28034,  28056,  27951,  28008,  28043,  28030,  28032,  28036,  27926,  28035,  28027,  28029,  28021,  28048,  28892,  
    28883,  28881,  28893,  28875,  32569,  28898,  28887,  28882,  28894,  28896,  28884,  28877,  28869,  28870,  28871,  28890,  28878,  28897,  29250,  29304,  
    29303,  29302,  29440,  29434,  29428,  29438,  29430,  29427,  29435,  29441,  29651,  29657,  29669,  29654,  29628,  29671,  29667,  29673,  29660,  29650,  
    29659,  29652,  29661,  29658,  29655,  29656,  29672,  29918,  29919,  29940,  29941,  29985,  30043,  30047,  30128,  30145,  30139,  30148,  30144,  30143,  
    30134,  30138,  30346,  30409,  30493,  30491,  30480,  30483,  30482,  30499,  30481,  30485,  30489,  30490,  30498,  30503,  30755,  30764,  30754,  30773,  
    30767,  30760,  30766,  30763,  30753,  30761,  30771,  30762,  30769,  31060,  31067,  31055,  31068,  31059,  31058,  31057,  31211,  31212,  31200,  31214,  
    31213,  31210,  31196,  31198,  31197,  31366,  31369,  31365,  31371,  31372,  31370,  31367,  31448,  31504,  31492,  31507,  31493,  31503,  31496,  31498,  
    31502,  31497,  31506,  31876,  31889,  31882,  31884,  31880,  31885,  31877,  32030,  32029,  32017,  32014,  32024,  32022,  32019,  32031,  32018,  32015,  
    32012,  32604,  32609,  32606,  32608,  32605,  32603,  32662,  32658,  32707,  32706,  32704,  32790,  32830,  32825,  33018,  33010,  33017,  33013,  33025,  
    33019,  33024,  33281,  33327,  33317,  33587,  33581,  33604,  33561,  33617,  33573,  33622,  33599,  33601,  33574,  33564,  33570,  33602,  33614,  33563,  
    33578,  33544,  33596,  33613,  33558,  33572,  33568,  33591,  33583,  33577,  33607,  33605,  33612,  33619,  33566,  33580,  33611,  33575,  33608,  34387,  
    34386,  34466,  34472,  34454,  34445,  34449,  34462,  34439,  34455,  34438,  34443,  34458,  34437,  34469,  34457,  34465,  34471,  34453,  34456,  34446,  
    34461,  34448,  34452,  34883,  34884,  34925,  34933,  34934,  34930,  34944,  34929,  34943,  34927,  34947,  34942,  34932,  34940,  35346,  35911,  35927,  
    35963,  36004,  36003,  36214,  36216,  36277,  36279,  36278,  36561,  36563,  36862,  36853,  36866,  36863,  36859,  36868,  36860,  36854,  37078,  37088,  
    37081,  37082,  37091,  37087,  37093,  37080,  37083,  37079,  37084,  37092,  37200,  37198,  37199,  37333,  37346,  37338,  38492,  38495,  38588,  39139,  
    39647,  39727,  20095,  20592,  20586,  20577,  20574,  20576,  20563,  20555,  20573,  20594,  20552,  20557,  20545,  20571,  20554,  20578,  20501,  20549,  
    20575,  20585,  20587,  20579,  20580,  20550,  20544,  20590,  20595,  20567,  20561,  20944,  21099,  21101,  21100,  21102,  21206,  21203,  21293,  21404,  
    21877,  21878,  21820,  21837,  21840,  21812,  21802,  21841,  21858,  21814,  21813,  21808,  21842,  21829,  21772,  21810,  21861,  21838,  21817,  21832,  
    21805,  21819,  21824,  21835,  22282,  22279,  22523,  22548,  22498,  22518,  22492,  22516,  22528,  22509,  22525,  22536,  22520,  22539,  22515,  22479,  
    22535,  22510,  22499,  22514,  22501,  22508,  22497,  22542,  22524,  22544,  22503,  22529,  22540,  22513,  22505,  22512,  22541,  22532,  22876,  23136,  
    23128,  23125,  23143,  23134,  23096,  23093,  23149,  23120,  23135,  23141,  23148,  23123,  23140,  23127,  23107,  23133,  23122,  23108,  23131,  23112,  
    23182,  23102,  23117,  23097,  23116,  23152,  23145,  23111,  23121,  23126,  23106,  23132,  23410,  23406,  23489,  23488,  23641,  23838,  23819,  23837,  
    23834,  23840,  23820,  23848,  23821,  23846,  23845,  23823,  23856,  23826,  23843,  23839,  23854,  24126,  24116,  24241,  24244,  24249,  24242,  24243,  
    24374,  24376,  24475,  24470,  24479,  24714,  24720,  24710,  24766,  24752,  24762,  24787,  24788,  24783,  24804,  24793,  24797,  24776,  24753,  24795,  
    24759,  24778,  24767,  24771,  24781,  24768,  25394,  25445,  25482,  25474,  25469,  25533,  25502,  25517,  25501,  25495,  25515,  25486,  25455,  25479,  
    25488,  25454,  25519,  25461,  25500,  25453,  25518,  25468,  25508,  25403,  25503,  25464,  25477,  25473,  25489,  25485,  25456,  25939,  26061,  26213,  
    26209,  26203,  26201,  26204,  26210,  26392,  26745,  26759,  26768,  26780,  26733,  26734,  26798,  26795,  26966,  26735,  26787,  26796,  26793,  26741,  
    26740,  26802,  26767,  26743,  26770,  26748,  26731,  26738,  26794,  26752,  26737,  26750,  26779,  26774,  26763,  26784,  26761,  26788,  26744,  26747,  
    26769,  26764,  26762,  26749,  27446,  27443,  27447,  27448,  27537,  27535,  27533,  27534,  27532,  27690,  28096,  28075,  28084,  28083,  28276,  28076,  
    28137,  28130,  28087,  28150,  28116,  28160,  28104,  28128,  28127,  28118,  28094,  28133,  28124,  28125,  28123,  28148,  28106,  28093,  28141,  28144,  
    28090,  28117,  28098,  28111,  28105,  28112,  28146,  28115,  28157,  28119,  28109,  28131,  28091,  28922,  28941,  28919,  28951,  28916,  28940,  28912,  
    28932,  28915,  28944,  28924,  28927,  28934,  28947,  28928,  28920,  28918,  28939,  28930,  28942,  29310,  29307,  29308,  29311,  29469,  29463,  29447,  
    29457,  29464,  29450,  29448,  29439,  29455,  29470,  29576,  29686,  29688,  29685,  29700,  29697,  29693,  29703,  29696,  29690,  29692,  29695,  29708,  
    29707,  29684,  29704,  30052,  30051,  30158,  30162,  30159,  30155,  30156,  30161,  30160,  30351,  30345,  30419,  30521,  30511,  30509,  30513,  30514,  
    30516,  30515,  30525,  30501,  30523,  30517,  30792,  30802,  30793,  30797,  30794,  30796,  30758,  30789,  30800,  31076,  31079,  31081,  31082,  31075,  
    31083,  31073,  31163,  31226,  31224,  31222,  31223,  31375,  31380,  31376,  31541,  31559,  31540,  31525,  31536,  31522,  31524,  31539,  31512,  31530,  
    31517,  31537,  31531,  31533,  31535,  31538,  31544,  31514,  31523,  31892,  31896,  31894,  31907,  32053,  32061,  32056,  32054,  32058,  32069,  32044,  
    32041,  32065,  32071,  32062,  32063,  32074,  32059,  32040,  32611,  32661,  32668,  32669,  32667,  32714,  32715,  32717,  32720,  32721,  32711,  32719,  
    32713,  32799,  32798,  32795,  32839,  32835,  32840,  33048,  33061,  33049,  33051,  33069,  33055,  33068,  33054,  33057,  33045,  33063,  33053,  33058,  
    33297,  33336,  33331,  33338,  33332,  33330,  33396,  33680,  33699,  33704,  33677,  33658,  33651,  33700,  33652,  33679,  33665,  33685,  33689,  33653,  
    33684,  33705,  33661,  33667,  33676,  33693,  33691,  33706,  33675,  33662,  33701,  33711,  33672,  33687,  33712,  33663,  33702,  33671,  33710,  33654,  
    33690,  34393,  34390,  34495,  34487,  34498,  34497,  34501,  34490,  34480,  34504,  34489,  34483,  34488,  34508,  34484,  34491,  34492,  34499,  34493,  
    34494,  34898,  34953,  34965,  34984,  34978,  34986,  34970,  34961,  34977,  34975,  34968,  34983,  34969,  34971,  34967,  34980,  34988,  34956,  34963,  
    34958,  35202,  35286,  35289,  35285,  35376,  35367,  35372,  35358,  35897,  35899,  35932,  35933,  35965,  36005,  36221,  36219,  36217,  36284,  36290,  
    36281,  36287,  36289,  36568,  36574,  36573,  36572,  36567,  36576,  36577,  36900,  36875,  36881,  36892,  36876,  36897,  37103,  37098,  37104,  37108,  
    37106,  37107,  37076,  37099,  37100,  37097,  37206,  37208,  37210,  37203,  37205,  37356,  37364,  37361,  37363,  37368,  37348,  37369,  37354,  37355,  
    37367,  37352,  37358,  38266,  38278,  38280,  38524,  38509,  38507,  38513,  38511,  38591,  38762,  38916,  39141,  39319,  20635,  20629,  20628,  20638,  
    20619,  20643,  20611,  20620,  20622,  20637,  20584,  20636,  20626,  20610,  20615,  20831,  20948,  21266,  21265,  21412,  21415,  21905,  21928,  21925,  
    21933,  21879,  22085,  21922,  21907,  21896,  21903,  21941,  21889,  21923,  21906,  21924,  21885,  21900,  21926,  21887,  21909,  21921,  21902,  22284,  
    22569,  22583,  22553,  22558,  22567,  22563,  22568,  22517,  22600,  22565,  22556,  22555,  22579,  22591,  22582,  22574,  22585,  22584,  22573,  22572,  
    22587,  22881,  23215,  23188,  23199,  23162,  23202,  23198,  23160,  23206,  23164,  23205,  23212,  23189,  23214,  23095,  23172,  23178,  23191,  23171,  
    23179,  23209,  23163,  23165,  23180,  23196,  23183,  23187,  23197,  23530,  23501,  23499,  23508,  23505,  23498,  23502,  23564,  23600,  23863,  23875,  
    23915,  23873,  23883,  23871,  23861,  23889,  23886,  23893,  23859,  23866,  23890,  23869,  23857,  23897,  23874,  23865,  23881,  23864,  23868,  23858,  
    23862,  23872,  23877,  24132,  24129,  24408,  24486,  24485,  24491,  24777,  24761,  24780,  24802,  24782,  24772,  24852,  24818,  24842,  24854,  24837,  
    24821,  24851,  24824,  24828,  24830,  24769,  24835,  24856,  24861,  24848,  24831,  24836,  24843,  25162,  25492,  25521,  25520,  25550,  25573,  25576,  
    25583,  25539,  25757,  25587,  25546,  25568,  25590,  25557,  25586,  25589,  25697,  25567,  25534,  25565,  25564,  25540,  25560,  25555,  25538,  25543,  
    25548,  25547,  25544,  25584,  25559,  25561,  25906,  25959,  25962,  25956,  25948,  25960,  25957,  25996,  26013,  26014,  26030,  26064,  26066,  26236,  
    26220,  26235,  26240,  26225,  26233,  26218,  26226,  26369,  26892,  26835,  26884,  26844,  26922,  26860,  26858,  26865,  26895,  26838,  26871,  26859,  
    26852,  26870,  26899,  26896,  26867,  26849,  26887,  26828,  26888,  26992,  26804,  26897,  26863,  26822,  26900,  26872,  26832,  26877,  26876,  26856,  
    26891,  26890,  26903,  26830,  26824,  26845,  26846,  26854,  26868,  26833,  26886,  26836,  26857,  26901,  26917,  26823,  27449,  27451,  27455,  27452,  
    27540,  27543,  27545,  27541,  27581,  27632,  27634,  27635,  27696,  28156,  28230,  28231,  28191,  28233,  28296,  28220,  28221,  28229,  28258,  28203,  
    28223,  28225,  28253,  28275,  28188,  28211,  28235,  28224,  28241,  28219,  28163,  28206,  28254,  28264,  28252,  28257,  28209,  28200,  28256,  28273,  
    28267,  28217,  28194,  28208,  28243,  28261,  28199,  28280,  28260,  28279,  28245,  28281,  28242,  28262,  28213,  28214,  28250,  28960,  28958,  28975,  
    28923,  28974,  28977,  28963,  28965,  28962,  28978,  28959,  28968,  28986,  28955,  29259,  29274,  29320,  29321,  29318,  29317,  29323,  29458,  29451,  
    29488,  29474,  29489,  29491,  29479,  29490,  29485,  29478,  29475,  29493,  29452,  29742,  29740,  29744,  29739,  29718,  29722,  29729,  29741,  29745,  
    29732,  29731,  29725,  29737,  29728,  29746,  29947,  29999,  30063,  30060,  30183,  30170,  30177,  30182,  30173,  30175,  30180,  30167,  30357,  30354,  
    30426,  30534,  30535,  30532,  30541,  30533,  30538,  30542,  30539,  30540,  30686,  30700,  30816,  30820,  30821,  30812,  30829,  30833,  30826,  30830,  
    30832,  30825,  30824,  30814,  30818,  31092,  31091,  31090,  31088,  31234,  31242,  31235,  31244,  31236,  31385,  31462,  31460,  31562,  31547,  31556,  
    31560,  31564,  31566,  31552,  31576,  31557,  31906,  31902,  31912,  31905,  32088,  32111,  32099,  32083,  32086,  32103,  32106,  32079,  32109,  32092,  
    32107,  32082,  32084,  32105,  32081,  32095,  32078,  32574,  32575,  32613,  32614,  32674,  32672,  32673,  32727,  32849,  32847,  32848,  33022,  32980,  
    33091,  33098,  33106,  33103,  33095,  33085,  33101,  33082,  33254,  33262,  33271,  33272,  33273,  33284,  33340,  33341,  33343,  33397,  33595,  33743,  
    33785,  33827,  33728,  33768,  33810,  33767,  33764,  33788,  33782,  33808,  33734,  33736,  33771,  33763,  33727,  33793,  33757,  33765,  33752,  33791,  
    33761,  33739,  33742,  33750,  33781,  33737,  33801,  33807,  33758,  33809,  33798,  33730,  33779,  33749,  33786,  33735,  33745,  33770,  33811,  33731,  
    33772,  33774,  33732,  33787,  33751,  33762,  33819,  33755,  33790,  34520,  34530,  34534,  34515,  34531,  34522,  34538,  34525,  34539,  34524,  34540,  
    34537,  34519,  34536,  34513,  34888,  34902,  34901,  35002,  35031,  35001,  35000,  35008,  35006,  34998,  35004,  34999,  35005,  34994,  35073,  35017,  
    35221,  35224,  35223,  35293,  35290,  35291,  35406,  35405,  35385,  35417,  35392,  35415,  35416,  35396,  35397,  35410,  35400,  35409,  35402,  35404,  
    35407,  35935,  35969,  35968,  36026,  36030,  36016,  36025,  36021,  36228,  36224,  36233,  36312,  36307,  36301,  36295,  36310,  36316,  36303,  36309,  
    36313,  36296,  36311,  36293,  36591,  36599,  36602,  36601,  36582,  36590,  36581,  36597,  36583,  36584,  36598,  36587,  36593,  36588,  36596,  36585,  
    36909,  36916,  36911,  37126,  37164,  37124,  37119,  37116,  37128,  37113,  37115,  37121,  37120,  37127,  37125,  37123,  37217,  37220,  37215,  37218,  
    37216,  37377,  37386,  37413,  37379,  37402,  37414,  37391,  37388,  37376,  37394,  37375,  37373,  37382,  37380,  37415,  37378,  37404,  37412,  37401,  
    37399,  37381,  37398,  38267,  38285,  38284,  38288,  38535,  38526,  38536,  38537,  38531,  38528,  38594,  38600,  38595,  38641,  38640,  38764,  38768,  
    38766,  38919,  39081,  39147,  40166,  40697,  20099,  20100,  20150,  20669,  20671,  20678,  20654,  20676,  20682,  20660,  20680,  20674,  20656,  20673,  
    20666,  20657,  20683,  20681,  20662,  20664,  20951,  21114,  21112,  21115,  21116,  21955,  21979,  21964,  21968,  21963,  21962,  21981,  21952,  21972,  
    21956,  21993,  21951,  21970,  21901,  21967,  21973,  21986,  21974,  21960,  22002,  21965,  21977,  21954,  22292,  22611,  22632,  22628,  22607,  22605,  
    22601,  22639,  22613,  22606,  22621,  22617,  22629,  22619,  22589,  22627,  22641,  22780,  23239,  23236,  23243,  23226,  23224,  23217,  23221,  23216,  
    23231,  23240,  23227,  23238,  23223,  23232,  23242,  23220,  23222,  23245,  23225,  23184,  23510,  23512,  23513,  23583,  23603,  23921,  23907,  23882,  
    23909,  23922,  23916,  23902,  23912,  23911,  23906,  24048,  24143,  24142,  24138,  24141,  24139,  24261,  24268,  24262,  24267,  24263,  24384,  24495,  
    24493,  24823,  24905,  24906,  24875,  24901,  24886,  24882,  24878,  24902,  24879,  24911,  24873,  24896,  25120,  37224,  25123,  25125,  25124,  25541,  
    25585,  25579,  25616,  25618,  25609,  25632,  25636,  25651,  25667,  25631,  25621,  25624,  25657,  25655,  25634,  25635,  25612,  25638,  25648,  25640,  
    25665,  25653,  25647,  25610,  25626,  25664,  25637,  25639,  25611,  25575,  25627,  25646,  25633,  25614,  25967,  26002,  26067,  26246,  26252,  26261,  
    26256,  26251,  26250,  26265,  26260,  26232,  26400,  26982,  26975,  26936,  26958,  26978,  26993,  26943,  26949,  26986,  26937,  26946,  26967,  26969,  
    27002,  26952,  26953,  26933,  26988,  26931,  26941,  26981,  26864,  27000,  26932,  26985,  26944,  26991,  26948,  26998,  26968,  26945,  26996,  26956,  
    26939,  26955,  26935,  26972,  26959,  26961,  26930,  26962,  26927,  27003,  26940,  27462,  27461,  27459,  27458,  27464,  27457,  27547,  64013,  27643,  
    27644,  27641,  27639,  27640,  28315,  28374,  28360,  28303,  28352,  28319,  28307,  28308,  28320,  28337,  28345,  28358,  28370,  28349,  28353,  28318,  
    28361,  28343,  28336,  28365,  28326,  28367,  28338,  28350,  28355,  28380,  28376,  28313,  28306,  28302,  28301,  28324,  28321,  28351,  28339,  28368,  
    28362,  28311,  28334,  28323,  28999,  29012,  29010,  29027,  29024,  28993,  29021,  29026,  29042,  29048,  29034,  29025,  28994,  29016,  28995,  29003,  
    29040,  29023,  29008,  29011,  28996,  29005,  29018,  29263,  29325,  29324,  29329,  29328,  29326,  29500,  29506,  29499,  29498,  29504,  29514,  29513,  
    29764,  29770,  29771,  29778,  29777,  29783,  29760,  29775,  29776,  29774,  29762,  29766,  29773,  29780,  29921,  29951,  29950,  29949,  29981,  30073,  
    30071,  27011,  30191,  30223,  30211,  30199,  30206,  30204,  30201,  30200,  30224,  30203,  30198,  30189,  30197,  30205,  30361,  30389,  30429,  30549,  
    30559,  30560,  30546,  30550,  30554,  30569,  30567,  30548,  30553,  30573,  30688,  30855,  30874,  30868,  30863,  30852,  30869,  30853,  30854,  30881,  
    30851,  30841,  30873,  30848,  30870,  30843,  31100,  31106,  31101,  31097,  31249,  31256,  31257,  31250,  31255,  31253,  31266,  31251,  31259,  31248,  
    31395,  31394,  31390,  31467,  31590,  31588,  31597,  31604,  31593,  31602,  31589,  31603,  31601,  31600,  31585,  31608,  31606,  31587,  31922,  31924,  
    31919,  32136,  32134,  32128,  32141,  32127,  32133,  32122,  32142,  32123,  32131,  32124,  32140,  32148,  32132,  32125,  32146,  32621,  32619,  32615,  
    32616,  32620,  32678,  32677,  32679,  32731,  32732,  32801,  33124,  33120,  33143,  33116,  33129,  33115,  33122,  33138,  26401,  33118,  33142,  33127,  
    33135,  33092,  33121,  33309,  33353,  33348,  33344,  33346,  33349,  34033,  33855,  33878,  33910,  33913,  33935,  33933,  33893,  33873,  33856,  33926,  
    33895,  33840,  33869,  33917,  33882,  33881,  33908,  33907,  33885,  34055,  33886,  33847,  33850,  33844,  33914,  33859,  33912,  33842,  33861,  33833,  
    33753,  33867,  33839,  33858,  33837,  33887,  33904,  33849,  33870,  33868,  33874,  33903,  33989,  33934,  33851,  33863,  33846,  33843,  33896,  33918,  
    33860,  33835,  33888,  33876,  33902,  33872,  34571,  34564,  34551,  34572,  34554,  34518,  34549,  34637,  34552,  34574,  34569,  34561,  34550,  34573,  
    34565,  35030,  35019,  35021,  35022,  35038,  35035,  35034,  35020,  35024,  35205,  35227,  35295,  35301,  35300,  35297,  35296,  35298,  35292,  35302,  
    35446,  35462,  35455,  35425,  35391,  35447,  35458,  35460,  35445,  35459,  35457,  35444,  35450,  35900,  35915,  35914,  35941,  35940,  35942,  35974,  
    35972,  35973,  36044,  36200,  36201,  36241,  36236,  36238,  36239,  36237,  36243,  36244,  36240,  36242,  36336,  36320,  36332,  36337,  36334,  36304,  
    36329,  36323,  36322,  36327,  36338,  36331,  36340,  36614,  36607,  36609,  36608,  36613,  36615,  36616,  36610,  36619,  36946,  36927,  36932,  36937,  
    36925,  37136,  37133,  37135,  37137,  37142,  37140,  37131,  37134,  37230,  37231,  37448,  37458,  37424,  37434,  37478,  37427,  37477,  37470,  37507,  
    37422,  37450,  37446,  37485,  37484,  37455,  37472,  37479,  37487,  37430,  37473,  37488,  37425,  37460,  37475,  37456,  37490,  37454,  37459,  37452,  
    37462,  37426,  38303,  38300,  38302,  38299,  38546,  38547,  38545,  38551,  38606,  38650,  38653,  38648,  38645,  38771,  38775,  38776,  38770,  38927,  
    38925,  38926,  39084,  39158,  39161,  39343,  39346,  39344,  39349,  39597,  39595,  39771,  40170,  40173,  40167,  40576,  40701,  20710,  20692,  20695,  
    20712,  20723,  20699,  20714,  20701,  20708,  20691,  20716,  20720,  20719,  20707,  20704,  20952,  21120,  21121,  21225,  21227,  21296,  21420,  22055,  
    22037,  22028,  22034,  22012,  22031,  22044,  22017,  22035,  22018,  22010,  22045,  22020,  22015,  22009,  22665,  22652,  22672,  22680,  22662,  22657,  
    22655,  22644,  22667,  22650,  22663,  22673,  22670,  22646,  22658,  22664,  22651,  22676,  22671,  22782,  22891,  23260,  23278,  23269,  23253,  23274,  
    23258,  23277,  23275,  23283,  23266,  23264,  23259,  23276,  23262,  23261,  23257,  23272,  23263,  23415,  23520,  23523,  23651,  23938,  23936,  23933,  
    23942,  23930,  23937,  23927,  23946,  23945,  23944,  23934,  23932,  23949,  23929,  23935,  24152,  24153,  24147,  24280,  24273,  24279,  24270,  24284,  
    24277,  24281,  24274,  24276,  24388,  24387,  24431,  24502,  24876,  24872,  24897,  24926,  24945,  24947,  24914,  24915,  24946,  24940,  24960,  24948,  
    24916,  24954,  24923,  24933,  24891,  24938,  24929,  24918,  25129,  25127,  25131,  25643,  25677,  25691,  25693,  25716,  25718,  25714,  25715,  25725,  
    25717,  25702,  25766,  25678,  25730,  25694,  25692,  25675,  25683,  25696,  25680,  25727,  25663,  25708,  25707,  25689,  25701,  25719,  25971,  26016,  
    26273,  26272,  26271,  26373,  26372,  26402,  27057,  27062,  27081,  27040,  27086,  27030,  27056,  27052,  27068,  27025,  27033,  27022,  27047,  27021,  
    27049,  27070,  27055,  27071,  27076,  27069,  27044,  27092,  27065,  27082,  27034,  27087,  27059,  27027,  27050,  27041,  27038,  27097,  27031,  27024,  
    27074,  27061,  27045,  27078,  27466,  27469,  27467,  27550,  27551,  27552,  27587,  27588,  27646,  28366,  28405,  28401,  28419,  28453,  28408,  28471,  
    28411,  28462,  28425,  28494,  28441,  28442,  28455,  28440,  28475,  28434,  28397,  28426,  28470,  28531,  28409,  28398,  28461,  28480,  28464,  28476,  
    28469,  28395,  28423,  28430,  28483,  28421,  28413,  28406,  28473,  28444,  28412,  28474,  28447,  28429,  28446,  28424,  28449,  29063,  29072,  29065,  
    29056,  29061,  29058,  29071,  29051,  29062,  29057,  29079,  29252,  29267,  29335,  29333,  29331,  29507,  29517,  29521,  29516,  29794,  29811,  29809,  
    29813,  29810,  29799,  29806,  29952,  29954,  29955,  30077,  30096,  30230,  30216,  30220,  30229,  30225,  30218,  30228,  30392,  30593,  30588,  30597,  
    30594,  30574,  30592,  30575,  30590,  30595,  30898,  30890,  30900,  30893,  30888,  30846,  30891,  30878,  30885,  30880,  30892,  30882,  30884,  31128,  
    31114,  31115,  31126,  31125,  31124,  31123,  31127,  31112,  31122,  31120,  31275,  31306,  31280,  31279,  31272,  31270,  31400,  31403,  31404,  31470,  
    31624,  31644,  31626,  31633,  31632,  31638,  31629,  31628,  31643,  31630,  31621,  31640,  21124,  31641,  31652,  31618,  31931,  31935,  31932,  31930,  
    32167,  32183,  32194,  32163,  32170,  32193,  32192,  32197,  32157,  32206,  32196,  32198,  32203,  32204,  32175,  32185,  32150,  32188,  32159,  32166,  
    32174,  32169,  32161,  32201,  32627,  32738,  32739,  32741,  32734,  32804,  32861,  32860,  33161,  33158,  33155,  33159,  33165,  33164,  33163,  33301,  
    33943,  33956,  33953,  33951,  33978,  33998,  33986,  33964,  33966,  33963,  33977,  33972,  33985,  33997,  33962,  33946,  33969,  34000,  33949,  33959,  
    33979,  33954,  33940,  33991,  33996,  33947,  33961,  33967,  33960,  34006,  33944,  33974,  33999,  33952,  34007,  34004,  34002,  34011,  33968,  33937,  
    34401,  34611,  34595,  34600,  34667,  34624,  34606,  34590,  34593,  34585,  34587,  34627,  34604,  34625,  34622,  34630,  34592,  34610,  34602,  34605,  
    34620,  34578,  34618,  34609,  34613,  34626,  34598,  34599,  34616,  34596,  34586,  34608,  34577,  35063,  35047,  35057,  35058,  35066,  35070,  35054,  
    35068,  35062,  35067,  35056,  35052,  35051,  35229,  35233,  35231,  35230,  35305,  35307,  35304,  35499,  35481,  35467,  35474,  35471,  35478,  35901,  
    35944,  35945,  36053,  36047,  36055,  36246,  36361,  36354,  36351,  36365,  36349,  36362,  36355,  36359,  36358,  36357,  36350,  36352,  36356,  36624,  
    36625,  36622,  36621,  37155,  37148,  37152,  37154,  37151,  37149,  37146,  37156,  37153,  37147,  37242,  37234,  37241,  37235,  37541,  37540,  37494,  
    37531,  37498,  37536,  37524,  37546,  37517,  37542,  37530,  37547,  37497,  37527,  37503,  37539,  37614,  37518,  37506,  37525,  37538,  37501,  37512,  
    37537,  37514,  37510,  37516,  37529,  37543,  37502,  37511,  37545,  37533,  37515,  37421,  38558,  38561,  38655,  38744,  38781,  38778,  38782,  38787,  
    38784,  38786,  38779,  38788,  38785,  38783,  38862,  38861,  38934,  39085,  39086,  39170,  39168,  39175,  39325,  39324,  39363,  39353,  39355,  39354,  
    39362,  39357,  39367,  39601,  39651,  39655,  39742,  39743,  39776,  39777,  39775,  40177,  40178,  40181,  40615,  20735,  20739,  20784,  20728,  20742,  
    20743,  20726,  20734,  20747,  20748,  20733,  20746,  21131,  21132,  21233,  21231,  22088,  22082,  22092,  22069,  22081,  22090,  22089,  22086,  22104,  
    22106,  22080,  22067,  22077,  22060,  22078,  22072,  22058,  22074,  22298,  22699,  22685,  22705,  22688,  22691,  22703,  22700,  22693,  22689,  22783,  
    23295,  23284,  23293,  23287,  23286,  23299,  23288,  23298,  23289,  23297,  23303,  23301,  23311,  23655,  23961,  23959,  23967,  23954,  23970,  23955,  
    23957,  23968,  23964,  23969,  23962,  23966,  24169,  24157,  24160,  24156,  32243,  24283,  24286,  24289,  24393,  24498,  24971,  24963,  24953,  25009,  
    25008,  24994,  24969,  24987,  24979,  25007,  25005,  24991,  24978,  25002,  24993,  24973,  24934,  25011,  25133,  25710,  25712,  25750,  25760,  25733,  
    25751,  25756,  25743,  25739,  25738,  25740,  25763,  25759,  25704,  25777,  25752,  25974,  25978,  25977,  25979,  26034,  26035,  26293,  26288,  26281,  
    26290,  26295,  26282,  26287,  27136,  27142,  27159,  27109,  27128,  27157,  27121,  27108,  27168,  27135,  27116,  27106,  27163,  27165,  27134,  27175,  
    27122,  27118,  27156,  27127,  27111,  27200,  27144,  27110,  27131,  27149,  27132,  27115,  27145,  27140,  27160,  27173,  27151,  27126,  27174,  27143,  
    27124,  27158,  27473,  27557,  27555,  27554,  27558,  27649,  27648,  27647,  27650,  28481,  28454,  28542,  28551,  28614,  28562,  28557,  28553,  28556,  
    28514,  28495,  28549,  28506,  28566,  28534,  28524,  28546,  28501,  28530,  28498,  28496,  28503,  28564,  28563,  28509,  28416,  28513,  28523,  28541,  
    28519,  28560,  28499,  28555,  28521,  28543,  28565,  28515,  28535,  28522,  28539,  29106,  29103,  29083,  29104,  29088,  29082,  29097,  29109,  29085,  
    29093,  29086,  29092,  29089,  29098,  29084,  29095,  29107,  29336,  29338,  29528,  29522,  29534,  29535,  29536,  29533,  29531,  29537,  29530,  29529,  
    29538,  29831,  29833,  29834,  29830,  29825,  29821,  29829,  29832,  29820,  29817,  29960,  29959,  30078,  30245,  30238,  30233,  30237,  30236,  30243,  
    30234,  30248,  30235,  30364,  30365,  30366,  30363,  30605,  30607,  30601,  30600,  30925,  30907,  30927,  30924,  30929,  30926,  30932,  30920,  30915,  
    30916,  30921,  31130,  31137,  31136,  31132,  31138,  31131,  27510,  31289,  31410,  31412,  31411,  31671,  31691,  31678,  31660,  31694,  31663,  31673,  
    31690,  31669,  31941,  31944,  31948,  31947,  32247,  32219,  32234,  32231,  32215,  32225,  32259,  32250,  32230,  32246,  32241,  32240,  32238,  32223,  
    32630,  32684,  32688,  32685,  32749,  32747,  32746,  32748,  32742,  32744,  32868,  32871,  33187,  33183,  33182,  33173,  33186,  33177,  33175,  33302,  
    33359,  33363,  33362,  33360,  33358,  33361,  34084,  34107,  34063,  34048,  34089,  34062,  34057,  34061,  34079,  34058,  34087,  34076,  34043,  34091,  
    34042,  34056,  34060,  34036,  34090,  34034,  34069,  34039,  34027,  34035,  34044,  34066,  34026,  34025,  34070,  34046,  34088,  34077,  34094,  34050,  
    34045,  34078,  34038,  34097,  34086,  34023,  34024,  34032,  34031,  34041,  34072,  34080,  34096,  34059,  34073,  34095,  34402,  34646,  34659,  34660,  
    34679,  34785,  34675,  34648,  34644,  34651,  34642,  34657,  34650,  34641,  34654,  34669,  34666,  34640,  34638,  34655,  34653,  34671,  34668,  34682,  
    34670,  34652,  34661,  34639,  34683,  34677,  34658,  34663,  34665,  34906,  35077,  35084,  35092,  35083,  35095,  35096,  35097,  35078,  35094,  35089,  
    35086,  35081,  35234,  35236,  35235,  35309,  35312,  35308,  35535,  35526,  35512,  35539,  35537,  35540,  35541,  35515,  35543,  35518,  35520,  35525,  
    35544,  35523,  35514,  35517,  35545,  35902,  35917,  35983,  36069,  36063,  36057,  36072,  36058,  36061,  36071,  36256,  36252,  36257,  36251,  36384,  
    36387,  36389,  36388,  36398,  36373,  36379,  36374,  36369,  36377,  36390,  36391,  36372,  36370,  36376,  36371,  36380,  36375,  36378,  36652,  36644,  
    36632,  36634,  36640,  36643,  36630,  36631,  36979,  36976,  36975,  36967,  36971,  37167,  37163,  37161,  37162,  37170,  37158,  37166,  37253,  37254,  
    37258,  37249,  37250,  37252,  37248,  37584,  37571,  37572,  37568,  37593,  37558,  37583,  37617,  37599,  37592,  37609,  37591,  37597,  37580,  37615,  
    37570,  37608,  37578,  37576,  37582,  37606,  37581,  37589,  37577,  37600,  37598,  37607,  37585,  37587,  37557,  37601,  37574,  37556,  38268,  38316,  
    38315,  38318,  38320,  38564,  38562,  38611,  38661,  38664,  38658,  38746,  38794,  38798,  38792,  38864,  38863,  38942,  38941,  38950,  38953,  38952,  
    38944,  38939,  38951,  39090,  39176,  39162,  39185,  39188,  39190,  39191,  39189,  39388,  39373,  39375,  39379,  39380,  39374,  39369,  39382,  39384,  
    39371,  39383,  39372,  39603,  39660,  39659,  39667,  39666,  39665,  39750,  39747,  39783,  39796,  39793,  39782,  39798,  39797,  39792,  39784,  39780,  
    39788,  40188,  40186,  40189,  40191,  40183,  40199,  40192,  40185,  40187,  40200,  40197,  40196,  40579,  40659,  40719,  40720,  20764,  20755,  20759,  
    20762,  20753,  20958,  21300,  21473,  22128,  22112,  22126,  22131,  22118,  22115,  22125,  22130,  22110,  22135,  22300,  22299,  22728,  22717,  22729,  
    22719,  22714,  22722,  22716,  22726,  23319,  23321,  23323,  23329,  23316,  23315,  23312,  23318,  23336,  23322,  23328,  23326,  23535,  23980,  23985,  
    23977,  23975,  23989,  23984,  23982,  23978,  23976,  23986,  23981,  23983,  23988,  24167,  24168,  24166,  24175,  24297,  24295,  24294,  24296,  24293,  
    24395,  24508,  24989,  25000,  24982,  25029,  25012,  25030,  25025,  25036,  25018,  25023,  25016,  24972,  25815,  25814,  25808,  25807,  25801,  25789,  
    25737,  25795,  25819,  25843,  25817,  25907,  25983,  25980,  26018,  26312,  26302,  26304,  26314,  26315,  26319,  26301,  26299,  26298,  26316,  26403,  
    27188,  27238,  27209,  27239,  27186,  27240,  27198,  27229,  27245,  27254,  27227,  27217,  27176,  27226,  27195,  27199,  27201,  27242,  27236,  27216,  
    27215,  27220,  27247,  27241,  27232,  27196,  27230,  27222,  27221,  27213,  27214,  27206,  27477,  27476,  27478,  27559,  27562,  27563,  27592,  27591,  
    27652,  27651,  27654,  28589,  28619,  28579,  28615,  28604,  28622,  28616,  28510,  28612,  28605,  28574,  28618,  28584,  28676,  28581,  28590,  28602,  
    28588,  28586,  28623,  28607,  28600,  28578,  28617,  28587,  28621,  28591,  28594,  28592,  29125,  29122,  29119,  29112,  29142,  29120,  29121,  29131,  
    29140,  29130,  29127,  29135,  29117,  29144,  29116,  29126,  29146,  29147,  29341,  29342,  29545,  29542,  29543,  29548,  29541,  29547,  29546,  29823,  
    29850,  29856,  29844,  29842,  29845,  29857,  29963,  30080,  30255,  30253,  30257,  30269,  30259,  30268,  30261,  30258,  30256,  30395,  30438,  30618,  
    30621,  30625,  30620,  30619,  30626,  30627,  30613,  30617,  30615,  30941,  30953,  30949,  30954,  30942,  30947,  30939,  30945,  30946,  30957,  30943,  
    30944,  31140,  31300,  31304,  31303,  31414,  31416,  31413,  31409,  31415,  31710,  31715,  31719,  31709,  31701,  31717,  31706,  31720,  31737,  31700,  
    31722,  31714,  31708,  31723,  31704,  31711,  31954,  31956,  31959,  31952,  31953,  32274,  32289,  32279,  32268,  32287,  32288,  32275,  32270,  32284,  
    32277,  32282,  32290,  32267,  32271,  32278,  32269,  32276,  32293,  32292,  32579,  32635,  32636,  32634,  32689,  32751,  32810,  32809,  32876,  33201,  
    33190,  33198,  33209,  33205,  33195,  33200,  33196,  33204,  33202,  33207,  33191,  33266,  33365,  33366,  33367,  34134,  34117,  34155,  34125,  34131,  
    34145,  34136,  34112,  34118,  34148,  34113,  34146,  34116,  34129,  34119,  34147,  34110,  34139,  34161,  34126,  34158,  34165,  34133,  34151,  34144,  
    34188,  34150,  34141,  34132,  34149,  34156,  34403,  34405,  34404,  34715,  34703,  34711,  34707,  34706,  34696,  34689,  34710,  34712,  34681,  34695,  
    34723,  34693,  34704,  34705,  34717,  34692,  34708,  34716,  34714,  34697,  35102,  35110,  35120,  35117,  35118,  35111,  35121,  35106,  35113,  35107,  
    35119,  35116,  35103,  35313,  35552,  35554,  35570,  35572,  35573,  35549,  35604,  35556,  35551,  35568,  35528,  35550,  35553,  35560,  35583,  35567,  
    35579,  35985,  35986,  35984,  36085,  36078,  36081,  36080,  36083,  36204,  36206,  36261,  36263,  36403,  36414,  36408,  36416,  36421,  36406,  36412,  
    36413,  36417,  36400,  36415,  36541,  36662,  36654,  36661,  36658,  36665,  36663,  36660,  36982,  36985,  36987,  36998,  37114,  37171,  37173,  37174,  
    37267,  37264,  37265,  37261,  37263,  37671,  37662,  37640,  37663,  37638,  37647,  37754,  37688,  37692,  37659,  37667,  37650,  37633,  37702,  37677,  
    37646,  37645,  37579,  37661,  37626,  37669,  37651,  37625,  37623,  37684,  37634,  37668,  37631,  37673,  37689,  37685,  37674,  37652,  37644,  37643,  
    37630,  37641,  37632,  37627,  37654,  38332,  38349,  38334,  38329,  38330,  38326,  38335,  38325,  38333,  38569,  38612,  38667,  38674,  38672,  38809,  
    38807,  38804,  38896,  38904,  38965,  38959,  38962,  39204,  39199,  39207,  39209,  39326,  39406,  39404,  39397,  39396,  39408,  39395,  39402,  39401,  
    39399,  39609,  39615,  39604,  39611,  39670,  39674,  39673,  39671,  39731,  39808,  39813,  39815,  39804,  39806,  39803,  39810,  39827,  39826,  39824,  
    39802,  39829,  39805,  39816,  40229,  40215,  40224,  40222,  40212,  40233,  40221,  40216,  40226,  40208,  40217,  40223,  40584,  40582,  40583,  40622,  
    40621,  40661,  40662,  40698,  40722,  40765,  20774,  20773,  20770,  20772,  20768,  20777,  21236,  22163,  22156,  22157,  22150,  22148,  22147,  22142,  
    22146,  22143,  22145,  22742,  22740,  22735,  22738,  23341,  23333,  23346,  23331,  23340,  23335,  23334,  23343,  23342,  23419,  23537,  23538,  23991,  
    24172,  24170,  24510,  24507,  25027,  25013,  25020,  25063,  25056,  25061,  25060,  25064,  25054,  25839,  25833,  25827,  25835,  25828,  25832,  25985,  
    25984,  26038,  26074,  26322,  27277,  27286,  27265,  27301,  27273,  27295,  27291,  27297,  27294,  27271,  27283,  27278,  27285,  27267,  27304,  27300,  
    27281,  27263,  27302,  27290,  27269,  27276,  27282,  27483,  27565,  27657,  28620,  28585,  28660,  28628,  28643,  28636,  28653,  28647,  28646,  28638,  
    28658,  28637,  28642,  28648,  29153,  29169,  29160,  29170,  29156,  29168,  29154,  29555,  29550,  29551,  29847,  29874,  29867,  29840,  29866,  29869,  
    29873,  29861,  29871,  29968,  29969,  29970,  29967,  30084,  30275,  30280,  30281,  30279,  30372,  30441,  30645,  30635,  30642,  30647,  30646,  30644,  
    30641,  30632,  30704,  30963,  30973,  30978,  30971,  30972,  30962,  30981,  30969,  30974,  30980,  31147,  31144,  31324,  31323,  31318,  31320,  31316,  
    31322,  31422,  31424,  31425,  31749,  31759,  31730,  31744,  31743,  31739,  31758,  31732,  31755,  31731,  31746,  31753,  31747,  31745,  31736,  31741,  
    31750,  31728,  31729,  31760,  31754,  31976,  32301,  32316,  32322,  32307,  38984,  32312,  32298,  32329,  32320,  32327,  32297,  32332,  32304,  32315,  
    32310,  32324,  32314,  32581,  32639,  32638,  32637,  32756,  32754,  32812,  33211,  33220,  33228,  33226,  33221,  33223,  33212,  33257,  33371,  33370,  
    33372,  34179,  34176,  34191,  34215,  34197,  34208,  34187,  34211,  34171,  34212,  34202,  34206,  34167,  34172,  34185,  34209,  34170,  34168,  34135,  
    34190,  34198,  34182,  34189,  34201,  34205,  34177,  34210,  34178,  34184,  34181,  34169,  34166,  34200,  34192,  34207,  34408,  34750,  34730,  34733,  
    34757,  34736,  34732,  34745,  34741,  34748,  34734,  34761,  34755,  34754,  34764,  34743,  34735,  34756,  34762,  34740,  34742,  34751,  34744,  34749,  
    34782,  34738,  35125,  35123,  35132,  35134,  35137,  35154,  35127,  35138,  35245,  35247,  35246,  35314,  35315,  35614,  35608,  35606,  35601,  35589,  
    35595,  35618,  35599,  35602,  35605,  35591,  35597,  35592,  35590,  35612,  35603,  35610,  35919,  35952,  35954,  35953,  35951,  35989,  35988,  36089,  
    36207,  36430,  36429,  36435,  36432,  36428,  36423,  36675,  36672,  36997,  36990,  37176,  37274,  37282,  37275,  37273,  37279,  37281,  37277,  37280,  
    37793,  37763,  37807,  37732,  37718,  37703,  37756,  37720,  37724,  37750,  37705,  37712,  37713,  37728,  37741,  37775,  37708,  37738,  37753,  37719,  
    37717,  37714,  37711,  37745,  37751,  37755,  37729,  37726,  37731,  37735,  37760,  37710,  37721,  38343,  38336,  38345,  38339,  38341,  38327,  38574,  
    38576,  38572,  38688,  38687,  38680,  38685,  38681,  38810,  38817,  38812,  38814,  38813,  38869,  38868,  38897,  38977,  38980,  38986,  38985,  38981,  
    38979,  39205,  39211,  39212,  39210,  39219,  39218,  39215,  39213,  39217,  39216,  39320,  39331,  39329,  39426,  39418,  39412,  39415,  39417,  39416,  
    39414,  39419,  39421,  39422,  39420,  39427,  39614,  39678,  39677,  39681,  39676,  39752,  39834,  39848,  39838,  39835,  39846,  39841,  39845,  39844,  
    39814,  39842,  39840,  39855,  40243,  40257,  40295,  40246,  40238,  40239,  40241,  40248,  40240,  40261,  40258,  40259,  40254,  40247,  40256,  40253,  
    32757,  40237,  40586,  40585,  40589,  40624,  40648,  40666,  40699,  40703,  40740,  40739,  40738,  40788,  40864,  20785,  20781,  20782,  22168,  22172,  
    22167,  22170,  22173,  22169,  22896,  23356,  23657,  23658,  24000,  24173,  24174,  25048,  25055,  25069,  25070,  25073,  25066,  25072,  25067,  25046,  
    25065,  25855,  25860,  25853,  25848,  25857,  25859,  25852,  26004,  26075,  26330,  26331,  26328,  27333,  27321,  27325,  27361,  27334,  27322,  27318,  
    27319,  27335,  27316,  27309,  27486,  27593,  27659,  28679,  28684,  28685,  28673,  28677,  28692,  28686,  28671,  28672,  28667,  28710,  28668,  28663,  
    28682,  29185,  29183,  29177,  29187,  29181,  29558,  29880,  29888,  29877,  29889,  29886,  29878,  29883,  29890,  29972,  29971,  30300,  30308,  30297,  
    30288,  30291,  30295,  30298,  30374,  30397,  30444,  30658,  30650,  30975,  30988,  30995,  30996,  30985,  30992,  30994,  30993,  31149,  31148,  31327,  
    31772,  31785,  31769,  31776,  31775,  31789,  31773,  31782,  31784,  31778,  31781,  31792,  32348,  32336,  32342,  32355,  32344,  32354,  32351,  32337,  
    32352,  32343,  32339,  32693,  32691,  32759,  32760,  32885,  33233,  33234,  33232,  33375,  33374,  34228,  34246,  34240,  34243,  34242,  34227,  34229,  
    34237,  34247,  34244,  34239,  34251,  34254,  34248,  34245,  34225,  34230,  34258,  34340,  34232,  34231,  34238,  34409,  34791,  34790,  34786,  34779,  
    34795,  34794,  34789,  34783,  34803,  34788,  34772,  34780,  34771,  34797,  34776,  34787,  34724,  34775,  34777,  34817,  34804,  34792,  34781,  35155,  
    35147,  35151,  35148,  35142,  35152,  35153,  35145,  35626,  35623,  35619,  35635,  35632,  35637,  35655,  35631,  35644,  35646,  35633,  35621,  35639,  
    35622,  35638,  35630,  35620,  35643,  35645,  35642,  35906,  35957,  35993,  35992,  35991,  36094,  36100,  36098,  36096,  36444,  36450,  36448,  36439,  
    36438,  36446,  36453,  36455,  36443,  36442,  36449,  36445,  36457,  36436,  36678,  36679,  36680,  36683,  37160,  37178,  37179,  37182,  37288,  37285,  
    37287,  37295,  37290,  37813,  37772,  37778,  37815,  37787,  37789,  37769,  37799,  37774,  37802,  37790,  37798,  37781,  37768,  37785,  37791,  37773,  
    37809,  37777,  37810,  37796,  37800,  37812,  37795,  37797,  38354,  38355,  38353,  38579,  38615,  38618,  24002,  38623,  38616,  38621,  38691,  38690,  
    38693,  38828,  38830,  38824,  38827,  38820,  38826,  38818,  38821,  38871,  38873,  38870,  38872,  38906,  38992,  38993,  38994,  39096,  39233,  39228,  
    39226,  39439,  39435,  39433,  39437,  39428,  39441,  39434,  39429,  39431,  39430,  39616,  39644,  39688,  39684,  39685,  39721,  39733,  39754,  39756,  
    39755,  39879,  39878,  39875,  39871,  39873,  39861,  39864,  39891,  39862,  39876,  39865,  39869,  40284,  40275,  40271,  40266,  40283,  40267,  40281,  
    40278,  40268,  40279,  40274,  40276,  40287,  40280,  40282,  40590,  40588,  40671,  40705,  40704,  40726,  40741,  40747,  40746,  40745,  40744,  40780,  
    40789,  20788,  20789,  21142,  21239,  21428,  22187,  22189,  22182,  22183,  22186,  22188,  22746,  22749,  22747,  22802,  23357,  23358,  23359,  24003,  
    24176,  24511,  25083,  25863,  25872,  25869,  25865,  25868,  25870,  25988,  26078,  26077,  26334,  27367,  27360,  27340,  27345,  27353,  27339,  27359,  
    27356,  27344,  27371,  27343,  27341,  27358,  27488,  27568,  27660,  28697,  28711,  28704,  28694,  28715,  28705,  28706,  28707,  28713,  28695,  28708,  
    28700,  28714,  29196,  29194,  29191,  29186,  29189,  29349,  29350,  29348,  29347,  29345,  29899,  29893,  29879,  29891,  29974,  30304,  30665,  30666,  
    30660,  30705,  31005,  31003,  31009,  31004,  30999,  31006,  31152,  31335,  31336,  31795,  31804,  31801,  31788,  31803,  31980,  31978,  32374,  32373,  
    32376,  32368,  32375,  32367,  32378,  32370,  32372,  32360,  32587,  32586,  32643,  32646,  32695,  32765,  32766,  32888,  33239,  33237,  33380,  33377,  
    33379,  34283,  34289,  34285,  34265,  34273,  34280,  34266,  34263,  34284,  34290,  34296,  34264,  34271,  34275,  34268,  34257,  34288,  34278,  34287,  
    34270,  34274,  34816,  34810,  34819,  34806,  34807,  34825,  34828,  34827,  34822,  34812,  34824,  34815,  34826,  34818,  35170,  35162,  35163,  35159,  
    35169,  35164,  35160,  35165,  35161,  35208,  35255,  35254,  35318,  35664,  35656,  35658,  35648,  35667,  35670,  35668,  35659,  35669,  35665,  35650,  
    35666,  35671,  35907,  35959,  35958,  35994,  36102,  36103,  36105,  36268,  36266,  36269,  36267,  36461,  36472,  36467,  36458,  36463,  36475,  36546,  
    36690,  36689,  36687,  36688,  36691,  36788,  37184,  37183,  37296,  37293,  37854,  37831,  37839,  37826,  37850,  37840,  37881,  37868,  37836,  37849,  
    37801,  37862,  37834,  37844,  37870,  37859,  37845,  37828,  37838,  37824,  37842,  37863,  38269,  38362,  38363,  38625,  38697,  38699,  38700,  38696,  
    38694,  38835,  38839,  38838,  38877,  38878,  38879,  39004,  39001,  39005,  38999,  39103,  39101,  39099,  39102,  39240,  39239,  39235,  39334,  39335,  
    39450,  39445,  39461,  39453,  39460,  39451,  39458,  39456,  39463,  39459,  39454,  39452,  39444,  39618,  39691,  39690,  39694,  39692,  39735,  39914,  
    39915,  39904,  39902,  39908,  39910,  39906,  39920,  39892,  39895,  39916,  39900,  39897,  39909,  39893,  39905,  39898,  40311,  40321,  40330,  40324,  
    40328,  40305,  40320,  40312,  40326,  40331,  40332,  40317,  40299,  40308,  40309,  40304,  40297,  40325,  40307,  40315,  40322,  40303,  40313,  40319,  
    40327,  40296,  40596,  40593,  40640,  40700,  40749,  40768,  40769,  40781,  40790,  40791,  40792,  21303,  22194,  22197,  22195,  22755,  23365,  24006,  
    24007,  24302,  24303,  24512,  24513,  25081,  25879,  25878,  25877,  25875,  26079,  26344,  26339,  26340,  27379,  27376,  27370,  27368,  27385,  27377,  
    27374,  27375,  28732,  28725,  28719,  28727,  28724,  28721,  28738,  28728,  28735,  28730,  28729,  28736,  28731,  28723,  28737,  29203,  29204,  29352,  
    29565,  29564,  29882,  30379,  30378,  30398,  30445,  30668,  30670,  30671,  30669,  30706,  31013,  31011,  31015,  31016,  31012,  31017,  31154,  31342,  
    31340,  31341,  31479,  31817,  31816,  31818,  31815,  31813,  31982,  32379,  32382,  32385,  32384,  32698,  32767,  32889,  33243,  33241,  33291,  33384,  
    33385,  34338,  34303,  34305,  34302,  34331,  34304,  34294,  34308,  34313,  34309,  34316,  34301,  34841,  34832,  34833,  34839,  34835,  34838,  35171,  
    35174,  35257,  35319,  35680,  35690,  35677,  35688,  35683,  35685,  35687,  35693,  36270,  36486,  36488,  36484,  36697,  36694,  36695,  36693,  36696,  
    36698,  37005,  37187,  37185,  37303,  37301,  37298,  37299,  37899,  37907,  37883,  37920,  37903,  37908,  37886,  37909,  37904,  37928,  37913,  37901,  
    37877,  37888,  37879,  37895,  37902,  37910,  37906,  37882,  37897,  37880,  37898,  37887,  37884,  37900,  37878,  37905,  37894,  38366,  38368,  38367,  
    38702,  38703,  38841,  38843,  38909,  38910,  39008,  39010,  39011,  39007,  39105,  39106,  39248,  39246,  39257,  39244,  39243,  39251,  39474,  39476,  
    39473,  39468,  39466,  39478,  39465,  39470,  39480,  39469,  39623,  39626,  39622,  39696,  39698,  39697,  39947,  39944,  39927,  39941,  39954,  39928,  
    40000,  39943,  39950,  39942,  39959,  39956,  39945,  40351,  40345,  40356,  40349,  40338,  40344,  40336,  40347,  40352,  40340,  40348,  40362,  40343,  
    40353,  40346,  40354,  40360,  40350,  40355,  40383,  40361,  40342,  40358,  40359,  40601,  40603,  40602,  40677,  40676,  40679,  40678,  40752,  40750,  
    40795,  40800,  40798,  40797,  40793,  40849,  20794,  20793,  21144,  21143,  22211,  22205,  22206,  23368,  23367,  24011,  24015,  24305,  25085,  25883,  
    27394,  27388,  27395,  27384,  27392,  28739,  28740,  28746,  28744,  28745,  28741,  28742,  29213,  29210,  29209,  29566,  29975,  30314,  30672,  31021,  
    31025,  31023,  31828,  31827,  31986,  32394,  32391,  32392,  32395,  32390,  32397,  32589,  32699,  32816,  33245,  34328,  34346,  34342,  34335,  34339,  
    34332,  34329,  34343,  34350,  34337,  34336,  34345,  34334,  34341,  34857,  34845,  34843,  34848,  34852,  34844,  34859,  34890,  35181,  35177,  35182,  
    35179,  35322,  35705,  35704,  35653,  35706,  35707,  36112,  36116,  36271,  36494,  36492,  36702,  36699,  36701,  37190,  37188,  37189,  37305,  37951,  
    37947,  37942,  37929,  37949,  37948,  37936,  37945,  37930,  37943,  37932,  37952,  37937,  38373,  38372,  38371,  38709,  38714,  38847,  38881,  39012,  
    39113,  39110,  39104,  39256,  39254,  39481,  39485,  39494,  39492,  39490,  39489,  39482,  39487,  39629,  39701,  39703,  39704,  39702,  39738,  39762,  
    39979,  39965,  39964,  39980,  39971,  39976,  39977,  39972,  39969,  40375,  40374,  40380,  40385,  40391,  40394,  40399,  40382,  40389,  40387,  40379,  
    40373,  40398,  40377,  40378,  40364,  40392,  40369,  40365,  40396,  40371,  40397,  40370,  40570,  40604,  40683,  40686,  40685,  40731,  40728,  40730,  
    40753,  40782,  40805,  40804,  40850,  20153,  22214,  22213,  22219,  22897,  23371,  23372,  24021,  24017,  24306,  25889,  25888,  25894,  25890,  27403,  
    27400,  27401,  27661,  28757,  28758,  28759,  28754,  29214,  29215,  29353,  29567,  29912,  29909,  29913,  29911,  30317,  30381,  31029,  31156,  31344,  
    31345,  31831,  31836,  31833,  31835,  31834,  31988,  31985,  32401,  32591,  32647,  33246,  33387,  34356,  34357,  34355,  34348,  34354,  34358,  34860,  
    34856,  34854,  34858,  34853,  35185,  35263,  35262,  35323,  35710,  35716,  35714,  35718,  35717,  35711,  36117,  36501,  36500,  36506,  36498,  36496,  
    36502,  36503,  36704,  36706,  37191,  37964,  37968,  37962,  37963,  37967,  37959,  37957,  37960,  37961,  37958,  38719,  38883,  39018,  39017,  39115,  
    39252,  39259,  39502,  39507,  39508,  39500,  39503,  39496,  39498,  39497,  39506,  39504,  39632,  39705,  39723,  39739,  39766,  39765,  40006,  40008,  
    39999,  40004,  39993,  39987,  40001,  39996,  39991,  39988,  39986,  39997,  39990,  40411,  40402,  40414,  40410,  40395,  40400,  40412,  40401,  40415,  
    40425,  40409,  40408,  40406,  40437,  40405,  40413,  40630,  40688,  40757,  40755,  40754,  40770,  40811,  40853,  40866,  20797,  21145,  22760,  22759,  
    22898,  23373,  24024,  34863,  24399,  25089,  25091,  25092,  25897,  25893,  26006,  26347,  27409,  27410,  27407,  27594,  28763,  28762,  29218,  29570,  
    29569,  29571,  30320,  30676,  31847,  31846,  32405,  33388,  34362,  34368,  34361,  34364,  34353,  34363,  34366,  34864,  34866,  34862,  34867,  35190,  
    35188,  35187,  35326,  35724,  35726,  35723,  35720,  35909,  36121,  36504,  36708,  36707,  37308,  37986,  37973,  37981,  37975,  37982,  38852,  38853,  
    38912,  39510,  39513,  39710,  39711,  39712,  40018,  40024,  40016,  40010,  40013,  40011,  40021,  40025,  40012,  40014,  40443,  40439,  40431,  40419,  
    40427,  40440,  40420,  40438,  40417,  40430,  40422,  40434,  40432,  40418,  40428,  40436,  40435,  40424,  40429,  40642,  40656,  40690,  40691,  40710,  
    40732,  40760,  40759,  40758,  40771,  40783,  40817,  40816,  40814,  40815,  22227,  22221,  23374,  23661,  25901,  26349,  26350,  27411,  28767,  28769,  
    28765,  28768,  29219,  29915,  29925,  30677,  31032,  31159,  31158,  31850,  32407,  32649,  33389,  34371,  34872,  34871,  34869,  34891,  35732,  35733,  
    36510,  36511,  36512,  36509,  37310,  37309,  37314,  37995,  37992,  37993,  38629,  38726,  38723,  38727,  38855,  38885,  39518,  39637,  39769,  40035,  
    40039,  40038,  40034,  40030,  40032,  40450,  40446,  40455,  40451,  40454,  40453,  40448,  40449,  40457,  40447,  40445,  40452,  40608,  40734,  40774,  
    40820,  40821,  40822,  22228,  25902,  26040,  27416,  27417,  27415,  27418,  28770,  29222,  29354,  30680,  30681,  31033,  31849,  31851,  31990,  32410,  
    32408,  32411,  32409,  33248,  33249,  34374,  34375,  34376,  35193,  35194,  35196,  35195,  35327,  35736,  35737,  36517,  36516,  36515,  37998,  37997,  
    37999,  38001,  38003,  38729,  39026,  39263,  40040,  40046,  40045,  40459,  40461,  40464,  40463,  40466,  40465,  40609,  40693,  40713,  40775,  40824,  
    40827,  40826,  40825,  22302,  28774,  31855,  34876,  36274,  36518,  37315,  38004,  38008,  38006,  38005,  39520,  40052,  40051,  40049,  40053,  40468,  
    40467,  40694,  40714,  40868,  28776,  28773,  31991,  34410,  34878,  34877,  34879,  35742,  35996,  36521,  36553,  38731,  39027,  39028,  39116,  39265,  
    39339,  39524,  39526,  39527,  39716,  40469,  40471,  40776,  25095,  27422,  29223,  34380,  36520,  38018,  38016,  38017,  39529,  39528,  39726,  40473,  
    29225,  34379,  35743,  38019,  40057,  40631,  30325,  39531,  40058,  40477,  28777,  28778,  40612,  40830,  40777,  40856,  30849,  37561,  35023,  22715,  
    24658,  31911,  23290,  9556,   9574,   9559,   9568,   9580,   9571,   9562,   9577,   9565,   9554,   9572,   9557,   9566,   9578,   9569,   9560,   9575,   
    9563,   9555,   9573,   9558,   9567,   9579,   9570,   9561,   9576,   9564,   9553,   9552,   9581,   9582,   9584,   9583,   65517,  132423, 37595,  132575, 
    147397, 34124,  17077,  29679,  20917,  13897,  149826, 166372, 37700,  137691, 33518,  146632, 30780,  26436,  25311,  149811, 166314, 131744, 158643, 135941, 
    20395,  140525, 20488,  159017, 162436, 144896, 150193, 140563, 20521,  131966, 24484,  131968, 131911, 28379,  132127, 20605,  20737,  13434,  20750,  39020,  
    14147,  33814,  149924, 132231, 20832,  144308, 20842,  134143, 139516, 131813, 140592, 132494, 143923, 137603, 23426,  34685,  132531, 146585, 20914,  20920,  
    40244,  20937,  20943,  20945,  15580,  20947,  150182, 20915,  20962,  21314,  20973,  33741,  26942,  145197, 24443,  21003,  21030,  21052,  21173,  21079,  
    21140,  21177,  21189,  31765,  34114,  21216,  34317,  158483, 21253,  166622, 21833,  28377,  147328, 133460, 147436, 21299,  21316,  134114, 27851,  136998, 
    26651,  29653,  24650,  16042,  14540,  136936, 29149,  17570,  21357,  21364,  165547, 21374,  21375,  136598, 136723, 30694,  21395,  166555, 21408,  21419,  
    21422,  29607,  153458, 16217,  29596,  21441,  21445,  27721,  20041,  22526,  21465,  15019,  134031, 21472,  147435, 142755, 21494,  134263, 21523,  28793,  
    21803,  26199,  27995,  21613,  158547, 134516, 21853,  21647,  21668,  18342,  136973, 134877, 15796,  134477, 166332, 140952, 21831,  19693,  21551,  29719,  
    21894,  21929,  22021,  137431, 147514, 17746,  148533, 26291,  135348, 22071,  26317,  144010, 26276,  26285,  22093,  22095,  30961,  22257,  38791,  21502,  
    22272,  22255,  22253,  166758, 13859,  135759, 22342,  147877, 27758,  28811,  22338,  14001,  158846, 22502,  136214, 22531,  136276, 148323, 22566,  150517, 
    22620,  22698,  13665,  22752,  22748,  135740, 22779,  23551,  22339,  172368, 148088, 37843,  13729,  22815,  26790,  14019,  28249,  136766, 23076,  21843,  
    136850, 34053,  22985,  134478, 158849, 159018, 137180, 23001,  137211, 137138, 159142, 28017,  137256, 136917, 23033,  159301, 23211,  23139,  14054,  149929, 
    23159,  14088,  23190,  29797,  23251,  159649, 140628, 15749,  137489, 14130,  136888, 24195,  21200,  23414,  25992,  23420,  162318, 16388,  18525,  131588, 
    23509,  24928,  137780, 154060, 132517, 23539,  23453,  19728,  23557,  138052, 23571,  29646,  23572,  138405, 158504, 23625,  18653,  23685,  23785,  23791,  
    23947,  138745, 138807, 23824,  23832,  23878,  138916, 23738,  24023,  33532,  14381,  149761, 139337, 139635, 33415,  14390,  15298,  24110,  27274,  24181,  
    24186,  148668, 134355, 21414,  20151,  24272,  21416,  137073, 24073,  24308,  164994, 24313,  24315,  14496,  24316,  26686,  37915,  24333,  131521, 194708, 
    15070,  18606,  135994, 24378,  157832, 140240, 24408,  140401, 24419,  38845,  159342, 24434,  37696,  166454, 24487,  23990,  15711,  152144, 139114, 159992, 
    140904, 37334,  131742, 166441, 24625,  26245,  137335, 14691,  15815,  13881,  22416,  141236, 31089,  15936,  24734,  24740,  24755,  149890, 149903, 162387, 
    29860,  20705,  23200,  24932,  33828,  24898,  194726, 159442, 24961,  20980,  132694, 24967,  23466,  147383, 141407, 25043,  166813, 170333, 25040,  14642,  
    141696, 141505, 24611,  24924,  25886,  25483,  131352, 25285,  137072, 25301,  142861, 25452,  149983, 14871,  25656,  25592,  136078, 137212, 25744,  28554,  
    142902, 38932,  147596, 153373, 25825,  25829,  38011,  14950,  25658,  14935,  25933,  28438,  150056, 150051, 25989,  25965,  25951,  143486, 26037,  149824, 
    19255,  26065,  16600,  137257, 26080,  26083,  24543,  144384, 26136,  143863, 143864, 26180,  143780, 143781, 26187,  134773, 26215,  152038, 26227,  26228,  
    138813, 143921, 165364, 143816, 152339, 30661,  141559, 39332,  26370,  148380, 150049, 15147,  27130,  145346, 26462,  26471,  26466,  147917, 168173, 26583,  
    17641,  26658,  28240,  37436,  26625,  144358, 159136, 26717,  144495, 27105,  27147,  166623, 26995,  26819,  144845, 26881,  26880,  15666,  14849,  144956, 
    15232,  26540,  26977,  166474, 17148,  26934,  27032,  15265,  132041, 33635,  20624,  27129,  144985, 139562, 27205,  145155, 27293,  15347,  26545,  27336,  
    168348, 15373,  27421,  133411, 24798,  27445,  27508,  141261, 28341,  146139, 132021, 137560, 14144,  21537,  146266, 27617,  147196, 27612,  27703,  140427, 
    149745, 158545, 27738,  33318,  27769,  146876, 17605,  146877, 147876, 149772, 149760, 146633, 14053,  15595,  134450, 39811,  143865, 140433, 32655,  26679,  
    159013, 159137, 159211, 28054,  27996,  28284,  28420,  149887, 147589, 159346, 34099,  159604, 20935,  27804,  28189,  33838,  166689, 28207,  146991, 29779,  
    147330, 31180,  28239,  23185,  143435, 28664,  14093,  28573,  146992, 28410,  136343, 147517, 17749,  37872,  28484,  28508,  15694,  28532,  168304, 15675,  
    28575,  147780, 28627,  147601, 147797, 147513, 147440, 147380, 147775, 20959,  147798, 147799, 147776, 156125, 28747,  28798,  28839,  28801,  28876,  28885,  
    28886,  28895,  16644,  15848,  29108,  29078,  148087, 28971,  28997,  23176,  29002,  29038,  23708,  148325, 29007,  37730,  148161, 28972,  148570, 150055, 
    150050, 29114,  166888, 28861,  29198,  37954,  29205,  22801,  37955,  29220,  37697,  153093, 29230,  29248,  149876, 26813,  29269,  29271,  15957,  143428, 
    26637,  28477,  29314,  29482,  29483,  149539, 165931, 18669,  165892, 29480,  29486,  29647,  29610,  134202, 158254, 29641,  29769,  147938, 136935, 150052, 
    26147,  14021,  149943, 149901, 150011, 29687,  29717,  26883,  150054, 29753,  132547, 16087,  29788,  141485, 29792,  167602, 29767,  29668,  29814,  33721,  
    29804,  14128,  29812,  37873,  27180,  29826,  18771,  150156, 147807, 150137, 166799, 23366,  166915, 137374, 29896,  137608, 29966,  29929,  29982,  167641, 
    137803, 23511,  167596, 37765,  30029,  30026,  30055,  30062,  151426, 16132,  150803, 30094,  29789,  30110,  30132,  30210,  30252,  30289,  30287,  30319,  
    30326,  156661, 30352,  33263,  14328,  157969, 157966, 30369,  30373,  30391,  30412,  159647, 33890,  151709, 151933, 138780, 30494,  30502,  30528,  25775,  
    152096, 30552,  144044, 30639,  166244, 166248, 136897, 30708,  30729,  136054, 150034, 26826,  30895,  30919,  30931,  38565,  31022,  153056, 30935,  31028,  
    30897,  161292, 36792,  34948,  166699, 155779, 140828, 31110,  35072,  26882,  31104,  153687, 31133,  162617, 31036,  31145,  28202,  160038, 16040,  31174,  
    168205, 31188,  
  ]);

  for (const [key, index] of encodingIndexes) {
    decoders.set(key, (options) => {
      return new SingleByteDecoder(index, options);
    });
  }

  function codePointsToString(codePoints) {
    let s = "";
    for (const cp of codePoints) {
      s += String.fromCodePoint(cp);
    }
    return s;
  }

  class Stream {
    #tokens = [];
    constructor(tokens) {
      this.#tokens = [...tokens];
      this.#tokens.reverse();
    }

    endOfStream() {
      return !this.#tokens.length;
    }

    read() {
      return !this.#tokens.length ? END_OF_STREAM : this.#tokens.pop();
    }

    prepend(token) {
      if (Array.isArray(token)) {
        while (token.length) {
          this.#tokens.push(token.pop());
        }
      } else {
        this.#tokens.push(token);
      }
    }

    push(token) {
      if (Array.isArray(token)) {
        while (token.length) {
          this.#tokens.unshift(token.shift());
        }
      } else {
        this.#tokens.unshift(token);
      }
    }
  }

  function isEitherArrayBuffer(x) {
    return (
      x instanceof SharedArrayBuffer ||
      x instanceof ArrayBuffer ||
      typeof x === "undefined"
    );
  }

  const whitespace = [" ", "\t", "\n", "\f", "\r"];
  function trimAsciiWhitespace(label) {
    let start = 0;
    for (const i in label) {
      if (!whitespace.includes(label[i])) {
        start = i;
        break;
      }
    }
    let end = label.length - 1;
    for (const _i in label) {
      const i = end - _i;
      if (!whitespace.includes(label[i])) {
        end = i;
        break;
      }
    }
    return label.substring(start, end + 1);
  }

  class TextDecoder {
    #encoding = "";

    get encoding() {
      return this.#encoding;
    }
    fatal = false;
    ignoreBOM = false;

    constructor(label = "utf-8", options = { fatal: false }) {
      if (options.ignoreBOM) {
        this.ignoreBOM = true;
      }
      if (options.fatal) {
        this.fatal = true;
      }
      const _label = trimAsciiWhitespace(String(label)).toLowerCase();
      const encoding = encodings.get(_label);
      if (!encoding) {
        throw new RangeError(
          `The encoding label provided ('${label}') is invalid.`,
        );
      }
      if (
        !decoders.has(encoding) &&
        !["utf-16le", "utf-16be", "utf-8", "big5"].includes(encoding)
      ) {
        throw new RangeError(`Internal decoder ('${encoding}') not found.`);
      }
      this.#encoding = encoding;
    }

    decode(input, options = { stream: false }) {
      if (options.stream) {
        throw new TypeError("Stream not supported.");
      }

      let bytes;
      if (input instanceof Uint8Array) {
        bytes = input;
      } else if (isEitherArrayBuffer(input)) {
        bytes = new Uint8Array(input);
      } else if (
        typeof input === "object" &&
        input !== null &&
        "buffer" in input &&
        isEitherArrayBuffer(input.buffer)
      ) {
        bytes = new Uint8Array(
          input.buffer,
          input.byteOffset,
          input.byteLength,
        );
      } else {
        throw new TypeError(
          "Provided input is not of type ArrayBuffer or ArrayBufferView",
        );
      }

      // For simple utf-8 decoding "Deno.core.decode" can be used for performance
      if (
        this.#encoding === "utf-8" &&
        this.fatal === false &&
        this.ignoreBOM === false
      ) {
        return core.decode(bytes);
      }

      // For performance reasons we utilise a highly optimised decoder instead of
      // the general decoder.
      if (this.#encoding === "utf-8") {
        return decodeUtf8(bytes, this.fatal, this.ignoreBOM);
      }

      if (this.#encoding === "utf-16le" || this.#encoding === "utf-16be") {
        const result = Utf16ByteDecoder(
          bytes,
          this.#encoding.endsWith("be"),
          this.fatal,
          this.ignoreBOM,
        );
        return String.fromCharCode.apply(null, result);
      }

      if (this.#encoding === "big5") {
        const result = Big5Decoder(
          encodingIndexes.get("big5"),
          bytes,
          this.fatal,
          this.ignoreBOM,
        );
        return String.fromCharCode.apply(null, result);
      }

      const decoder = decoders.get(this.#encoding)({
        fatal: this.fatal,
        ignoreBOM: this.ignoreBOM,
      });
      const inputStream = new Stream(bytes);
      const output = [];

      while (true) {
        const result = decoder.handler(inputStream, inputStream.read());
        if (result === FINISHED) {
          break;
        }

        if (result !== CONTINUE) {
          output.push(result);
        }
      }

      if (output.length > 0 && output[0] === 0xfeff) {
        output.shift();
      }

      return codePointsToString(output);
    }

    get [Symbol.toStringTag]() {
      return "TextDecoder";
    }
  }

  class TextEncoder {
    encoding = "utf-8";
    encode(input = "") {
      input = String(input);
      // Deno.core.encode() provides very efficient utf-8 encoding
      if (this.encoding === "utf-8") {
        return core.encode(input);
      }

      const encoder = new UTF8Encoder();
      const inputStream = new Stream(stringToCodePoints(input));
      const output = [];

      while (true) {
        const result = encoder.handler(inputStream.read());
        if (result === "finished") {
          break;
        }
        output.push(...result);
      }

      return new Uint8Array(output);
    }
    encodeInto(input, dest) {
      const encoder = new UTF8Encoder();
      const inputStream = new Stream(stringToCodePoints(input));

      if (!(dest instanceof Uint8Array)) {
        throw new TypeError(
          "2nd argument to TextEncoder.encodeInto must be Uint8Array",
        );
      }

      let written = 0;
      let read = 0;
      while (true) {
        const item = inputStream.read();
        const result = encoder.handler(item);
        if (result === "finished") {
          break;
        }
        if (dest.length - written >= result.length) {
          read++;
          if (item > 0xFFFF) {
            // increment read a second time if greater than U+FFFF
            read++;
          }
          dest.set(result, written);
          written += result.length;
        } else {
          break;
        }
      }

      return {
        read,
        written,
      };
    }
    get [Symbol.toStringTag]() {
      return "TextEncoder";
    }
  }

  // This function is based on Bjoern Hoehrmann's DFA UTF-8 decoder.
  // See http://bjoern.hoehrmann.de/utf-8/decoder/dfa/ for details.
  //
  // Copyright (c) 2008-2009 Bjoern Hoehrmann <bjoern@hoehrmann.de>
  //
  // Permission is hereby granted, free of charge, to any person obtaining a copy
  // of this software and associated documentation files (the "Software"), to deal
  // in the Software without restriction, including without limitation the rights
  // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  // copies of the Software, and to permit persons to whom the Software is
  // furnished to do so, subject to the following conditions:
  //
  // The above copyright notice and this permission notice shall be included in
  // all copies or substantial portions of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  // SOFTWARE.
  function decodeUtf8(input, fatal, ignoreBOM) {
    let outString = "";

    // Prepare a buffer so that we don't have to do a lot of string concats, which
    // are very slow.
    const outBufferLength = Math.min(1024, input.length);
    const outBuffer = new Uint16Array(outBufferLength);
    let outIndex = 0;

    let state = 0;
    let codepoint = 0;
    let type;

    let i =
      !ignoreBOM && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf
        ? 3
        : 0;

    for (; i < input.length; ++i) {
      // Encoding error handling
      if (state === 12 || (state !== 0 && (input[i] & 0xc0) !== 0x80)) {
        if (fatal) {
          throw new TypeError(
            `Decoder error. Invalid byte in sequence at position ${i} in data.`,
          );
        }
        outBuffer[outIndex++] = 0xfffd; // Replacement character
        if (outIndex === outBufferLength) {
          outString += String.fromCharCode.apply(null, outBuffer);
          outIndex = 0;
        }
        state = 0;
      }

      // deno-fmt-ignore
      // deno-fmt-ignore
      type = [
         0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
         0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
         0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
         0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
         1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,  9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,
         7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
         8,8,2,2,2,2,2,2,2,2,2,2,2,2,2,2,  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
        10,3,3,3,3,3,3,3,3,3,3,3,3,4,3,3, 11,6,6,6,5,8,8,8,8,8,8,8,8,8,8,8
      ][input[i]];
      codepoint = state !== 0
        ? (input[i] & 0x3f) | (codepoint << 6)
        : (0xff >> type) & input[i];
      // deno-fmt-ignore
      // deno-fmt-ignore
      state = [
         0,12,24,36,60,96,84,12,12,12,48,72, 12,12,12,12,12,12,12,12,12,12,12,12,
        12, 0,12,12,12,12,12, 0,12, 0,12,12, 12,24,12,12,12,12,12,24,12,24,12,12,
        12,12,12,12,12,12,12,24,12,12,12,12, 12,24,12,12,12,12,12,12,12,24,12,12,
        12,12,12,12,12,12,12,36,12,36,12,12, 12,36,12,12,12,12,12,36,12,36,12,12,
        12,36,12,12,12,12,12,12,12,12,12,12
      ][state + type];

      if (state !== 0) continue;

      // Add codepoint to buffer (as charcodes for utf-16), and flush buffer to
      // string if needed.
      if (codepoint > 0xffff) {
        outBuffer[outIndex++] = 0xd7c0 + (codepoint >> 10);
        if (outIndex === outBufferLength) {
          outString += String.fromCharCode.apply(null, outBuffer);
          outIndex = 0;
        }
        outBuffer[outIndex++] = 0xdc00 | (codepoint & 0x3ff);
        if (outIndex === outBufferLength) {
          outString += String.fromCharCode.apply(null, outBuffer);
          outIndex = 0;
        }
      } else {
        outBuffer[outIndex++] = codepoint;
        if (outIndex === outBufferLength) {
          outString += String.fromCharCode.apply(null, outBuffer);
          outIndex = 0;
        }
      }
    }

    // Add a replacement character if we ended in the middle of a sequence or
    // encountered an invalid code at the end.
    if (state !== 0) {
      if (fatal) throw new TypeError(`Decoder error. Unexpected end of data.`);
      outBuffer[outIndex++] = 0xfffd; // Replacement character
    }

    // Final flush of buffer
    outString += String.fromCharCode.apply(
      null,
      outBuffer.subarray(0, outIndex),
    );

    return outString;
  }

  // Following code is forked from https://github.com/beatgammit/base64-js
  // Copyright (c) 2014 Jameson Little. MIT License.
  const lookup = [];
  const revLookup = [];

  const code =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0, len = code.length; i < len; ++i) {
    lookup[i] = code[i];
    revLookup[code.charCodeAt(i)] = i;
  }

  // Support decoding URL-safe base64 strings, as Node.js does.
  // See: https://en.wikipedia.org/wiki/Base64#URL_applications
  revLookup["-".charCodeAt(0)] = 62;
  revLookup["_".charCodeAt(0)] = 63;

  function getLens(b64) {
    const len = b64.length;

    if (len % 4 > 0) {
      throw new Error("Invalid string. Length must be a multiple of 4");
    }

    // Trim off extra bytes after placeholder bytes are found
    // See: https://github.com/beatgammit/base64-js/issues/42
    let validLen = b64.indexOf("=");
    if (validLen === -1) validLen = len;

    const placeHoldersLen = validLen === len ? 0 : 4 - (validLen % 4);

    return [validLen, placeHoldersLen];
  }

  // base64 is 4/3 + up to two characters of the original data
  function byteLength(b64) {
    const lens = getLens(b64);
    const validLen = lens[0];
    const placeHoldersLen = lens[1];
    return ((validLen + placeHoldersLen) * 3) / 4 - placeHoldersLen;
  }

  function _byteLength(b64, validLen, placeHoldersLen) {
    return ((validLen + placeHoldersLen) * 3) / 4 - placeHoldersLen;
  }

  function toByteArray(b64) {
    let tmp;
    const lens = getLens(b64);
    const validLen = lens[0];
    const placeHoldersLen = lens[1];

    const arr = new Uint8Array(_byteLength(b64, validLen, placeHoldersLen));

    let curByte = 0;

    // if there are placeholders, only get up to the last complete 4 chars
    const len = placeHoldersLen > 0 ? validLen - 4 : validLen;

    let i;
    for (i = 0; i < len; i += 4) {
      tmp = (revLookup[b64.charCodeAt(i)] << 18) |
        (revLookup[b64.charCodeAt(i + 1)] << 12) |
        (revLookup[b64.charCodeAt(i + 2)] << 6) |
        revLookup[b64.charCodeAt(i + 3)];
      arr[curByte++] = (tmp >> 16) & 0xff;
      arr[curByte++] = (tmp >> 8) & 0xff;
      arr[curByte++] = tmp & 0xff;
    }

    if (placeHoldersLen === 2) {
      tmp = (revLookup[b64.charCodeAt(i)] << 2) |
        (revLookup[b64.charCodeAt(i + 1)] >> 4);
      arr[curByte++] = tmp & 0xff;
    }

    if (placeHoldersLen === 1) {
      tmp = (revLookup[b64.charCodeAt(i)] << 10) |
        (revLookup[b64.charCodeAt(i + 1)] << 4) |
        (revLookup[b64.charCodeAt(i + 2)] >> 2);
      arr[curByte++] = (tmp >> 8) & 0xff;
      arr[curByte++] = tmp & 0xff;
    }

    return arr;
  }

  function tripletToBase64(num) {
    return (
      lookup[(num >> 18) & 0x3f] +
      lookup[(num >> 12) & 0x3f] +
      lookup[(num >> 6) & 0x3f] +
      lookup[num & 0x3f]
    );
  }

  function encodeChunk(uint8, start, end) {
    let tmp;
    const output = [];
    for (let i = start; i < end; i += 3) {
      tmp = ((uint8[i] << 16) & 0xff0000) +
        ((uint8[i + 1] << 8) & 0xff00) +
        (uint8[i + 2] & 0xff);
      output.push(tripletToBase64(tmp));
    }
    return output.join("");
  }

  function fromByteArray(uint8) {
    let tmp;
    const len = uint8.length;
    const extraBytes = len % 3; // if we have 1 byte left, pad 2 bytes
    const parts = [];
    const maxChunkLength = 16383; // must be multiple of 3

    // go through the array every three bytes, we'll deal with trailing stuff later
    for (let i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
      parts.push(
        encodeChunk(
          uint8,
          i,
          i + maxChunkLength > len2 ? len2 : i + maxChunkLength,
        ),
      );
    }

    // pad the end with zeros, but make sure to not forget the extra bytes
    if (extraBytes === 1) {
      tmp = uint8[len - 1];
      parts.push(lookup[tmp >> 2] + lookup[(tmp << 4) & 0x3f] + "==");
    } else if (extraBytes === 2) {
      tmp = (uint8[len - 2] << 8) + uint8[len - 1];
      parts.push(
        lookup[tmp >> 10] +
          lookup[(tmp >> 4) & 0x3f] +
          lookup[(tmp << 2) & 0x3f] +
          "=",
      );
    }

    return parts.join("");
  }

  const base64 = {
    byteLength,
    toByteArray,
    fromByteArray,
  };

  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.atob = atob;
  window.btoa = btoa;
  window.__bootstrap = window.__bootstrap || {};
  window.__bootstrap.base64 = base64;
})(this);
