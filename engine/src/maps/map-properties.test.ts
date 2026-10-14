import { describe, expect, it } from 'vitest';
import {
  MAP_BATTLE_TYPE_NAMES,
  MAP_CAVE_OR_TYPE_NAMES,
  MAP_FLAGS_BITS,
  MAP_TYPE_NAMES,
  MAP_WEATHER_NAMES,
  aggregateMapProperties,
  nameFlagsBits,
  nameFromTable,
} from './map-properties.js';

describe('nameFromTable', () => {
  it('returns the named entry for a known value', () => {
    expect(nameFromTable(MAP_TYPE_NAMES, 1)).toBe('TOWN');
    expect(nameFromTable(MAP_WEATHER_NAMES, 3)).toBe('RAIN');
    expect(nameFromTable(MAP_BATTLE_TYPE_NAMES, 7)).toBe('CHAMPION');
  });

  it('returns UNKNOWN_<value> for an unknown value', () => {
    expect(nameFromTable(MAP_TYPE_NAMES, 99)).toBe('UNKNOWN_99');
    expect(nameFromTable(MAP_WEATHER_NAMES, 42)).toBe('UNKNOWN_42');
    expect(nameFromTable(MAP_BATTLE_TYPE_NAMES, 255)).toBe('UNKNOWN_255');
  });

  it('treats 0 as the NONE-class name (table value or UNKNOWN_0)', () => {
    expect(nameFromTable(MAP_TYPE_NAMES, 0)).toBe('NONE');
    expect(nameFromTable(MAP_WEATHER_NAMES, 0)).toBe('NONE');
  });
});

describe('nameFlagsBits', () => {
  it('returns empty for flags=0', () => {
    expect(nameFlagsBits(0)).toEqual([]);
  });

  it('decodes bit 0/1 to their canonical names', () => {
    expect(nameFlagsBits(1)).toEqual(['ALLOW_ESCAPING']);
    expect(nameFlagsBits(2)).toEqual(['ALLOW_RUNNING']);
  });

  it('decodes the showMapName field (bits 2..7) to SHOW_MAP_NAME', () => {
    expect(nameFlagsBits(4)).toEqual(['SHOW_MAP_NAME']);
    expect(nameFlagsBits(8)).toEqual(['SHOW_MAP_NAME']);
    // Any non-zero value in bits 2..7 means "show map name".
    expect(nameFlagsBits(0x80)).toEqual(['SHOW_MAP_NAME']);
  });

  it('decodes multiple bits/fields in ascending order', () => {
    // 0x0D = bits 0, 2, 3 → allowEscaping + showMapName (bits 2-3)
    expect(nameFlagsBits(0x0d)).toEqual(['ALLOW_ESCAPING', 'SHOW_MAP_NAME']);
    // 0x03 = allowEscaping + allowRunning, no showMapName
    expect(nameFlagsBits(0x03)).toEqual(['ALLOW_ESCAPING', 'ALLOW_RUNNING']);
  });
});

describe('aggregateMapProperties', () => {
  it('returns empty histograms for an empty input', () => {
    const r = aggregateMapProperties([]);
    expect(r.mapCount).toBe(0);
    expect(r.mapType).toEqual({});
    expect(r.weather).toEqual({});
    expect(r.flagsBits).toEqual({});
  });

  it('counts each named value once per map', () => {
    const r = aggregateMapProperties([
      { mapType: 1, weather: 3, caveOrType: 0, battleType: 0, flags: 1, bikingAllowed: true },
      { mapType: 1, weather: 4, caveOrType: 0, battleType: 0, flags: 1, bikingAllowed: true },
      { mapType: 3, weather: 0, caveOrType: 1, battleType: 1, flags: 4 },
    ]);
    expect(r.mapCount).toBe(3);
    expect(r.mapType['TOWN']).toBe(2);
    expect(r.mapType['ROUTE']).toBe(1);
    expect(r.weather['RAIN']).toBe(1);
    expect(r.weather['SNOW']).toBe(1);
    expect(r.weather['NONE']).toBe(1);
    expect(r.caveOrType['CAVE']).toBe(1);
    expect(r.caveOrType['NONE']).toBe(2);
    expect(r.battleType['GYM']).toBe(1);
    expect(r.battleType['NORMAL']).toBe(2);
    // allow_cycling comes from byte 0x18 (bikingAllowed), not the flags byte.
    expect(r.flagsBits['ALLOW_CYCLING']).toBe(2);
    // flags=1 (×2 maps) has bit 0 = ALLOW_ESCAPING
    expect(r.flagsBits['ALLOW_ESCAPING']).toBe(2);
    // flags=4 (×1 map) is showMapName only
    expect(r.flagsBits['SHOW_MAP_NAME']).toBe(1);
    expect(r.flagsBits['ALLOW_RUNNING']).toBeUndefined();
  });

  it('omits ALLOW_CYCLING when bikingAllowed is absent or false', () => {
    const r = aggregateMapProperties([
      { mapType: 1, weather: 0, caveOrType: 0, battleType: 0, flags: 0 },
      { mapType: 1, weather: 0, caveOrType: 0, battleType: 0, flags: 0, bikingAllowed: false },
    ]);
    expect(r.flagsBits['ALLOW_CYCLING']).toBeUndefined();
    expect(r.flagsBits).toEqual({});
  });

  it('returns frozen objects + nested tables', () => {
    const r = aggregateMapProperties([
      { mapType: 1, weather: 0, caveOrType: 0, battleType: 0, flags: 0 },
    ]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.mapType)).toBe(true);
    expect(Object.isFrozen(r.weather)).toBe(true);
    expect(Object.isFrozen(r.flagsBits)).toBe(true);
  });

  it('falls back to UNKNOWN_<value> names for out-of-table bytes', () => {
    const r = aggregateMapProperties([
      { mapType: 200, weather: 100, caveOrType: 50, battleType: 99, flags: 0 },
    ]);
    expect(r.mapType['UNKNOWN_200']).toBe(1);
    expect(r.weather['UNKNOWN_100']).toBe(1);
    expect(r.caveOrType['UNKNOWN_50']).toBe(1);
    expect(r.battleType['UNKNOWN_99']).toBe(1);
  });
});

describe('name tables - well-formed', () => {
  it('MAP_TYPE_NAMES has entries 0..9', () => {
    for (let i = 0; i <= 9; i++) {
      expect(MAP_TYPE_NAMES[i]).toBeDefined();
    }
  });

  it('MAP_WEATHER_NAMES has 16 entries (0..15)', () => {
    for (let i = 0; i <= 15; i++) {
      expect(MAP_WEATHER_NAMES[i]).toBeDefined();
    }
  });

  it('MAP_FLAGS_BITS has bits 0..1 named', () => {
    for (let bit = 0; bit <= 1; bit++) {
      expect(MAP_FLAGS_BITS[bit]).toBeDefined();
    }
  });
});
