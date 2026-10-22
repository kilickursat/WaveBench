import { WaveBenchError } from "./errors";

export type Quantity = "acceleration" | "voltage" | "count" | "unknown";

export interface UnitDef {
  id: string;
  /** Display label (Unicode). */
  label: string;
  /** ASCII form for CSV headers and file names. */
  ascii: string;
  quantity: Quantity;
  /** Factor to the coherent SI unit of the quantity (m/s^2, V); null when no conversion is defined. */
  toSI: number | null;
}

/** Standard acceleration of gravity, exact by definition (CGPM 1901; NIST CODATA "gn"). */
export const STANDARD_GRAVITY = 9.80665;

export const UNITS: readonly UnitDef[] = [
  { id: "g", label: "g", ascii: "g", quantity: "acceleration", toSI: STANDARD_GRAVITY },
  { id: "mg", label: "mg", ascii: "mg", quantity: "acceleration", toSI: STANDARD_GRAVITY * 1e-3 },
  { id: "m/s^2", label: "m/s²", ascii: "m/s^2", quantity: "acceleration", toSI: 1 },
  { id: "mm/s^2", label: "mm/s²", ascii: "mm/s^2", quantity: "acceleration", toSI: 1e-3 },
  { id: "Gal", label: "Gal (cm/s²)", ascii: "Gal", quantity: "acceleration", toSI: 1e-2 },
  { id: "V", label: "V", ascii: "V", quantity: "voltage", toSI: 1 },
  { id: "mV", label: "mV", ascii: "mV", quantity: "voltage", toSI: 1e-3 },
  { id: "count", label: "counts", ascii: "count", quantity: "count", toSI: null },
  { id: "unknown", label: "unknown", ascii: "unknown", quantity: "unknown", toSI: null },
];

export function unitDef(id: string): UnitDef {
  const def = UNITS.find((u) => u.id === id);
  if (!def) throw new WaveBenchError("UNKNOWN_UNIT", `unknown unit "${id}"`);
  return def;
}

/** Units the value can be shown in without new information: same quantity with a defined factor. */
export function compatibleUnits(id: string): UnitDef[] {
  const def = unitDef(id);
  if (def.toSI === null) return [def];
  return UNITS.filter((u) => u.quantity === def.quantity && u.toSI !== null);
}

/** Multiply a value in `from` by this factor to express it in `to`. */
export function conversionFactor(from: string, to: string): number {
  if (from === to) return 1;
  const a = unitDef(from);
  const b = unitDef(to);
  if (a.quantity !== b.quantity || a.toSI === null || b.toSI === null) {
    throw new WaveBenchError("INCOMPATIBLE_UNITS", `cannot convert ${a.label} to ${b.label}`);
  }
  return a.toSI / b.toSI;
}

export function unitLabel(id: string): string {
  const def = UNITS.find((u) => u.id === id);
  return def ? (def.id === "Gal" ? "Gal" : def.label) : id;
}

export type SpectralQuantity = "peak" | "rms" | "power" | "psd" | "asd";

/** Unit of a spectral quantity for a signal in `unit` (Unicode). */
export function spectralUnitLabel(unit: string, quantity: SpectralQuantity): string {
  const u = unitLabel(unit);
  const wrapped = /[/ ]/.test(u) ? `(${u})` : u;
  switch (quantity) {
    case "peak":
    case "rms":
      return u;
    case "power":
      return `${wrapped}²`;
    case "psd":
      return `${wrapped}²/Hz`;
    case "asd":
      return `${u}/√Hz`;
  }
}

/** ASCII form of {@link spectralUnitLabel} for CSV headers. */
export function spectralUnitAscii(unit: string, quantity: SpectralQuantity): string {
  const def = UNITS.find((u) => u.id === unit);
  const u = def ? def.ascii : unit;
  const wrapped = /[/ ]/.test(u) ? `(${u})` : u;
  switch (quantity) {
    case "peak":
    case "rms":
      return u;
    case "power":
      return `${wrapped}^2`;
    case "psd":
      return `${wrapped}^2/Hz`;
    case "asd":
      return `${u}/sqrt(Hz)`;
  }
}
