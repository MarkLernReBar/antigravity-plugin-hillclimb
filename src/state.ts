// Reading a climb's state the way climb.py reads it.
//
// The script is the authority: it decides keep or undo, and its own `status`
// is the last word. This module re-reads the same two files (card.json,
// log.jsonl) and reaches the same verdict, so `hillclimb status` and an
// agent tool can answer without a shell on the repo's machine. Anything that
// changes state stays in the script.

export type Direction = "min" | "max";

export const PLATEAU = 5;
const BARS = "▁▂▃▄▅▆▇█";

const SECRET_KEY_CACHE = new Map<string, boolean>();

function isSecretKey(key: string): boolean {
  const cached = SECRET_KEY_CACHE.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  if (/^[A-Z0-9_]+$/.test(key)) {
    result = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|AUTH)(?:_|$)/.test(key);
  } else if (/^[a-z0-9_-]+$/.test(key)) {
    result =
      /(?:^|[-_])(?:token|secret|password|passwd|passphrase|credential)(?:[-_]|$)|(?:^|[-_])(?:api|auth|access|refresh|bearer|client|private|secret|session|oauth|signing|encryption)[-_](?:key|auth)(?:[-_]|$)/.test(
        key,
      );
  }
  if (SECRET_KEY_CACHE.size < 1024) SECRET_KEY_CACHE.set(key, result);
  return result;
}

function isWhitespaceChar(code: number, line: string, idx: number): boolean {
  if (code === 32 || code === 9 || code === 11 || code === 12) return true;
  return code >= 128 && /\s/.test(line[idx]!);
}

const WORD_PREFIX_ASCII = new Uint8Array(128);
for (const code of [32, 9, 11, 12, 34, 39, 96, 40, 59, 38, 63, 61, 44, 123, 124, 91, 58]) {
  WORD_PREFIX_ASCII[code] = 1;
}

const KEY_CHAR_ASCII = new Uint8Array(128);
for (let c = 48; c <= 57; c++) KEY_CHAR_ASCII[c] = 1; // 0-9
for (let c = 65; c <= 90; c++) KEY_CHAR_ASCII[c] = 1; // A-Z
for (let c = 97; c <= 122; c++) KEY_CHAR_ASCII[c] = 1; // a-z
KEY_CHAR_ASCII[95] = 1; // _
KEY_CHAR_ASCII[45] = 1; // -

const UNCLOSED_STOP_ASCII = new Uint8Array(128);
for (const code of [32, 9, 11, 12, 59, 38, 35, 41]) {
  UNCLOSED_STOP_ASCII[code] = 1;
}

function isWordPrefixCode(line: string, idx: number): boolean {
  const code = line.charCodeAt(idx);
  return code < 128 ? WORD_PREFIX_ASCII[code] === 1 : /\s/.test(line[idx]!);
}

function isKeyCharCode(code: number): boolean {
  return code < 128 && KEY_CHAR_ASCII[code] === 1;
}

const CLOSE_BOUNDARY_ASCII = new Uint8Array(128);
for (const code of [32, 9, 11, 12, 59, 38, 124, 41, 125, 93, 44, 96]) {
  CLOSE_BOUNDARY_ASCII[code] = 1;
}

function isValidQuoteCloseBoundary(line: string, closeIdx: number): boolean {
  const nextIdx = closeIdx + 1;
  if (nextIdx >= line.length) return true;
  const nextCode = line.charCodeAt(nextIdx);
  return nextCode < 128 ? CLOSE_BOUNDARY_ASCII[nextCode] === 1 : /\s/.test(line[nextIdx]!);
}

function isSecretDoubleQuotedAssignmentAt(line: string, idx: number): boolean {
  const n = line.length;
  let j = idx;
  while (j < n && isKeyCharCode(line.charCodeAt(j))) {
    j += 1;
  }
  if (j === idx || j + 1 >= n) return false;
  if (line.charCodeAt(j) !== 61 || line.charCodeAt(j + 1) !== 34) return false;
  return isSecretKey(line.slice(idx, j));
}

function findMatchingOuterQuoteClose(
  line: string,
  openIdx: number,
  quoteCode: number,
  isAnsic: boolean,
): number {
  const start = openIdx + (isAnsic ? 2 : 1);
  if (isAnsic || quoteCode === 34) {
    const ch = quoteCode === 34 ? '"' : "'";
    let p = start;
    while (p < line.length) {
      const q = line.indexOf(ch, p);
      if (q === -1) return -1;
      let bs = 0;
      let k = q - 1;
      while (k >= start && line.charCodeAt(k) === 92) {
        bs += 1;
        k -= 1;
      }
      if ((bs & 1) === 0) return q;
      p = q + 1;
    }
    return -1;
  }
  let p = start;
  while (p < line.length) {
    const q = line.indexOf("'", p);
    if (q === -1) return -1;
    if (
      q + 3 < line.length &&
      line.charCodeAt(q + 1) === 92 &&
      line.charCodeAt(q + 2) === 39 &&
      line.charCodeAt(q + 3) === 39
    ) {
      p = q + 4;
      continue;
    }
    return q;
  }
  return -1;
}

function isUnclosedStopChar(code: number, line: string, idx: number): boolean {
  return code < 128 ? UNCLOSED_STOP_ASCII[code] === 1 : /\s/.test(line[idx]!);
}

function isShellSingleQuoteEscape(line: string, idx: number): boolean {
  return (
    idx + 3 < line.length &&
    line.charCodeAt(idx) === 39 &&
    line.charCodeAt(idx + 1) === 92 &&
    line.charCodeAt(idx + 2) === 39 &&
    line.charCodeAt(idx + 3) === 39
  );
}

const INVALIDATE_OUTER_SPAN = -2;

function scanClosedQuoted(
  line: string,
  contentStart: number,
  quoteCode: number,
  outerCode: number,
  allowBackslashEscape = false,
  outerAnsic = false,
  outerEnd = line.length,
): number {
  if (outerCode === 0) {
    if (quoteCode === 39 && !allowBackslashEscape) {
      const q = line.indexOf("'", contentStart);
      return q === -1 ? -1 : q + 1;
    }
    const ch = quoteCode === 39 ? "'" : '"';
    let p = contentStart;
    while (p < line.length) {
      const q = line.indexOf(ch, p);
      if (q === -1) return -1;
      let bs = 0;
      let k = q - 1;
      while (k >= contentStart && line.charCodeAt(k) === 92) {
        bs += 1;
        k -= 1;
      }
      if ((bs & 1) === 0) return q + 1;
      p = q + 1;
    }
    return -1;
  }
  const limit = Math.min(line.length, outerEnd + 1);
  let q = contentStart;
  if (quoteCode === 39) {
    while (q < limit) {
      const code = line.charCodeAt(q);
      if (outerCode === 39) {
        if (!outerAnsic && q === outerEnd) return q;
        if (!outerAnsic && isShellSingleQuoteEscape(line, q)) return q + 4;
        if (code === 39) return -1;
      }
      if (allowBackslashEscape && code === 92) {
        if (outerCode === 39 && q + 1 < limit && line.charCodeAt(q + 1) === 39) {
          if (outerAnsic) {
            q += 2;
            continue;
          }
          if (isShellSingleQuoteEscape(line, q + 1)) {
            q += 5;
            continue;
          }
          return -1;
        }
        q += q + 1 < limit ? 2 : 1;
        continue;
      }
      if (outerCode === 34 && code === 34) return -1;
      if (outerCode !== 39 && code === 39) {
        return q + 1;
      }
      q += 1;
    }
    return -1;
  }
  while (q < limit) {
    const code = line.charCodeAt(q);
    if (outerCode === 39) {
      if (!outerAnsic && isShellSingleQuoteEscape(line, q)) {
        q += 4;
        continue;
      }
      if (code === 39) return -1;
    }
    if (code === 92) {
      if (outerCode === 39 && q + 1 < limit && line.charCodeAt(q + 1) === 39) {
        if (outerAnsic) {
          q += 2;
          continue;
        }
        if (isShellSingleQuoteEscape(line, q + 1)) {
          q += 5;
          continue;
        }
        return -1;
      }
      q += q + 1 < limit ? 2 : 1;
    } else if (code === 34) {
      return q + 1;
    } else {
      q += 1;
    }
  }
  return -1;
}

function scanClosedEscapedQuoted(
  line: string,
  contentStart: number,
  quoteCode: number,
  outerCode: number,
  outerAnsic = false,
  outerEnd = line.length,
): number {
  const limit = outerCode !== 0 ? Math.min(line.length, outerEnd + 1) : line.length;
  let q = contentStart;
  while (q < limit) {
    const code = line.charCodeAt(q);
    if (outerCode === 39) {
      if (!outerAnsic && isShellSingleQuoteEscape(line, q)) {
        q += 4;
        continue;
      }
      if (code === 39) return -1;
    } else if (code === outerCode) {
      return -1;
    }
    if (code === 92) {
      if (q + 1 < limit) {
        const c1 = line.charCodeAt(q + 1);
        if (outerCode === 39 && !outerAnsic && quoteCode === 39 && isShellSingleQuoteEscape(line, q + 1)) {
          return q + 5;
        }
        if (c1 === quoteCode && !(outerCode === 39 && !outerAnsic && c1 === 39)) return q + 2;
        if (c1 === 92) {
          if (q + 3 < limit && line.charCodeAt(q + 2) === 92) {
            const c3 = line.charCodeAt(q + 3);
            if (c3 === quoteCode || c3 === 92) {
              q += 4;
              continue;
            }
          }
          q += 2;
          continue;
        }
        if (outerCode === 39 && c1 === 39) {
          if (outerAnsic) {
            q += 2;
            continue;
          }
          if (isShellSingleQuoteEscape(line, q + 1)) {
            q += 5;
            continue;
          }
          return -1;
        }
        q += 2;
      } else {
        q += 1;
      }
    } else {
      q += 1;
    }
  }
  return -1;
}

const CLI_BOUNDARY_ASCII = new Uint8Array(128);
for (const code of [32, 9, 11, 12, 59, 38, 124, 40, 41]) {
  CLI_BOUNDARY_ASCII[code] = 1;
}

const CLI_ARG_PREFIX_ASCII = new Uint8Array(128);
for (const code of [32, 9, 11, 12, 59, 38, 124, 40, 41, 61]) {
  CLI_ARG_PREFIX_ASCII[code] = 1;
}

function isCliBoundaryChar(line: string, idx: number): boolean {
  const code = line.charCodeAt(idx);
  return code < 128 ? CLI_BOUNDARY_ASCII[code] === 1 : /\s/.test(line[idx]!);
}

function isCliArgPrefixChar(line: string, idx: number): boolean {
  const code = line.charCodeAt(idx);
  return code < 128 ? CLI_ARG_PREFIX_ASCII[code] === 1 : /\s/.test(line[idx]!);
}

function isAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUpperEnvKey(line: string, start: number, end: number): boolean {
  if (end - start < 2) return false;
  const first = line.charCodeAt(start);
  if (!((first >= 65 && first <= 90) || first === 95)) return false;
  for (let i = start + 1; i < end; i += 1) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}

function spanContainsSecretAssignment(line: string, start: number, end: number): boolean {
  let k = start;
  while (k < end) {
    const code = line.charCodeAt(k);
    if (code < 128 && KEY_CHAR_ASCII[code] === 1) {
      const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
      const atWordStart =
        k === start || (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!));
      let j = k + 1;
      while (j < end) {
        const jc = line.charCodeAt(j);
        if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
        j += 1;
      }
      if (atWordStart && j < end && line.charCodeAt(j) === 61 && isSecretKey(line.slice(k, j))) {
        return true;
      }
      k = j;
      continue;
    }
    k += 1;
  }
  return false;
}

function hasBalancedInnerQuoteAt(
  line: string,
  openQuoteIdx: number,
  spanClose: number,
  targetQuoteIdx: number,
  targetQuoteCode: number,
  isEscaped: boolean,
): boolean {
  if (isEscaped) {
    const escStart = targetQuoteIdx - 1;
    if (escStart <= openQuoteIdx || line.charCodeAt(escStart) !== 92) return false;
    if (escStart - 1 > openQuoteIdx && !isCliArgPrefixChar(line, escStart - 1)) return false;
    const ch = targetQuoteCode === 34 ? '"' : "'";
    let p = targetQuoteIdx + 1;
    while (p < spanClose) {
      const q = line.indexOf(ch, p);
      if (q === -1 || q >= spanClose) return false;
      let bs = 0;
      let b = q - 1;
      while (b >= targetQuoteIdx + 1 && line.charCodeAt(b) === 92) {
        bs += 1;
        b -= 1;
      }
      if ((bs & 1) === 1) {
        return q + 1 === spanClose || isValidQuoteCloseBoundary(line, q);
      }
      p = q + 1;
    }
    return false;
  }

  if (targetQuoteIdx - 1 > openQuoteIdx && !isCliArgPrefixChar(line, targetQuoteIdx - 1)) {
    return false;
  }
  if (targetQuoteCode === 34) {
    let p = targetQuoteIdx + 1;
    while (p < spanClose) {
      const q = line.indexOf('"', p);
      if (q === -1 || q >= spanClose) return false;
      let bs = 0;
      let b = q - 1;
      while (b >= targetQuoteIdx + 1 && line.charCodeAt(b) === 92) {
        bs += 1;
        b -= 1;
      }
      if ((bs & 1) === 0) {
        return q + 1 === spanClose || isValidQuoteCloseBoundary(line, q);
      }
      p = q + 1;
    }
    return false;
  }
  const q = line.indexOf("'", targetQuoteIdx + 1);
  return q !== -1 && q < spanClose && (q + 1 === spanClose || isValidQuoteCloseBoundary(line, q));
}

function isSecretKeyBeforeEq(line: string, bound: number, eqIdx: number): boolean {
  let start = eqIdx;
  while (start > bound && isKeyCharCode(line.charCodeAt(start - 1))) {
    start -= 1;
  }
  return start < eqIdx && isSecretKey(line.slice(start, eqIdx));
}

function isUpperEnvKeyBeforeEq(line: string, bound: number, eqIdx: number): boolean {
  let start = eqIdx;
  while (start > bound && isKeyCharCode(line.charCodeAt(start - 1))) {
    start -= 1;
  }
  return start < eqIdx && isUpperEnvKey(line, start, eqIdx);
}

function isConcatNonSecretFollowedBySecretCmd(
  line: string,
  afterQuoteIdx: number,
  n: number,
  isEscaped: boolean,
): boolean {
  let p = afterQuoteIdx;
  while (p < n) {
    const c = line.charCodeAt(p);
    if (c < 128 ? CLI_BOUNDARY_ASCII[c] === 1 : /\s/.test(line[p]!)) break;
    if (c === 61 || c === 34 || c === 39 || (c === 92 && !isEscaped)) return false;
    if (c === 92 && isEscaped) {
      if (p + 1 < n) {
        const nc = line.charCodeAt(p + 1);
        if (nc === 34 || nc === 39) return false;
        p += 2;
        continue;
      }
      return false;
    }
    p += 1;
  }
  while (p < n && isWhitespaceChar(line.charCodeAt(p), line, p)) {
    p += 1;
  }
  if (p >= n) return false;
  const op = line.charCodeAt(p);
  if (op === 59 || op === 124) {
    p += 1;
    if (op === 124 && p < n && line.charCodeAt(p) === 124) p += 1;
  } else if (op === 38) {
    p += 1;
    if (p < n && line.charCodeAt(p) === 38) p += 1;
  } else {
    return false;
  }
  while (p < n && isWhitespaceChar(line.charCodeAt(p), line, p)) {
    p += 1;
  }
  if (p >= n) return false;
  let j = p;
  while (j < n && isKeyCharCode(line.charCodeAt(j))) {
    j += 1;
  }
  return j > p && j < n && line.charCodeAt(j) === 61 && isSecretKey(line.slice(p, j));
}

function matchesCrossSpanTarget(
  line: string,
  outerEnd: number,
  k: number,
  openQuoteIdx: number,
  spanClose: number,
  validClose: boolean,
  prefixEnd: number,
  targetQuoteIdx: number,
  isEscaped: boolean,
  sawShellOp: boolean,
  sawFlag: boolean,
  sawEnvAssign: boolean,
  lastEqPos: number,
): boolean {
  const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
  const validPrefix = k === prefixEnd || (prevCode < 128 ? CLI_ARG_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!));
  if (!validPrefix) return false;
  if (targetQuoteIdx === openQuoteIdx && !isEscaped) {
    const hasAssignAtK = lastEqPos === k - 1;
    if (!hasAssignAtK) {
      return validClose && (sawShellOp || sawFlag);
    }
    const isSecretAssign = isSecretKeyBeforeEq(line, outerEnd + 1, lastEqPos);
    if (validClose) {
      return sawShellOp || sawFlag || isSecretAssign;
    }
    if (isSecretAssign) return true;
    return (
      sawShellOp &&
      isUpperEnvKeyBeforeEq(line, outerEnd + 1, lastEqPos) &&
      isConcatNonSecretFollowedBySecretCmd(line, spanClose + 1, line.length, false)
    );
  }
  if (
    validClose &&
    targetQuoteIdx > openQuoteIdx &&
    targetQuoteIdx < spanClose &&
    hasBalancedInnerQuoteAt(line, openQuoteIdx, spanClose, targetQuoteIdx, line.charCodeAt(targetQuoteIdx), isEscaped)
  ) {
    if (sawShellOp || sawFlag) return true;
    return sawEnvAssign && spanContainsSecretAssignment(line, openQuoteIdx + 1, spanClose);
  }
  return false;
}

function scanFlagWordAdvance(line: string, k: number, targetQuoteIdx: number): number {
  const n = line.length;
  if (k + 1 >= n) return k + 1;
  const c1 = line.charCodeAt(k + 1);
  const startIdx = c1 === 45 ? k + 2 : k + 1;
  let j = startIdx;
  if (j >= n || !isAlphaCode(line.charCodeAt(j))) {
    j = k + 1;
    while (j <= targetQuoteIdx) {
      const jc = line.charCodeAt(j);
      if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
      j += 1;
    }
    return j;
  }
  j += 1;
  while (j < n) {
    const jc = line.charCodeAt(j);
    if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
    j += 1;
  }
  if (j === n || isWhitespaceChar(line.charCodeAt(j), line, j) || line.charCodeAt(j) === 61) {
    return -(j + (j < n && line.charCodeAt(j) === 61 ? 1 : 0));
  }
  return Math.min(j, targetQuoteIdx + 1);
}

function advanceEscapedCrossBoundary(
  line: string,
  n: number,
  outerEnd: number,
  k: number,
  nextCode: number,
  prefixEnd: number,
  targetQuoteIdx: number,
  sawShellOp: boolean,
  sawFlag: boolean,
  sawEnvAssign: boolean,
  lastEqPos: number,
  escFail: Int32Array,
): number {
  const failIdx = nextCode === 39 ? 0 : 1;
  if (k < escFail[failIdx]!) return -2;
  const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
  const validPrefix =
    k === prefixEnd || (prevCode < 128 ? CLI_ARG_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!));
  if (!validPrefix) return -2;
  const escCloseEnd = scanClosedEscapedQuoted(line, k + 2, nextCode, 0, false, n);
  if (escCloseEnd === -1) {
    escFail[failIdx] = n;
    return -2;
  }
  const spanClose = escCloseEnd - 2;
  const closeQuoteIdx = escCloseEnd - 1;
  const validClose = isValidQuoteCloseBoundary(line, closeQuoteIdx);
  if (targetQuoteIdx <= closeQuoteIdx) {
    if (k + 1 === targetQuoteIdx) {
      const hasAssignAtK = lastEqPos === k - 1;
      const isSecretAssign = hasAssignAtK && isSecretKeyBeforeEq(line, outerEnd + 1, lastEqPos);
      if (validClose) {
        if (sawShellOp || sawFlag || isSecretAssign) return -1;
      } else if (
        isSecretAssign ||
        (sawShellOp &&
          hasAssignAtK &&
          isUpperEnvKeyBeforeEq(line, outerEnd + 1, lastEqPos) &&
          isConcatNonSecretFollowedBySecretCmd(line, escCloseEnd, n, true))
      ) {
        return -1;
      }
    } else if (
      validClose &&
      targetQuoteIdx > k + 1 &&
      targetQuoteIdx < spanClose &&
      hasBalancedInnerQuoteAt(line, k + 1, spanClose, targetQuoteIdx, line.charCodeAt(targetQuoteIdx), true)
    ) {
      if (sawShellOp || sawFlag) return -1;
      if (sawEnvAssign && spanContainsSecretAssignment(line, k + 2, spanClose)) return -1;
    }
  }
  if (validClose) {
    let nextK = escCloseEnd;
    if (nextK <= targetQuoteIdx && line.charCodeAt(nextK) === 32) nextK += 1;
    return nextK;
  }
  escFail[failIdx] = spanClose;
  return -2;
}

function hasCrossBoundaryAfterOuter(
  line: string,
  outerEnd: number,
  closeEnd: number,
  isEscaped = false,
): boolean {
  if (closeEnd <= outerEnd || !isValidQuoteCloseBoundary(line, outerEnd)) return false;
  const n = line.length;
  const targetQuoteIdx = closeEnd - 1;
  let prefixEnd = -1;
  let sqFailUntil = 0;
  let dqFailUntil = 0;
  let ansicFailUntil = 0;
  let escFail: Int32Array | null = null;
  let sawShellOp = false;
  let sawFlag = false;
  let sawEnvAssign = false;
  let lastEqPos = -1;
  let k = outerEnd + 1;

  while (k <= targetQuoteIdx) {
    const firstCode = line.charCodeAt(k);
    if (firstCode === 32) {
      k += 1;
      continue;
    }
    if (firstCode < 128 && KEY_CHAR_ASCII[firstCode] === 1) {
      const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
      const atBoundary =
        k === outerEnd + 1 ||
        (prevCode < 128 ? CLI_BOUNDARY_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!));
      if (!atBoundary) {
        let j = k + 1;
        while (j <= targetQuoteIdx) {
          const jc = line.charCodeAt(j);
          if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
          j += 1;
        }
        if (
          j < n &&
          line.charCodeAt(j) === 61 &&
          (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!)) &&
          isSecretKey(line.slice(k, j))
        ) {
          lastEqPos = j;
        }
        k = j;
        continue;
      }
      if (firstCode === 45) {
        const res = scanFlagWordAdvance(line, k, targetQuoteIdx);
        if (res < 0) {
          sawFlag = true;
          const eqPos = -res - 1;
          if (sawShellOp && eqPos < n && line.charCodeAt(eqPos) === 61 && isSecretKeyBeforeEq(line, k, eqPos)) {
            lastEqPos = eqPos;
          }
          k = -res;
          continue;
        }
        k = res;
        continue;
      }
      let j = k + 1;
      while (j <= targetQuoteIdx) {
        const jc = line.charCodeAt(j);
        if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
        j += 1;
      }
      if (j < n && line.charCodeAt(j) === 61) {
        lastEqPos = j;
        let v = j + 1;
        if (v < n) {
          const vc = line.charCodeAt(v);
          if (vc !== 39 && vc !== 34 && !(vc === 36 && v + 1 < n && line.charCodeAt(v + 1) === 39)) {
            if (isUpperEnvKey(line, k, j)) {
              sawEnvAssign = true;
            }
            while (v <= targetQuoteIdx) {
              const wc = line.charCodeAt(v);
              if (
                wc < 128
                  ? CLI_BOUNDARY_ASCII[wc] === 1 || wc === 39 || wc === 34 || wc === 36 || wc === 92
                  : /\s/.test(line[v]!)
              ) {
                break;
              }
              v += 1;
            }
          }
        }
        k = v;
        continue;
      }
      k = j;
      continue;
    }
    if (firstCode === 92) {
      if (k + 1 < n) {
        const nextCode = line.charCodeAt(k + 1);
        if (isEscaped && (nextCode === 34 || nextCode === 39)) {
          const res = advanceEscapedCrossBoundary(
            line,
            n,
            outerEnd,
            k,
            nextCode,
            prefixEnd,
            targetQuoteIdx,
            sawShellOp,
            sawFlag,
            sawEnvAssign,
            lastEqPos,
            escFail ?? (escFail = new Int32Array(2)),
          );
          if (res === -1) return true;
          if (res >= 0) {
            k = res;
            continue;
          }
        }
        if (nextCode === 36 || nextCode === 92) prefixEnd = k + 2;
        k += 2;
      } else {
        k += 1;
      }
      continue;
    }
    if (firstCode === 36 && k + 1 < n) {
      const nextCode = line.charCodeAt(k + 1);
      if (nextCode === 36) {
        prefixEnd = k + 2;
        k += 2;
        continue;
      }
      if (nextCode === 39) {
        if (k >= ansicFailUntil) {
          const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
          if (k === prefixEnd || (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!))) {
            const spanClose = findMatchingOuterQuoteClose(line, k, 39, true);
            if (spanClose !== -1) {
              const validClose = isValidQuoteCloseBoundary(line, spanClose);
              if (
                targetQuoteIdx <= spanClose &&
                matchesCrossSpanTarget(
                  line,
                  outerEnd,
                  k,
                  k + 1,
                  spanClose,
                  validClose,
                  prefixEnd,
                  targetQuoteIdx,
                  isEscaped,
                  sawShellOp,
                  sawFlag,
                  sawEnvAssign,
                  lastEqPos,
                )
              ) {
                return true;
              }
              if (validClose) {
                k = spanClose + 1;
                if (k <= targetQuoteIdx && line.charCodeAt(k) === 32) k += 1;
                continue;
              }
            }
            ansicFailUntil = spanClose !== -1 ? spanClose : n;
          }
        }
        k += 2;
        continue;
      }
    }
    if (firstCode === 39 || firstCode === 34) {
      const failUntil = firstCode === 39 ? sqFailUntil : dqFailUntil;
      if (k >= failUntil) {
        const prevCode = k > 0 ? line.charCodeAt(k - 1) : 32;
        if (k === prefixEnd || (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[k - 1]!))) {
          const spanClose = findMatchingOuterQuoteClose(line, k, firstCode, false);
          if (spanClose !== -1) {
            const validClose = isValidQuoteCloseBoundary(line, spanClose);
            if (
              targetQuoteIdx <= spanClose &&
              matchesCrossSpanTarget(
                line,
                outerEnd,
                k,
                k,
                spanClose,
                validClose,
                prefixEnd,
                targetQuoteIdx,
                isEscaped,
                sawShellOp,
                sawFlag,
                sawEnvAssign,
                lastEqPos,
              )
            ) {
              return true;
            }
            if (validClose) {
              k = spanClose + 1;
              if (k <= targetQuoteIdx && line.charCodeAt(k) === 32) k += 1;
              continue;
            }
          }
          if (firstCode === 39) sqFailUntil = spanClose !== -1 ? spanClose : n;
          else dqFailUntil = spanClose !== -1 ? spanClose : n;
        }
      }
      k += 1;
      continue;
    }
    if (firstCode === 59 || firstCode === 124 || firstCode === 41) {
      sawShellOp = true;
      k += 1;
      continue;
    }
    if (firstCode === 38) {
      if (k + 1 < n && line.charCodeAt(k + 1) === 38) {
        sawShellOp = true;
        k += 2;
        continue;
      }
      if (
        (k > outerEnd + 1 && isCliBoundaryChar(line, k - 1)) ||
        (k + 1 < n && isWhitespaceChar(line.charCodeAt(k + 1), line, k + 1))
      ) {
        sawShellOp = true;
      }
      k += 1;
      continue;
    }
    k += 1;
  }
  return false;
}

function tryInvalidateQuoted(
  line: string,
  contentStart: number,
  quoteCode: number,
  allowBackslashEscape: boolean,
  outerEnd: number,
  allowInvalidate: boolean,
  badUntil: Int32Array,
  badIdx: number,
): boolean {
  if (!allowInvalidate || contentStart < badUntil[badIdx]!) return false;
  const closeEnd = scanClosedQuoted(line, contentStart, quoteCode, 0, allowBackslashEscape, false, line.length);
  if (closeEnd !== -1 && (closeEnd <= outerEnd || !hasCrossBoundaryAfterOuter(line, outerEnd, closeEnd, false))) {
    return true;
  }
  badUntil[badIdx] = closeEnd === -1 ? line.length : closeEnd;
  return false;
}

function tryInvalidateEscapedQuoted(
  line: string,
  contentStart: number,
  quoteCode: number,
  outerEnd: number,
  allowInvalidate: boolean,
  badUntil: Int32Array,
  badIdx: number,
): boolean {
  if (!allowInvalidate || contentStart < badUntil[badIdx]!) return false;
  const closeEnd = scanClosedEscapedQuoted(line, contentStart, quoteCode, 0, false, line.length);
  if (closeEnd !== -1 && (closeEnd <= outerEnd || !hasCrossBoundaryAfterOuter(line, outerEnd, closeEnd, true))) {
    return true;
  }
  badUntil[badIdx] = closeEnd === -1 ? line.length : closeEnd;
  return false;
}

function scanUnclosedSegment(
  line: string,
  start: number,
  prefixLen: number,
  outerCode: number,
  stopCharCode = 0,
  outerAnsic = false,
): number {
  const n = line.length;
  let q = start + prefixLen;
  while (q < n) {
    const code = line.charCodeAt(q);
    if (outerCode === 39 && !outerAnsic && isShellSingleQuoteEscape(line, q)) {
      q += 4;
      continue;
    }
    if (
      code === outerCode ||
      (stopCharCode !== 0 && code === stopCharCode) ||
      isUnclosedStopChar(code, line, q)
    ) {
      break;
    }
    if (code === 92) {
      if (q + 1 < n) {
        const nextCode = line.charCodeAt(q + 1);
        if (outerCode === 39 && nextCode === 39) {
          if (outerAnsic) {
            q += 2;
            continue;
          }
          if (isShellSingleQuoteEscape(line, q + 1)) {
            q += 5;
            continue;
          }
          q += 1;
          break;
        }
        if (isWhitespaceChar(nextCode, line, q + 1)) {
          q += 1;
          break;
        }
        q += 2;
      } else {
        q += 1;
      }
    } else {
      q += 1;
    }
  }
  return q;
}

function scanSecretValue(
  line: string,
  valStart: number,
  outerCode: number,
  stopCharCode = 0,
  outerAnsic = false,
  outerEnd = line.length,
  allowInvalidate = false,
  unclosedInOuter?: Int32Array,
  badUntil?: Int32Array,
): number {
  const n = line.length;
  let p = valStart;
  while (p < n) {
    const code = line.charCodeAt(p);
    if (outerCode === 39 && !outerAnsic && isShellSingleQuoteEscape(line, p)) {
      const contentStart = p + 4;
      const closeEnd =
        unclosedInOuter && contentStart < unclosedInOuter[0]!
          ? -1
          : scanClosedQuoted(line, contentStart, 39, outerCode, false, outerAnsic, outerEnd);
      if (closeEnd !== -1) {
        p = closeEnd;
        continue;
      }
      if (unclosedInOuter) unclosedInOuter[0] = outerEnd;
      p = scanUnclosedSegment(line, p, 4, outerCode, stopCharCode, outerAnsic);
      break;
    }
    if (code === outerCode) break;

    if (code === 36 && p + 1 < n) {
      const nextCode = line.charCodeAt(p + 1);
      if (nextCode === 36) {
        p += 2;
        continue;
      }
      if (outerCode === 39 && !outerAnsic && isShellSingleQuoteEscape(line, p + 1)) {
        const contentStart = p + 5;
        const closeEnd =
          unclosedInOuter && contentStart < unclosedInOuter[2]!
            ? -1
            : scanClosedQuoted(line, contentStart, 39, outerCode, true, outerAnsic, outerEnd);
        if (closeEnd !== -1) {
          p = closeEnd;
          continue;
        }
        if (unclosedInOuter) unclosedInOuter[2] = outerEnd;
        if (badUntil && tryInvalidateQuoted(line, contentStart, 39, true, outerEnd, allowInvalidate, badUntil, 2)) {
          return INVALIDATE_OUTER_SPAN;
        }
        p = scanUnclosedSegment(line, p, 5, outerCode, stopCharCode, outerAnsic);
        break;
      }
      if ((nextCode === 39 || nextCode === 34) && nextCode !== outerCode) {
        const contentStart = p + 2;
        const badIdx = nextCode === 39 ? 2 : 1;
        const closeEnd =
          outerCode !== 0 && unclosedInOuter && contentStart < unclosedInOuter[badIdx]!
            ? -1
            : scanClosedQuoted(line, contentStart, nextCode, outerCode, nextCode === 39, outerAnsic, outerEnd);
        if (closeEnd !== -1) {
          p = closeEnd;
          continue;
        }
        if (outerCode !== 0) {
          if (unclosedInOuter) unclosedInOuter[badIdx] = outerEnd;
          if (badUntil && tryInvalidateQuoted(line, contentStart, nextCode, nextCode === 39, outerEnd, allowInvalidate, badUntil, badIdx)) {
            return INVALIDATE_OUTER_SPAN;
          }
        }
        p = scanUnclosedSegment(line, p, 2, outerCode, stopCharCode, outerAnsic);
        break;
      }
    }

    if (code === 34 || code === 39) {
      const contentStart = p + 1;
      const badIdx = code === 39 ? 0 : 1;
      const closeEnd =
        outerCode !== 0 && unclosedInOuter && contentStart < unclosedInOuter[badIdx]!
          ? -1
          : scanClosedQuoted(line, contentStart, code, outerCode, false, outerAnsic, outerEnd);
      if (closeEnd !== -1) {
        p = closeEnd;
        continue;
      }
      if (outerCode !== 0) {
        if (unclosedInOuter) unclosedInOuter[badIdx] = outerEnd;
        if (badUntil && tryInvalidateQuoted(line, contentStart, code, false, outerEnd, allowInvalidate, badUntil, badIdx)) {
          return INVALIDATE_OUTER_SPAN;
        }
      }
      p = scanUnclosedSegment(line, p, 1, outerCode, stopCharCode, outerAnsic);
      break;
    }

    if (code === 92) {
      if (p + 1 < n) {
        const nextCode = line.charCodeAt(p + 1);
        if (nextCode === 34 || nextCode === 39) {
          if (outerCode === 39 && nextCode === 39) {
            if (outerAnsic) {
              const contentStart = p + 2;
              const closeEnd =
                unclosedInOuter && contentStart < unclosedInOuter[4]!
                  ? -1
                  : scanClosedEscapedQuoted(line, contentStart, 39, outerCode, true, outerEnd);
              if (closeEnd !== -1) {
                p = closeEnd;
                continue;
              }
              if (unclosedInOuter) unclosedInOuter[4] = outerEnd;
              if (badUntil && tryInvalidateEscapedQuoted(line, contentStart, 39, outerEnd, allowInvalidate, badUntil, 4)) {
                return INVALIDATE_OUTER_SPAN;
              }
              p = scanUnclosedSegment(line, p, 2, outerCode, stopCharCode, true);
              break;
            }
            if (isShellSingleQuoteEscape(line, p + 1)) {
              if (isShellSingleQuoteEscape(line, p + 5)) {
                p += 5;
                continue;
              }
              const contentStart = p + 5;
              const closeEnd =
                unclosedInOuter && contentStart < unclosedInOuter[4]!
                  ? -1
                  : scanClosedEscapedQuoted(line, contentStart, 39, outerCode, false, outerEnd);
              if (closeEnd !== -1) {
                p = closeEnd;
                continue;
              }
              if (unclosedInOuter) unclosedInOuter[4] = outerEnd;
              if (badUntil && tryInvalidateEscapedQuoted(line, contentStart, 39, outerEnd, allowInvalidate, badUntil, 4)) {
                return INVALIDATE_OUTER_SPAN;
              }
              p = scanUnclosedSegment(line, p, 5, outerCode, stopCharCode, false);
              break;
            }
            p += 1;
            break;
          }
          if (outerCode !== 39 && nextCode === 39 && p + 2 < n && line.charCodeAt(p + 2) === 39) {
            p += 2;
            continue;
          }
          const contentStart = p + 2;
          const badIdx = nextCode === 39 ? 4 : 3;
          const closeEnd =
            outerCode !== 0 && unclosedInOuter && contentStart < unclosedInOuter[badIdx]!
              ? -1
              : scanClosedEscapedQuoted(line, contentStart, nextCode, outerCode, outerAnsic, outerEnd);
          if (closeEnd !== -1) {
            p = closeEnd;
            continue;
          }
          if (outerCode !== 0) {
            if (unclosedInOuter) unclosedInOuter[badIdx] = outerEnd;
            if (badUntil && tryInvalidateEscapedQuoted(line, contentStart, nextCode, outerEnd, allowInvalidate, badUntil, badIdx)) {
              return INVALIDATE_OUTER_SPAN;
            }
          }
          p = scanUnclosedSegment(line, p, 2, outerCode, stopCharCode, outerAnsic);
          break;
        }
        if (!isWhitespaceChar(nextCode, line, p + 1)) {
          p += 2;
          continue;
        }
      }
      p += 1;
      continue;
    }

    if (
      code === 96 ||
      (stopCharCode !== 0 && code === stopCharCode) ||
      (code < 128 ? UNCLOSED_STOP_ASCII[code] === 1 : /\s/.test(line[p]!))
    ) {
      break;
    }

    p += 1;
  }
  return p;
}

function redactAssignmentsOnLine(line: string): string {
  const lastEq = line.lastIndexOf("=");
  if (lastEq <= 0) return line;
  const n = line.length;
  let chunks: string[] | null = null;
  let copiedTo = 0;
  let outerCode = 0; // 0 = null, 39 = "'", 34 = '"'
  let outerAnsic = false;
  let outerStart = -1;
  let outerEnd = n;
  let prefixEnd = -1;
  let sqFailUntil = 0;
  let dqFailUntil = 0;
  let ansicFailUntil = 0;
  let nextEq = -1;
  const unclosedInOuter = new Int32Array(5);
  const badUntil = new Int32Array(5);
  let i = 0;

  while (i < lastEq) {
    const firstCode = line.charCodeAt(i);
    if (firstCode < 128 && KEY_CHAR_ASCII[firstCode] === 1) {
      let j = i + 1;
      while (j < lastEq) {
        const jc = line.charCodeAt(j);
        if (jc >= 128 || KEY_CHAR_ASCII[jc] !== 1) break;
        j += 1;
      }
      if (j <= lastEq && line.charCodeAt(j) === 61) {
        const prevCode = i > 0 ? line.charCodeAt(i - 1) : 32;
        if (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[i - 1]!)) {
          const key = line.slice(i, j);
          if (isSecretKey(key)) {
            const valStart = j + 1;
            const stopCharCode = prevCode === 123 ? 125 : prevCode === 91 ? 93 : 0;
            const allowInvalidate = outerCode !== 0 && i > outerStart + (outerAnsic ? 2 : 1);
            let valEnd = scanSecretValue(
              line,
              valStart,
              outerCode,
              stopCharCode,
              outerAnsic,
              outerEnd,
              allowInvalidate,
              unclosedInOuter,
              badUntil,
            );
            if (valEnd === INVALIDATE_OUTER_SPAN) {
              outerCode = 0;
              outerAnsic = false;
              outerStart = -1;
              outerEnd = n;
              valEnd = scanSecretValue(line, valStart, 0, stopCharCode, false, n, false, unclosedInOuter, badUntil);
            }
            if (valEnd > valStart) {
              if (chunks === null) chunks = [];
              chunks.push(line.slice(copiedTo, valStart), "<redacted>");
              copiedTo = valEnd;
              i = valEnd;
              continue;
            }
            i = valStart;
            continue;
          }
        }
        i = j + 1;
        continue;
      }
      if (outerCode === 0 && j < lastEq) {
        const afterWord = line.charCodeAt(j);
        if (afterWord === 39 || afterWord === 34) {
          i = j + 1;
          continue;
        }
      }
      i = j;
      continue;
    }

    if (outerCode === 0) {
      if (firstCode === 92) {
        if (i + 1 < n) {
          const nextCode = line.charCodeAt(i + 1);
          if (nextCode === 36 || nextCode === 92) {
            prefixEnd = i + 2;
          }
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (firstCode === 36 && i + 1 < n) {
        const nextCode = line.charCodeAt(i + 1);
        if (nextCode === 36) {
          prefixEnd = i + 2;
          i += 2;
          continue;
        }
        if (nextCode === 39) {
          if (i >= ansicFailUntil) {
            const prevCode = i > 0 ? line.charCodeAt(i - 1) : 32;
            if (
              i === prefixEnd ||
              (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[i - 1]!))
            ) {
              const closed = findMatchingOuterQuoteClose(line, i, 39, true);
              if (closed !== -1 && isValidQuoteCloseBoundary(line, closed)) {
                if (nextEq < i) nextEq = line.indexOf("=", i);
                if (nextEq === -1) break;
                if (closed < nextEq) {
                  i = closed + 1;
                  continue;
                }
                outerCode = 39;
                outerAnsic = true;
                outerStart = i;
                outerEnd = closed;
              } else {
                ansicFailUntil = closed !== -1 ? closed : n;
              }
            }
          }
          i += 2;
          continue;
        }
      }
      if (firstCode === 39 || firstCode === 34) {
        const failUntil = firstCode === 39 ? sqFailUntil : dqFailUntil;
        if (i >= failUntil) {
          const prevCode = i > 0 ? line.charCodeAt(i - 1) : 32;
          if (
            i === prefixEnd ||
            (prevCode < 128 ? WORD_PREFIX_ASCII[prevCode] === 1 : /\s/.test(line[i - 1]!))
          ) {
            const closed = findMatchingOuterQuoteClose(line, i, firstCode, false);
            if (
              closed !== -1 &&
              (isValidQuoteCloseBoundary(line, closed) ||
                (firstCode === 39 && isSecretDoubleQuotedAssignmentAt(line, i + 1)))
            ) {
              if (nextEq < i) nextEq = line.indexOf("=", i);
              if (nextEq === -1) break;
              if (closed < nextEq) {
                i = closed + 1;
                continue;
              }
              outerCode = firstCode;
              outerAnsic = false;
              outerStart = i;
              outerEnd = closed;
            } else if (firstCode === 39) {
              sqFailUntil = closed !== -1 ? closed : n;
            } else {
              dqFailUntil = closed !== -1 ? closed : n;
            }
          }
        }
      }
      i += 1;
      continue;
    }

    if (outerCode === 34) {
      if (firstCode === 92) {
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (firstCode === 34) {
        outerCode = 0;
        outerAnsic = false;
        outerStart = -1;
        outerEnd = n;
      }
    } else if (outerCode === 39) {
      if (outerAnsic && firstCode === 92) {
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (firstCode === 39) {
        if (!outerAnsic && isShellSingleQuoteEscape(line, i)) {
          i += 4;
          continue;
        }
        outerCode = 0;
        outerAnsic = false;
        outerStart = -1;
        outerEnd = n;
      }
    }
    i += 1;
  }

  if (chunks === null) return line;
  chunks.push(line.slice(copiedTo));
  return chunks.join("");
}

/**
 * Mask inline environment secrets (e.g. FOO_TOKEN=abc, API_KEY=xyz, ?api_key=xyz),
 * Bearer/Basic auth headers, and common API token prefixes before storing or rendering.
 */
export function redactSecrets(command: string): string {
  let redactedAssigns: string;
  if (!command.includes("\n") && !command.includes("\r")) {
    redactedAssigns = redactAssignmentsOnLine(command);
  } else {
    const n = command.length;
    let out = "";
    let pos = 0;
    let changed = false;

    while (pos < n) {
      let lineEnd = pos;
      while (lineEnd < n) {
        const code = command.charCodeAt(lineEnd);
        if (code === 10 || code === 13) break;
        lineEnd += 1;
      }
      const line = command.slice(pos, lineEnd);
      const redactedLine = redactAssignmentsOnLine(line);
      if (redactedLine !== line) changed = true;

      let sepEnd = lineEnd;
      if (sepEnd < n) {
        if (command.charCodeAt(sepEnd) === 13 && sepEnd + 1 < n && command.charCodeAt(sepEnd + 1) === 10) {
          sepEnd += 2;
        } else {
          sepEnd += 1;
        }
      }
      out += redactedLine + command.slice(lineEnd, sepEnd);
      pos = sepEnd;
    }

    redactedAssigns = changed ? out : command;
  }

  let out = redactedAssigns;
  if (out.indexOf("b") !== -1 || out.indexOf("B") !== -1) {
    out = out.replace(/\b(Bearer\s+|Basic\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>");
  }
  if (
    out.indexOf("sk-") !== -1 ||
    out.indexOf("gh") !== -1 ||
    out.indexOf("xox") !== -1 ||
    out.indexOf("AKIA") !== -1
  ) {
    out = out.replace(
      /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      "<redacted>",
    );
  }
  return out;
}

export interface ClimbBest {
  score: number;
  step: number;
  commit?: string;
}

export interface ClimbCard {
  name: string;
  goal: string;
  direction: Direction;
  baseline: number;
  target: number | null;
  target_text?: string | null;
  after?: "stop" | "raise" | string;
  best: ClimbBest;
  branch?: string;
  base?: string;
  check?: string | string[];
  score?: string[];
  score_mode?: "numeric" | "failure-count";
  guards?: string[];
  lock?: string[];
  fingerprint?: string | null;
  holdout?: string | null;
  holdout_once?: boolean;
  timeout?: number;
  repos?: Array<{ path: string; base?: string; branch?: string }>;
  runs?: number;
  min_gain?: number | string;
  paired?: boolean;
  max_steps?: number | null;
  max_hours?: number | null;
  hard?: boolean;
  started?: number;
}

export type LogKind = "baseline" | "step" | "review" | "holdout" | "raise" | "relock" | "budget";

export interface LogRow {
  time?: string;
  kind: LogKind | string;
  step?: number;
  idea?: string;
  result?: "kept" | "undone" | "broke";
  score?: number;
  seconds?: number;
  why?: string;
  gain?: boolean;
}

export interface ClimbFiles {
  card: ClimbCard;
  rows: LogRow[];
  notes: string | null;
  pendingTree: boolean;
}

export type Verdict = "bar-reached" | "stuck" | "plateau" | "climbing";

export interface ClimbSummary {
  name: string;
  goal: string;
  branch: string | null;
  direction: Direction;
  baseline: number;
  best: number;
  bestStep: number;
  target: number | null;
  after: string;
  steps: number;
  kept: number;
  sinceGain: number;
  hours: number;
  minutesPerStep: number | null;
  checkSeconds: number | null;
  trail: number[];
  spark: string;
  raises: string[];
  holdouts: Array<{ score: number; why: string }>;
  verdict: Verdict;
  maxSteps: number | null;
  maxHours: number | null;
  pendingTree: boolean;
  hasHoldout: boolean;
  holdoutOnce: boolean;
  notes: string | null;
  recent: ClimbSummaryRow[];
}

export interface ClimbSummaryRow {
  step: number | null;
  kind: string;
  result?: string;
  score: number | null;
  idea: string;
  note: string;
}

/** Python's `f"{value:.6g}"`, so a score reads the same in both surfaces. */
export function number(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const exponential = value.toExponential(5);
  const [mantissa, exponentText] = exponential.split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= 6) {
    const trimmed = (mantissa ?? "").replace(/0+$/, "").replace(/\.$/, "");
    return `${trimmed}e${exponent >= 0 ? "+" : "-"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const fixed = value.toFixed(Math.max(0, 5 - exponent));
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export function spark(values: number[], direction: Direction): string {
  if (values.length < 2) return "";
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const levels = values.map((value) => (value - low) / span);
  const oriented = direction === "min" ? levels.map((level) => 1 - level) : levels;
  return oriented.map((level) => BARS[Math.round(level * (BARS.length - 1))] ?? "").join("");
}

export function parseCard(text: string): ClimbCard {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) throw new Error("card.json is not an object");
  const card = raw as Partial<ClimbCard> & { best?: Partial<ClimbBest> };
  if (typeof card.name !== "string") throw new Error("card.json has no name");
  if (typeof card.baseline !== "number") throw new Error("card.json has no baseline");
  if (card.direction !== "min" && card.direction !== "max") throw new Error("card.json has no direction");
  if (card.score_mode !== undefined && card.score_mode !== "numeric" && card.score_mode !== "failure-count") {
    throw new Error("card.json has an unknown score mode");
  }
  const best: Partial<ClimbBest> = card.best ?? {};
  return {
    ...card,
    name: card.name,
    goal: card.goal ?? "",
    direction: card.direction,
    baseline: card.baseline,
    target: typeof card.target === "number" ? card.target : null,
    after: card.after ?? "stop",
    best: {
      score: typeof best.score === "number" ? best.score : card.baseline,
      step: typeof best.step === "number" ? best.step : 0,
      commit: best.commit,
    },
  } as ClimbCard;
}

export function parseLog(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row === "object" && row !== null) rows.push(row as LogRow);
    } catch {
      // A half-written last line after a crash is not a reason to lose the trail.
    }
  }
  return rows;
}

function at(time: string | undefined): number {
  if (!time) return Number.NaN;
  const parsed = Date.parse(time.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Mirror of climb.py's `cmd_status`, including its verdict precedence. */
export function summarize(files: ClimbFiles, recentLimit = 15, now = Date.now()): ClimbSummary {
  const { card, rows, notes, pendingTree } = files;
  const steps = rows.filter((row) => row.kind === "step");
  const kept = steps.filter((row) => row.result === "kept");
  const trail = [card.baseline, ...kept.map((row) => row.score ?? card.baseline)];
  const sinceGain = steps.length - card.best.step;
  const reviews = rows.filter((row) => row.kind === "review");
  const lastReview = reviews.length > 0 ? (reviews[reviews.length - 1]?.step ?? null) : null;
  const previousReview = reviews.length >= 2 ? (reviews[reviews.length - 2]?.step ?? null) : null;
  const stuck = reviews.length >= 2 && previousReview !== null && previousReview >= card.best.step;
  const timed = rows.map((row) => row.seconds).filter((value): value is number => typeof value === "number");
  const started = typeof card.started === "number" ? card.started * 1000 : null;
  const hours = started === null ? 0 : Math.max(0, (now - started) / 3_600_000);

  const reached = card.target !== null && (card.direction === "max" ? card.best.score >= card.target : card.best.score <= card.target);
  const plateau =
    sinceGain >= PLATEAU && (lastReview === null || steps.length - lastReview >= PLATEAU);
  const verdict: Verdict = reached ? "bar-reached" : stuck ? "stuck" : plateau ? "plateau" : "climbing";

  const recent: ClimbSummaryRow[] = rows.slice(-recentLimit).map((row) => {
    if (row.kind === "step") {
      return {
        step: row.step ?? null,
        kind: "step",
        result: row.result,
        score: typeof row.score === "number" ? row.score : null,
        idea: redactSecrets(row.idea ?? ""),
        note: row.result === "kept" ? "" : redactSecrets(row.why ?? ""),
      };
    }
    return {
      step: row.step ?? null,
      kind: String(row.kind),
      score: typeof row.score === "number" ? row.score : null,
      idea: "",
      note: redactSecrets(row.why ?? ""),
    };
  });

  return {
    name: card.name,
    goal: redactSecrets(card.goal),
    branch: card.branch ?? null,
    direction: card.direction,
    baseline: card.baseline,
    best: card.best.score,
    bestStep: card.best.step,
    target: card.target,
    after: card.after ?? "stop",
    steps: steps.length,
    kept: kept.length,
    sinceGain,
    hours,
    minutesPerStep: steps.length > 0 ? (60 * hours) / steps.length : null,
    checkSeconds: timed.length > 0 ? timed.reduce((total, value) => total + value, 0) / timed.length : null,
    trail,
    spark: spark(trail, card.direction),
    raises: rows.filter((row) => row.kind === "raise").map((row) => redactSecrets(row.why ?? "")),
    holdouts: rows
      .filter((row) => row.kind === "holdout")
      .map((row) => ({ score: typeof row.score === "number" ? row.score : 0, why: redactSecrets(row.why ?? "") })),
    verdict,
    maxSteps: card.max_steps ?? null,
    maxHours: card.max_hours ?? null,
    pendingTree,
    hasHoldout: typeof card.holdout === "string" && card.holdout !== "",
    holdoutOnce: Boolean(card.holdout_once),
    notes: notes === null ? null : redactSecrets(tail(notes, 40)),
    recent,
  };
}

export function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/** The single line an agent must act on. */
export function verdictLine(summary: ClimbSummary): string {
  switch (summary.verdict) {
    case "bar-reached":
      // climb.py status owns this wording; match it so either surface greps the same.
      return `BAR REACHED. ${summary.hasHoldout ? "Check the holdout, then " : "Then "}${summary.after}.`;
    case "stuck":
      return "STUCK: two blocker reviews with no gain between them. Stop and report.";
    case "plateau":
      return `PLATEAU: ${summary.sinceGain} steps with no gain. Do a blocker review, then log it with: climb.py review`;
    default:
      return "";
  }
}

/** Same shape as `climb.py status`, so either surface tells the same story. */
export function formatSummary(summary: ClimbSummary): string {
  const lines: string[] = [];
  lines.push(`Climb ${summary.name} on ${summary.branch ?? "(no branch)"}: ${summary.goal}`);
  lines.push(
    `Score ${number(summary.baseline)} -> ${number(summary.best)} (${summary.direction})  ${summary.spark}`.trimEnd(),
  );
  const bar = summary.target === null ? "none" : `${number(summary.target)}, then ${summary.after}`;
  const budget = summary.maxSteps ? ` of ${summary.maxSteps}` : "";
  lines.push(`Bar ${bar}. Steps ${summary.steps}${budget}, kept ${summary.kept}, ${summary.sinceGain} since the last gain.`);
  const limit = summary.maxHours ? ` of ${number(summary.maxHours)}` : "";
  const pace = summary.minutesPerStep === null ? "" : `, about ${summary.minutesPerStep.toFixed(1)} min a step`;
  lines.push(`Time ${summary.hours.toFixed(1)}${limit} hours${pace}.`);
  if (summary.checkSeconds !== null) lines.push(`Check takes ${summary.checkSeconds.toFixed(1)}s on average.`);
  for (const raised of summary.raises) lines.push(`Raised ${raised}`);
  if (summary.holdouts.length > 0) {
    lines.push(`Holdout ${summary.holdouts.map((row) => `${number(row.score)} (${row.why})`).join(", ")}`);
  } else if (summary.hasHoldout && !summary.holdoutOnce) {
    lines.push(
      `Holdout baseline missing — do not inspect holdout files; run: climb.py holdout ${summary.name} --why baseline`,
    );
  }
  for (const row of summary.recent) {
    if (row.kind === "step") {
      const score = row.score === null ? "-" : number(row.score);
      const note = row.note === "" ? "" : `  [${row.note}]`;
      const step = String(row.step ?? 0).padStart(4);
      lines.push(`  ${step} ${(row.result ?? "").padEnd(6)} ${score.padStart(10)}  ${row.idea}${note}`);
    } else if (row.kind !== "holdout") {
      lines.push(`  ---- ${row.kind}: ${row.note || number(row.score ?? 0)}`);
    }
  }
  if (summary.pendingTree) {
    lines.push(
      "A paired step was cut off and the tree may hold the old code. Run `climb.py status` in the repo for the exact restore command.",
    );
  }
  if (summary.notes !== null) lines.push(`Notes:\n${summary.notes}`);
  const line = verdictLine(summary);
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

export interface ClimbEntry {
  name: string;
  best: number;
  baseline: number;
  direction: Direction;
  steps: number;
  verdict: Verdict;
}

export function listClimbs(entries: Array<{ card: ClimbCard; rows: LogRow[] }>, now = Date.now()): ClimbEntry[] {
  return entries.map(({ card, rows }) => {
    const summary = summarize({ card, rows, notes: null, pendingTree: false }, 0, now);
    return {
      name: card.name,
      best: summary.best,
      baseline: summary.baseline,
      direction: summary.direction,
      steps: summary.steps,
      verdict: summary.verdict,
    };
  });
}

/**
 * The rig, as the engine recorded it in card.json.
 *
 * A resumed session has to know what it must not edit (the lock), what must
 * still pass (the guards), and which files it must never look at (the holdout).
 * Guessing those from a score line is how a climb gets cheated by accident, so
 * print them, including the ones that are absent.
 */
export function formatRig(card: ClimbCard): string {
  const checks = (Array.isArray(card.check) ? card.check : typeof card.check === "string" ? [card.check] : []).map(
    redactSecrets,
  );
  const patterns = card.score ?? [];
  const guards = (card.guards ?? []).map(redactSecrets);
  const locks = card.lock ?? [];
  const repos = card.repos ?? [];

  const rows: Array<[string, string]> = [];
  const bar =
    card.target === null
      ? `none (${card.direction} is the direction; no target set)`
      : `${number(card.target)}${card.target_text && card.target_text !== String(card.target) ? ` (${card.target_text})` : ""}, then ${card.after ?? "stop"}`;
  rows.push(["Goal", redactSecrets(card.goal)]);
  rows.push(["Bar", bar]);
  rows.push(["Mode", card.score_mode ?? "failure-count (legacy card)"]);
  if (checks.length === 0) rows.push(["Check", "none recorded"]);
  checks.forEach((command, index) => {
    const pattern = patterns.length === 1 ? patterns[0] : patterns[index];
    rows.push([index === 0 ? "Check" : "", pattern ? `${command}\nscore: ${pattern}` : command]);
  });
  if (checks.length > 0 && patterns.length === 0) {
    rows.push(["Score", "the last line of check output must be the number"]);
  }
  const modifiers: string[] = [];
  if ((card.runs ?? 1) > 1) modifiers.push(`${card.runs} runs, median`);
  if (card.paired) modifiers.push("paired (old and new code in turns)");
  if (card.min_gain !== undefined && card.min_gain !== null && String(card.min_gain) !== "0") modifiers.push(`min gain ${String(card.min_gain)}`);
  if (modifiers.length > 0) rows.push(["Scoring", modifiers.join(", ")]);
  rows.push(["Guards", guards.length > 0 ? guards.join("\n") : "none — a kept step can break anything the check does not measure"]);
  rows.push([
    "Holdout",
    typeof card.holdout === "string" && card.holdout !== ""
      ? `${redactSecrets(card.holdout)}\nnever read it again; run holdout --why "…" at the bar`
      : "none — nothing catches overfitting to the visible cases",
  ]);
  rows.push(["Locked", locks.length > 0 ? locks.join("\n") : "none — nothing stops a step from editing the check"]);
  rows.push([
    "Lock hash",
    typeof card.fingerprint === "string" && card.fingerprint !== ""
      ? `${card.fingerprint.slice(0, 12)} — the engine re-checks it on every try`
      : "none",
  ]);
  if (repos.length > 0) rows.push(["Repos", repos.map((repo) => repo.path).join("\n")]);
  const limits: string[] = [];
  if (card.max_steps) limits.push(`${card.max_steps} steps`);
  if (card.max_hours) limits.push(`${number(card.max_hours)} hours`);
  if (limits.length > 0) rows.push(["Limits", `${limits.join(", ")} (${card.hard ? "hard" : "soft"})`]);

  const head = `Climb ${card.name} on ${card.branch ?? "(no branch)"}${card.base ? ` (base ${card.base})` : ""}`;
  const body = rows.map(([label, value]) => {
    const [first, ...rest] = value.split("\n");
    return [`${label.padEnd(10)} ${first ?? ""}`, ...rest.map((line) => `${" ".repeat(11)}${line}`)].join("\n");
  });
  return [head, ...body].join("\n");
}
