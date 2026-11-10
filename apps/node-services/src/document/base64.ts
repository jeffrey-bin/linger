export function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  let padding = 0;
  if (value.endsWith("=")) {
    padding++;
  }
  if (value.endsWith("==")) {
    padding++;
  }
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (base64Value(value.charCodeAt(index)) < 0) {
      return false;
    }
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) {
      return false;
    }
  }
  if (padding === 0 || contentLength === 0) {
    return padding === 0;
  }
  const finalValue = base64Value(value.charCodeAt(contentLength - 1));
  return padding === 1
    ? (finalValue & 0b11) === 0
    : (finalValue & 0b1111) === 0;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}
