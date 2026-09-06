import {geometryBounds} from './viewport_layers.mjs?v=1';

// Contours share two styles and their pane is non-interactive. Batch their
// screen paths without copying/simplifying coordinates or changing export data.
export function contourDisplayData(data, batchSize = 32) {
  const features = [];
  const batches = new Map();
  for (const feature of data.features || []) {
    const geometry = feature.geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    const indexContour = Boolean(feature.properties?.indexContour);
    for (const coordinates of lines) {
      if (!coordinates?.length) continue;
      const bounds = geometryBounds({type: 'LineString', coordinates});
      if (!bounds) continue;
      // Keep distant curves in separate batches so the viewport index can
      // discard them independently. This grid is for display grouping only.
      const key = `${indexContour}:${Math.floor((bounds[0]+bounds[2])/.02)}:${Math.floor((bounds[1]+bounds[3])/.02)}`;
      let batch = batches.get(key);
      if (!batch || batch.geometry.coordinates.length >= batchSize) {
        batch = {type: 'Feature', properties: {indexContour}, geometry: {type: 'MultiLineString', coordinates: []}};
        batches.set(key, batch);
        features.push(batch);
      }
      batch.geometry.coordinates.push(coordinates);
    }
  }
  return {type: 'FeatureCollection', features};
}
