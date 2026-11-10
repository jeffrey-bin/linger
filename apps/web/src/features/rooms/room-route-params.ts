export function requireRoomRouteParam(
  value: string | undefined,
  label: string,
) {
  if (!value) {
    throw new Error(`${label} route parameter is required.`);
  }

  return value;
}
