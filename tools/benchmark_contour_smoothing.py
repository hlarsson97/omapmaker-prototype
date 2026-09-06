"""Compare smoothing and the complete generator against its previous version."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin
from generate_contours import smooth_line
from test_contour_smoothing import reference_smoothing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', default='7a4560ae1262390319371a8ba4ccf7df59476b7b')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    random = np.random.default_rng(42)
    points = np.cumsum(random.normal(size=(10000, 2)), axis=0)
    np.testing.assert_array_equal(smooth_line(points, 2), reference_smoothing(points, 2))
    result = {}
    for name, function in [('before', reference_smoothing), ('after', smooth_line)]:
        durations = []
        for _ in range(7):
            start = time.perf_counter()
            function(points, 2)
            durations.append((time.perf_counter()-start)*1000)
        result[name+'_smoothing_ms'] = round(statistics.median(durations), 2)
    with tempfile.TemporaryDirectory(prefix='omapmaker-smoothing-') as temporary:
        folder = Path(temporary)
        previous = folder/'previous.py'
        previous.write_bytes(subprocess.check_output(['git', '-c', f'safe.directory={root.as_posix()}', 'show', f'{args.baseline}:tools/generate_contours.py'], cwd=root))
        raster = folder/'synthetic.tif'
        y, x = np.mgrid[:512, :512]
        heights = (100+25*np.sin(x/25)*np.cos(y/30)).astype('float32')
        with rasterio.open(raster, 'w', driver='GTiff', width=512, height=512, count=1, dtype='float32', crs='EPSG:3006', transform=from_origin(500000, 6650000, 1, 1)) as dataset:
            dataset.write(heights, 1)
        outputs = []
        for name, script in [('before', previous), ('after', root/'tools/generate_contours.py')]:
            output = folder/f'{name}.geojson'
            start = time.perf_counter()
            subprocess.run([sys.executable, str(script), str(raster), str(output), '--interval', '2.5', '--smooth', '2'], check=True, capture_output=True)
            result[name+'_generation_ms'] = round((time.perf_counter()-start)*1000, 2)
            outputs.append(json.loads(output.read_text(encoding='utf-8')))
        assert outputs[0] == outputs[1], 'Complete GeoJSON output must match'
        result['features'] = len(outputs[0]['features'])
        result['identical_geojson'] = True
    print(json.dumps(result))


if __name__ == '__main__':
    main()
