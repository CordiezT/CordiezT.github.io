// Hand-placed schematic anchors, in the spirit of the official Tube diagram.
//
// Grid units (x east, y south). Every junction, terminus and major interchange
// is pinned here; the stations in between are placed automatically along the
// route between anchors (see layout.mjs). Neighbouring anchors are aligned so
// the track between them is horizontal, vertical or at 45°.
//
// Keys are station names, or NaPTAN ids where a name is ambiguous
// (two Paddingtons, two Edgware Roads, two Hammersmiths).

export const UNIT = 170; // world units per grid step

export const ANCHORS = {
  // --- Circle north side (Paddington → King's Cross) ---------------------
  '940GZZLUPAH': [-14, 0],          // Paddington (H&C / Circle)
  '940GZZLUERC': [-12, 0],          // Edgware Road (Circle, H&C, District)
  'Baker Street': [-8, 0],
  'Great Portland Street': [-6, 0],
  'Euston Square': [-4, 0],
  "King's Cross St. Pancras": [0, 0],

  // --- Circle north-east (King's Cross → Aldgate) --------------------------
  'Farringdon': [2, 2],
  'Barbican': [6, 2],
  'Moorgate': [10, 2],
  'Liverpool Street': [14, 2],
  'Aldgate': [16, 2],
  'Tower Hill': [16, 8],

  // --- Circle west side & Bakerloo through Paddington ------------------------
  '940GZZLUPAC': [-14, 2],          // Paddington (Bakerloo, Circle, District)
  '940GZZLUERB': [-12, 2],          // Edgware Road (Bakerloo)
  'Marylebone': [-10, 2],
  'Bayswater': [-14, 4],
  'Notting Hill Gate': [-14, 6],
  'High Street Kensington': [-14, 12],

  // --- Circle / District south side --------------------------------------
  'Gloucester Road': [-12, 14],
  'South Kensington': [-10, 14],
  'Sloane Square': [-8, 14],
  'Victoria': [-6, 14],
  "St. James's Park": [-3, 14],
  'Westminster': [0, 14],
  'Embankment': [0, 12],
  'Temple': [2, 12],
  'Blackfriars': [5, 12],
  'Mansion House': [7, 12],
  'Cannon Street': [8.5, 12],
  'Monument': [12, 12],

  // --- Central line ----------------------------------------------------------
  'Bond Street': [-8, 6],
  'Oxford Circus': [-4, 6],
  'Tottenham Court Road': [-2, 6],
  'Holborn': [0, 6],
  'Bank': [10, 6],
  'Bethnal Green': [16, 0],
  'Mile End': [20, 0],
  'Stratford': [24, 0],
  'Leytonstone': [27, -3],
  'Woodford': [27, -8],
  'Epping': [27, -14],
  'North Acton': [-24, 4],
  'Ealing Broadway': [-30, 9],
  'West Ruislip': [-36, -2],

  // --- Northern line ------------------------------------------------------------
  'Camden Town': [-2, -6],
  'Euston': [-2, -2],
  'Warren Street': [-2, 4],
  'Leicester Square': [-2, 8],
  'Charing Cross': [-2, 10],
  'Waterloo': [2, 14],
  'Kennington': [2, 20],
  'Elephant & Castle': [5, 17],
  'London Bridge': [10, 14],
  'Old Street': [10, -3],
  'Angel': [3, -3],
  'Stockwell': [2, 24],
  'Morden': [2, 36],
  'Battersea Power Station': [-4, 20],
  'Finchley Central': [-2, -16],
  'High Barnet': [-2, -22],
  'Mill Hill East': [-4, -18],
  'Edgware': [-10, -14],

  // --- Victoria line ----------------------------------------------------------
  'Finsbury Park': [0, -6],
  'Walthamstow Central': [8, -10],
  'Green Park': [-6, 8],
  'Pimlico': [-6, 16],
  'Vauxhall': [-4, 18],
  'Brixton': [4, 26],

  // --- Piccadilly line ------------------------------------------------------
  'Piccadilly Circus': [-4, 8],
  'Covent Garden': [-1, 7],
  'Russell Square': [0, 3],
  'Cockfosters': [0, -20],
  "Earl's Court": [-16, 14],
  'Barons Court': [-19, 14],
  '940GZZLUHSD': [-21, 14],         // Hammersmith (District & Piccadilly)
  'Turnham Green': [-24, 14],
  'Acton Town': [-28, 14],
  'Ealing Common': [-28, 11],
  'Rayners Lane': [-28, -6],
  'Uxbridge': [-36, -6],
  'Hatton Cross': [-38, 18],
  'Heathrow Terminals 2 & 3': [-41, 18],
  'Heathrow Terminal 5': [-44, 18],

  // --- District & Hammersmith & City -----------------------------------------
  'Kensington (Olympia)': [-16, 12],
  'Wimbledon': [-16, 26],
  'Richmond': [-26, 20],
  'Aldgate East': [18, 6],
  'West Ham': [24, 6],
  'Barking': [30, 6],
  'Upminster': [36, 6],
  '940GZZLUHSC': [-20, 12],         // Hammersmith (H&C / Circle)

  // --- Metropolitan line ------------------------------------------------------
  'Finchley Road': [-12, -4],
  'Wembley Park': [-18, -10],
  'Harrow-on-the-Hill': [-24, -10],
  'Moor Park': [-28, -14],
  'Watford': [-30, -18],
  'Chalfont & Latimer': [-34, -14],
  'Amersham': [-38, -14],
  'Chesham': [-36, -16],

  // --- Jubilee line -----------------------------------------------------------
  'Stanmore': [-18, -18],
  'Canada Water': [16, 14],
  'Canary Wharf': [19, 14],
  'North Greenwich': [21, 12],
  'Canning Town': [24, 9],

  // --- Bakerloo line -----------------------------------------------------------
  'Harrow & Wealdstone': [-22, -16],
};

// The Thames, in the same grid: horizontal / vertical / 45° runs threaded
// between the stations on each bank (checked automatically at build time).
export const RIVER = [
  [-34, 16.5], [-22.5, 16.5], [-18.25, 20.75], [-9.25, 20.75], [-5, 16.5], [-3.5, 15], [1, 15],
  [1, 13], [17.5, 13], [17.5, 16], [20, 16], [20, 10.5], [40, 10.5],
];
