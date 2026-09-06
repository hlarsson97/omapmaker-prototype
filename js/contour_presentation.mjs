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
      let batch = batches.get(indexContour);
      if (!batch || batch.geometry.coordinates.length >= batchSize) {
        batch = {type: 'Feature', properties: {indexContour}, geometry: {type: 'MultiLineString', coordinates: []}};
        batches.set(indexContour, batch);
        features.push(batch);
      }
      batch.geometry.coordinates.push(coordinates);
    }
  }
  return {type: 'FeatureCollection', features};
}
