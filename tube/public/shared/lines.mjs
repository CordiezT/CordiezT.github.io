// Every line on the map, in the fixed order used for parallel-line offsets.
// Colours: TfL corporate line colours (`dark` = override for dark backgrounds).
// `mode` groups lines in the UI; `cased` lines are drawn as a coloured line
// with a thin centre stripe, as rail lines are on the official map.
export const LINES = [
  { id: 'metropolitan', name: 'Metropolitan', color: '#9B0056', dark: '#C2337F', mode: 'tube' },
  { id: 'hammersmith-city', name: 'Hammersmith & City', color: '#F3A9BB', mode: 'tube' },
  { id: 'circle', name: 'Circle', color: '#FFD300', mode: 'tube' },
  { id: 'district', name: 'District', color: '#00782A', dark: '#14A048', mode: 'tube' },
  { id: 'piccadilly', name: 'Piccadilly', color: '#003688', dark: '#3D6FD9', mode: 'tube' },
  { id: 'central', name: 'Central', color: '#E32017', mode: 'tube' },
  { id: 'bakerloo', name: 'Bakerloo', color: '#B36305', dark: '#C9792A', mode: 'tube' },
  { id: 'jubilee', name: 'Jubilee', color: '#A0A5A9', mode: 'tube' },
  { id: 'northern', name: 'Northern', color: '#000000', dark: '#E6E6E6', mode: 'tube' },
  { id: 'victoria', name: 'Victoria', color: '#0098D4', mode: 'tube' },
  { id: 'waterloo-city', name: 'Waterloo & City', color: '#95CDBA', mode: 'tube' },
  { id: 'elizabeth', name: 'Elizabeth line', color: '#6950A1', dark: '#8C72CC', mode: 'elizabeth', cased: true },
  { id: 'dlr', name: 'DLR', color: '#00A4A7', mode: 'dlr', cased: true },
  { id: 'liberty', name: 'Liberty', color: '#676C6F', dark: '#8D9295', mode: 'overground', cased: true },
  { id: 'lioness', name: 'Lioness', color: '#F1A72F', mode: 'overground', cased: true },
  { id: 'mildmay', name: 'Mildmay', color: '#2F6FB6', dark: '#4F8FD6', mode: 'overground', cased: true },
  { id: 'suffragette', name: 'Suffragette', color: '#4FA35A', mode: 'overground', cased: true },
  { id: 'weaver', name: 'Weaver', color: '#8A2C5C', dark: '#B04C80', mode: 'overground', cased: true },
  { id: 'windrush', name: 'Windrush', color: '#E7362B', mode: 'overground', cased: true },
];

export const MODES = [
  { id: 'tube', name: 'Underground' },
  { id: 'elizabeth', name: 'Elizabeth line' },
  { id: 'overground', name: 'Overground' },
  { id: 'dlr', name: 'DLR' },
];
