// Distance rings around home: which radii to show for an aircraft this far away. Shared by the
// world and the map, so both show the same rings.

export const RING_RADII = [10, 20, 50, 100, 200, 500, 1000, 2000];

export function rangeRings(metres) {
  return RING_RADII.filter(r => r >= metres / 4 && r <= Math.max(metres * 4, 25)).slice(-4);
}
